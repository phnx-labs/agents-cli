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

/** The shell command a --watch-pid source polls. Portable across the shells `sources/command.ts` invokes (`/bin/sh -c` posix, `cmd /c` Windows). */
export function pidLivenessCommand(pid: number): string {
  return IS_WINDOWS
    ? `tasklist /FI "PID eq ${pid}" 2>NUL | findstr /I "${pid}" >NUL && echo running || echo ${PID_WATCH_EXITED_TOKEN}`
    : `kill -0 ${pid} 2>/dev/null && echo running || echo ${PID_WATCH_EXITED_TOKEN}`;
}
