/**
 * Runtime placement resolution for routines: local / host / fleet / cloud.
 *
 * The scheduler only decides *whether* this machine may fire the job
 * (`devices` + `jobRunsOnThisDevice`). This module decides *where the job
 * body runs* once it has been fired, using `hostStrategy`.
 *
 * Fleet semantics (RUSH-2035 / RUSH-1980): pick exactly one online device per
 * fire. Cross-device double-fire is prevented by requiring a `devices` firing
 * pin for fleet/host/cloud strategies (applied at add/sync time).
 */

import type { JobConfig, HostStrategy } from './routines.js';
import { resolveHostStrategy } from './routines.js';
import { machineId, normalizeHost } from './machine-id.js';
import { loadDevicesSync } from './devices/registry.js';
import { planFleetTargets } from './devices/fleet.js';

export type PlacementTarget =
  | { mode: 'local' }
  | { mode: 'host'; host: string }
  | { mode: 'cloud' };

/**
 * Pick one online fleet device for `hostStrategy: fleet`.
 *
 * Preference order:
 * 1. This machine, if online and eligible (avoids needless SSH)
 * 2. First eligible online device by name (stable / deterministic)
 *
 * When `config.devices` is set it is treated as an *execution* allowlist for
 * the pick (in addition to its firing role). Control / offline / no-address
 * devices are never chosen.
 */
export function pickFleetDevice(config: Pick<JobConfig, 'devices'>): string | null {
  let reg: ReturnType<typeof loadDevicesSync>;
  try {
    reg = loadDevicesSync();
  } catch {
    return null;
  }
  const planned = planFleetTargets(reg);
  let candidates = planned.filter((t) => !t.skip).map((t) => t.device.name);
  if (config.devices && config.devices.length > 0) {
    const allow = new Set(config.devices.map((d) => normalizeHost(d)));
    candidates = candidates.filter((n) => allow.has(normalizeHost(n)));
  }
  if (candidates.length === 0) {
    // No registry / nothing online: fall back to self so a single-box fleet
    // without a registry entry still runs locally.
    return machineId();
  }
  const self = machineId();
  const selfMatch = candidates.find((n) => normalizeHost(n) === self);
  if (selfMatch) return selfMatch;
  return [...candidates].sort((a, b) => a.localeCompare(b))[0] ?? null;
}

/**
 * Resolve where a fired job's body should execute.
 * Throws a human-readable Error when placement cannot be satisfied.
 */
export function resolvePlacementTarget(config: JobConfig): PlacementTarget {
  const strategy: HostStrategy = resolveHostStrategy(config);
  switch (strategy) {
    case 'local':
      return { mode: 'local' };
    case 'host': {
      if (!config.host || config.host.trim() === '') {
        throw new Error(
          `Routine '${config.name}' has hostStrategy: host but no host: — set host: or --run-on`,
        );
      }
      // host: pointing at this machine is local execution (no SSH loop).
      if (normalizeHost(config.host) === machineId()) return { mode: 'local' };
      return { mode: 'host', host: config.host };
    }
    case 'fleet': {
      const picked = pickFleetDevice(config);
      if (!picked) {
        throw new Error(
          `Routine '${config.name}' hostStrategy: fleet — no eligible online device to place the run`,
        );
      }
      if (normalizeHost(picked) === machineId()) return { mode: 'local' };
      return { mode: 'host', host: picked };
    }
    case 'cloud':
      return { mode: 'cloud' };
  }
}
