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
 * Step 3 is cap-aware: a device at its `agents.max-concurrent` cap (from the
 * device doc, passed in via PlacementOptions) is excluded from the auto-pick,
 * and an all-capped pool fails loud. Pins and pools of one are the user's own
 * choice and are never second-guessed.
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
 * Optional placement inputs beyond the team + roster. `maxConcurrent` maps a
 * device name to its `agents.max-concurrent` cap (from the device doc — read
 * locally via `readMaxConcurrentCaps`, never probed over SSH). Teams counts
 * the team's OWN roster against the cap (device-global counting would need an
 * SSH probe per candidate — out of the hot path; Factory auto-launch is the
 * device-wide counter). Only the least-loaded AUTO-PICK (cascade step 3)
 * honors caps: an explicit pin or a pool of one is the user's own choice and
 * is never second-guessed.
 */
export interface PlacementOptions {
  maxConcurrent?: Record<string, number>;
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

/** Count RUNNING teammates per pool device. Pure. A null/empty hostName is a
 * LOCAL teammate — it counts against the pool member that is this machine,
 * otherwise a cap on the local device could never engage. */
function loadByDevice(devices: string[], roster: RosterEntry[]): Map<string, number> {
  const load = new Map<string, number>();
  for (const d of devices) load.set(d, 0);
  for (const r of roster) {
    if (r.status !== 'running') continue;
    const host = r.hostName ? r.hostName : devices.find((d) => isLocalDevice(d));
    if (!host) continue; // local teammate but this machine is not in the pool
    if (load.has(host)) load.set(host, (load.get(host) ?? 0) + 1);
  }
  return load;
}

/**
 * Pool devices excluded from auto-pick because they are at (or over) their
 * `agents.max-concurrent` cap. Returned with the live counts so the caller can
 * state the reason to the user instead of the device silently never winning.
 */
export function cappedDevices(
  devices: string[],
  roster: RosterEntry[],
  maxConcurrent: Record<string, number>,
): Array<{ device: string; running: number; cap: number }> {
  const load = loadByDevice(devices, roster);
  const capped: Array<{ device: string; running: number; cap: number }> = [];
  for (const d of devices) {
    const cap = maxConcurrent[d];
    if (cap === undefined) continue;
    const running = load.get(d) ?? 0;
    if (running >= cap) capped.push({ device: d, running, cap });
  }
  return capped;
}

/**
 * Pick the least-loaded device from the pool — the one with the fewest RUNNING
 * teammates currently assigned to it. Ties break by pool order (first wins), so
 * an empty pool fills round-robin-ish as teammates launch. Pure: counts the
 * roster, no I/O.
 *
 * With `maxConcurrent`, devices at their cap are excluded; if EVERY device is
 * capped this throws naming each cap and the fix — a loud failure beats a
 * teammate silently landing on a machine its operator capped.
 */
export function pickLeastLoaded(
  devices: string[],
  roster: RosterEntry[],
  maxConcurrent?: Record<string, number>,
): string {
  if (devices.length === 0) {
    throw new Error('pickLeastLoaded called with an empty device pool');
  }
  const load = loadByDevice(devices, roster);
  const capped = new Set(
    maxConcurrent ? cappedDevices(devices, roster, maxConcurrent).map((c) => c.device) : [],
  );
  const eligible = devices.filter((d) => !capped.has(d));
  if (eligible.length === 0) {
    const detail = devices
      .map((d) => `${d} (${load.get(d) ?? 0}/${maxConcurrent![d]})`)
      .join(', ');
    throw new Error(
      `Every device in the pool is at its agents.max-concurrent cap: ${detail}. ` +
        `Raise a cap with 'agents devices configure <name> --max-agents N' or add a device to the pool.`,
    );
  }
  // Iterate the pool in declared order so the first device wins ties.
  let best = eligible[0];
  let bestLoad = load.get(best) ?? 0;
  for (const d of eligible) {
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
  opts?: PlacementOptions,
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
  // 3. Many → least-loaded across the pool (cap-aware when caps are provided).
  const picked = pickLeastLoaded(pool, roster, opts?.maxConcurrent);
  return { device: isLocalDevice(picked) ? null : picked };
}
