/**
 * Daemon harness-update service (PHNX-3940).
 *
 * Runs the automatic-update pass (`installations/update-runtime.ts`) on a
 * schedule so a managed, transactional npm harness (Claude, Codex, …) stays
 * current with no operator action, subject to the `updates.auto` /
 * `updates.<agent>.auto` switches and each installation's own update policy.
 *
 * The pass itself does real, synchronous filesystem work per installation —
 * staging an npm install into a sibling directory, `fs.renameSync`/`fs.cpSync`
 * swaps, `fs.rmSync` cleanup — potentially across several installations in one
 * tick. Running that inline on the daemon's own event loop would stall every
 * other service (secrets broker, browser IPC, the scheduler) for the
 * duration, the same class of problem `self-update-service.ts` solves for the
 * CLI's OWN upgrade by installing into a fresh process it then exits into.
 * Here there is no "exit and let the supervisor restart" option (the daemon
 * itself isn't what's being updated), so instead this tick SPAWNS a bounded,
 * abort-safe child `agents update --auto --json` and only waits on that child
 * — every sync fs call happens in the child's own event loop / thread pool,
 * never this one.
 */

import { execFile } from 'child_process';
import { BasePeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';
import { getCliLaunch, getAgentsBinPath } from '../cli-entry.js';

/** Runs every 15 minutes — a design decision, not an externally-fixed cadence (PHNX-3940). */
const HARNESS_UPDATE_TICK_MS = 15 * 60_000;
/**
 * Hard cap per tick. A real pass can touch several installations, each an npm
 * install (`INSTALL_TIMEOUT_MS` = 120s in strategies.ts) plus two launch
 * probes; 10 minutes leaves headroom for a handful of harnesses in one pass
 * while staying comfortably under the 15-minute cadence above.
 */
export const HARNESS_UPDATE_DEADLINE_MS = 10 * 60_000;
/** First tick fires 60 seconds after daemon boot — long enough for shims/PATH to settle, short enough that a fresh box doesn't wait a full interval for its first check. */
const HARNESS_UPDATE_STARTUP_DELAY_MS = 60_000;

export interface HarnessUpdateOutcome {
  ran: boolean;
  reason?: string;
  exitCode?: number | null;
  stdout?: string;
}

/**
 * Dependency seam so tests can assert the tick's decision/spawn logic without
 * actually installing anything. Production always uses
 * {@link defaultHarnessUpdateDeps}.
 */
export interface HarnessUpdateDeps {
  runAutoUpdatePass(signal: AbortSignal): Promise<{ exitCode: number | null; stdout: string }>;
}

export function defaultHarnessUpdateDeps(): HarnessUpdateDeps {
  return {
    runAutoUpdatePass(signal) {
      const { command, args } = getCliLaunch(['update', '--auto', '--json'], getAgentsBinPath());
      return new Promise((resolve, reject) => {
        execFile(
          command,
          args,
          { timeout: HARNESS_UPDATE_DEADLINE_MS, signal, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => {
            // execFile rejects on a non-zero exit — the pass reports per-
            // installation failures inside its own JSON and only exits non-zero
            // when at least one installation errored, which is a normal outcome
            // for this tick (log it, don't throw the service into its own
            // failure/backoff path over one harness's bad release). A spawn
            // failure (missing binary) or an abort/timeout kill is a genuine
            // service failure and must reject, not be read as a clean exit 0.
            if (err) {
              const typed = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
              if (typed.killed || typeof typed.code !== 'number') {
                reject(err);
                return;
              }
              resolve({ exitCode: typed.code, stdout: stdout ?? '' });
              return;
            }
            resolve({ exitCode: 0, stdout: stdout ?? '' });
          },
        );
      });
    },
  };
}

/**
 * Core decision + spawn, shared so a future on-demand trigger (mirroring
 * `triggerSelfUpdateInBackground`) can reuse it. Returns rather than throws —
 * the periodic tick logs the outcome and moves on either way.
 */
export async function runHarnessUpdateTick(
  ctx: DaemonContext,
  signal: AbortSignal,
  deps: HarnessUpdateDeps = defaultHarnessUpdateDeps(),
): Promise<HarnessUpdateOutcome> {
  try {
    const { exitCode, stdout } = await deps.runAutoUpdatePass(signal);
    if (exitCode !== 0) {
      ctx.log('WARN', `harness-update: pass exited ${exitCode} — see stdout for per-installation errors: ${stdout.slice(0, 2000)}`);
    } else {
      ctx.log('INFO', 'harness-update: pass completed');
    }
    return { ran: true, exitCode, stdout };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log('ERROR', `harness-update: pass failed to run: ${message}`);
    return { ran: false, reason: message };
  }
}

export class HarnessUpdateService extends BasePeriodicService {
  readonly id: DaemonServiceId = 'harness-update';
  readonly intervalMs = HARNESS_UPDATE_TICK_MS;
  readonly deadlineMs = HARNESS_UPDATE_DEADLINE_MS;
  readonly startupDelayMs = HARNESS_UPDATE_STARTUP_DELAY_MS;

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    // No connections/handles to open — each tick spawns its own bounded child.
  }

  protected async onStop(): Promise<void> {
    // The in-flight child (if any) is killed by the supervisor aborting `signal`
    // on the current tick; nothing else to release here.
  }

  protected async onTick(ctx: DaemonContext, signal: AbortSignal): Promise<void> {
    await runHarnessUpdateTick(ctx, signal);
  }
}
