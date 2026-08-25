/**
 * One reachability resolver for the fleet render (RUSH-1965).
 *
 * "Is this device online?" had three disagreeing answers: the live SSH probe
 * (`DeviceStats.reachable`, display-only), the persisted registry verdict, and
 * the cached `tailscale.online` snapshot that the online/offline word actually
 * read. A box reachable every day but whose tailscale snapshot was stale (or a
 * `via:"manual"` device that never got a tailscale field at all) rendered
 * "offline forever". This module is the single ordering the render + the
 * write-back both go through, so the word and the persisted truth agree.
 */
import type { DeviceProfile, DeviceReachability, DeviceRegistry } from './registry.js';
import type { DeviceStats } from './health.js';

export type OnlineState = 'online' | 'offline' | 'unknown';

/**
 * Resolve a device's online/offline state, preferring the freshest signal.
 *
 * Precedence: a live stat from THIS run (the probe that just ran) > the
 * persisted reachability verdict written back by a prior probe > the cached
 * `tailscale.online` snapshot. 'unknown' only when nothing at all is known.
 */
export function deviceOnlineState(d: DeviceProfile, stats?: DeviceStats): OnlineState {
  if (stats) return stats.reachable ? 'online' : 'offline';
  if (d.reachability) return d.reachability.reachable ? 'online' : 'offline';
  if (d.tailscale) return d.tailscale.online ? 'online' : 'offline';
  return 'unknown';
}

/** Build the reachability verdict to persist from a fresh probe stat. Pure. */
export function reachabilityFromStats(d: DeviceProfile, stats: DeviceStats): DeviceReachability {
  return {
    reachable: stats.reachable,
    via: d.address?.via,
    checkedAt: new Date(stats.fetchedAt).toISOString(),
  };
}

/**
 * Collect the reachability verdicts to write back for a fleet's freshly-read
 * stats map. Only devices present in the registry are included (a stat for a
 * name we don't track is dropped rather than resurrected). Pure — the caller
 * hands the result to {@link writeReachability}.
 */
export function collectReachabilityWriteBacks(
  reg: DeviceRegistry,
  statsMap: Map<string, DeviceStats>,
): Record<string, DeviceReachability> {
  const out: Record<string, DeviceReachability> = {};
  for (const [name, stats] of statsMap) {
    const d = reg[name];
    if (!d) continue;
    out[name] = reachabilityFromStats(d, stats);
  }
  return out;
}
