/**
 * `--watch-pid` support — turns a backgrounded OS process into a durable,
 * daemon-polled watcher instead of relying on a harness's own exit hook
 * (PHNX-3023: a "will re-invoke me" background shell never fires when the
 * harness only notifies on process exit and the watch loop itself never
 * exits — `gh pr checks --watch`, a long sleep, a tick poll).
 *
 * The command built here reuses the same existence-check predicate
 * `isPidAlive`'s existence branch uses (`process.kill(pid, 0)`), but it runs
 * inside the monitor engine's own poll loop (`sources/command.ts`) rather than
 * the caller's process — so the check survives past the CLI invocation that
 * armed it.
 */

import { IS_WINDOWS } from '../platform/index.js';

/** The token a --watch-pid source's condition matches on process exit. */
export const PID_WATCH_EXITED_TOKEN = 'exited';
/** Emitted while the pid is alive. */
export const PID_WATCH_RUNNING_TOKEN = 'running';
/**
 * Emitted when the pid is not alive AND has never been observed alive — the
 * `--force` not-yet-spawned case. Deliberately distinct from
 * {@link PID_WATCH_EXITED_TOKEN} so it can never match the exit condition.
 */
export const PID_WATCH_NOT_YET_SPAWNED_TOKEN = 'notyetspawned';

/**
 * The shell command a --watch-pid source polls. A poll only reports "exited"
 * once it has FIRST observed the pid running — tracked with a marker file the
 * command touches on every "running" poll — otherwise a `--force`-armed watch
 * on a not-yet-spawned pid would report "exited" on its very first poll (the
 * pid doesn't exist *yet*, not *anymore*), which the engine's match-mode
 * fires immediately (no prior state to diff against) and then persists as the
 * baseline — silencing the real exit forever once the process actually spawns
 * and later dies. Portable across the shells `sources/command.ts` invokes
 * (`/bin/sh -c` posix, `cmd /c` Windows).
 */
export function pidLivenessCommand(pid: number, seenRunningMarkerPath: string): string {
  if (IS_WINDOWS) {
    return (
      `tasklist /FI "PID eq ${pid}" 2>NUL | findstr /I "${pid}" >NUL ` +
      `&& (type nul > "${seenRunningMarkerPath}" & echo ${PID_WATCH_RUNNING_TOKEN}) ` +
      `|| (if exist "${seenRunningMarkerPath}" (echo ${PID_WATCH_EXITED_TOKEN}) else (echo ${PID_WATCH_NOT_YET_SPAWNED_TOKEN}))`
    );
  }
  return (
    `kill -0 ${pid} 2>/dev/null ` +
    `&& { mkdir -p "$(dirname "${seenRunningMarkerPath}")" 2>/dev/null; : > "${seenRunningMarkerPath}"; echo ${PID_WATCH_RUNNING_TOKEN}; } ` +
    `|| { [ -e "${seenRunningMarkerPath}" ] && echo ${PID_WATCH_EXITED_TOKEN} || echo ${PID_WATCH_NOT_YET_SPAWNED_TOKEN}; }`
  );
}
