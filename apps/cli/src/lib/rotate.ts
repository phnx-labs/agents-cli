/**
 * Account rotation across agent versions.
 *
 * Detects which installed versions have expired credentials and rotates
 * authentication tokens so users maintain active sessions across version switches.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, RunStrategy } from './types.js';
import type { FallbackEntry } from './exec.js';
import { getAccountInfo, type AccountInfo } from './agents.js';
import { readMeta, writeMeta, getHelpersDir } from './state.js';
import { listInstalledVersions, getVersionHomePath, resolveVersion } from './versions.js';
import { getProjectRunConfigs } from './run-config.js';
import { emit } from './events.js';
import {
  getUsageInfoByIdentity,
  getUsageLookupKey,
  deriveUsageStatusFromSnapshot,
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
 *   3. default: `balanced` (weighted-random across all healthy accounts by
 *      remaining headroom, skipping any that are currently rate-limited). A
 *      bare `agents run <agent>` — e.g. every new terminal the extension spawns
 *      — should spread load and never launch into a throttled account, rather
 *      than stick to the pinned default even when it's maxed.
 */
export function getConfiguredRunStrategy(agent: AgentId, startPath: string = process.cwd()): RunStrategy {
  return getProjectRunStrategy(agent, startPath)
    ?? normalizeRunStrategy(readMeta().run?.[agent]?.strategy)
    ?? 'balanced';
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
  const snapshot = candidate.usageSnapshot;
  if (snapshot && snapshot.windows.length > 0) {
    // Eligibility mirrors the `agents view` throttle badge exactly
    // (deriveUsageStatusFromSnapshot): an account maxed on ANY blocking window —
    // including the 5-hour session window — cannot serve the next request, so it
    // must not be picked. Previously this checked only non-session windows
    // (getRoutingUsedPercent), so a session-maxed account with weekly headroom
    // stayed "eligible" and the router kept launching into it while `ag view`
    // showed it rate-limited. Capacity *weighting* still ranks eligible accounts
    // by weekly headroom; this gate only decides can-it-run-right-now.
    return deriveUsageStatusFromSnapshot(snapshot) !== 'rate_limited';
  }

  // No live snapshot: fall back to the coarse cached status.
  if (candidate.usageStatus === 'out_of_credits' || candidate.usageStatus === 'rate_limited') {
    return false;
  }

  return true;
}

/**
 * Whether a specific account can serve a run right now, and — when it can't —
 * why. `signed_out` covers no-email / invalid-auth; `rate_limited` and
 * `out_of_credits` name the throttle. Used to pre-warn on a version-pinned
 * teammate whose account rotation won't route around (a pin IS the target).
 */
export type AccountReadiness =
  | { ready: true }
  | { ready: false; reason: 'rate_limited' | 'out_of_credits' | 'signed_out'; email: string | null };

/**
 * Pure decision reusing the router's own eligibility gate (`hasUsageAvailable`
 * + email/auth, i.e. `isRotationEligible`), so a pre-flight warning can NEVER
 * disagree with what rotation would actually do. The `reason` combines the two
 * signals `hasUsageAvailable` reads: the live snapshot (session-inclusive
 * rate-limit) and the coarse cached `usageStatus` (out-of-credits, which a
 * snapshot never carries). When a live snapshot exists it wins over the cached
 * status — matching the gate — so a stale `out_of_credits` cache is not
 * reported while the account is actually serving requests.
 */
export function readinessFromCandidate(candidate: RotateCandidate): AccountReadiness {
  if (!candidate.email || !candidate.authValid) {
    return { ready: false, reason: 'signed_out', email: candidate.email };
  }
  if (hasUsageAvailable(candidate)) {
    return { ready: true };
  }
  const snap = candidate.usageSnapshot;
  const snapRateLimited =
    !!snap && snap.windows.length > 0 && deriveUsageStatusFromSnapshot(snap) === 'rate_limited';
  const reason: 'rate_limited' | 'out_of_credits' =
    !snapRateLimited && candidate.usageStatus === 'out_of_credits' ? 'out_of_credits' : 'rate_limited';
  return { ready: false, reason, email: candidate.email };
}

/**
 * Readiness for a specific installed (agent, version). Returns `{ ready: true }`
 * when the version isn't among the collected candidates — absence is the
 * caller's `isVersionInstalled` concern, not ours; don't cry wolf. Only
 * meaningful for a version-pinned target: a bare target rotates to a healthy
 * account on its own, and a profile injects its own auth (a different account
 * than the version home carries), so neither is checkable here.
 */
export async function checkRunAccountReadiness(agent: AgentId, version: string): Promise<AccountReadiness> {
  const candidates = await collectRunCandidates(agent);
  const candidate = candidates.find((c) => c.version === version);
  if (!candidate) return { ready: true };
  return readinessFromCandidate(candidate);
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
 * Eligibility: signed in (email present), auth valid, and not currently
 * rate-limited — no blocking window (session OR weekly) at 100%, matching the
 * `agents view` badge; or the local cached status is usable when no live
 * snapshot exists. Note the split: eligibility considers the session window
 * (a session-maxed account can't run now), but the capacity *weight* above is
 * driven by weekly headroom so a brief session spike doesn't distort routing.
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
    emit('rotation.resolved', { module: 'rotate', agent, version: rotation.picked.version, strategy, healthy: rotation.healthy.length, excluded: rotation.excluded.length });
    return { version: rotation.picked.version, rotation };
  }

  return { version: fallback, rotation: null };
}

/**
 * Cap on the number of healthy accounts a single run will re-dispatch through
 * after a mid-run rate limit. Bounds the synthesized chain so a machine signed
 * into many accounts can't turn one 429 into an unbounded cascade of retries.
 */
export const DEFAULT_ROTATION_FAILOVER_LIMIT = 3;

/**
 * Synthesize a same-agent, cross-account fallback chain from a pre-flight
 * rotation result (issue #348: mid-run rate-limit failover).
 *
 * The account rotation picks ONE version pre-spawn; today a 429 mid-run kills
 * the run with no recovery. `runWithFallback` + `detectRateLimit` already
 * re-dispatch to the NEXT chain entry on a rate limit and hand off the session
 * via `/continue <id>` — but only for explicit `--fallback` chains. This turns
 * the OTHER healthy rotation candidates (every account except the one already
 * picked as the primary) into `FallbackEntry`s so that SAME machinery re-runs
 * the task on the next healthy account of the same agent when the primary 429s.
 *
 * Each account is a distinct installed version (its own home/auth), so the
 * entries are same-agent, different-version — exactly what runWithFallback
 * spawns and what buildFallbackPrompt continues (claude→claude via `/continue`).
 * Candidates are consumed in `rotation.healthy` order, which is sorted by
 * remaining capacity (most headroom first, see compareCandidates), so failover
 * prefers the freshest account.
 *
 * Returns `[]` when there is no rotation (pinned strategy) or the picked account
 * is the only healthy one — so single-account users and non-rotation runs are
 * completely unchanged.
 */
export function rotationFailoverChain(
  rotation: RotateResult | null,
  pickedVersion: string,
  limit: number = DEFAULT_ROTATION_FAILOVER_LIMIT,
): FallbackEntry[] {
  if (!rotation || limit <= 0) return [];
  const chain: FallbackEntry[] = [];
  for (const candidate of rotation.healthy) {
    if (candidate.version === pickedVersion) continue; // the primary account
    chain.push({ agent: candidate.agent, version: candidate.version });
    if (chain.length >= limit) break;
  }
  return chain;
}

/**
 * Whether a run is eligible to have a mid-run rate-limit failover chain armed
 * (issue #348). Failover injects synthesized `FallbackEntry`s into the same
 * `fallback` array that `--fallback` uses — so it must NOT arm for run shapes
 * that reject a non-empty fallback chain, or the run hard-exits on a flag the
 * user never passed. Specifically:
 *
 * - `acp` and `loop` runs bail with "not compatible with --fallback yet" the
 *   moment `fallback.length > 0` (src/commands/exec.ts), so arming failover
 *   would break a previously-working `agents run … --loop` / `--acp`.
 * - `resumeCheckpoint` runs take the loop path (same guard).
 * - `interactive` / no-prompt runs can't be re-dispatched headlessly.
 * - `hasRotation`/`hasVersion` gate on an actual pre-flight rotation having
 *   picked an account, so pinned and non-rotation runs are untouched.
 *
 * An explicit `--fallback` chain does NOT disarm rotation failover: the
 * synthesized same-agent entries are unshifted AHEAD of the user's cross-agent
 * entries, so a rate limit exhausts the other accounts of the same agent
 * before cascading to a different CLI. Profile fallbacks never reach here —
 * strategy resolution is skipped for profiles, so hasRotation is false.
 *
 * Pure so the arming matrix is unit-testable without invoking the run command.
 */
export interface FailoverArmingContext {
  hasRotation: boolean;
  hasVersion: boolean;
  hasPrompt: boolean;
  interactive: boolean;
  acp: boolean;
  loop: boolean;
  resumeCheckpoint: boolean;
}

export function shouldArmRotationFailover(ctx: FailoverArmingContext): boolean {
  return (
    ctx.hasRotation &&
    ctx.hasVersion &&
    ctx.hasPrompt &&
    !ctx.interactive &&
    !ctx.acp &&
    !ctx.loop &&
    !ctx.resumeCheckpoint
  );
}
