/**
 * `agents daemon status` process-uptime probe (PHNX-3289).
 *
 * Regression: `uptimeSeconds` shelled `ps -o etimes=` — a GNU/procps keyword
 * that macOS/BSD `ps` rejects with `ps: etimes: keyword not found` and a
 * non-zero exit, so `execFileSync` threw and `agents daemon status` errored out
 * on macOS. This exercises the real `ps` invocation against a live pid (no
 * mocking) and asserts a plausible elapsed time comes back on every POSIX
 * platform — which the old `etimes=` keyword could not deliver on macOS.
 */
import { describe, it, expect } from 'vitest';
import { uptimeSeconds } from './daemon.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('uptimeSeconds', () => {
  it('returns a non-negative elapsed time for a live pid via portable `ps -o etime=`', () => {
    const secs = uptimeSeconds(process.pid);
    expect(secs).not.toBeNull();
    expect(typeof secs).toBe('number');
    expect(secs as number).toBeGreaterThanOrEqual(0);
    // This process has not been running for a year; a sane ceiling catches a
    // parser that mis-scales the `[[dd-]hh:]mm:ss` fields.
    expect(secs as number).toBeLessThan(365 * 24 * 3600);
  });

  it('returns null for a pid that does not exist', () => {
    // 2^31-ish: high enough to be unallocated on the test host.
    expect(uptimeSeconds(2_147_483_646)).toBeNull();
  });
});

describe('uptimeSeconds on Windows', () => {
  it.skipIf(process.platform !== 'win32')('returns null (ps is POSIX-only)', () => {
    expect(uptimeSeconds(process.pid)).toBeNull();
  });
});
