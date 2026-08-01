/**
 * Smart launch: pick device + harness from usage affinity, then leave account
 * selection to `--strategy balanced` (live rate-limit windows in rotate.ts).
 *
 * Probability model (per axis):
 *   P(x) ∝ launches(x)^α   among eligible candidates
 * Most-used gets the highest probability; never a hard lock (sample, not argmax).
 */

import type { AgentId } from './types.js';
import { queryAffinityRollup, type AffinityRow } from './session/db.js';
import { localMachineId } from './session/origin-machine.js';
import { loadDevicesSync } from './devices/registry.js';
import { normalizeHost } from './machine-id.js';

/** Default harness allowlist for auto-pick. */
export const DEFAULT_SMART_HARNESSES: AgentId[] = ['claude', 'codex', 'kimi'];

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

export interface SmartLaunchOptions {
  /** Fixed harness (skip harness sample). */
  agent?: AgentId;
  /** When true and agent unset, sample harness from allowlist. */
  pickHarness?: boolean;
  allowAgents?: AgentId[];
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
  harnessAffinity?: AffinityRow[];
  rng?: () => number;
  project?: string;
}

export interface SmartLaunchPlan {
  /** null means run locally (do not pass --host). */
  host: string | null;
  agent: AgentId;
  /** Account strategy the caller must use. Always balanced for smart launch. */
  accountStrategy: 'balanced';
  deviceCandidates: WeightedCandidate[];
  harnessCandidates: WeightedCandidate[];
  pickedDeviceKey: string | null;
  pickedHarnessKey: string | null;
}

/**
 * Resolve host + harness for an unpinned launch. Does NOT pick accounts —
 * caller runs `agents run <agent> --host <host> --strategy balanced`.
 */
export function resolveSmartLaunch(opts: SmartLaunchOptions = {}): SmartLaunchPlan {
  const local = normalizeHost(opts.localMachine ?? localMachineId());
  const alpha = opts.alpha ?? DEFAULT_AFFINITY_ALPHA;
  const rng = opts.rng ?? Math.random;
  const sinceDays = opts.sinceDays ?? 14;
  const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const allow = opts.allowAgents ?? DEFAULT_SMART_HARNESSES;

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

  // Restrict affinity to online hosts. Hosts with history get launches^α;
  // online hosts with no history still participate at weight 1 (exploration).
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

  let agent: AgentId;
  let harnessWeights: WeightedCandidate[] = [];
  let pickedHarnessKey: string | null = null;

  if (opts.agent) {
    agent = opts.agent;
    pickedHarnessKey = opts.agent;
  } else if (opts.pickHarness) {
    const harnessRows =
      opts.harnessAffinity ??
      queryAffinityRollup({
        groupBy: 'agent',
        sinceMs,
        agents: allow as import('./session/types.js').SessionAgentId[],
        excludeTeamOrigin: true,
        onlyCli: true,
        project: opts.project,
      });
    harnessWeights = affinityWeights(
      harnessRows.filter((r) => allow.includes(r.key as AgentId)),
      alpha,
    );
    if (harnessWeights.length === 0) {
      harnessWeights = allow.map((key) => ({ key, launches: 1, weight: 1 }));
    }
    pickedHarnessKey = sampleWeighted(harnessWeights, rng) ?? allow[0];
    agent = (pickedHarnessKey as AgentId) ?? allow[0];
  } else {
    agent = allow[0] ?? 'claude';
    pickedHarnessKey = agent;
  }

  return {
    host,
    agent,
    accountStrategy: 'balanced',
    deviceCandidates: deviceWeights,
    harnessCandidates: harnessWeights,
    pickedDeviceKey,
    pickedHarnessKey,
  };
}
