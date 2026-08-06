/**
 * Live pool probing for the teams placement scheduler (RUSH-2002).
 *
 * Gathers one {@link DevicePlacementSignal} per pool device so the pure pick in
 * {@link ./scheduler} can filter unreachable / overloaded / not-installed
 * devices and rank the rest. Two concerns, both best-effort:
 *
 *   - reachability + headroom + load  ← {@link probeFleetStats} (one parallel
 *     SSH fan-out over the pool; the local box is measured directly).
 *   - requested agent installed (+ signed in, locally)  ← a one-shot readiness
 *     probe per remote device ({@link buildReadyProbeCommand} → `agents view`),
 *     the local box via {@link checkCliAvailable}/{@link checkCliSignedIn}.
 *
 * The result is cached briefly per (pool, agent) so a `teams start` wave that
 * places N teammates probes the pool ONCE, not N times — the roster-count part
 * of the rank stays live (the pure pick recounts the roster each call), only the
 * SSH-measured load/harness snapshot is reused within the TTL.
 *
 * All SSH here is via `execFile` (async, bounded) so the whole pool is probed in
 * parallel; a slow or wedged box degrades to "no signal" instead of blocking the
 * launch. Remote sign-in is deliberately left unknown — sign-in detection is
 * unreliable over SSH (see {@link checkCliSignedIn}); it ranks the local box
 * only, and the install gate (not sign-in) is what drives the fail-loud.
 */
import { execFile } from 'child_process';
import { probeFleetStats, headroom } from '../devices/health.js';
import { loadDevicesSync, type DeviceProfile } from '../devices/registry.js';
import { buildSshInvocation, writeAskpassShim } from '../devices/connect.js';
import { buildReadyProbeCommand, parseReadyProbe, viewHasAgent } from '../hosts/ready.js';
import { localMachineId } from '../session/origin-machine.js';
import { normalizeHost } from '../machine-id.js';
import { checkCliAvailable, checkCliSignedIn, type AgentType } from './agents.js';
import type { DevicePlacementSignal } from './scheduler.js';

/** Per-remote readiness probe budget — matches the health probe's short window
 * (`agents view` on a warm box is sub-second; a wedged one degrades to unknown). */
export const READY_PROBE_TIMEOUT_MS = 8_000;

/** How long a probed pool snapshot is reused within a `teams start` wave. Short
 * enough that a device coming online / going overloaded is seen next wave, long
 * enough that placing a wave of teammates does not re-fan-out per teammate. */
export const SIGNAL_TTL_MS = 15_000;

interface CacheEntry {
  at: number;
  signals: Map<string, DevicePlacementSignal>;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(pool: string[], agent: string): string {
  return `${agent}::${[...pool].map(normalizeHost).sort().join(',')}`;
}

/** Clear the probe cache — for tests and after a device-registry change. */
export function clearPlacementSignalCache(): void {
  cache.clear();
}

/**
 * Whether the requested agent is installed on a REMOTE device, via one SSH
 * readiness probe. `undefined` when the probe could not answer (ssh/login
 * failure) — reachability is then left to {@link probeFleetStats}; `false` when
 * the box answered but agents-cli or the agent is absent (a genuine can't-run).
 */
function probeRemoteInstalled(device: DeviceProfile, agent: string): Promise<boolean | undefined> {
  let args: string[];
  let env: Record<string, string>;
  try {
    const shim = writeAskpassShim();
    const cmd = buildReadyProbeCommand(device.shell === 'powershell' ? 'windows' : undefined);
    // agentOnly: a read-only probe must never force a foreground Touch ID sheet
    // on a password-auth device (mirrors probeDeviceStats in devices/health).
    ({ args, env } = buildSshInvocation(device, [cmd], shim, {}, { agentOnly: true }));
  } catch {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    execFile(
      'ssh',
      args,
      { encoding: 'utf-8', env: { ...process.env, ...env }, timeout: READY_PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err || !stdout) return resolve(undefined);
        const probe = parseReadyProbe(stdout);
        if (!probe.reachable) return resolve(undefined); // ssh/login issue → unknown
        if (!probe.version) return resolve(false); // agents-cli missing → cannot run
        resolve(viewHasAgent(probe.view, agent));
      },
    );
  });
}

/**
 * Probe every device in the team pool and return a name→signal map for the pure
 * placement pick. Devices with no data at all are omitted (the pick then neither
 * excludes nor prefers them). Never throws — a probe failure degrades to a
 * missing/partial signal.
 */
export async function probePoolSignals(
  pool: string[],
  agent: AgentType,
  opts: { force?: boolean; now?: number } = {},
): Promise<Map<string, DevicePlacementSignal>> {
  const now = opts.now ?? Date.now();
  const key = cacheKey(pool, agent);
  const cached = cache.get(key);
  if (!opts.force && cached && now - cached.at < SIGNAL_TTL_MS) return cached.signals;

  const reg = loadDevicesSync();
  const self = normalizeHost(localMachineId());
  const lookup = (name: string): DeviceProfile | undefined =>
    reg[name] ?? reg[normalizeHost(name)];

  const profiles: DeviceProfile[] = [];
  const seen = new Set<string>();
  for (const name of pool) {
    const d = lookup(name);
    if (d && !seen.has(d.name)) {
      profiles.push(d);
      seen.add(d.name);
    }
  }

  const selfProfile = profiles.find((d) => normalizeHost(d.name) === self);
  const stats = await probeFleetStats(profiles, { selfName: selfProfile?.name });

  type InstalledInfo = { installed: boolean | undefined; signedIn: boolean | undefined };
  const installed = new Map<string, InstalledInfo>(
    await Promise.all(
      profiles.map(async (d): Promise<readonly [string, InstalledInfo]> => {
        const isSelf = normalizeHost(d.name) === self;
        if (isSelf) {
          const inst = checkCliAvailable(agent)[0];
          const signedIn = inst ? await checkCliSignedIn(agent) : undefined;
          return [d.name, { installed: inst, signedIn }];
        }
        // Remote sign-in stays unknown (see the module docblock); the install
        // gate is what drives the fail-loud.
        return [d.name, { installed: await probeRemoteInstalled(d, agent), signedIn: undefined }];
      }),
    ),
  );

  const signals = new Map<string, DevicePlacementSignal>();
  for (const name of pool) {
    const d = lookup(name);
    const s = d ? stats.get(d.name) : undefined;
    const inst = d ? installed.get(d.name) : undefined;
    if (!s && !inst) continue; // fully unknown device — leave it out of the map
    signals.set(name, {
      reachable: s?.reachable,
      headroom: s ? headroom(s) : undefined,
      loadPercent: s?.loadPercent,
      memPercent: s?.memPercent,
      installed: inst?.installed,
      signedIn: inst?.signedIn,
    });
  }

  cache.set(key, { at: now, signals });
  return signals;
}
