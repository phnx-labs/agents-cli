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

import type { JobConfig, HostStrategy } from './scheduling/routines.js';
import { resolveHostStrategy } from './scheduling/routines.js';
import { machineId, normalizeHost } from './machine-id.js';
import { loadDevicesSync, type DevicePlatform } from './devices/registry.js';
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
 * `config.devices` is the *firing* allowlist only (which daemon may fire the
 * job). It is intentionally NOT used as an execution pool filter — otherwise
 * the double-fire pin (`devices: [self]`) would collapse fleet placement to
 * always-local. Offline / no-address devices are never chosen.
 */
export function pickFleetDevice(
  _config?: Pick<JobConfig, 'devices'>,
  platform?: DevicePlatform,
): string | null {
  let reg: ReturnType<typeof loadDevicesSync>;
  try {
    reg = loadDevicesSync();
  } catch {
    return null;
  }
  const planned = planFleetTargets(reg);
  const candidates = planned
    .filter((t) => !t.skip && (!platform || t.device.platform === platform))
    .map((t) => t.device.name);
  if (candidates.length === 0) {
    // No registry / nothing online: fall back to self so a single-box fleet
    // without a registry entry still runs locally. Only when no platform filter
    // was requested — an unmet filter must fail loud so e.g. `fleet/linux` never
    // silently lands on a macOS box.
    return platform ? null : machineId();
  }
  const self = machineId();
  const selfMatch = candidates.find((n) => normalizeHost(n) === self);
  if (selfMatch) return selfMatch;
  return [...candidates].sort((a, b) => a.localeCompare(b))[0] ?? null;
}

/**
 * Resolve where a fired job's body should execute.
 * Throws a human-readable Error when placement cannot be satisfied.
 *
 * `host: 'auto'` under `hostStrategy: fleet` re-picks a healthy, signed-in,
 * unloaded device AT EACH FIRE via the same picker `agents run --device auto`
 * uses (`resolveDeviceAuto`), instead of `pickFleetDevice`'s
 * first-online-by-name order. The decision is deliberately not baked in at add
 * time — fleet health at fire time is the whole point (RUSH-2719).
 */
export async function resolvePlacementTarget(
  config: JobConfig,
  deps: { resolveDeviceAuto?: (agent?: string) => Promise<{ pickedDeviceKey: string }> } = {},
): Promise<PlacementTarget> {
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
      let picked: string | null;
      if (config.host === 'auto') {
        const resolveAuto = deps.resolveDeviceAuto
          ?? (async (agent?: string) => (await import('./smart-launch.js')).resolveDeviceAuto(agent));
        // resolveDeviceAuto fails loud on an empty/unhealthy pool — surface its
        // message (it names each excluded device) instead of a generic one.
        const plan = await resolveAuto(config.agent);
        picked = plan.pickedDeviceKey;
      } else {
        picked = pickFleetDevice(config);
      }
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
