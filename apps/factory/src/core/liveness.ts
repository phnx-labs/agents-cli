/**
 * Canonical process-liveness check, shared across modules that key work by
 * OS pid (foreman registry, monitor lease, …).
 *
 * `process.kill(pid, 0)` sends no signal — it only probes whether the pid is
 * deliverable:
 *   - resolves          -> process exists and we own it (alive)
 *   - throws ESRCH      -> no such process (dead)
 *   - throws EPERM      -> process exists but owned by another user (alive)
 *
 * Lives in /core (no vscode dep) so it can be reused from pure modules and
 * unit-tested with real pids in plain subprocesses.
 */
export function isPidAlive(pid: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}
