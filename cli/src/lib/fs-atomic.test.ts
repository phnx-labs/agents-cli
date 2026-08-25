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
import { withFileLock, ensureLockTarget, sleepSync, atomicWriteJsonSync } from './fs-atomic.js';

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

/**
 * RUSH-2840: `atomicWriteJsonSync` is the JSON convenience wrapper around
 * `atomicWriteFileSync` -- six independent private/inline copies of this
 * write-tmp-then-rename-JSON pattern were consolidated to call it instead of
 * reinventing the primitive. These tests pin its atomicity guarantee (which
 * it inherits from `atomicWriteFileSync`) against the real filesystem, and
 * are deliberately discriminating: they fail against a naive, non-atomic
 * `writeFileSync(target, ...)` mutant.
 */
describe('atomicWriteJsonSync()', () => {
  function tmpBase(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-atomic-json-'));
  }

  it('round-trips data as pretty-printed JSON', () => {
    const dir = tmpBase();
    try {
      const target = path.join(dir, 'file.json');
      atomicWriteJsonSync(target, { a: 1, b: [2, 3] });
      expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ a: 1, b: [2, 3] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no stray tmp file behind on a normal, uninterrupted write', () => {
    const dir = tmpBase();
    try {
      atomicWriteJsonSync(path.join(dir, 'file.json'), { v: 1 });
      expect(fs.readdirSync(dir)).toEqual(['file.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Only a NEW-file create can be blocked by directory permissions; renaming
  // over an already-existing file's directory entry is not (the rename needs
  // write access in the DIRECTORY, not the target file, but making the tmp
  // file impossible to CREATE blocks the write before rename is ever
  // reached). chmod is a no-op on Windows and root bypasses the permission
  // check entirely, so this is skipped where the mechanism cannot hold.
  const canBlockFileCreate =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  const itBlocksCreate = canBlockFileCreate ? it : it.skip;

  itBlocksCreate(
    'a write that fails leaves the destination with its previous valid content, and no tmp file behind',
    () => {
      const dir = tmpBase();
      try {
        const target = path.join(dir, 'registry.json');
        atomicWriteJsonSync(target, { version: 1 });
        const before = fs.readFileSync(target, 'utf-8');
        expect(JSON.parse(before)).toEqual({ version: 1 });

        // Block creation of the sibling tmp file by making the directory
        // read-only. This drives the REAL writer into a failure at its very
        // first fs call (the tmp-file create) instead of planting a decoy
        // file it never touches -- a bare `writeFileSync(target, ...)` would
        // still SUCCEED here, since `target` already exists and stays
        // writable regardless of the directory's permissions. That asymmetry
        // is what makes this test discriminating against a non-atomic mutant.
        fs.chmodSync(dir, 0o555);
        try {
          expect(() => atomicWriteJsonSync(target, { version: 2 })).toThrow();

          const after = fs.readFileSync(target, 'utf-8');
          expect(after).toBe(before);
          expect(JSON.parse(after)).toEqual({ version: 1 });
        } finally {
          fs.chmodSync(dir, 0o755);
        }

        expect(fs.readdirSync(dir)).toEqual(['registry.json']);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
