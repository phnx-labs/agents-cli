/**
 * Device source evaluator.
 *
 * A fleet device becomes the watched source. Reuses the real load/health probe
 * (lib/devices/health.ts) — the first scheduler consumer of it — so a monitor can
 * fire "when a box goes loaded / unreachable". The observation is
 * `<reachable>\t<headroom>` plus the full DeviceStats in meta, so an on-change
 * monitor fires on a headroom-bucket flip and a match monitor can match `loaded`.
 */

import { loadDevices } from '../../devices/registry.js';
import { probeDeviceStats, probeLocalStats, headroom } from '../../devices/health.js';
import { machineId, normalizeHost } from '../../machine-id.js';
import type { MonitorSource } from '../config.js';
import type { Observation } from './types.js';

/** Probe the device and return reachability + headroom bucket as the observation. */
export async function evaluate(source: MonitorSource): Promise<Observation | null> {
  const name = source.device;
  if (!name) return null;

  const registry = await loadDevices();
  const wanted = normalizeHost(name);
  const entry = Object.entries(registry).find(([k]) => normalizeHost(k) === wanted);

  // An unregistered / removed device must NOT silently fall back to the local
  // machine's stats — that would watch the wrong box under the requested name
  // (the "no fallback logic" convention). `add` validates --watch-device up
  // front, so this catches the device-removed-after-creation case at eval time.
  if (!entry) {
    return {
      raw: `error\tdevice not registered: ${name}`,
      meta: { error: true, reachable: false, device: name },
    };
  }

  const stats = normalizeHost(entry[0]) === machineId()
    ? await probeLocalStats(name)
    : await probeDeviceStats(entry[1]);

  const bucket = headroom(stats);
  return {
    raw: `${stats.reachable ? 'reachable' : 'unreachable'}\t${bucket}`,
    meta: {
      reachable: stats.reachable,
      headroom: bucket,
      loadPercent: stats.loadPercent,
      memPercent: stats.memPercent,
      ncpu: stats.ncpu,
    },
  };
}
