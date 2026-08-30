/**
 * Account-state service as a supervised `PeriodicService` (PHNX-3608).
 *
 * The daemon owns usage and authentication health as first-party device state.
 * This used to run its OWN two `setInterval` loops behind a `usageRunning` /
 * `authRunning` latch with NO deadline (`account-state-service.ts`, now removed):
 * a `runUsageRefreshTick` that hung on an unbounded provider await latched
 * `usageRunning = true` forever, so the usage cache froze for the daemon's whole
 * life while the service still looked healthy — the "12h usage-dark" root cause.
 *
 * Now it is a first-class supervised tick: the `ServiceSupervisor` owns the
 * timer, the per-tick deadline, the AbortSignal, and the circuit breaker, so a
 * hung refresh is abandoned (aborted + parked + restarted on backoff) instead of
 * latching. The two refreshes keep their historical cadences — usage every tick
 * ({@link USAGE_STATE_TICK_MS}), auth on the slower {@link AUTH_STATE_TICK_MS} —
 * within one supervised tick, and run concurrently so neither's failure or
 * slowness starves the other.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { runUsageRefreshTick, runFleetCacheWarmTick } from '../daemon-ticks.js';

/** Usage cache refresh cadence — every tick. */
export const USAGE_STATE_TICK_MS = 60_000;
/** Fleet-auth refresh cadence — the slower of the two, gated inside the tick. */
export const AUTH_STATE_TICK_MS = 3 * 60_000;

export interface AccountStateDeps {
  refreshUsage: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  /** Injectable clock for the auth-due gate; defaults to `Date.now`. */
  now?: () => number;
}

export class AccountStateDaemonService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'account-state';
  readonly intervalMs = USAGE_STATE_TICK_MS;
  /**
   * A real refresh sweep across every held account is far under two minutes; a
   * tick that exceeds it is hung, not slow, so the supervisor abandons and
   * restarts it. This is the bound the old un-deadlined loop lacked.
   */
  readonly deadlineMs = 2 * 60_000;

  private readonly deps: AccountStateDeps;
  private lastAuthMs = 0;

  constructor(deps: AccountStateDeps = { refreshUsage: runUsageRefreshTick, refreshAuth: runFleetCacheWarmTick }) {
    super();
    this.deps = deps;
  }

  protected async onStart(): Promise<void> {
    // Force auth to run on the first post-start tick (and after any restart),
    // matching the old service's immediate boot refresh of both areas. A
    // sentinel — not 0 — so the "due" arithmetic holds even when the injected
    // clock is itself near 0 (tests).
    this.lastAuthMs = Number.NEGATIVE_INFINITY;
  }

  protected async onStop(): Promise<void> {
    // No owned resources — the supervisor owns the timer. Nothing to release.
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const authDue = now - this.lastAuthMs >= AUTH_STATE_TICK_MS;
    if (authDue) this.lastAuthMs = now;

    // Run both concurrently so a slow/failing usage refresh never delays or skips
    // the auth refresh (they hit different endpoints). Both share the tick's one
    // deadline + AbortSignal — a hang in either aborts the whole tick, which the
    // supervisor then parks and restarts on backoff.
    const jobs: Array<{ area: 'usage' | 'auth'; run: () => Promise<void> }> = [
      { area: 'usage', run: this.deps.refreshUsage },
    ];
    if (authDue) jobs.push({ area: 'auth', run: this.deps.refreshAuth });

    const results = await Promise.allSettled(jobs.map((j) => j.run()));

    let firstError: unknown;
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        if (firstError === undefined) firstError = result.reason;
        ctx.log('WARN', `${jobs[i].area} state refresh failed: ${(result.reason as Error)?.message ?? String(result.reason)}`);
      }
    });
    // Surface a failure to the supervisor so it accrues consecutiveFailures and
    // the circuit breaker can act on a persistently-failing area; both refreshes
    // still got their attempt this tick regardless.
    if (firstError !== undefined) throw firstError;
    if (signal.aborted) throw new Error('account-state tick aborted at deadline');
  }
}
