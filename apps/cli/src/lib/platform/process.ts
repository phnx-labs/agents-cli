/**
 * Process liveness / control, platform-aware.
 */
import { execFileSync } from 'child_process';

/**
 * Forcefully terminate a process AND its descendant tree.
 *
 * Windows: `taskkill /F /T /PID` — the only reliable way to take down the whole
 * tree (a bare TerminateProcess leaves children orphaned, which is exactly the
 * "stop reported success but the tree is still alive" bug). POSIX: SIGKILL to the
 * pid (matching the existing hard-kill behavior; callers that own a process group
 * can pass the negative pid). Best-effort — never throws; an already-exited
 * process counts as success.
 */
export function killTree(pid: number): void {
  if (!pid || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch { /* already gone, or no such pid */ }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
}

/**
 * Spawn options for a long-lived background child (daemon, detached worker,
 * sidecar server, fire-and-forget job).
 *
 * POSIX: `detached: true` — the child leads its own process group, so it
 * survives the parent and group kills (`kill(-pid)`) still reach it.
 *
 * Windows: the child must not share the launcher's console (a console-close
 * event when the launcher exits would tear it down, #556) and must not flash
 * a window. How to get there depends on the child's stdio:
 *
 * - All stdio non-inherited ('ignore'/'pipe'): `windowsHide: true`, NOT
 *   detached. CREATE_NO_WINDOW gives the child its own hidden console that
 *   every console-subsystem descendant (powershell, git, a .cmd shim's cmd.exe
 *   wrapper) inherits — no window anywhere down the tree. `detached` would
 *   defeat it: DETACHED_PROCESS makes CreateProcess ignore CREATE_NO_WINDOW.
 *
 * - Any stdio slot redirected to an fd (log files — `fdStdio: true`): libuv
 *   skips CREATE_NO_WINDOW whenever a stdio fd is inherited, so windowsHide
 *   cannot engage and a non-detached child would share the launcher's console
 *   and die with it. Keep DETACHED_PROCESS: the child runs console-less and
 *   windowless; its console-tool spawns stay invisible because the leaf call
 *   sites pass their own `windowsHide` with piped stdio.
 */
export function backgroundSpawnOptions(
  opts: { fdStdio?: boolean; platform?: NodeJS.Platform } = {},
): { detached: boolean; windowsHide: boolean } {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    return opts.fdStdio
      ? { detached: true, windowsHide: true }
      : { detached: false, windowsHide: true };
  }
  return { detached: true, windowsHide: false };
}

/**
 * Is a process with this PID currently alive?
 *
 * Uses the signal-0 probe, which is cross-platform in Node (Windows included —
 * it maps to OpenProcess). Returns false on any error (no such process, or no
 * permission to signal it), matching the long-standing call sites that treat a
 * throw from `process.kill(pid, 0)` as "not running".
 */
export function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
