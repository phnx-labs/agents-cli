import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readDoctorOverviewCache,
  writeDoctorOverviewCache,
  enterDoctorOverviewGate,
  DOCTOR_OVERVIEW_FRESH_MS,
} from './doctor-overview-cache.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-overview-cache-'));
}

const LOCK = '.doctor-overview.lock';

describe('doctor-overview-cache: read/write roundtrip', () => {
  it('writes then reads back the payload with a fresh fetchedAt', () => {
    const dir = tmpDir();
    writeDoctorOverviewCache({ clis: { claude: { installed: true } } }, { dir, now: () => 1000 });
    const got = readDoctorOverviewCache({ dir });
    expect(got).not.toBeNull();
    expect(got!.fetchedAt).toBe(1000);
    expect(got!.payload).toEqual({ clis: { claude: { installed: true } } });
  });

  it('returns null for a missing or corrupt cache file', () => {
    const dir = tmpDir();
    expect(readDoctorOverviewCache({ dir })).toBeNull();
    fs.writeFileSync(path.join(dir, '.doctor-overview.json'), '{ not json');
    expect(readDoctorOverviewCache({ dir })).toBeNull();
  });
});

describe('doctor-overview-cache: gate fast path (fresh snapshot)', () => {
  it('serves a fresh snapshot with no compute token and no lock', async () => {
    const dir = tmpDir();
    writeDoctorOverviewCache({ hello: 'world' }, { dir, now: () => 10_000 });
    // 20s later — well within the freshness window.
    const gate = await enterDoctorOverviewGate({}, { dir, now: () => 30_000 });
    expect(gate.cached).not.toBeNull();
    expect(gate.release).toBeUndefined();
    expect(JSON.parse(gate.cached!)).toEqual({ hello: 'world' });
    // A served fast-path read must not have created the singleflight lock.
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(false);
  });

  it('does NOT serve a snapshot older than the freshness window', async () => {
    const dir = tmpDir();
    writeDoctorOverviewCache({ hello: 'stale' }, { dir, now: () => 0 });
    // Past the freshness window → must take the compute token, not serve.
    const gate = await enterDoctorOverviewGate({}, { dir, now: () => DOCTOR_OVERVIEW_FRESH_MS + 1 });
    expect(gate.cached).toBeNull();
    expect(gate.release).toBeTypeOf('function');
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(true);
    gate.release!();
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(false);
  });
});

describe('doctor-overview-cache: singleflight coalescing (the bug fix)', () => {
  it('hands exactly one compute token to concurrent callers; the rest serve the winner', async () => {
    const dir = tmpDir();

    // Caller A wins the race and holds the lock (no fresh cache yet).
    const a = await enterDoctorOverviewGate({}, { dir });
    expect(a.cached).toBeNull();
    expect(a.release).toBeTypeOf('function');
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(true);

    // Caller B starts while A still holds the lock. B must NOT get a second
    // compute token — it waits, and once A writes + releases, B serves A's
    // result. We drive A's "finish" from inside B's first poll so the wait
    // path is exercised deterministically without real timers.
    let polls = 0;
    const bPromise = enterDoctorOverviewGate(
      {},
      {
        dir,
        sleep: async () => {
          polls += 1;
          if (polls === 1) {
            writeDoctorOverviewCache({ computedBy: 'A' }, { dir });
            a.release!();
          }
        },
      },
    );

    const b = await bPromise;
    // The whole point: B coalesced onto A's compute — it got a result, not a token.
    expect(b.release).toBeUndefined();
    expect(b.cached).not.toBeNull();
    expect(JSON.parse(b.cached!)).toEqual({ computedBy: 'A' });
    expect(polls).toBeGreaterThanOrEqual(1);
  });
});

describe('doctor-overview-cache: robustness', () => {
  it('forceRefresh ignores a fresh snapshot and takes the compute token', async () => {
    const dir = tmpDir();
    writeDoctorOverviewCache({ hello: 'fresh' }, { dir, now: () => 1000 });
    const gate = await enterDoctorOverviewGate({ forceRefresh: true }, { dir, now: () => 1001 });
    expect(gate.cached).toBeNull();
    expect(gate.release).toBeTypeOf('function');
    gate.release!();
  });

  it('steals a lock whose directory mtime has gone stale', async () => {
    const dir = tmpDir();
    // Simulate an abandoned lock: a real lock dir created "now", observed from a
    // clock far enough in the future that its mtime reads as stale.
    fs.mkdirSync(path.join(dir, LOCK));
    const realMtime = fs.statSync(path.join(dir, LOCK)).mtimeMs;
    const gate = await enterDoctorOverviewGate(
      {},
      { dir, now: () => realMtime + 10 * 60_000 }, // 10 min later — well past stale
    );
    // Stealing means we become the computer (fresh token), not a waiter.
    expect(gate.cached).toBeNull();
    expect(gate.release).toBeTypeOf('function');
    gate.release!();
  });
});
