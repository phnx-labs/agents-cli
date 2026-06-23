/**
 * Account rotation across agent versions.
 *
 * Detects which installed versions have expired credentials and rotates
 * authentication tokens so users maintain active sessions across version switches.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, RunStrategy } from './types.js';
import { getAccountInfo, type AccountInfo } from './agents.js';
import { readMeta, writeMeta, getHelpersDir } from './state.js';
import { listInstalledVersions, getVersionHomePath, resolveVersion } from './versions.js';
import { getProjectRunConfigs } from './run-config.js';
import {
  getUsageInfoByIdentity,
  getUsageLookupKey,
  type UsageSnapshot,
} from './usage.js';

function getRotateDir(): string {
  const dir = path.join(getHelpersDir(), 'rotate');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface RotateCandidate {
  agent: AgentId;
  version: string;
  email: string | null;
  /**
   * Per-org usage/quota key (e.g. `claude:org=<orgUuid>`) — the unit rate
   * limits are actually measured in. Distinct orgs signed in under the same
   * email have distinct keys, so this is the correct dedup boundary; null when
   * no usage identity is available (then we fall back to email).
   */
  usageKey: string | null;
  usageStatus: AccountInfo['usageStatus'];
  usageSnapshot: UsageSnapshot | null;
  authValid: boolean;
  lastActive: Date | null;
}

export interface RotateResult {
  /** The version picked for this run. */
  picked: RotateCandidate;
  /** Candidates that were considered healthy (including the picked one). */
  healthy: RotateCandidate[];
  /** Candidates excluded (not signed in, or out of credits). */
  excluded: RotateCandidate[];
}

export const RUN_STRATEGIES: RunStrategy[] = ['pinned', 'available', 'balanced'];

/**
 * Return a run strategy when the input is valid, otherwise null.
 *
 * `'rotate'` is accepted as a deprecated alias for `'balanced'` so old yaml
 * configs and `--strategy rotate` invocations keep working. The legacy alias
 * normalizes to `'balanced'` and uses the weighted-random algorithm.
 */
export function normalizeRunStrategy(value: unknown): RunStrategy | null {
  if (typeof value !== 'string') return null;
  if (value === 'rotate') return 'balanced';
  return RUN_STRATEGIES.includes(value as RunStrategy) ? value as RunStrategy : null;
}

/** Read project-local run strategy from the nearest agents.yaml, if present. */
export function getProjectRunStrategy(agent: AgentId, startPath: string): RunStrategy | null {
  for (const runConfig of getProjectRunConfigs(startPath)) {
    const strategy = normalizeRunStrategy(runConfig[agent]?.strategy);
    if (strategy) return strategy;
  }

  return null;
}

/**
 * Resolve the configured strategy. Lookup order:
 *   1. project-local agents.yaml (nearest to `startPath`)
 *   2. ~/.agents/.system/agents.yaml
 *   3. default: `available` (use the pinned default version when healthy,
 *      otherwise fall through to a healthy account so a single rate-limited
 *      account doesn't block the run).
 */
export function getConfiguredRunStrategy(agent: AgentId, startPath: string = process.cwd()): RunStrategy {
  return getProjectRunStrategy(agent, startPath)
    ?? normalizeRunStrategy(readMeta().run?.[agent]?.strategy)
    ?? 'available';
}

/** Persist the global run strategy used by bare `agents run <agent>`. */
export function setGlobalRunStrategy(agent: AgentId, strategy: RunStrategy): void {
  const meta = readMeta();
  if (!meta.run) meta.run = {};
  meta.run[agent] = { ...(meta.run[agent] ?? {}), strategy };
  writeMeta(meta);
}

function isRotationEligible(candidate: RotateCandidate): boolean {
  return !!candidate.email
    && candidate.authValid
    && hasUsageAvailable(candidate);
}

function isAvailableEligible(candidate: RotateCandidate): boolean {
  return !!candidate.email
    && candidate.authValid
    && hasUsageAvailable(candidate);
}

function hasUsageAvailable(candidate: RotateCandidate): boolean {
  const usedPercent = getRoutingUsedPercent(candidate.usageSnapshot);
  if (usedPercent !== null) {
    return usedPercent < 100;
  }

  if (candidate.usageStatus === 'out_of_credits' || candidate.usageStatus === 'rate_limited') {
    return false;
  }

  return true;
}

function getRoutingUsedPercent(snapshot: UsageSnapshot | null | undefined): number | null {
  if (!snapshot || snapshot.windows.length === 0) return null;
  const routingWindows = snapshot.windows.filter((window) => window.key !== 'session');
  const windows = routingWindows.length > 0 ? routingWindows : snapshot.windows;
  return Math.max(...windows.map((window) => window.usedPercent));
}

function compareCandidates(a: RotateCandidate, b: RotateCandidate): number {
  const au = getRoutingUsedPercent(a.usageSnapshot);
  const bu = getRoutingUsedPercent(b.usageSnapshot);

  if (au !== null || bu !== null) {
    if (au === null) return 1;
    if (bu === null) return -1;
    if (au !== bu) return au - bu;
  }

  const ta = a.lastActive ? a.lastActive.getTime() : 0;
  const tb = b.lastActive ? b.lastActive.getTime() : 0;
  if (ta !== tb) return ta - tb;
  return Math.random() - 0.5;
}

/**
 * Identity a candidate dedups on. Quota is tracked per-org, so two versions
 * that share an org are the same rate-limit bucket and must collapse — but two
 * orgs under the same email (e.g. Enterprise + Personal on one Google identity)
 * are genuinely separate buckets and must stay distinct. Prefer the org usage
 * key; fall back to email only when no usage identity is available.
 */
function candidateIdentity(c: RotateCandidate): string {
  return c.usageKey ?? c.email!;
}

function dedupeAndSortCandidates(candidates: RotateCandidate[]): RotateCandidate[] {
  const byIdentity = new Map<string, RotateCandidate>();
  for (const c of candidates) {
    const id = candidateIdentity(c);
    const existing = byIdentity.get(id);
    if (!existing) {
      byIdentity.set(id, c);
      continue;
    }
    if (compareCandidates(c, existing) < 0) byIdentity.set(id, c);
  }

  return [...byIdentity.values()].sort(compareCandidates);
}

/**
 * Pick a healthy candidate using weighted random by remaining capacity.
 *
 * Each healthy candidate gets weight = max(1, 100 - usedPercent) where
 * usedPercent is the highest-utilized non-session window (week / sonnet_week
 * for Claude). An account at 10% used gets weight 90; one at 90% used gets
 * weight 10 — so the fresher account is 9× more likely to be picked. Over N
 * calls, traffic distributes across healthy accounts proportional to their
 * headroom, with no stampede on the lowest-usage one. Stateless — parallel
 * callers naturally fan out via the random roll.
 *
 * Eligibility: signed in (email present), auth valid, and usage available
 * (any non-session window strictly under 100%, or local flag not exhausted
 * when no live snapshot exists).
 *
 * Dedupe: when multiple versions share an email, collapse to one candidate
 * per email (the least-recently-active version). Prevents two parallel pods
 * from "balancing" to different versions but hitting the same Anthropic
 * account and both 429ing.
 *
 * Returns null if no candidate is eligible — callers fall back to the pinned
 * version so behavior stays predictable.
 */
export function pickBalancedCandidate(candidates: RotateCandidate[]): RotateResult | null {
  const healthy: RotateCandidate[] = [];
  const excluded: RotateCandidate[] = [];
  for (const c of candidates) {
    if (!isRotationEligible(c)) {
      excluded.push(c);
      continue;
    }
    healthy.push(c);
  }

  if (healthy.length === 0) return null;

  const sorted = dedupeAndSortCandidates(healthy);
  const deduped = new Set(sorted);
  for (const c of healthy) {
    if (!deduped.has(c)) excluded.push(c);
  }

  const picked = weightedRandomByCapacity(sorted);
  return { picked, healthy: sorted, excluded };
}

/**
 * Pick one candidate from `sorted` using weights proportional to remaining
 * routing capacity. Floor each weight at 1 so a near-exhausted-but-still-
 * eligible candidate can still be picked occasionally. When usage is unknown
 * (no live snapshot), treat the candidate as full-capacity (weight 100) — we
 * have no signal to deprioritize it.
 */
function weightedRandomByCapacity(sorted: RotateCandidate[]): RotateCandidate {
  const weights = sorted.map((c) => {
    const used = getRoutingUsedPercent(c.usageSnapshot);
    if (used === null) return 100;
    return Math.max(1, 100 - used);
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return sorted[0];
  let roll = Math.random() * total;
  for (let i = 0; i < sorted.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return sorted[i];
  }
  return sorted[sorted.length - 1];
}

/**
 * Pick an available candidate. Prefers the configured pinned version when that
 * version has usage available; otherwise routes to the candidate with the most
 * usage headroom.
 */
export function pickAvailableCandidate(
  candidates: RotateCandidate[],
  preferredVersion?: string | null,
): RotateResult | null {
  const healthy: RotateCandidate[] = [];
  const excluded: RotateCandidate[] = [];
  for (const c of candidates) {
    if (!isAvailableEligible(c)) {
      excluded.push(c);
      continue;
    }
    healthy.push(c);
  }

  if (healthy.length === 0) return null;

  const sorted = dedupeAndSortCandidates(healthy);
  const deduped = new Set(sorted);
  for (const c of healthy) {
    if (!deduped.has(c)) excluded.push(c);
  }

  const preferred = preferredVersion
    ? sorted.find((candidate) => candidate.version === preferredVersion)
    : undefined;
  return { picked: preferred ?? sorted[0], healthy: sorted, excluded };
}

async function collectRunCandidates(agent: AgentId): Promise<RotateCandidate[]> {
  const versions = listInstalledVersions(agent);
  const rows = await Promise.all(
    versions.map(async (version) => {
      const home = getVersionHomePath(agent, version);
      const info = await getAccountInfo(agent, home);
      // `info.email` (from .claude.json's oauthAccount) is the auth heuristic.
      // We used to additionally call isClaudeAuthValid(home), which reads
      // "Claude Code-credentials-<hash>" from the system keychain. That item is
      // written by Claude Code itself with its own process in the ACL, so our
      // helper triggers a macOS keychain-authorization sheet on every probe —
      // one per installed version, every time `agents run` cold-starts. If
      // claude's stored token has actually expired, the spawned agent detects
      // it at its own startup and re-auths; that's the correct UX.
      const authValid = info.email != null;
      return {
        agent,
        version,
        home,
        info,
        email: info.email,
        usageStatus: info.usageStatus,
        authValid,
        lastActive: info.lastActive,
      };
    })
  );

  const { usageByKey } = await getUsageInfoByIdentity(
    rows.map(({ home, info, version }) => ({
      agentId: agent,
      home,
      cliVersion: version,
      info,
    }))
  );

  return rows.map(({ home: _home, info, ...candidate }) => {
    const usageKey = getUsageLookupKey(info);
    const usageSnapshot = usageKey
      ? usageByKey.get(usageKey)?.snapshot ?? null
      : null;
    return { ...candidate, usageKey, usageSnapshot };
  });
}

/**
 * Pick a healthy version for `agent` using weighted random by remaining
 * capacity. See `pickBalancedCandidate` for algorithm details.
 *
 * No external state — health and capacity are both read off per-version
 * AccountInfo (same data `agents view` surfaces). The weighted random roll
 * keeps parallel callers fanned out without rotation files or locks.
 *
 * Returns null if no installed version is eligible. Callers fall back to the
 * global default so behavior stays predictable — we never refuse to run.
 */
export async function selectBalancedVersion(agent: AgentId): Promise<RotateResult | null> {
  return pickBalancedCandidate(await collectRunCandidates(agent));
}

/** Select the configured version if available, otherwise another available version. */
export async function selectAvailableVersion(
  agent: AgentId,
  preferredVersion?: string | null,
): Promise<RotateResult | null> {
  return pickAvailableCandidate(await collectRunCandidates(agent), preferredVersion);
}

/**
 * Resolve the version `agents run` should use when the caller did not pin
 * one with `@version`. The caller supplies the effective strategy; if that
 * strategy cannot find a usable candidate, fall back to the pinned
 * workspace/global version.
 */
/**
 * Record a rotation pick so parallel callers see it as recently-used.
 * Writes a stamp file per agent — lightweight, no locking needed since
 * a torn write just means the next reader sees a stale timestamp (harmless).
 */
function recordRotationPick(agent: AgentId, version: string): void {
  const stampPath = path.join(getRotateDir(), `stamp-${agent}.json`);
  try {
    fs.writeFileSync(stampPath, JSON.stringify({ version, ts: Date.now() }), 'utf-8');
  } catch { /* best effort — doesn't block the run */ }
}

/**
 * Read the most recent rotation pick for an agent. Returns null if no stamp
 * or stamp is older than 60 seconds (stale).
 */
function readRotationStamp(agent: AgentId): string | null {
  const stampPath = path.join(getRotateDir(), `stamp-${agent}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(stampPath, 'utf-8')) as { version: string; ts: number };
    if (Date.now() - raw.ts < 60_000) return raw.version;
  } catch { /* missing or corrupt — treat as no stamp */ }
  return null;
}

export async function resolveRunVersion(agent: AgentId, strategy: RunStrategy, cwd: string = process.cwd()): Promise<{
  version: string | null;
  rotation: RotateResult | null;
}> {
  const fallback = resolveVersion(agent, cwd);
  if (strategy === 'pinned') {
    return { version: fallback, rotation: null };
  }

  const rotation = strategy === 'available'
    ? await selectAvailableVersion(agent, fallback)
    : await selectBalancedVersion(agent);

  if (rotation) {
    // `available` is sticky to the pinned default when healthy. Use the 60s
    // anti-collision stamp to nudge parallel callers off the same version.
    // `balanced` doesn't need this — its weighted random roll already
    // distributes naturally across healthy accounts.
    if (strategy === 'available') {
      const recentPick = readRotationStamp(agent);
      if (recentPick === rotation.picked.version && rotation.healthy.length > 1) {
        const alt = rotation.healthy.find(c => c.version !== recentPick);
        if (alt) rotation.picked = alt;
      }
      recordRotationPick(agent, rotation.picked.version);
    }
    return { version: rotation.picked.version, rotation };
  }

  return { version: fallback, rotation: null };
}
