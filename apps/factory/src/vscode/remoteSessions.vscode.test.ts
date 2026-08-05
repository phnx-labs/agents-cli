import { test, expect, afterEach } from 'bun:test';
import {
  mapWithConcurrency,
  setFloorSnapshotStore,
  getLastGoodFloorSnapshot,
  __resetRemoteSessionsCachesForTests,
  fetchHostSessions,
  fetchLocalSessions,
  discoverHosts,
  seedFloorHostsFromDevices,
  __remoteSessionsTestCounters,
} from './remoteSessions.vscode';
import {
  __deviceHealthTestCounters,
  setRegisteredDevicesCache,
} from './deviceHealth.vscode';
import {
  acceptSuccessfulFloorFetch,
  retainLastGoodOnFailure,
  shouldRunBareFleetFetch,
  type FloorHostSessionsSnapshot,
} from '../core/floorSnapshot';
import type { HostInfo, RemoteSession } from '../core/remoteSessions';

// mapWithConcurrency bounds the host fan-out. A broken bound is what froze the M5,
// and order preservation matters because results are zipped back to their host by
// index. Real async work (setTimeout), no mocks.

test('preserves input order regardless of per-item latency', async () => {
  const items = [40, 5, 25, 10, 0];
  const out = await mapWithConcurrency(items, 2, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return `${i}:${ms}`;
  });
  expect(out).toEqual(['0:40', '1:5', '2:25', '3:10', '4:0']);
});

test('never exceeds the concurrency limit and still runs every item', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 4, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  expect(peak).toBeLessThanOrEqual(4);
  expect(out).toEqual(items.map((n) => n * 2));
});

test('a limit larger than the item count runs all of them (no hang)', async () => {
  const out = await mapWithConcurrency([1, 2, 3], 10, async (n) => n + 1);
  expect(out).toEqual([2, 3, 4]);
});

test('an empty list resolves to an empty array', async () => {
  const out = await mapWithConcurrency([] as number[], 4, async (n) => n);
  expect(out).toEqual([]);
});

// --- Floor last-good / force-only fleet policy (real store, no CLI required) ---

afterEach(() => {
  __resetRemoteSessionsCachesForTests();
  setRegisteredDevicesCache(null);
  __deviceHealthTestCounters.reset();
});

function sampleSnap(): FloorHostSessionsSnapshot {
  const hosts: HostInfo[] = [
    { name: 'this-mac', online: true, agents: 1, load: 'free', uses: 1 },
    { name: 'yosemite', online: true, agents: 1, load: 'free', uses: 1 },
  ];
  const sessions = [
    { sessionId: 'local-1', host: 'this-mac' },
    { sessionId: 'remote-1', host: 'yosemite' },
  ] as RemoteSession[];
  return acceptSuccessfulFloorFetch(null, {
    hosts,
    sessions,
    groups: [
      { host: 'this-mac', online: true, fetchedAt: 1000, sessions: [sessions[0]] },
      { host: 'yosemite', online: true, fetchedAt: 1000, sessions: [sessions[1]] },
    ],
    fetchedAt: 1000,
  });
}

test('setFloorSnapshotStore hydrates last-good so non-force fetchHostSessions does zero bare CLI calls', async () => {
  const snap = sampleSnap();
  let written: FloorHostSessionsSnapshot | null = null;
  setFloorSnapshotStore({
    read: () => snap,
    write: (s) => {
      written = s;
    },
  });
  expect(getLastGoodFloorSnapshot()?.sessions).toHaveLength(2);
  expect(shouldRunBareFleetFetch(false, true)).toBe(false);

  __remoteSessionsTestCounters.reset();
  const before = __remoteSessionsTestCounters.bareActiveCalls;
  // Three "poll" calls that the UI would fire — must not invoke fleet CLI.
  const a = await fetchHostSessions(Date.now(), { force: false });
  const b = await fetchHostSessions(Date.now(), { force: false });
  const c = await fetchHostSessions(Date.now(), { force: false });
  expect(__remoteSessionsTestCounters.bareActiveCalls).toBe(before);
  expect(a.fromCache).toBe(true);
  expect(b.sessions.map((s) => s.sessionId).sort()).toEqual(['local-1', 'remote-1']);
  expect(c.hostFreshness?.yosemite).toBe(1000);
  expect(written).toBeNull(); // non-force read does not rewrite
});

test('retainLastGoodOnFailure keeps remote rows when a refresh fails', () => {
  const prev = sampleSnap();
  const kept = retainLastGoodOnFailure(prev);
  expect(kept?.fromCache).toBe(true);
  expect(kept?.sessions.map((s) => s.sessionId)).toContain('remote-1');
  expect(kept?.fetchedAt).toBe(1000);
});

test('hydrate from store seeds localCache so non-force local reads need no CLI', async () => {
  const snap = sampleSnap();
  setFloorSnapshotStore({
    read: () => snap,
    write: () => {},
  });
  __remoteSessionsTestCounters.reset();
  // After hydrate, non-force local reads must return last-good this-mac rows
  // without a local CLI call (backstop clock stamped "now" at hydrate).
  const before = __remoteSessionsTestCounters.localActiveCalls;
  const local = await fetchLocalSessions(Date.now(), { force: false });
  expect(local.fromCache).toBe(true);
  expect(local.sessions.map((s) => s.sessionId)).toEqual(['local-1']);
  expect(__remoteSessionsTestCounters.localActiveCalls).toBe(before);
});

test('hydrate retains full last-good including remote rows; fail path cannot empty them', () => {
  const snap = sampleSnap();
  setFloorSnapshotStore({
    read: () => snap,
    write: () => {},
  });
  expect(getLastGoodFloorSnapshot()?.sessions.map((s) => s.sessionId).sort()).toEqual([
    'local-1',
    'remote-1',
  ]);
  // Pure fail retain (what fetchHostSessions / empty local fail path use).
  const kept = retainLastGoodOnFailure(getLastGoodFloorSnapshot());
  expect(kept?.sessions.map((s) => s.sessionId).sort()).toEqual(['local-1', 'remote-1']);
  expect(kept?.fromCache).toBe(true);
});

test('discoverHosts reuses the activation device cache without another devices CLI call', async () => {
  setRegisteredDevicesCache([
    { name: 'worker', host: 'worker.tailnet', online: true, registeredAt: 1 },
  ]);
  const before = __deviceHealthTestCounters.registeredDeviceCliCalls;
  const hosts = await discoverHosts();
  expect(__deviceHealthTestCounters.registeredDeviceCliCalls).toBe(before);
  expect(hosts.some((host) => host.name === 'worker' && host.online)).toBe(true);
});

test('activation device seed adds registered hosts while retaining last-good sessions', () => {
  const snap = sampleSnap();
  let written: FloorHostSessionsSnapshot | null = null;
  setFloorSnapshotStore({
    read: () => snap,
    write: (next) => {
      written = next;
    },
  });
  const merged = seedFloorHostsFromDevices([
    { name: 'newbox', host: 'newbox.tailnet', online: true },
  ]);
  expect(merged.hosts.some((host) => host.name === 'newbox')).toBe(true);
  expect(merged.sessions.map((session) => session.sessionId).sort()).toEqual(['local-1', 'remote-1']);
  expect(written?.hosts.some((host) => host.name === 'newbox')).toBe(true);
});
