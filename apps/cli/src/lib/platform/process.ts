/**
 * Process liveness / control, platform-aware.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { sleepSync } from '../fs-atomic.js';

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
/** Poll interval while waiting for a pid to disappear. */
const EXIT_POLL_MS = 50;

/**
 * Whether `pid` has stopped serving — dead, or a ZOMBIE awaiting reap.
 *
 * `isAlive` is a bare `kill(pid, 0)`, which succeeds for a zombie. That matters
 * here because {@link waitForExit} blocks the event loop, so a daemon that is
 * this process's own child can never be reaped while we wait: it would read as
 * alive for the entire timeout and then be hard-killed after it had already
 * exited. A zombie holds no socket and serves no request, so for stop purposes
 * it has exited.
 */
export function hasExited(pid: number): boolean {
  if (!isAlive(pid)) return true;
  if (process.platform === 'win32') return false; // no zombie state to unwrap
  try {
    const state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    return state.startsWith('Z');
  } catch (err: any) {
    // `ps` exiting non-zero because the pid is unknown means gone. Any OTHER
    // failure (ps missing from PATH, a permission error) is NOT evidence of
    // death, and isAlive already said this pid is live — so fail CLOSED and keep
    // treating it as alive. Failing open here would clear the pid file under a
    // running daemon and recreate this very bug through a different door.
    if (err?.code === 'ENOENT' && err?.syscall === 'spawnSync ps') return false;
    const out = String(err?.stdout ?? '').trim();
    const errOut = String(err?.stderr ?? '').trim();
    if (err?.status === 1 && out === '' && errOut === '') return true; // no such pid
    return false;
  }
}

/**
 * Block until `pid` stops serving or `timeoutMs` elapses. Synchronous on purpose:
 * the callers are short-lived CLI/postinstall processes that exit before any
 * async timer would fire, which is exactly how a SIGTERMed daemon used to outlive
 * the `stopDaemon()` that was supposed to have reaped it. Returns true if it is
 * gone.
 */
export function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hasExited(pid)) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(EXIT_POLL_MS); // blocks this thread outright; no busy-loop
  }
}

export function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Memoized per pid: a process's start time cannot change while it lives, and a
 *  recycled pid is precisely what the caller is trying to detect — so a stale
 *  hit still compares unequal against the recorded value. Bounded by the pids a
 *  single CLI invocation asks about. */
const startTimeByPid = new Map<number, string | null>();

/**
 * A stable identifier for the process at `pid` as of when it started, or null if
 * unknowable. Used to defeat PID reuse: acting on a pid is only safe when the
 * process still occupies the slot we observed earlier. The value is only ever
 * compared for equality against an earlier capture of the SAME pid, so the format
 * need only be stable, not parseable.
 *
 * Linux:   field 22 of /proc/<pid>/stat (starttime in clock ticks since boot).
 * macOS:   `ps -o lstart= -p <pid>`.
 * Windows: CreationDate from Win32_Process, as a culture-independent FILETIME.
 *
 * This is the single source of truth. `pty-server.ts` and `teams/agents.ts` each
 * carried their own copy; the Windows branch was missing from both, so every
 * caller there silently ran with NO pid-reuse protection — including
 * `agents teams stop`, which is how it could SIGKILL an unrelated process group.
 */
export function captureProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cached = startTimeByPid.get(pid);
  if (cached !== undefined) return cached;
  const value = readProcessStartTime(pid);
  startTimeByPid.set(pid, value);
  return value;
}

function readProcessStartTime(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      // ToFileTimeUtc() rather than the raw DateTime: the default string form is
      // rendered in the current culture, so a persisted fingerprint would stop
      // comparing equal across a locale change.
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToFileTimeUtc()`,
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 },
      );
      const trimmed = out.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // The comm field (#2) is parenthesized and may contain spaces, so split
      // off everything after the last ')' to get a clean field list.
      const lastParen = stat.lastIndexOf(')');
      if (lastParen < 0) return null;
      const fields = stat.slice(lastParen + 2).split(' ');
      // After comm we are at field 3; starttime is field 22, so index 19 here.
      return fields[19] || null;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
