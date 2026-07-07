// isLeader() gate — real-elector tests (no mocks).
//
// Drives `runOnLeaderOnly` with the ACTUAL `MonitorLeader` elector against a
// real lease file in a temp dir (same style as leader.test.ts). Proves the seam
// migrations #68-71 depend on: heavy work starts when this window is leader and
// is torn down the instant leadership is lost.

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { electLeader, disposeLeader, isLeader } from './leader';
import { runOnLeaderOnly } from './gate';

const dirs: string[] = [];

function tempLeaseFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gate-'));
  dirs.push(dir);
  return path.join(dir, 'monitor-lease.json');
}

afterEach(() => {
  disposeLeader();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('runOnLeaderOnly', () => {
  test('starts immediately when already leader, stops when leadership is lost', () => {
    const leaseFile = tempLeaseFile();
    // Single elector -> wins on the synchronous first tick in start().
    electLeader({
      selfId: 'win-gate',
      pid: process.pid,
      heartbeatMs: 50,
      ttlMs: 150,
      leaseFile,
    });
    expect(isLeader()).toBe(true);

    let started = 0;
    let stopped = 0;
    const gate = runOnLeaderOnly(() => {
      started++;
      return { dispose: () => { stopped++; } };
    });

    // Already leader at wire-up time -> started once, not yet stopped.
    expect(started).toBe(1);
    expect(stopped).toBe(0);

    // Releasing the lease flips leadership to false and tears the work down.
    disposeLeader();
    expect(isLeader()).toBe(false);
    expect(started).toBe(1);
    expect(stopped).toBe(1);

    gate.dispose();
  });

  test('does not start when this window is not the leader', () => {
    const leaseFile = tempLeaseFile();
    // A live peer already holds a valid lease; our elector must not claim it.
    fs.writeFileSync(
      leaseFile,
      JSON.stringify({ leaderId: 'peer', pid: process.pid, expiresAt: Date.now() + 60_000 }),
    );
    electLeader({
      selfId: 'win-loser',
      pid: process.pid,
      heartbeatMs: 50,
      ttlMs: 150,
      leaseFile,
    });
    expect(isLeader()).toBe(false);

    let started = 0;
    const gate = runOnLeaderOnly(() => {
      started++;
      return { dispose: () => {} };
    });
    expect(started).toBe(0);

    gate.dispose();
  });
});
