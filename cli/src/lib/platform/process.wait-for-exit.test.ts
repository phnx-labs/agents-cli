/**
 * `stopDaemon` used to SIGTERM the daemon, schedule a `setTimeout` escalation,
 * and clear the pid file immediately. Two failure modes fell out of that: in a
 * short-lived process (the npm postinstall) the timer never fired at all, and
 * clearing the pid file while the old daemon still ran made `isDaemonRunning()`
 * report false, so `startDaemon()` launched a SECOND daemon. Its hosted broker
 * then unlinked the live socket and rebound, orphaning the first broker with
 * every unlocked bundle still in RAM and unreachable.
 *
 * These drive REAL child processes — the point is that the wait is synchronous
 * and actually observes the exit, which a fake clock cannot demonstrate.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { waitForExit, hasExited, isAlive } from './index.js';


function spawnSleeper(seconds: number) {
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${seconds * 1000})`], {
    stdio: 'ignore',
  });
  return child;
}

// POSIX signal semantics. On Windows `process.kill(pid, 'SIGTERM')` maps to
// TerminateProcess, which kills unconditionally — a process cannot decline it —
// and there is no zombie state for hasExited to unwrap. stopDaemon takes the
// win32 killTree branch before waitForExit is ever reached there.
describe.skipIf(process.platform === 'win32')('waitForExit — the wait stopDaemon relies on', () => {
  it('returns true once a SIGTERMed process is actually gone', () => {
    const child = spawnSleeper(30);
    expect(isAlive(child.pid!)).toBe(true);
    process.kill(child.pid!, 'SIGTERM');
    const exited = waitForExit(child.pid!, 5000);
    expect(exited).toBe(true);
    expect(hasExited(child.pid!)).toBe(true);
  });

  it('reports false for a process that ignores SIGTERM, so the caller escalates', async () => {
    // Traps SIGTERM and keeps running — the case the old code silently mistook
    // for a clean stop, leaving two daemons alive. The child announces itself
    // first: signalling before its handler is installed would just kill it and
    // the test would pass for the wrong reason.
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 30000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    process.kill(child.pid!, 'SIGTERM');
    const exited = waitForExit(child.pid!, 300);
    expect(exited).toBe(false);
    expect(hasExited(child.pid!)).toBe(false);
    process.kill(child.pid!, 'SIGKILL'); // clean up the test's own child
    expect(waitForExit(child.pid!, 5000)).toBe(true);
  });

  it('returns immediately for a pid that is already gone', () => {
    const child = spawnSleeper(30);
    const pid = child.pid!;
    process.kill(pid, 'SIGKILL');
    waitForExit(pid, 5000);
    const started = Date.now();
    expect(waitForExit(pid, 5000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500); // no needless blocking
  });
});
