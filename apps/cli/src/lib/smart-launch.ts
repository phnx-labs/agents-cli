/**
 * Device affinity for `--device auto` / `--host auto`.
 *
 * Picks a host from 14d session usage (launches by machine), weighted sample
 * among online devices. Most-used has highest probability — not a hard lock.
 * Account selection is separate (`--strategy balanced` / rotate.ts).
 */

import { queryAffinityRollup, type AffinityRow } from './session/db.js';
import { localMachineId } from './session/origin-machine.js';
import { loadDevicesSync } from './devices/registry.js';
import { normalizeHost } from './machine-id.js';

/** Peakiness of usage weights; >1 amplifies the most-used option. */
export const DEFAULT_AFFINITY_ALPHA = 1.3;

export interface WeightedCandidate {
  key: string;
  launches: number;
  weight: number;
}

/**
 * Convert affinity rows into positive weights: launches^α (floor 1 for any
 * row with launches > 0 so a single-use host still participates).
 */
export function affinityWeights(
  rows: AffinityRow[],
  alpha: number = DEFAULT_AFFINITY_ALPHA,
): WeightedCandidate[] {
  return rows
    .filter((r) => r.launches > 0 && r.key && r.key !== '(unknown)')
    .map((r) => ({
      key: r.key,
      launches: r.launches,
      weight: Math.max(1, Math.pow(r.launches, alpha)),
    }));
}

/**
 * Weighted random sample. Returns null when candidates is empty.
 * Pure — inject `rng` for tests.
 */
export function sampleWeighted(
  candidates: WeightedCandidate[],
  rng: () => number = Math.random,
): string | null {
  if (candidates.length === 0) return null;
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  if (total <= 0) return candidates[0].key;
  let roll = rng() * total;
  for (const c of candidates) {
    roll -= c.weight;
    if (roll <= 0) return c.key;
  }
  return candidates[candidates.length - 1].key;
}

/** Online device names from the local registry (+ always include local). */
export function listOnlineDeviceNames(localName: string = localMachineId()): string[] {
  const names = new Set<string>([normalizeHost(localName)]);
  try {
    const reg = loadDevicesSync();
    for (const [name, d] of Object.entries(reg)) {
      if (!d || typeof d !== 'object') continue;
      const online = d.tailscale?.online;
      // No tailscale snapshot → treat as candidate (registry-only box).
      if (online === false) continue;
      names.add(normalizeHost(name));
    }
  } catch {
    /* registry missing — local only */
  }
  return [...names];
}

export interface DeviceAffinityOptions {
  sinceDays?: number;
  alpha?: number;
  /**
   * Eligible hosts (normalized). Defaults to online devices + local.
   * Empty after filter → fall back to local.
   */
  eligibleHosts?: string[];
  localMachine?: string;
  /** Injected affinity (tests). When omitted, reads sessions.db. */
  deviceAffinity?: AffinityRow[];
  rng?: () => number;
  project?: string;
}

export interface DeviceAffinityPlan {
  /** null means run locally (do not pass --host). */
  host: string | null;
  deviceCandidates: WeightedCandidate[];
  pickedDeviceKey: string | null;
}

/**
 * Resolve host for `--device auto`. Does NOT pick harness or accounts.
 */
export function resolveDeviceAffinity(opts: DeviceAffinityOptions = {}): DeviceAffinityPlan {
  const local = normalizeHost(opts.localMachine ?? localMachineId());
  const alpha = opts.alpha ?? DEFAULT_AFFINITY_ALPHA;
  const rng = opts.rng ?? Math.random;
  const sinceDays = opts.sinceDays ?? 14;
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  const eligible = new Set(
    (opts.eligibleHosts ?? listOnlineDeviceNames(local)).map(normalizeHost),
  );
  if (eligible.size === 0) eligible.add(local);

  const deviceRows =
    opts.deviceAffinity ??
    queryAffinityRollup({
      groupBy: 'machine',
      sinceMs,
      excludeTeamOrigin: true,
      onlyCli: true,
      project: opts.project,
    });

  // Hosts with history get launches^α; online hosts with no history explore at weight 1.
  const launchesByHost = new Map<string, number>();
  for (const r of deviceRows) {
    const k = normalizeHost(r.key);
    if (!eligible.has(k) || k === '(unknown)') continue;
    launchesByHost.set(k, (launchesByHost.get(k) ?? 0) + r.launches);
  }
  let deviceWeights: WeightedCandidate[] = [...eligible].map((key) => {
    const launches = launchesByHost.get(key) ?? 0;
    return {
      key,
      launches,
      weight: launches > 0 ? Math.max(1, Math.pow(launches, alpha)) : 1,
    };
  });
  if (deviceWeights.length === 0) {
    deviceWeights = [{ key: local, launches: 1, weight: 1 }];
  }

  const pickedDeviceKey = sampleWeighted(deviceWeights, rng);
  const hostNorm = pickedDeviceKey ? normalizeHost(pickedDeviceKey) : local;
  const host = hostNorm === local ? null : hostNorm;

  return {
    host,
    deviceCandidates: deviceWeights,
    pickedDeviceKey,
  };
}

/** True when a host flag value means affinity pick. */
export function isDeviceAuto(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'auto';
}

const HOST_SLOTS = ['host', 'device', 'on', 'computer'] as const;

export type DeviceAutoHostOptions = {
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
  /** @deprecated Hidden alias for `--device auto`. */
  smart?: boolean;
  balanced?: boolean;
  strategy?: string;
};

export type DeviceAutoApplyResult = {
  /** True when affinity ran (success or degrade-to-local). */
  attempted: boolean;
  /** True when deprecated `--smart` was seen. */
  deprecationSmart: boolean;
  /** Affinity threw: host slots cleared → local; message for stderr. */
  skipped?: string;
  /** Present when affinity resolved without error. */
  banner?: {
    hostLabel: string;
    deviceHint: string;
    acctNote: string;
  };
};

/**
 * Apply `--device auto` / `--host auto` (and deprecated `--smart`) onto run options.
 * Mutates `options` in place. On affinity failure, clears auto slots (local) and
 * returns `skipped` — never throws; callers must not hard-exit.
 */
export function applyDeviceAutoToOptions(
  options: DeviceAutoHostOptions,
  deps: {
    resolve?: () => DeviceAffinityPlan;
    accountPickerRequested?: boolean;
  } = {},
): DeviceAutoApplyResult {
  let deprecationSmart = false;

  if (options.smart) {
    const anyHost = HOST_SLOTS.some(
      (k) => typeof options[k] === 'string' && options[k]!.trim() !== '',
    );
    if (!anyHost) options.device = 'auto';
    deprecationSmart = true;
  }

  const hasAuto = HOST_SLOTS.some((k) => isDeviceAuto(options[k]));
  if (!hasAuto) {
    return { attempted: false, deprecationSmart };
  }

  try {
    const plan = (deps.resolve ?? (() => resolveDeviceAffinity({})))();
    const concrete = plan.host; // null = local
    for (const k of HOST_SLOTS) {
      if (isDeviceAuto(options[k])) {
        options[k] = concrete ?? undefined;
      }
    }
    const accountPickerRequested = deps.accountPickerRequested ?? false;
    if (!accountPickerRequested && !options.strategy && !options.balanced) {
      options.balanced = true;
    }
    const hostLabel = concrete ?? 'local';
    const deviceHint = plan.deviceCandidates
      .slice(0, 4)
      .map((c) => `${c.key}:${c.launches}`)
      .join(', ');
    const acctNote = accountPickerRequested ? 'accounts=picker' : 'accounts=balanced';
    return {
      attempted: true,
      deprecationSmart,
      banner: { hostLabel, deviceHint, acctNote },
    };
  } catch (err) {
    // Graceful degrade: clear auto slots so the run continues locally.
    for (const k of HOST_SLOTS) {
      if (isDeviceAuto(options[k])) {
        options[k] = undefined;
      }
    }
    return {
      attempted: true,
      deprecationSmart,
      skipped: (err as Error).message,
    };
  }
}
