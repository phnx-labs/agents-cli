/**
 * Tests for the cross-process file lock's synchronous heartbeat (RUSH-1975).
 *
 * proper-lockfile keeps a held lock alive by refreshing its lockfile mtime on a
 * setTimeout every `stale/2` — but that timer only fires when the event loop gets a
 * turn, so a fully synchronous critical section that outlives the stale window (the
 * scrypt-bound secrets rotation) would age past `stale` mid-hold and a peer could
 * break the lock as "stale" and interleave. `withFileLock` hands `fn` a `heartbeat()`
 * that bumps the lockfile mtime synchronously to close that window.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { withFileLock, ensureLockTarget, sleepSync } from './fs-atomic.js';

/**
 * proper-lockfile silently raises any `stale` below this floor:
 *   node_modules/proper-lockfile/lib/lockfile.js:219 (and :304)
 *     options.stale = Math.max(options.stale || 0, 2000);
 *
 * Every stale window in this file MUST sit above it. A test written with
 * `stale: 50` does not test a 50ms window — it tests a 2000ms one, so a hold
 * shorter than 2s blocks a peer whether or not the heartbeat does anything,
 * and the test passes against a no-op heartbeat.
 */
const PROPER_LOCKFILE_MIN_STALE_MS = 2_000;
const STALE_MS = PROPER_LOCKFILE_MIN_STALE_MS + 500;
/** Long enough that an un-refreshed lock is comfortably past STALE_MS. */
const HOLD_MS = STALE_MS + 1_500;

/** Hold the lock for HOLD_MS, optionally heartbeating, and report what a peer saw. */
function peerVerdictAfterSyncHold(beat: ((heartbeat: () => void) => void) | null): 'stole' | 'blocked' {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-hb-'));
  const target = path.join(dir, 'target');
  ensureLockTarget(target);
  try {
    let verdict: 'stole' | 'blocked' = 'blocked';
    try {
      withFileLock(target, (heartbeat) => {
        // A fully synchronous hold: sleepSync blocks the event loop, so
        // proper-lockfile's own setTimeout-based refresher never gets a turn.
        // The only thing that can keep the lock fresh is the sync heartbeat.
        const deadline = Date.now() + HOLD_MS;
        while (Date.now() < deadline) {
          if (beat) beat(heartbeat);
          sleepSync(250);
        }
        try {
          const release = lockfile.lockSync(target, { stale: STALE_MS });
          release();
          verdict = 'stole';
        } catch {
          verdict = 'blocked';
        }
      }, { staleMs: STALE_MS, acquireTimeoutMs: 100 });
    } catch (err) {
      // A stolen lock now surfaces synchronously as a "broken by another process"
      // error instead of proper-lockfile crashing the process from its refresh
      // timer. That only happens in the stolen case, so it corroborates the
      // verdict rather than being an error to hide.
      if (!/was broken by another process/.test((err as Error).message)) throw err;
      expect(verdict).toBe('stole');
    }
    return verdict;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('withFileLock heartbeat', () => {
  it('pins the proper-lockfile stale floor these tests depend on', () => {
    // If a dependency bump changes this floor, the windows below stop meaning
    // what they say and the heartbeat tests silently go vacuous. Fail loudly here
    // instead: a sub-floor stale must NOT be honoured.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-floor-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    try {
      const release = lockfile.lockSync(target, { stale: 50 });
      // Age well past the *requested* 50ms but far short of the 2000ms floor.
      sleepSync(400);
      let peerSawStale = false;
      try { lockfile.lockSync(target, { stale: 50 })(); peerSawStale = true; } catch { /* held */ }
      release();
      expect(peerSawStale).toBe(false);
      expect(STALE_MS).toBeGreaterThan(PROPER_LOCKFILE_MIN_STALE_MS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a synchronous hold that outlives the stale window stays un-stealable when it heartbeats', () => {
    expect(peerVerdictAfterSyncHold((heartbeat) => heartbeat())).toBe('blocked');
  });

  it('the same hold IS stolen without the heartbeat — proving the test can fail', () => {
    // Negative control. Without this, the assertion above passes against a no-op
    // heartbeat and proves nothing about the data-loss window it guards.
    expect(peerVerdictAfterSyncHold(null)).toBe('stole');
  });

  it('a short hold needs no heartbeat — the lock is held for the whole critical section', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-short-'));
    const target = path.join(dir, 'target');
    ensureLockTarget(target);
    try {
      let blocked = false;
      withFileLock(target, () => {
        // A single fast read-modify-write, well inside the stale window: a peer must
        // find the lock held even though this callback never touches the heartbeat.
        try { const release = lockfile.lockSync(target, { stale: 5_000 }); release(); }
        catch { blocked = true; }
      });
      expect(blocked).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
