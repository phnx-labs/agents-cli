/**
 * Leader election — real-process end-to-end tests (no mocks).
 *
 * Mirrors `src/core/foreman.windowId.test.ts`: spawns real child processes
 * (each one a stand-in for an IDE window's extension host) that run the ACTUAL
 * `MonitorLeader` against a shared lease file in a temp dir. We then assert the
 * two acceptance criteria from issue #65:
 *
 *   1. With K windows open, exactly ONE reports isLeader === true at all times.
 *   2. Killing the leader => another claims within one heartbeat interval.
 *
 * Each window's identity is `computeWindowId(sharedSessionId, pid)` — the exact
 * VSCodium scenario where every window reports the same sessionId and only the
 * pid disambiguates. No mocks: distinct OS processes with distinct pids.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { canClaim, readLease, writeLease, releaseLease, type MonitorLease } from './lease';
import { isPidAlive } from '../core/liveness';

const LEADER_SRC = path.resolve(__dirname, 'leader.ts');
const WINDOWID_SRC = path.resolve(__dirname, '../core/foreman.windowId.ts');
const DEAD_PID = 2_147_483_000; // implausibly high pid -> ESRCH on kill(pid,0)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('canClaim — the pure takeover decision', () => {
  test('no lease yet -> bootstrap claim', () => {
    expect(canClaim(undefined, 'win-1', 1000)).toBe(true);
  });

  test('lease already ours -> renew', () => {
    const lease: MonitorLease = { leaderId: 'win-1', pid: process.pid, expiresAt: 5000 };
    expect(canClaim(lease, 'win-1', 1000)).toBe(true);
  });

  test('valid lease held by someone else -> no claim', () => {
    const lease: MonitorLease = { leaderId: 'win-2', pid: process.pid, expiresAt: 5000 };
    expect(canClaim(lease, 'win-1', 1000)).toBe(false);
  });

  test('expired but holder pid alive -> no claim (slow, not dead)', () => {
    const lease: MonitorLease = { leaderId: 'win-2', pid: process.pid, expiresAt: 1000 };
    expect(isPidAlive(process.pid)).toBe(true);
    expect(canClaim(lease, 'win-1', 2000)).toBe(false);
  });

  test('expired and holder pid dead -> takeover claim', () => {
    const lease: MonitorLease = { leaderId: 'win-2', pid: DEAD_PID, expiresAt: 1000 };
    expect(isPidAlive(DEAD_PID)).toBe(false);
    expect(canClaim(lease, 'win-1', 2000)).toBe(true);
  });
});

describe('lease file IO — atomic round-trip', () => {
  test('write then read returns the same lease; release removes it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lease-io-'));
    const file = path.join(dir, 'monitor-lease.json');
    try {
      const lease: MonitorLease = { leaderId: 'win-7', pid: 1234, expiresAt: 9999 };
      writeLease(lease, file);
      expect(readLease(file)).toEqual(lease);

      // A different holder must not be able to release our lease.
      releaseLease('win-other', file);
      expect(readLease(file)).toEqual(lease);

      // The real holder can.
      releaseLease('win-7', file);
      expect(readLease(file)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed lease file reads as undefined (no throw)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-lease-bad-'));
    const file = path.join(dir, 'monitor-lease.json');
    try {
      fs.writeFileSync(file, '{ not json');
      expect(readLease(file)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Multi-process election harness -----------------------------------------

const HEARTBEAT_MS = 150;
const TTL_MS = 450;
const SESSION_ID = 'someValue.sessionId'; // the VSCodium collision placeholder

// Code run by each child "window". Imports the REAL leader + windowId source,
// runs the election against the shared lease file, and mirrors its current
// isLeader flag into its own status file every heartbeat.
const WINDOW_CODE = `
  const { MonitorLeader } = await import(process.argv[1]);
  const { computeWindowId } = await import(process.argv[2]);
  const fs = require('fs');
  const leaseFile = process.argv[3];
  const statusFile = process.argv[4];
  const heartbeatMs = Number(process.argv[5]);
  const ttlMs = Number(process.argv[6]);
  const sessionId = process.argv[7];
  const selfId = computeWindowId(sessionId, process.pid);
  function writeStatus(isLeader) {
    try {
      const tmp = statusFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, selfId, isLeader }));
      fs.renameSync(tmp, statusFile);
    } catch {}
  }
  writeStatus(false);
  const leader = new MonitorLeader({ selfId, pid: process.pid, heartbeatMs, ttlMs, leaseFile, onChange: writeStatus });
  leader.start();
  setInterval(() => writeStatus(leader.isLeader()), heartbeatMs);
  process.on('SIGTERM', () => { try { leader.dispose(); } catch {} process.exit(0); });
`;

interface Window {
  index: number;
  child: ChildProcess;
  statusFile: string;
  killed: boolean;
}

function spawnWindow(index: number, dir: string, leaseFile: string): Window {
  const statusFile = path.join(dir, `w${index}.json`);
  const child = spawn(
    process.execPath, // the bun binary running this test
    ['-e', WINDOW_CODE, LEADER_SRC, WINDOWID_SRC, leaseFile, statusFile, String(HEARTBEAT_MS), String(TTL_MS), SESSION_ID],
    { stdio: 'ignore' },
  );
  return { index, child, statusFile, killed: false };
}

function readStatus(w: Window): { pid: number; isLeader: boolean } | undefined {
  try {
    return JSON.parse(fs.readFileSync(w.statusFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function leaders(windows: Window[]): Array<{ pid: number; index: number }> {
  const out: Array<{ pid: number; index: number }> = [];
  for (const w of windows) {
    if (w.killed) continue;
    const s = readStatus(w);
    if (s?.isLeader) out.push({ pid: s.pid, index: w.index });
  }
  return out;
}

// Poll `fn` until it returns a truthy value or `timeoutMs` elapses.
async function waitFor<T>(fn: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  return undefined;
}

describe('end-to-end: K real windows elect exactly one leader, take over on death', () => {
  test('one leader at steady state; killing it hands off to another window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-leader-e2e-'));
    const leaseFile = path.join(dir, 'monitor-lease.json');
    const windows: Window[] = [];

    try {
      for (let i = 0; i < 3; i++) windows.push(spawnWindow(i, dir, leaseFile));

      // (1) Converge to exactly one leader.
      const settled = await waitFor(() => (leaders(windows).length === 1 ? leaders(windows) : undefined), 5000);
      expect(settled).toBeDefined();
      expect(settled!.length).toBe(1);

      const firstLeaderPid = settled![0].pid;
      const firstLeaderWin = windows.find((w) => readStatus(w)?.pid === firstLeaderPid)!;
      expect(firstLeaderWin).toBeDefined();

      // The lease file on disk must agree with the elected window.
      const onDisk = readLease(leaseFile);
      expect(onDisk?.pid).toBe(firstLeaderPid);

      // Hold for a few heartbeats: still exactly one, still the same one.
      await sleep(HEARTBEAT_MS * 4);
      const held = leaders(windows);
      expect(held.length).toBe(1);
      expect(held[0].pid).toBe(firstLeaderPid);

      // (2) Kill the leader; a survivor must take over within one heartbeat
      //     after the lease expires.
      firstLeaderWin.child.kill('SIGKILL');
      firstLeaderWin.killed = true;
      try { fs.rmSync(firstLeaderWin.statusFile, { force: true }); } catch {}

      const tookOver = await waitFor(() => {
        const ls = leaders(windows);
        return ls.length === 1 && ls[0].pid !== firstLeaderPid ? ls : undefined;
      }, TTL_MS + HEARTBEAT_MS * 6 + 2000);

      expect(tookOver).toBeDefined();
      expect(tookOver!.length).toBe(1);
      expect(tookOver![0].pid).not.toBe(firstLeaderPid);

      // New leader's pid is alive and recorded in the lease.
      expect(isPidAlive(tookOver![0].pid)).toBe(true);
      expect(readLease(leaseFile)?.pid).toBe(tookOver![0].pid);
    } finally {
      for (const w of windows) {
        try { w.child.kill('SIGKILL'); } catch {}
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
