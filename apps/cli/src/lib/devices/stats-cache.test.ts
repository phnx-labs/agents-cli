import { describe, it, expect } from 'vitest';

import { loadFleetStats } from './stats-cache.js';
import type { DeviceStats } from './health.js';
import type { DeviceProfile } from './registry.js';

function dev(name: string): DeviceProfile {
  return { name, platform: 'linux' } as DeviceProfile;
}

function stat(host: string, fetchedAt: number, loadPercent = 10): DeviceStats {
  return { host, reachable: true, loadPercent, memPercent: 20, ncpu: 4, fetchedAt };
}

/** A probe stub that records which devices it was asked to probe. */
function fakeProbe(now: number, probed: string[]) {
  return (async (devices: DeviceProfile[]) => {
    const m = new Map<string, DeviceStats>();
    for (const d of devices) {
      probed.push(d.name);
      m.set(d.name, stat(d.name, now));
    }
    return m;
  }) as unknown as Parameters<typeof loadFleetStats>[1]['probeFleet'];
}

describe('loadFleetStats', () => {
  it('serves cached remotes and never ssh-probes them (default path)', async () => {
    const probed: string[] = [];
    const cache = { a: stat('a', 1000), b: stat('b', 1000) };
    const res = await loadFleetStats([dev('a'), dev('b')], {
      selfName: 'z', // not in the list — no local probe needed either
      readCache: () => ({ ...cache }),
      writeCache: () => {},
      probeFleet: fakeProbe(2000, probed),
      probeLocal: (async (h: string) => stat(h, 2000)) as never,
    });
    expect(probed).toEqual([]); // both served from cache
    expect(res.servedFromCache).toBe(true);
    expect(res.stats.get('a')?.fetchedAt).toBe(1000);
    expect(res.oldestFetchedAt).toBe(1000);
  });

  it('always probes THIS machine locally even when cached', async () => {
    const probed: string[] = [];
    const cache = { z: stat('z', 1000) };
    const res = await loadFleetStats([dev('z')], {
      selfName: 'z',
      readCache: () => ({ ...cache }),
      writeCache: () => {},
      probeFleet: fakeProbe(2000, probed),
      probeLocal: (async (h: string) => stat(h, 2000)) as never,
    });
    // self went through probeFleet (which handles selfName locally); it is never
    // served stale from cache.
    expect(probed).toContain('z');
    expect(res.stats.get('z')?.fetchedAt).toBe(2000);
  });

  it('probes only the devices missing from the cache (gap-fill) and persists them', async () => {
    const probed: string[] = [];
    const written: Record<string, DeviceStats>[] = [];
    const cache = { a: stat('a', 1000) };
    const res = await loadFleetStats([dev('a'), dev('b')], {
      selfName: 'z',
      readCache: () => ({ ...cache }),
      writeCache: (e) => { written.push(e); },
      probeFleet: fakeProbe(2000, probed),
      probeLocal: (async (h: string) => stat(h, 2000)) as never,
    });
    expect(probed).toEqual(['b']);            // only the uncached one
    expect(res.stats.get('a')?.fetchedAt).toBe(1000); // cached
    expect(res.stats.get('b')?.fetchedAt).toBe(2000); // fresh
    expect(written).toHaveLength(1);
    expect(Object.keys(written[0])).toEqual(['b']);   // only fresh rows persisted
  });

  it('forceRefresh bypasses the cache and probes every device', async () => {
    const probed: string[] = [];
    const cache = { a: stat('a', 1000), b: stat('b', 1000) };
    const res = await loadFleetStats([dev('a'), dev('b')], {
      forceRefresh: true,
      selfName: 'z',
      readCache: () => ({ ...cache }),
      writeCache: () => {},
      probeFleet: fakeProbe(2000, probed),
      probeLocal: (async (h: string) => stat(h, 2000)) as never,
    });
    expect(probed.sort()).toEqual(['a', 'b']);
    expect(res.servedFromCache).toBe(false);
    expect(res.oldestFetchedAt).toBe(2000);
  });

  it('falls back to a local probe for a self not present in the device list', async () => {
    const res = await loadFleetStats([], {
      selfName: 'z',
      readCache: () => ({}),
      writeCache: () => {},
      probeFleet: fakeProbe(2000, []),
      probeLocal: (async (h: string) => stat(h, 3000)) as never,
    });
    expect(res.stats.get('z')?.fetchedAt).toBe(3000);
  });
});
