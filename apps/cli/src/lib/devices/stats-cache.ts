/**
 * Disk cache for fleet {@link DeviceStats} so `agents devices list` and
 * `agents fleet status` render instantly from the last probe instead of
 * live-SSHing every registered box on every invocation.
 *
 * The old behaviour probed the whole fleet over ssh on every call
 * ({@link probeFleetStats}) — with a dozen devices, a few of them cold or
 * timing out, that turned a status glance into a multi-second hang. This module
 * makes the reads cache-first:
 *
 * - **Default:** serve remote devices from the cache (instant); always probe
 *   *this* machine locally (no ssh, sub-ms) so the "this machine" row is live;
 *   probe only the remote devices missing from the cache (first run / a
 *   newly-added box), then persist them.
 * - **`--refresh` / `--live`:** skip the cache and live-probe every device,
 *   rewriting the cache.
 *
 * The daemon warms this cache (~every 3 min, see `lib/daemon.ts
 * runFleetCacheWarm`), so in steady state a default read has zero
 * remote ssh round-trips and returns immediately with data that is at most a
 * few minutes old — surfaced to the user as an "as of …" freshness note.
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from '../state.js';
import { probeFleetStats, probeLocalStats, type DeviceStats } from './health.js';
import type { DeviceProfile } from './registry.js';

const CACHE_FILE = '.fleet-stats.json';

interface StatsCacheFile {
  version: 1;
  entries: Record<string, DeviceStats>;
}

function cacheFilePath(): string {
  return path.join(getCacheDir(), CACHE_FILE);
}

/** Read the whole cache (best-effort; a missing/corrupt file yields an empty map). */
export function readStatsCache(): Record<string, DeviceStats> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), 'utf-8')) as StatsCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
    // missing or corrupt — treat as empty
  }
  return {};
}

/**
 * Merge freshly-probed rows into the on-disk cache (best-effort write). Rows for
 * devices not in `entries` are preserved, so a partial probe (gap-fill, or a
 * single-device refresh) never drops the rest of the fleet's cached stats.
 */
export function writeStatsCache(entries: Record<string, DeviceStats>): void {
  try {
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const merged: StatsCacheFile = {
      version: 1,
      entries: { ...readStatsCache(), ...entries },
    };
    fs.writeFileSync(cacheFilePath(), JSON.stringify(merged, null, 2));
  } catch {
    // best-effort; a failed write just means the next read falls back to a live probe
  }
}

export interface FleetStatsResult {
  /** name → stats for every requested device (cache-served + freshly probed). */
  stats: Map<string, DeviceStats>;
  /** Oldest `fetchedAt` among the returned rows, or null when empty. Drives the
   *  "as of …" freshness note. */
  oldestFetchedAt: number | null;
  /** True when at least one row was served from cache rather than probed this call. */
  servedFromCache: boolean;
}

export interface LoadFleetStatsOptions {
  /** Skip the cache and live-probe every device (the `--refresh`/`--live` path). */
  forceRefresh?: boolean;
  /** Device name of THIS machine — always probed locally (no ssh), never cached-served. */
  selfName?: string;
  /** Injectable probes + cache IO for tests (default to the real ssh/local/disk ones). */
  probeFleet?: typeof probeFleetStats;
  probeLocal?: typeof probeLocalStats;
  readCache?: typeof readStatsCache;
  writeCache?: typeof writeStatsCache;
}

/**
 * Load fleet stats cache-first. See the module doc for the default vs
 * `--refresh` behaviour. Never throws — an unreachable box degrades to a
 * `reachable: false` row exactly as the live probe does.
 */
export async function loadFleetStats(
  devices: DeviceProfile[],
  opts: LoadFleetStatsOptions = {},
): Promise<FleetStatsResult> {
  const probeFleet = opts.probeFleet ?? probeFleetStats;
  const probeLocal = opts.probeLocal ?? probeLocalStats;
  const readCache = opts.readCache ?? readStatsCache;
  const writeCache = opts.writeCache ?? writeStatsCache;
  const self = opts.selfName;
  const cache = opts.forceRefresh ? {} : readCache();

  const stats = new Map<string, DeviceStats>();
  const toProbe: DeviceProfile[] = [];
  let servedFromCache = false;

  for (const d of devices) {
    if (d.name === self) {
      // This machine is always probed locally — cheap, no ssh, always live.
      toProbe.push(d);
      continue;
    }
    const cached = cache[d.name];
    if (cached) {
      stats.set(d.name, cached);
      servedFromCache = true;
    } else {
      toProbe.push(d);
    }
  }

  if (toProbe.length > 0) {
    const probed = await probeFleet(toProbe, { selfName: self });
    const fresh: Record<string, DeviceStats> = {};
    for (const [name, s] of probed) {
      stats.set(name, s);
      fresh[name] = s;
    }
    if (Object.keys(fresh).length > 0) writeCache(fresh);
  }

  // Guarantee a row for this machine even when it isn't in the passed device
  // list (e.g. self not registered as an ssh target) — matches the old callers'
  // explicit local fallback.
  if (self && !stats.has(self)) {
    stats.set(self, await probeLocal(self));
  }

  let oldest: number | null = null;
  for (const s of stats.values()) {
    if (oldest === null || s.fetchedAt < oldest) oldest = s.fetchedAt;
  }
  return { stats, oldestFetchedAt: oldest, servedFromCache };
}
