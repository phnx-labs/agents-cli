import { describe, expect, test } from 'bun:test';
import type { HostInfo, RemoteSession } from './remoteSessions';
import {
  FLOOR_SNAPSHOT_KEY,
  FLOOR_DEVICES_KEY,
  FLOOR_INVENTORY_KEY,
  INVENTORY_CACHE_TTL_MS,
  LOCAL_SESSIONS_BACKSTOP_MS,
  acceptSuccessfulFloorFetch,
  buildHostFreshness,
  isInventoryStale,
  isLocalSessionsStale,
  mergeLocalSessionsIntoSnapshot,
  mergeHostRosterIntoSnapshot,
  parseFloorSnapshot,
  parseFloorDevicesSnapshot,
  parseFloorInventorySnapshot,
  retainLastGoodOnFailure,
  shouldRunBareFleetFetch,
  type FloorHostSessionsSnapshot,
} from './floorSnapshot';

const host = (name: string, online = true, agents = 0): HostInfo => ({
  name,
  online,
  agents,
  load: online ? (agents === 0 ? 'idle' : 'free') : 'off',
  uses: agents,
});

const session = (id: string, hostName: string): RemoteSession =>
  ({
    sessionId: id,
    host: hostName,
    agentType: 'claude',
    status: 'running',
    cwd: '/x',
    label: id,
    startedAtMs: 1,
    lastActivityMs: 1,
    pid: 1,
  }) as RemoteSession;

function snap(partial: Partial<FloorHostSessionsSnapshot> = {}): FloorHostSessionsSnapshot {
  return {
    hosts: [host('this-mac', true, 1), host('yosemite', true, 2)],
    sessions: [session('a', 'this-mac'), session('b', 'yosemite')],
    groups: [
      { host: 'this-mac', online: true, fetchedAt: 1000, sessions: [session('a', 'this-mac')] },
      { host: 'yosemite', online: true, fetchedAt: 1000, sessions: [session('b', 'yosemite')] },
    ],
    fetchedAt: 1000,
    hostFreshness: { 'this-mac': 1000, yosemite: 1000 },
    ...partial,
  };
}

describe('floorSnapshot pure model', () => {
  test('FLOOR_SNAPSHOT_KEY is stable for globalState', () => {
    expect(FLOOR_SNAPSHOT_KEY).toBe('agents.floorSnapshot.v1');
    expect(FLOOR_DEVICES_KEY).toBe('agents.floorDevices.v1');
    expect(FLOOR_INVENTORY_KEY).toBe('agents.floorInventory.v1');
  });

  test('persisted device and inventory snapshots reject drift', () => {
    expect(parseFloorDevicesSnapshot({ devices: [], fetchedAt: 10 })).toEqual({ devices: [], fetchedAt: 10 });
    expect(parseFloorDevicesSnapshot({ devices: [{ name: 's0' }], fetchedAt: 10 })).toBeUndefined();
    expect(parseFloorInventorySnapshot({ data: { claude: { installed: true } }, fetchedAt: 20 })).toEqual({
      data: { claude: { installed: true } },
      fetchedAt: 20,
    });
    expect(parseFloorInventorySnapshot({ data: [], fetchedAt: 20 })).toBeUndefined();
  });

  test('parseFloorSnapshot rejects drift and accepts a valid shape', () => {
    expect(parseFloorSnapshot(null)).toBeUndefined();
    expect(parseFloorSnapshot({})).toBeUndefined();
    expect(parseFloorSnapshot({ hosts: [], sessions: [], groups: [] })).toBeUndefined();
    const ok = parseFloorSnapshot(snap());
    expect(ok?.sessions).toHaveLength(2);
    expect(ok?.hostFreshness.yosemite).toBe(1000);
  });

  test('buildHostFreshness advances only online hosts', () => {
    const prev = { 'this-mac': 500, yosemite: 500, ghost: 400 };
    const freshness = buildHostFreshness(
      [host('this-mac', true), host('yosemite', false), host('newbox', true)],
      2000,
      prev,
    );
    expect(freshness['this-mac']).toBe(2000);
    expect(freshness.yosemite).toBe(500); // offline keeps prior success stamp
    expect(freshness.newbox).toBe(2000);
    expect(freshness.ghost).toBe(400);
  });

  test('acceptSuccessfulFloorFetch replaces rows and clears fromCache', () => {
    const prev = snap({ fromCache: true });
    const next = acceptSuccessfulFloorFetch(prev, {
      hosts: [host('this-mac', true, 0)],
      sessions: [],
      groups: [],
      fetchedAt: 3000,
    });
    expect(next.fromCache).toBe(false);
    expect(next.fetchedAt).toBe(3000);
    expect(next.sessions).toEqual([]);
    expect(next.hostFreshness['this-mac']).toBe(3000);
  });

  test('retainLastGoodOnFailure keeps rows and marks fromCache', () => {
    const prev = snap();
    const kept = retainLastGoodOnFailure(prev);
    expect(kept).not.toBeNull();
    expect(kept!.fromCache).toBe(true);
    expect(kept!.sessions).toEqual(prev.sessions);
    expect(kept!.fetchedAt).toBe(prev.fetchedAt);
    expect(retainLastGoodOnFailure(null)).toBeNull();
  });

  test('isLocalSessionsStale enforces the 60s local-only backstop', () => {
    expect(isLocalSessionsStale(null, 10_000)).toBe(true);
    expect(isLocalSessionsStale(10_000, 10_000 + LOCAL_SESSIONS_BACKSTOP_MS - 1)).toBe(false);
    expect(isLocalSessionsStale(10_000, 10_000 + LOCAL_SESSIONS_BACKSTOP_MS)).toBe(true);
  });

  test('isInventoryStale matches the 60s SWR window', () => {
    expect(isInventoryStale(undefined, 0)).toBe(true);
    expect(isInventoryStale(1000, 1000 + INVENTORY_CACHE_TTL_MS - 1)).toBe(false);
    expect(isInventoryStale(1000, 1000 + INVENTORY_CACHE_TTL_MS)).toBe(true);
  });

  test('mergeLocalSessionsIntoSnapshot preserves remote rows', () => {
    const prev = snap();
    const local = [session('c', 'this-mac')];
    const merged = mergeLocalSessionsIntoSnapshot(
      prev,
      local,
      host('this-mac', true, 1),
      5000,
    );
    expect(merged.sessions.map((s) => s.sessionId).sort()).toEqual(['b', 'c']);
    expect(merged.hostFreshness['this-mac']).toBe(5000);
    expect(merged.hostFreshness.yosemite).toBe(1000);
    expect(merged.sessions.find((s) => s.host === 'yosemite')?.sessionId).toBe('b');
  });

  test('mergeHostRosterIntoSnapshot renders registered hosts without erasing last-good rows', () => {
    const merged = mergeHostRosterIntoSnapshot(snap(), [
      host('this-mac', true),
      host('yosemite', false),
      host('newbox', true),
    ]);
    expect(merged.hosts.find((h) => h.name === 'yosemite')).toMatchObject({
      online: false,
      agents: 2,
      uses: 2,
    });
    expect(merged.hosts.find((h) => h.name === 'newbox')).toMatchObject({
      online: true,
      agents: 0,
      uses: 0,
    });
    expect(merged.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
    expect(merged.hostFreshness.yosemite).toBe(1000);
    expect(merged.hostFreshness.newbox).toBe(0);
    expect(merged.fromCache).toBe(true);
  });

  test('shouldRunBareFleetFetch: explicit user refresh only', () => {
    expect(shouldRunBareFleetFetch(false)).toBe(false);
    expect(shouldRunBareFleetFetch(true)).toBe(true);
  });
});
