/**
 * Placement scheduler for distributed teams.
 *
 * Decides WHERE an unpinned teammate runs, resolving the create→pin→pool→local
 * cascade from the team's device pool and the live roster. Kept pure and
 * I/O-free (plain data in, a device name or null out) so it is trivially
 * testable and can be called from the hot launch path without SSH round-trips.
 *
 *   1. teammate has an explicit `--device` pin      → that device
 *   2. else the team pool has exactly one device     → that device (whole team)
 *   3. else the team pool has many devices           → least-loaded pick
 *   4. else (no pin, no pool)                         → null == run local
 *
 * A device whose name equals the local machine id is treated as "local" — it
 * resolves to a null placement so the existing local spawn path runs unchanged,
 * letting the local machine participate in a pool as just another member.
 */
import { machineId } from '../session/sync/config.js';

/** Team fields the placement cascade reads (a subset of TeamMeta). */
export interface PlacementTeam {
  devices?: string[];
}

/**
 * A roster entry the load counter reads — the shape any teammate satisfies
 * (AgentProcess included). `status` is compared against `'running'` (the
 * AgentStatus.RUNNING value) without importing the enum, keeping this leaf pure.
 */
export interface RosterEntry {
  hostName: string | null;
  status: string;
}

/** True when `device` names the local machine (case-insensitive). */
function isLocalDevice(device: string): boolean {
  return device.toLowerCase() === machineId();
}

/**
 * Pick the least-loaded device from the pool — the one with the fewest RUNNING
 * teammates currently assigned to it. Ties break by pool order (first wins), so
 * an empty pool fills round-robin-ish as teammates launch. Pure: counts the
 * roster, no I/O.
 */
export function pickLeastLoaded(devices: string[], roster: RosterEntry[]): string {
  if (devices.length === 0) {
    throw new Error('pickLeastLoaded called with an empty device pool');
  }
  const load = new Map<string, number>();
  for (const d of devices) load.set(d, 0);
  for (const r of roster) {
    if (!r.hostName) continue;
    if (r.status !== 'running') continue;
    if (load.has(r.hostName)) load.set(r.hostName, (load.get(r.hostName) ?? 0) + 1);
  }
  // Iterate the pool in declared order so the first device wins ties.
  let best = devices[0];
  let bestLoad = load.get(best) ?? 0;
  for (const d of devices) {
    const l = load.get(d) ?? 0;
    if (l < bestLoad) {
      best = d;
      bestLoad = l;
    }
  }
  return best;
}

/**
 * Resolve where a teammate runs. Returns `{ device: null }` for a local run
 * (no pin, no pool, or the chosen device is the local machine) and
 * `{ device: <name> }` for a remote placement. See the cascade in the module
 * header.
 */
export function resolvePlacement(
  team: PlacementTeam,
  explicitDevice: string | null,
  roster: RosterEntry[],
): { device: string | null } {
  // 1. Explicit pin wins — even without a pool.
  if (explicitDevice) {
    return { device: isLocalDevice(explicitDevice) ? null : explicitDevice };
  }
  const pool = team.devices ?? [];
  // 4. No pool → local, exactly like today.
  if (pool.length === 0) return { device: null };
  // 2. Pool of one → the whole team runs there.
  if (pool.length === 1) {
    return { device: isLocalDevice(pool[0]) ? null : pool[0] };
  }
  // 3. Many → least-loaded across the pool.
  const picked = pickLeastLoaded(pool, roster);
  return { device: isLocalDevice(picked) ? null : picked };
}
