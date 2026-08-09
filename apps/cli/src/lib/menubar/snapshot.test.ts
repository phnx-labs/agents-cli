import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ActiveSession } from '../session/active.js';
import { setActiveSessionsSnapshotPathForTest, setImmutableMemoPathForTest, writeActiveSessionsCache } from '../session/session-cache.js';
import { closeDB } from '../session/db.js';
import { computeMenubarSnapshot, readLastWatchdogTick } from './snapshot.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('menubar snapshot', () => {
  it('reads the daemon-owned watchdog result without running a watchdog tick', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-'));
    dirs.push(dir);
    const tick = {
      didNudge: true,
      counts: { total: 2, stalled: 1, nudged: 1, unaddressable: 0, skipped: 1 },
      outcomes: [],
    };
    fs.writeFileSync(path.join(dir, 'last-tick.json'), JSON.stringify(tick));

    expect(readLastWatchdogTick(dir)).toEqual(tick);
  });

  it('returns null when the daemon has not published a watchdog result', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-'));
    dirs.push(dir);
    expect(readLastWatchdogTick(dir)).toBeNull();
  });

  it('emits preferred state from the device auto-launch preference file', async () => {
    const devicesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-devices-'));
    dirs.push(devicesDir);
    const previousDevicesDir = process.env.AGENTS_DEVICES_DIR;
    process.env.AGENTS_DEVICES_DIR = devicesDir;

    const now = new Date().toISOString();
    const device = (name: string) => ({
      name,
      platform: 'macos',
      shell: 'posix',
      address: { via: 'tailscale', dnsName: `${name}.example.ts.net` },
      auth: { method: 'key' },
      createdAt: now,
      updatedAt: now,
    });
    fs.writeFileSync(
      path.join(devicesDir, 'registry.json'),
      JSON.stringify({ alpha: device('alpha'), zion: device('zion') }),
    );
    fs.writeFileSync(
      path.join(devicesDir, 'auto-launch.json'),
      JSON.stringify({ devices: { zion: { preferred: true } }, updatedAt: now }),
    );

    try {
      const snapshot = await computeMenubarSnapshot();
      expect(snapshot.devices.map(({ name, preferred }) => ({ name, preferred }))).toEqual([
        { name: 'alpha', preferred: false },
        { name: 'zion', preferred: true },
      ]);
    } finally {
      if (previousDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR;
      else process.env.AGENTS_DEVICES_DIR = previousDevicesDir;
    }
  });
});

/**
 * RUSH-2336 — the menubar snapshot must apply the same canonical
 * `isRunningLiveSession` selector the CLI's bare `--active` view does. The
 * daemon warm-tick writer never stamps `machine` on a local row (unlike the
 * CLI's own gather), so this also pins the self-stamp fallback that lets a
 * process row satisfy the selector's "names its machine" requirement.
 */
describe('computeMenubarSnapshot — active-session selector (RUSH-2336)', () => {
  let snapDir: string;
  let prevSnap: string | null;
  let prevImm: string | null;
  let prevMachineId: string | undefined;
  let prevSessionsDb: string | undefined;
  let prevRoutinesDir: string | undefined;
  let prevSystemRoutinesDir: string | undefined;

  beforeEach(() => {
    snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-snapshot-active-'));
    dirs.push(snapDir);
    prevSnap = setActiveSessionsSnapshotPathForTest(path.join(snapDir, 'snap.json'));
    prevImm = setImmutableMemoPathForTest(path.join(snapDir, 'imm.json'));
    prevMachineId = process.env.AGENTS_SYNC_MACHINE_ID;
    process.env.AGENTS_SYNC_MACHINE_ID = 'test-box';
    prevSessionsDb = process.env.AGENTS_SESSIONS_DB;
    process.env.AGENTS_SESSIONS_DB = path.join(snapDir, 'sessions.db');
    closeDB();
    prevRoutinesDir = process.env.AGENTS_ROUTINES_DIR;
    process.env.AGENTS_ROUTINES_DIR = path.join(snapDir, 'routines');
    prevSystemRoutinesDir = process.env.AGENTS_SYSTEM_ROUTINES_DIR;
    process.env.AGENTS_SYSTEM_ROUTINES_DIR = path.join(snapDir, 'system-routines');
  });

  afterEach(() => {
    setActiveSessionsSnapshotPathForTest(prevSnap);
    setImmutableMemoPathForTest(prevImm);
    closeDB();
    if (prevMachineId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = prevMachineId;
    if (prevSessionsDb === undefined) delete process.env.AGENTS_SESSIONS_DB;
    else process.env.AGENTS_SESSIONS_DB = prevSessionsDb;
    if (prevRoutinesDir === undefined) delete process.env.AGENTS_ROUTINES_DIR;
    else process.env.AGENTS_ROUTINES_DIR = prevRoutinesDir;
    if (prevSystemRoutinesDir === undefined) delete process.env.AGENTS_SYSTEM_ROUTINES_DIR;
    else process.env.AGENTS_SYSTEM_ROUTINES_DIR = prevSystemRoutinesDir;
  });

  function row(partial: Partial<ActiveSession>): ActiveSession {
    return { context: 'terminal', kind: 'claude', status: 'running', ...partial } as ActiveSession;
  }

  it('excludes retained queued/closed/crashed and unverified-liveness rows, keeps verified process + cloud rows', async () => {
    const rows: ActiveSession[] = [
      // Real, positively-alive process row — no `machine` stamped (the daemon
      // warm-tick gather never sets it), so the snapshot must self-stamp it.
      row({ sessionId: 'alive-proc', pid: 4242, pidAlive: true, status: 'running' }),
      // A cloud row is active on the provider's word alone, no pid at all.
      row({ context: 'cloud', sessionId: 'alive-cloud', status: 'running', cloudProvider: 'rush', cloudTaskId: 'task-123' }),
      // Retained-dead rows the raw cache keeps around for --closed/--crashed.
      row({ sessionId: 'dead-closed', pid: 1111, pidAlive: false, status: 'closed' }),
      row({ sessionId: 'dead-crashed', pid: 2222, pidAlive: false, status: 'crashed' }),
      // Dispatched-but-not-started — belongs only behind --queued.
      row({ context: 'cloud', sessionId: 'not-started', status: 'queued', cloudProvider: 'rush', cloudTaskId: 'task-999' }),
      // A process row whose liveness was never positively verified (an older
      // peer's row, or a pid that could not be resolved) must not read as active.
      row({ sessionId: 'unknown-liveness', pid: 3333, status: 'running' }),
    ];
    writeActiveSessionsCache('local', rows, { capturedAt: Date.now() });

    const snap = await computeMenubarSnapshot();
    const ids = snap.activeSessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(['alive-cloud', 'alive-proc']);

    const proc = snap.activeSessions.find((s) => s.sessionId === 'alive-proc')!;
    expect(proc.machine).toBe('test-box');
    expect(proc.pid).toBe(4242);
    expect(proc.pidAlive).toBe(true);

    const cloud = snap.activeSessions.find((s) => s.sessionId === 'alive-cloud')!;
    expect(cloud.cloudProvider).toBe('rush');
    expect(cloud.cloudTaskId).toBe('task-123');
    expect(cloud.pid).toBeUndefined();
  });

  it('emits no active sessions when the raw cache is empty or missing', async () => {
    const snap = await computeMenubarSnapshot();
    expect(snap.activeSessions).toEqual([]);
  });
});
