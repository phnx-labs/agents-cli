import { describe, it, expect } from 'vitest';

import { SPECS_STALE_MS, STATS_STALE_MS, isFreshDeviceSpecs, isFreshDeviceStats, loadFleetStats } from './stats-cache.js';
import type { DeviceStats } from './health.js';
import type { DeviceProfile } from './registry.js';

function dev(name: string): DeviceProfile {
  return { name, platform: 'linux' } as DeviceProfile;
}

function stat(host: string, fetchedAt: number, loadPercent = 10): DeviceStats {
  return { host, reachable: true, loadPercent, memPercent: 20, ncpu: 4, memTotalBytes: 16 * 1024 ** 3, diskTotalBytes: 256 * 1024 ** 3, fetchedAt, specsFetchedAt: fetchedAt };
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
      now: 2000,
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
      now: 2000,
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
      now: 2000,
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

  it('serves a specs-only second read inside the static TTL with zero probes', async () => {
    const now = 10_000_000;
    const probed: string[] = [];
    let cache: Record<string, DeviceStats> = {};
    const options = {
      selfName: 'z',
      probeFleet: fakeProbe(now, probed),
      probeLocal: (async (h: string) => stat(h, now)) as never,
      readCache: () => ({ ...cache }),
      writeCache: (entries: Record<string, DeviceStats>) => { cache = { ...cache, ...entries }; },
    };
    await loadFleetStats([dev('a')], { ...options, now });
    expect(probed).toEqual(['a']);
    probed.length = 0;
    const second = await loadFleetStats([dev('a')], {
      ...options,
      specsOnly: true,
      now: now + STATS_STALE_MS + 1,
    });
    expect(probed).toEqual([]);
    expect(second.stats.get('a')?.ncpu).toBe(4);
    expect(second.stats.get('a')?.diskTotalBytes).toBe(256 * 1024 ** 3);
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

  // #2666: a cache entry older than STATS_STALE_MS must never be presented as
  // current load — it is re-probed live and the fresh row rewrites the cache.
  it('re-probes and rewrites a cache entry older than STATS_STALE_MS instead of serving it', async () => {
    const now = 10_000_000;
    const probed: string[] = [];
    const written: Record<string, DeviceStats>[] = [];
    const cache = {
      fresh: stat('fresh', now - STATS_STALE_MS, 10),          // exactly on the bound — still served
      stale: stat('stale', now - STATS_STALE_MS - 1, 1058),    // the fossilized 9-day-old shape
    };
    const res = await loadFleetStats([dev('fresh'), dev('stale')], {
      selfName: 'z',
      now,
      readCache: () => ({ ...cache }),
      writeCache: (e) => { written.push(e); },
      probeFleet: fakeProbe(now, probed),
      probeLocal: (async (h: string) => stat(h, now)) as never,
    });
    expect(probed).toEqual(['stale']);                    // stale re-probed, fresh untouched
    expect(res.stats.get('stale')?.loadPercent).toBe(10); // the live number, not 1058
    expect(res.stats.get('stale')?.fetchedAt).toBe(now);
    expect(res.stats.get('fresh')?.fetchedAt).toBe(now - STATS_STALE_MS);
    expect(written).toHaveLength(1);                      // the default read is the writer now
    expect(Object.keys(written[0])).toEqual(['stale']);
  });

  it('isFreshDeviceStats bounds a row at STATS_STALE_MS', () => {
    const now = 1_000_000;
    expect(isFreshDeviceStats(stat('a', now), now)).toBe(true);
    expect(isFreshDeviceStats(stat('a', now - STATS_STALE_MS), now)).toBe(true);
    expect(isFreshDeviceStats(stat('a', now - STATS_STALE_MS - 1), now)).toBe(false);
    expect(isFreshDeviceStats(stat('a', now - 9 * 24 * 3600_000), now)).toBe(false); // the observed 9d row
  });

  it('isFreshDeviceSpecs bounds static facts at seven days independently', () => {
    const now = 1_000_000_000;
    expect(isFreshDeviceSpecs(stat('a', now - SPECS_STALE_MS), now)).toBe(true);
    expect(isFreshDeviceSpecs(stat('a', now - SPECS_STALE_MS - 1), now)).toBe(false);
  });
});
