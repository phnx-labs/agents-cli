/**
 * Auto-sync this device's just-finished session trace when a local, headless
 * `agents run` exits (PHNX-3628).
 *
 * Why exit-armed + spawn, exactly like `run-notify`: the sync reads this
 * device's `sessions.db` and PUTs redacted shards over the network — async work
 * that CANNOT run inside a `process.on('exit')` handler (Node runs no more
 * microtasks after exit). So, mirroring `notifyDesktop`, on exit we SPAWN a
 * detached `agents traces sync` and unref it; it finishes after the parent is
 * gone, and the run itself returns immediately instead of waiting on the PUTs.
 *
 * The upload is incremental by construction (`syncTraces` de-dups by the
 * `traces-sync.json` mtime watermark), so the spawned sync pushes essentially
 * just the session that finished, not the whole history.
 *
 * Default policy: fire ONLY when the user has ALREADY opted into the traces
 * store — i.e. they are signed in AND have run `agents traces sync` at least
 * once (`hasSyncedBefore`). A user who never synced is never touched. Opt out
 * of a given run with `--no-trace-sync` or `AGENTS_NO_TRACE_SYNC=1`.
 *
 * Local runs only: a `--device` / `--lease` / `--cloud` session's trajectory
 * lives on the REMOTE box, not this device's `sessions.db`, so arming here would
 * upload nothing useful. The caller gates those out before arming.
 */
import { spawn } from 'child_process';

import { readSession } from './identity/client.js';
import { hasSyncedBefore } from './traces/sync.js';

/** A stalled sync is hard-killed after this; a normal incremental sync is quick. */
const TRACE_SYNC_TIMEOUT_MS = 120_000;

/**
 * The policy gate, pure and unit-testable. `disabled` is the resolved
 * `--no-trace-sync` (commander maps it to `traceSync === false`).
 */
export function shouldAutoSyncTraces(disabled: boolean): boolean {
  if (disabled) return false;
  if (process.env.AGENTS_NO_TRACE_SYNC === '1') return false;
  if (!readSession()) return false; // not signed in → nothing to authenticate an upload
  if (!hasSyncedBefore()) return false; // never opted into the traces store
  return true;
}

/**
 * Arm a fire-and-forget `agents traces sync` for when this process exits.
 * No-op unless {@link shouldAutoSyncTraces} passes. Best-effort by
 * construction: a missing binary or a stalled child never affects the run.
 */
export function armRunFinishTraceSync(opts: { disabled?: boolean } = {}): void {
  if (!shouldAutoSyncTraces(!!opts.disabled)) return;

  process.on('exit', () => {
    try {
      // Re-invoke the same CLI entrypoint the user launched, so version pinning
      // and shims resolve exactly as they did for `agents run`.
      const child = spawn(process.execPath, [process.argv[1]!, 'traces', 'sync'], {
        detached: true,
        stdio: 'ignore',
      });
      // A child that never starts (ENOENT) emits an async 'error'; without a
      // listener Node re-throws it as uncaught. Swallow — this is best-effort.
      child.on('error', () => {});
      const watchdog = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, TRACE_SYNC_TIMEOUT_MS);
      watchdog.unref();
      child.unref();
    } catch {
      // A synchronous spawn failure must never change the run's exit outcome.
    }
  });
}
