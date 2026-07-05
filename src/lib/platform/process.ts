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
 * Windows: `windowsHide: true` and NOT detached. `detached` maps to
 * DETACHED_PROCESS, under which CreateProcess ignores CREATE_NO_WINDOW and the
 * child runs console-less — every console-subsystem descendant (powershell,
 * git, node, a .cmd shim's cmd.exe wrapper) then allocates its own VISIBLE
 * console window, flashing on the user's desktop. CREATE_NO_WINDOW alone gives
 * the child its own hidden console instead: descendants inherit it (no window
 * anywhere down the tree), and a console-close event from the launcher's
 * console can never reach the child (#556), which is all `detached` bought us
 * on Windows.
 */
export function backgroundSpawnOptions(
  platform: NodeJS.Platform = process.platform,
): { detached: boolean; windowsHide: boolean } {
  if (platform === 'win32') return { detached: false, windowsHide: true };
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
