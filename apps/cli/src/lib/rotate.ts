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
import { accountDisplayLabel, getAccountInfo, ALL_AGENT_IDS, type AccountInfo } from './agents.js';
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
import { readAccountHeadroom } from './fleet-cache.js';

function getRotateDir(): string {
  const dir = path.join(getHelpersDir(), 'rotate');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface RotateCandidate {
  agent: AgentId;
  version: string;
  accountKey: string | null;
  accountLabel: string;
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
  usageError: string | null;
  /**
   * Projected minutes until this account's 5-hour session window caps, as
   * computed by the daemon's burn-rate refresher and read from the headroom
   * cache. `null` when unknown (cold cache, idle, or not burning up). Balanced
   * routing deprioritizes an account projected to cap soon — see
   * {@link capacityWeight} — so a launch avoids an account racing toward its
   * limit, not just one already 100%-maxed.
   */
  usageMinutesToLimit: number | null;
  plan: string | null;
  signedIn: boolean;
  lastActive: Date | null;
}

export interface RotateResult {
  /** The version picked for this run. */
  picked: RotateCandidate;
  /** Candidates that were considered healthy (including the picked one). */
  healthy: RotateCandidate[];
  /** Candidates excluded (not signed in, or out of credits). */
  excluded: RotateCandidate[];
  /**
   * True when NO candidate on this machine had usage data fresh enough to decide
   * on, so the pick was made from unverified snapshots. Callers surface it —
   * routing blind is a fact the operator needs, not an internal detail.
   */
  usageUnverified?: boolean;
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
  return candidate.signedIn && hasUsageAvailable(candidate);
}

function isAvailableEligible(candidate: RotateCandidate): boolean {
  return isRotationEligible(candidate);
}

/**
 * How old a usage snapshot may be and still settle a routing DECISION.
 *
 * Deliberately far tighter than the 24h stale-while-revalidate window the
 * display paths use (`USAGE_CACHE_SWR_MS`): `agents view` rendering a slightly
 * old bar costs nothing, but the router choosing an account from one costs the
 * whole run. Measured case — `yosemite-s1` held snapshots 26h to 2.7 days old
 * with a failing refresh, so balanced read `muqsit@getrush.ai` as 48% used and
 * launched into it while the account was actually at its weekly cap.
 */
export const USAGE_DECISION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Whether this candidate's usage number is recent enough to route on. A missing
 * snapshot is unverified by definition — there is no number to trust.
 */
export function isUsageVerified(candidate: RotateCandidate, nowMs: number = Date.now()): boolean {
  const capturedAt = candidate.usageSnapshot?.capturedAt;
  if (!capturedAt) return false;
  return nowMs - capturedAt.getTime() <= USAGE_DECISION_MAX_AGE_MS;
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
 * why. `signed_out` covers a missing usable credential; `rate_limited` and
 * `out_of_credits` name the throttle. Used to pre-warn on a version-pinned
 * teammate whose account rotation won't route around (a pin IS the target).
 */
export type AccountReadiness =
  | { ready: true }
  | { ready: false; reason: 'rate_limited' | 'out_of_credits' | 'signed_out'; email: string | null };

/**
 * Pure decision reusing the router's own eligibility gate (`hasUsageAvailable`
 * + canonical signed-in state, i.e. `isRotationEligible`), so a pre-flight warning can NEVER
 * disagree with what rotation would actually do. The `reason` combines the two
 * signals `hasUsageAvailable` reads: the live snapshot (session-inclusive
 * rate-limit) and the coarse cached `usageStatus` (out-of-credits, which a
 * snapshot never carries). When a live snapshot exists it wins over the cached
 * status — matching the gate — so a stale `out_of_credits` cache is not
 * reported while the account is actually serving requests.
 */
export function readinessFromCandidate(candidate: RotateCandidate): AccountReadiness {
  if (!candidate.signedIn) {
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
  return c.usageKey ?? c.accountKey ?? c.email ?? `${c.agent}@${c.version}`;
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
 * Eligibility: signed in according to AccountInfo and not currently
 * rate-limited — no blocking window (session OR weekly) at 100%, matching the
 * `agents view` badge; or the local cached status is usable when no live
 * snapshot exists. Note the split: eligibility considers the session window
 * (a session-maxed account can't run now), but the capacity *weight* above is
 * driven by weekly headroom so a brief session spike doesn't distort routing.
 *
 * Dedupe: when multiple versions share a usage/account identity, collapse to
 * one candidate (the least-recently-active version). The org-scoped usage key
 * wins over email so same-email personal and Team accounts remain distinct.
 *
 * Returns null if no candidate is eligible — callers fall back to the pinned
 * version so behavior stays predictable.
 */
export function pickBalancedCandidate(
  candidates: RotateCandidate[],
  nowMs: number = Date.now(),
): RotateResult | null {
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

  const { picked, usageUnverified } = preferVerified(sorted, nowMs, weightedRandomByCapacity);
  return { picked, healthy: sorted, excluded, usageUnverified };
}

/**
 * Choose from the VERIFIED candidates when any exist, else from the whole pool.
 *
 * An eligible account whose usage we could not confirm is a guess, not a green
 * light: the snapshot reads "48% used" with equal confidence whether it was
 * captured a minute or three days ago, and a box whose refresh is failing stays
 * wrong indefinitely. Confirmed headroom therefore beats apparent headroom, even
 * when the unconfirmed number looks better.
 *
 * `healthy` deliberately keeps every eligible candidate rather than just the
 * verified ones. Declining to *pick* an account on stale data and declining to
 * *fail over to* it after the primary has already hit a 429 are different risks:
 * by then the alternative is not launching at all, so the failover chain
 * (rotationFailoverChain, which reads `healthy`) keeps its full safety net —
 * exactly on the machines this guard is protecting.
 */
function preferVerified(
  pool: RotateCandidate[],
  nowMs: number,
  choose: (from: RotateCandidate[]) => RotateCandidate,
): { picked: RotateCandidate; usageUnverified: boolean } {
  const verified = pool.filter((c) => isUsageVerified(c, nowMs));
  return {
    picked: choose(verified.length > 0 ? verified : pool),
    usageUnverified: verified.length === 0,
  };
}

/**
 * How far from its projected cap an account must be to keep its FULL headroom
 * weight. Inside this horizon the weight is scaled down linearly toward the
 * floor, so an account racing toward its 5h cap loses priority before it maxes.
 */
export const PROJECTION_HORIZON_MIN = 30;

/**
 * Weight one candidate by remaining routing capacity, deprioritized by how soon
 * it is projected to cap. The base is weekly headroom (`max(1, 100 - used)`);
 * an account with no live snapshot is treated as full-capacity (100) since there
 * is no signal to deprioritize it. `minutesToLimit` (the daemon's burn-rate
 * projection on the 5h session window) then scales that base: >= horizon (or
 * unknown) keeps full weight, and closer-to-cap scales toward the floor of 1 —
 * so a launch avoids an account projected to cap soon, not just a 100%-maxed
 * one. Pure + exported so the deprioritization is unit-tested directly (a
 * weighted-random draw is not).
 */
export function capacityWeight(
  usedPercent: number | null,
  minutesToLimit: number | null,
): number {
  const base = usedPercent === null ? 100 : Math.max(1, 100 - usedPercent);
  if (minutesToLimit === null || !Number.isFinite(minutesToLimit)) return base;
  const factor = Math.max(0, Math.min(1, minutesToLimit / PROJECTION_HORIZON_MIN));
  return Math.max(1, base * factor);
}

/**
 * Pick one candidate from `sorted` using weights proportional to remaining
 * routing capacity (see {@link capacityWeight}). Floor each weight at 1 so a
 * near-exhausted-but-still-eligible candidate can still be picked occasionally.
 */
function weightedRandomByCapacity(sorted: RotateCandidate[]): RotateCandidate {
  const weights = sorted.map((c) =>
    capacityWeight(getRoutingUsedPercent(c.usageSnapshot), c.usageMinutesToLimit),
  );
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
  nowMs: number = Date.now(),
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

  // `available` sorts by apparent headroom and takes the front of the list, so an
  // unconfirmed "48% used" outranks an accurate "90% used" — the same inversion
  // that put a launch on an exhausted account under `balanced`. It routes on the
  // same cache, so it gets the same rule: confirmed headroom first.
  const { picked: bestVerified, usageUnverified } = preferVerified(sorted, nowMs, (from) => from[0]);
  // An explicit version preference is an instruction, not a ranking signal, so it
  // still wins — but only while that version is actually eligible.
  const preferred = preferredVersion
    ? sorted.find((candidate) => candidate.version === preferredVersion)
    : undefined;
  return { picked: preferred ?? bestVerified, healthy: sorted, excluded, usageUnverified };
}

/**
 * Per-harness routing summary for `agents run auto` — the cross-harness layer
 * that sits above `pickBalancedCandidate` (which is strictly per-harness).
 */
export interface HarnessSummary {
  agent: AgentId;
  /** Every installed account slot probed for this harness. */
  candidates: RotateCandidate[];
  /** Healthy accounts after identity dedupe, sorted by headroom. */
  healthy: RotateCandidate[];
  /** The account this harness would route to (best verified headroom). Null when the harness is excluded. */
  best: RotateCandidate | null;
  /** Routing used% of `best` (max across non-session windows); null when unknown. */
  bestUsedPercent: number | null;
  /** Why the harness was excluded, e.g. ['2 rate_limited', '1 signed_out']. Empty when healthy. */
  exclusionReasons: string[];
}

export interface HarnessPickResult {
  /** The harness picked for this run. */
  picked: HarnessSummary;
  /** Harnesses with ≥1 healthy account (including the picked one). */
  healthy: HarnessSummary[];
  /** Harnesses with zero healthy accounts — excluded, not down-weighted. */
  excluded: HarnessSummary[];
}

/**
 * Classify every harness's candidates into healthy (with a representative
 * best account) vs excluded (with per-reason counts). Pure — the pick and the
 * zero-healthy error message both read this, so they can never disagree.
 *
 * Health uses the exact account-layer gate (`isRotationEligible`: signed in
 * AND not maxed on ANY blocking window, weekly included). The representative
 * best account honors `preferVerified`: confirmed headroom beats apparent
 * headroom, the same freshness rule the account layer routes on.
 */
export function classifyHarnessCandidates(
  byHarness: ReadonlyMap<AgentId, RotateCandidate[]>,
  nowMs: number = Date.now(),
): HarnessSummary[] {
  const summaries: HarnessSummary[] = [];
  for (const [agent, candidates] of byHarness) {
    const eligible = candidates.filter(isRotationEligible);
    if (eligible.length === 0) {
      const counts = new Map<string, number>();
      for (const c of candidates) {
        const readiness = readinessFromCandidate(c);
        const reason = readiness.ready ? 'ineligible' : readiness.reason;
        counts.set(reason, (counts.get(reason) ?? 0) + 1);
      }
      summaries.push({
        agent,
        candidates,
        healthy: [],
        best: null,
        bestUsedPercent: null,
        exclusionReasons: [...counts.entries()].map(([reason, n]) => `${n} ${reason}`),
      });
      continue;
    }
    const sorted = dedupeAndSortCandidates(eligible);
    const { picked: best } = preferVerified(sorted, nowMs, (from) => from[0]);
    summaries.push({
      agent,
      candidates,
      healthy: sorted,
      best,
      bestUsedPercent: getRoutingUsedPercent(best.usageSnapshot),
      exclusionReasons: [],
    });
  }
  return summaries;
}

/**
 * Pick a harness for `agents run auto` using weighted random by best-account
 * headroom (RUSH-2132).
 *
 * A harness's capacity is `100 − min(routingUsed% across its healthy accounts)`
 * — its best account's headroom. The pick reuses `weightedRandomByCapacity` on
 * the representative best accounts, so host/harness/account layers all share
 * one sampling behavior. Harnesses with zero healthy accounts are EXCLUDED,
 * not down-weighted. Returns null when no harness has any healthy account;
 * call `classifyHarnessCandidates` for the exclusion detail to message with.
 */
export function pickHarnessWeighted(
  byHarness: ReadonlyMap<AgentId, RotateCandidate[]>,
  nowMs: number = Date.now(),
): HarnessPickResult | null {
  const summaries = classifyHarnessCandidates(byHarness, nowMs);
  const healthy = summaries.filter((s) => s.best !== null);
  const excluded = summaries.filter((s) => s.best === null);
  if (healthy.length === 0) return null;
  const pickedBest = weightedRandomByCapacity(healthy.map((s) => s.best!));
  const picked = healthy.find((s) => s.best === pickedBest)!;
  return { picked, healthy, excluded };
}

/** One-line banner naming the auto-picked harness and why (headroom). */
export function formatHarnessPickBanner(result: HarnessPickResult): string {
  const { picked, healthy, excluded } = result;
  const headroom = picked.bestUsedPercent === null
    ? 'best account headroom unknown'
    : `best account ${Math.max(0, Math.round(100 - picked.bestUsedPercent))}% headroom`;
  const ratio = `${healthy.length} of ${healthy.length + excluded.length} harnesses healthy`;
  return `[agents] auto picked ${picked.agent} (${headroom}, ${ratio})`;
}

/**
 * The earliest FUTURE window reset across these candidates' usage snapshots —
 * when the first exhausted account becomes usable again. Null when no snapshot
 * carries a reset timestamp.
 */
export function earliestResetAcross(candidates: RotateCandidate[], nowMs: number = Date.now()): Date | null {
  let earliest: number | null = null;
  for (const c of candidates) {
    for (const window of c.usageSnapshot?.windows ?? []) {
      const t = window.resetsAt?.getTime();
      if (t != null && t > nowMs && (earliest === null || t < earliest)) {
        earliest = t;
      }
    }
  }
  return earliest === null ? null : new Date(earliest);
}

/**
 * The `resets <summary>` fragment both zero-healthy errors share. ISO 8601 so
 * a watchdog can parse the cooldown straight off the line; `unknown` when no
 * snapshot carries a reset (a parser falls back to its default cooldown).
 */
function formatResetSummary(reset: Date | null): string {
  return reset ? reset.toISOString() : 'unknown (no reset timestamps in any snapshot)';
}

/**
 * The zero-healthy-account error (RUSH-2132). EXACT contract — the Factory
 * watchdog tail-detects this text: it must contain the literal `no healthy`
 * and `resets <time>` (parsed for the rotate cooldown). Do not deviate.
 */
export function formatNoHealthyAccountError(
  agent: AgentId,
  strategy: RunStrategy,
  excluded: RotateCandidate[],
  nowMs: number = Date.now(),
): string {
  const excludedStr = excluded.length === 0
    ? 'no installed versions'
    : excluded.map((c) => {
        const readiness = readinessFromCandidate(c);
        const reason = readiness.ready ? 'ineligible' : readiness.reason;
        return `${c.version} (${reason})`;
      }).join(', ');
  const resetSummary = formatResetSummary(earliestResetAcross(excluded, nowMs));
  return `agents: no healthy ${agent} account under strategy '${strategy}' — excluded: ${excludedStr}; earliest window resets ${resetSummary}. Use --strategy pinned to force the default.`;
}

/**
 * The zero-healthy-harness error for `agents run auto` — names each harness's
 * exclusion reason plus the earliest reset across all snapshots.
 */
export function formatNoHealthyHarnessError(
  summaries: HarnessSummary[],
  nowMs: number = Date.now(),
): string {
  const excludedStr = summaries.length === 0
    ? 'no installed harnesses'
    : summaries.map((s) => {
        const n = s.candidates.length;
        const detail = s.exclusionReasons.length > 0 ? s.exclusionReasons.join(', ') : 'no accounts signed in';
        return `${s.agent} (${n} account${n === 1 ? '' : 's'}: ${detail})`;
      }).join(', ');
  const resetSummary = formatResetSummary(earliestResetAcross(summaries.flatMap((s) => s.candidates), nowMs));
  return `agents: no healthy harness for 'run auto' — excluded: ${excludedStr}; earliest window resets ${resetSummary}. Sign in an account or wait for a window to reset.`;
}

export async function collectRunCandidates(agent: AgentId): Promise<RotateCandidate[]> {
  const versions = listInstalledVersions(agent);
  const rows = await Promise.all(
    versions.map(async (version) => {
      const home = getVersionHomePath(agent, version);
      const info = await getAccountInfo(agent, home);
      // We used to additionally call isClaudeAuthValid(home), which reads
      // "Claude Code-credentials-<hash>" from the system keychain. That item is
      // written by Claude Code itself with its own process in the ACL, so our
      // helper triggers a macOS keychain-authorization sheet on every probe —
      // one per installed version, every time `agents run` cold-starts. If
      // claude's stored token has actually expired, the spawned agent detects
      // it at its own startup and re-auths; that's the correct UX.
      return {
        agent,
        version,
        home,
        info,
        accountKey: info.accountKey,
        accountLabel: accountDisplayLabel(info),
        email: info.email,
        usageStatus: info.usageStatus,
        plan: info.plan,
        signedIn: info.signedIn,
        lastActive: info.lastActive,
      };
    })
  );

  // These candidates feed a routing decision on the `agents run` hot path, so
  // this read is CACHE-ONLY (`readOnly`): it never blocks on a live provider
  // fetch. A snapshot older than USAGE_DECISION_MAX_AGE_MS is not trusted for
  // the pick — but the guard that enforces that is `isUsageVerified` below, not
  // a blocking refresh here. Keeping the cache fresh is the daemon's job
  // (`runUsageRefresh`, adaptive + rate-capped, sole-writer per local account),
  // so a cold `agents run` reads the last daemon-written snapshot instead of
  // stalling on N parallel HTTP round trips (the measured cold-start stall this
  // removes). A stale-or-absent snapshot routes as unverified, exactly as a
  // failed live read did before.
  const { usageByKey } = await getUsageInfoByIdentity(
    rows.map(({ home, info, version }) => ({
      agentId: agent,
      home,
      cliVersion: version,
      info,
    })),
    { readOnly: true }
  );

  return rows.map(({ home: _home, info, ...candidate }) => {
    const usageKey = getUsageLookupKey(info);
    const usage = usageKey ? usageByKey.get(usageKey) : undefined;
    // Projected headroom is a separate cache-only read (also off the network) —
    // the daemon publishes minutesToLimit; a cold cache yields null and routing
    // falls back to snapshot-only weighting.
    const headroom = usageKey ? readAccountHeadroom(usageKey) : null;
    return {
      ...candidate,
      usageKey,
      usageSnapshot: usage?.snapshot ?? null,
      usageError: usage?.error ?? null,
      usageMinutesToLimit: headroom?.minutesToLimit ?? null,
    };
  });
}

/**
 * Collect run candidates for every harness with ≥1 installed version — the
 * probe `agents run auto` routes on (the same per-harness account probe
 * `agents view` aggregates). Harnesses with nothing installed are absent from
 * the map: not a candidate at all, rather than an excluded one.
 */
export async function collectHarnessCandidates(
  agentIds: AgentId[] = ALL_AGENT_IDS,
): Promise<Map<AgentId, RotateCandidate[]>> {
  const entries = await Promise.all(
    agentIds.map(async (agent) => {
      if (listInstalledVersions(agent).length === 0) return null;
      return [agent, await collectRunCandidates(agent)] as const;
    }),
  );
  const byHarness = new Map<AgentId, RotateCandidate[]>();
  for (const entry of entries) {
    if (entry) byHarness.set(entry[0], entry[1]);
  }
  return byHarness;
}

/**
 * Resolve an account identity to the installed version slot that holds it, over
 * an already-collected candidate list. Pure — no I/O — so it is unit-tested
 * directly. Matches, case-insensitively, against a candidate's login `email`
 * (the usual form) or its `accountKey`, and only ever returns a signed-in slot.
 * Returns null when nothing matches, so the caller can fall back and warn.
 */
export function matchAccountVersion(
  candidates: RotateCandidate[],
  account: string,
): string | null {
  const needle = account.trim().toLowerCase();
  if (!needle) return null;
  const match = candidates.find(
    (c) =>
      c.signedIn &&
      (c.email?.toLowerCase() === needle || c.accountKey?.toLowerCase() === needle),
  );
  return match?.version ?? null;
}

/**
 * Resolve a routine's `account:` pin (login email or account key) to the
 * installed version currently holding that account. Thin I/O wrapper over
 * {@link collectRunCandidates} + {@link matchAccountVersion}; returns null when
 * no signed-in version matches. Pinning a routine to a distinct account is the
 * durable cure for the shared-single-use-refresh-token revocation storm
 * (RUSH-1957): the pinned run never rotates and never lands on another
 * routine's credential.
 */
export async function resolveAccountVersion(
  agent: AgentId,
  account: string,
): Promise<string | null> {
  const candidates = await collectRunCandidates(agent);
  return matchAccountVersion(candidates, account);
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

export async function resolveRunVersion(
  agent: AgentId,
  strategy: RunStrategy,
  cwd: string = process.cwd(),
  collect: (agent: AgentId) => Promise<RotateCandidate[]> = collectRunCandidates,
): Promise<{
  version: string | null;
  rotation: RotateResult | null;
  /**
   * Set when a non-pinned strategy found ZERO healthy candidates among the
   * installed versions: the full excluded set, so callers fail loud with
   * per-account reasons instead of launching the exhausted pinned default
   * (RUSH-2132). Undefined for pinned, for successful picks, and when no
   * version is installed at all (the pre-existing not-installed path — there
   * is no account to be "unhealthy").
   */
  exhausted?: RotateCandidate[];
}> {
  const fallback = resolveVersion(agent, cwd);
  if (strategy === 'pinned') {
    return { version: fallback, rotation: null };
  }

  const candidates = await collect(agent);
  const rotation = strategy === 'available'
    ? pickAvailableCandidate(candidates, fallback)
    : pickBalancedCandidate(candidates);

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

  return { version: fallback, rotation: null, exhausted: candidates.length > 0 ? candidates : undefined };
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
