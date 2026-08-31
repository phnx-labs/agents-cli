/**
 * Account-state services as supervised `PeriodicService`s (PHNX-3608).
 *
 * The daemon owns usage and authentication health as first-party device state.
 * This used to run its OWN two `setInterval` loops behind a `usageRunning` /
 * `authRunning` latch with NO deadline (`account-state-service.ts`, now removed):
 * a `runUsageRefreshTick` that hung on an unbounded provider await latched
 * `usageRunning = true` forever, so the usage cache froze for the daemon's whole
 * life while the service still looked healthy — the "12h usage-dark" root cause.
 *
 * Now usage and auth are TWO independent supervised services, each with its own
 * timer, per-tick deadline, AbortSignal, and — crucially — its own circuit
 * breaker (`AccountUsageService` = `account-state`, `AccountAuthService` =
 * `account-auth`). Keeping them separate means a run of usage-refresh failures
 * parks ONLY usage and never starves the slower auth refresh (they hit different
 * endpoints), matching the old design's independent loops. Each threads its
 * deadline AbortSignal into its refresh so the tick unwinds at the deadline
 * instead of blocking; the provider fetch is itself already bounded
 * (`AbortSignal.timeout` at the leaf), and the supervisor abandons + restarts a
 * hung tick regardless.
 */

import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { runUsageRefreshTick, runFleetCacheWarmTick } from '../daemon-ticks.js';

/** Usage cache refresh cadence. */
export const USAGE_STATE_TICK_MS = 60_000;
/** Fleet-auth refresh cadence — deliberately slower (rate-limited endpoint). */
export const AUTH_STATE_TICK_MS = 3 * 60_000;

/** A hung refresh is abandoned at this deadline; a real sweep is far under it. */
const REFRESH_DEADLINE_MS = 2 * 60_000;

/**
 * A promise that rejects when `signal` aborts (immediately if already aborted),
 * so a tick can `Promise.race` its work against the supervisor's deadline and
 * unwind instead of blocking on an await that may never settle. The signal is
 * per-tick, so the once-listener is dropped with it — no cross-tick leak.
 */
function abortRejection(signal: AbortSignal, label: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) { reject(new Error(label)); return; }
    signal.addEventListener('abort', () => reject(new Error(label)), { once: true });
  });
}

/**
 * Refresh the usage cache the `agents run` router reads. Independent circuit
 * breaker from auth — a persistently-failing usage endpoint parks only this.
 */
export class AccountUsageService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'account-state';
  readonly intervalMs = USAGE_STATE_TICK_MS;
  readonly deadlineMs = REFRESH_DEADLINE_MS;

  private readonly refresh: (signal: AbortSignal) => Promise<void>;

  constructor(refresh: (signal: AbortSignal) => Promise<void> = runUsageRefreshTick) {
    super();
    this.refresh = refresh;
  }

  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(_ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    await Promise.race([
      this.refresh(signal),
      abortRejection(signal, 'usage refresh aborted at deadline'),
    ]);
  }
}

/**
 * Publish this host's fleet-status row and refresh auth health. Independent
 * circuit breaker from usage, and on a slower cadence (the auth verdict rides a
 * rate-limited endpoint).
 */
export class AccountAuthService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'account-auth';
  readonly intervalMs = AUTH_STATE_TICK_MS;
  readonly deadlineMs = REFRESH_DEADLINE_MS;

  private readonly refresh: (signal: AbortSignal) => Promise<void>;

  constructor(refresh: (signal: AbortSignal) => Promise<void> = runFleetCacheWarmTick) {
    super();
    this.refresh = refresh;
  }

  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}

  protected async onTick(_ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    await Promise.race([
      this.refresh(signal),
      abortRejection(signal, 'auth refresh aborted at deadline'),
    ]);
  }
}
