/**
 * Daemon-owned usage refresher (publisher host).
 *
 * The routing hot path (`agents run` → collectRunCandidates) reads usage
 * CACHE-ONLY (`getUsageInfoForIdentity`, RUSH-2061) and never blocks
 * on a provider fetch. Something still has to keep that cache fresh — this
 * module is that something, running inside the daemon on the configured
 * `usage.primary-host` (or locally when no primary is configured).
 *
 * Design:
 *
 *  - **Fleet sole writer.** Only the configured primary lists credential-backed
 *    accounts and calls providers. It exports derived snapshots/headroom;
 *    subscriber hosts import that token-free envelope (`usage-fleet.ts`).
 *  - **Fixed 5-minute cadence** (`REFRESH_INTERVAL_MS`). Enough to keep
 *    balanced/`agents view` off multi-hour stale data without thrashing
 *    provider APIs when the user runs agents frequently. The delay helpers
 *    still accept a burn projection for tests/future tuning, but the default
 *    floor and ceiling are both 5 minutes.
 *  - **Hard hourly cap** (`HOURLY_CALL_CAP`) so a stuck "due" loop cannot
 *    hammer an endpoint past ~12 calls/account/hour.
 *  - **429 backoff.** An account (or provider-wide scope) under
 *    `usageRateLimitedUntil` is skipped — no live fetch or re-armed penalty.
 *  - **File-only credentials on the daemon path.** Refresh never opens the
 *    ACL-bound macOS keychain item (Touch ID storm). It uses the no-ACL
 *    access-token cache / setup-token / `.credentials.json` only
 *    (`fileOnly: true` on `getUsageInfo`).
 *  - **Concurrency-safe cache writes.** Usage + headroom files are updated
 *    under `withFileLock` + atomic rename so a concurrent `agents view`
 *    background refresh cannot tear or drop another account's row.
 *
 * Scenarios (what this path must survive):
 *
 *  1. **Daemon tick overlaps a slow tick** — overlap guard in daemon.ts;
 *     second tick is a no-op.
 *  2. **`agents view` writes cache while daemon refreshes** — file lock
 *     serializes read-modify-write; no lost updates.
 *  3. **macOS keychain ACL / Touch ID** — fileOnly refresh never calls
 *     `security find-generic-password` on Claude's ACL item.
 *  4. **Account 429** — that account is skipped until Retry-After while its
 *     siblings continue; a provider-wide penalty still skips all accounts.
 *  5. **Expired access token (no refresh)** — usage path never rotates
 *     single-use refresh tokens; counts as `failed`, reschedules 5m later.
 *  6. **No file credential on this host** — account skipped / failed; no
 *     keychain fallback from the daemon refresher.
 *  7. **Grok/Codex (network:false)** — not listed by `buildLocalUsageAccounts`;
 *     their "cache" is local logs, not this HTTP refresher.
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';
import {
  deriveUsageHeadroom,
  getUsageInfo,
  buildCanonicalUsageContext,
  USAGE_SOURCE_AGENT_IDS,
  type UsageHeadroom,
  type UsageSnapshot,
  type UsageInfo,
  type UsageIdentityInput,
} from './accounting/usage.js';
import { getAccountInfo } from './agents.js';
import { listInstalledVersions, getVersionHomePath } from './installations/versions.js';
import type { AgentId } from './types.js';

/**
 * Default schedule between successful (or attempted) live usage fetches for one
 * account. Floor and ceiling of the delay helper are pinned to this so the
 * daemon does not poll faster than 5 minutes even under high burn, and does not
 * let an idle account rot longer than 5 minutes between attempts.
 */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** @deprecated alias — use {@link REFRESH_INTERVAL_MS}. Kept for test imports. */
export const REFRESH_MIN_MS = REFRESH_INTERVAL_MS;
/** @deprecated alias — use {@link REFRESH_INTERVAL_MS}. Kept for test imports. */
export const REFRESH_MAX_MS = REFRESH_INTERVAL_MS;
/** Burn-rate divisor retained for the pure delay helper / tests; with min=max
 * the divisor does not change the scheduled interval. */
export const REFRESH_BURN_DIVISOR = 4;
/** At most this many live fetches per account per rolling hour (5m cadence ⇒ 12). */
export const HOURLY_CALL_CAP = 12;
/** How often the daemon wakes to *consider* a refresh pass (due accounts only). */
export const USAGE_REFRESH_TICK_MS = 60 * 1000;
/** Consecutive failed live reads before one broken account is quarantined. */
export const FAILURE_QUARANTINE_THRESHOLD = 3;
/** A chronic offender waits this long while healthy siblings keep their cadence. */
export const FAILURE_QUARANTINE_MS = 30 * 60 * 1000;
const SKIP_JITTER_MIN_MS = 2_000;
const SKIP_JITTER_RANGE_MS = 3_001;
const HOUR_MS = 60 * 60 * 1000;

/**
 * One account's refresh state + published headroom. `sessionUsedPercent` /
 * `capturedAt` are the prior sample the NEXT tick projects the burn rate from;
 * `minutesToLimit` / `status` are what the routing hot path reads.
 */
export interface HeadroomEntry {
  status: UsageHeadroom['status'];
  minutesToLimit: number | null;
  /** The session window's usedPercent in the last snapshot (the prev sample). */
  sessionUsedPercent: number | null;
  /** Epoch ms the last snapshot was captured. */
  capturedAt: number | null;
  /** Epoch ms this account is next due for a live refresh. */
  nextRefreshAt: number;
  /** Epoch ms of recent live fetches, for the rolling-hour cap. */
  callTimestamps: number[];
  /** Epoch ms this entry was written. */
  computedAt: number;
  /** Consecutive live-fetch misses; absent on entries written before this field. */
  consecutiveFailures?: number;
}

interface HeadroomCacheFile {
  version: 1;
  entries: Record<string, HeadroomEntry>;
}

/** Test seam for the headroom cache path (see usage.ts `setClaudeUsageCachePathForTest`). */
let headroomCachePathOverride: string | null = null;
export function setHeadroomCachePathForTest(cachePath: string | null): string | null {
  const prev = headroomCachePathOverride;
  headroomCachePathOverride = cachePath;
  return prev;
}
function headroomCachePath(): string {
  return headroomCachePathOverride ?? path.join(getCacheDir(), '.usage-headroom.json');
}

/** Read the whole headroom cache (best-effort; missing/corrupt → empty map). */
export function readHeadroomCache(): Record<string, HeadroomEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(headroomCachePath(), 'utf-8')) as HeadroomCacheFile;
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
  } catch {
    // missing or corrupt — treat as empty
  }
  return {};
}

/** Read one account's headroom entry, or null. */
export function readHeadroomEntry(usageKey: string): HeadroomEntry | null {
  return readHeadroomCache()[usageKey] ?? null;
}

/** Merge entries into the cache (best-effort; preserves other accounts' rows). */
export function writeHeadroomEntries(entries: Record<string, HeadroomEntry>): void {
  try {
    const cachePath = headroomCachePath();
    ensureLockTarget(cachePath, JSON.stringify({ version: 1, entries: {} }, null, 2));
    withFileLock(cachePath, () => {
      // Re-read under the lock so a concurrent tick/view cannot drop rows.
      const merged: HeadroomCacheFile = {
        version: 1,
        entries: { ...readHeadroomCache(), ...entries },
      };
      atomicWriteFileSync(cachePath, JSON.stringify(merged, null, 2));
    });
  } catch {
    // best-effort; a failed write just means the router sees no projection
  }
}

/**
 * Interval until the next refresh attempt, clamped to [minMs, maxMs].
 * Defaults pin both ends to {@link REFRESH_INTERVAL_MS} (5 minutes) so the
 * live daemon path is a fixed schedule. Tests may pass a wider range to
 * exercise burn-aware scheduling without changing production cadence.
 */
export function computeNextRefreshDelayMs(
  minutesToLimit: number | null,
  opts: { minMs?: number; maxMs?: number; divisor?: number } = {},
): number {
  const minMs = opts.minMs ?? REFRESH_INTERVAL_MS;
  const maxMs = opts.maxMs ?? REFRESH_INTERVAL_MS;
  const divisor = opts.divisor ?? REFRESH_BURN_DIVISOR;
  if (minutesToLimit === null || !Number.isFinite(minutesToLimit)) return maxMs;
  const targetMs = (minutesToLimit / divisor) * 60_000;
  return Math.max(minMs, Math.min(maxMs, targetMs));
}

/** Recent call timestamps trimmed to the trailing hour. */
export function pruneCallTimestamps(timestamps: number[], now: number, windowMs = HOUR_MS): number[] {
  const floor = now - windowMs;
  return timestamps.filter((ts) => ts > floor);
}

/**
 * Whether an account may be live-refreshed right now: it is due (past its
 * scheduled `nextRefreshAt`) AND under the rolling-hour call cap. Pure so the
 * cadence + cap arithmetic is unit-tested without a daemon or a network call.
 */
export function shouldRefreshAccount(
  entry: HeadroomEntry | null | undefined,
  now: number,
  opts: { hourlyCap?: number; windowMs?: number } = {},
): boolean {
  const cap = opts.hourlyCap ?? HOURLY_CALL_CAP;
  const windowMs = opts.windowMs ?? HOUR_MS;
  const due = !entry || now >= entry.nextRefreshAt;
  if (!due) return false;
  const recent = pruneCallTimestamps(entry?.callTimestamps ?? [], now, windowMs);
  return recent.length < cap;
}

/**
 * Build the next headroom entry after a live refresh: project headroom from the
 * new snapshot against the prior sample, schedule the next refresh from the
 * projection, and record this call for the hourly cap.
 */
export function nextHeadroomEntry(
  prev: HeadroomEntry | null | undefined,
  snapshot: UsageSnapshot | null,
  now: number,
): HeadroomEntry {
  const headroom = deriveUsageHeadroom(
    snapshot,
    prev && prev.capturedAt !== null && prev.sessionUsedPercent !== null
      ? { capturedAt: prev.capturedAt, usedPercent: prev.sessionUsedPercent }
      : null,
  );
  const session = snapshot?.windows.find((window) => window.key === 'session') ?? null;
  const callTimestamps = pruneCallTimestamps([...(prev?.callTimestamps ?? []), now], now);
  return {
    status: headroom.status,
    minutesToLimit: headroom.minutesToLimit,
    sessionUsedPercent: session?.usedPercent ?? null,
    capturedAt: snapshot?.capturedAt?.getTime() ?? null,
    nextRefreshAt: now + computeNextRefreshDelayMs(headroom.minutesToLimit),
    callTimestamps,
    computedAt: now,
    consecutiveFailures: snapshot ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
  };
}

/** Stable per-account delay in [2s, 5s], used to spread skipped accounts. */
function skipJitterMs(usageKey: string): number {
  let hash = 0;
  for (const char of usageKey) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SKIP_JITTER_MIN_MS + (hash % SKIP_JITTER_RANGE_MS);
}

function skippedHeadroomEntry(
  prev: HeadroomEntry | null,
  usageKey: string,
  now: number,
  index: number,
): HeadroomEntry {
  return {
    status: prev?.status ?? null,
    minutesToLimit: prev?.minutesToLimit ?? null,
    sessionUsedPercent: prev?.sessionUsedPercent ?? null,
    capturedAt: prev?.capturedAt ?? null,
    nextRefreshAt: now + (index + 1) * skipJitterMs(usageKey),
    callTimestamps: pruneCallTimestamps(prev?.callTimestamps ?? [], now),
    computedAt: now,
    consecutiveFailures: prev?.consecutiveFailures ?? 0,
  };
}

function failedHeadroomEntry(prev: HeadroomEntry | null, now: number): HeadroomEntry {
  const next = nextHeadroomEntry(prev, null, now);
  if ((next.consecutiveFailures ?? 0) >= FAILURE_QUARANTINE_THRESHOLD) {
    next.nextRefreshAt = now + FAILURE_QUARANTINE_MS;
  }
  return next;
}

/** An account whose credentials live on the publisher host. */
export interface LocalUsageAccount {
  usageKey: string;
  agentId: AgentId;
  /** Live-fetch this account's usage; the daemon passes the real network fetch. */
  fetch: () => Promise<UsageInfo>;
}

/** Cold accounts lead each pass; both cold and cached groups rotate every tick. */
export function orderUsageAccounts(
  accounts: LocalUsageAccount[],
  cache: Record<string, HeadroomEntry>,
  tick: number,
): LocalUsageAccount[] {
  const rotate = (group: LocalUsageAccount[]): LocalUsageAccount[] => {
    if (group.length < 2) return group;
    const start = tick % group.length;
    return [...group.slice(start), ...group.slice(0, start)];
  };
  const cold = accounts.filter((account) => cache[account.usageKey] == null);
  const cached = accounts.filter((account) => cache[account.usageKey] != null);
  return [...rotate(cold), ...rotate(cached)];
}

/**
 * Enumerate the usage accounts whose credentials live on THIS host — one
 * per unique usage key, deduped to the most-recently-active version (the same
 * canonicalization `getUsageInfoByIdentity` uses). Each carries a closure that
 * live-fetches its usage. This is the daemon's `listAccounts`; because it only
 * ever lists local, signed-in accounts, each host is the sole writer for its own
 * accounts' caches. `runUsageRefreshTick` calls this only on the fleet publisher.
 */
export async function buildLocalUsageAccounts(): Promise<LocalUsageAccount[]> {
  const accounts: LocalUsageAccount[] = [];
  for (const agentId of USAGE_SOURCE_AGENT_IDS) {
    const versions = listInstalledVersions(agentId);
    if (versions.length === 0) continue;

    const inputs: UsageIdentityInput[] = await Promise.all(
      versions.map(async (version) => {
        const home = getVersionHomePath(agentId, version);
        return { agentId, info: await getAccountInfo(agentId, home), home, cliVersion: version };
      }),
    );

    const { canonicalByUsageKey, usageFetchInputs } = buildCanonicalUsageContext(inputs);
    for (const [usageKey, fetchInput] of usageFetchInputs) {
      const canonical = canonicalByUsageKey.get(usageKey);
      if (!canonical?.signedIn) continue; // only refresh accounts actually usable here
      accounts.push({
        usageKey,
        agentId,
        // fileOnly: never open the ACL-bound keychain item from the daemon —
        // that path is the Touch ID storm. Usage reads the file-based setup-token
        // only, never the interactive login (see loadClaudeOauth); no setup-token
        // reads as "usage pending".
        fetch: async () => {
          const { getUsageInfoForIdentity } = await import('./accounting/usage.js');
          return getUsageInfoForIdentity({
            agentId,
            home: fetchInput.home,
            cliVersion: fetchInput.cliVersion,
            info: canonical,
          }, { forceRefresh: true, fileOnly: true });
        },
      });
    }
  }
  return accounts;
}

/** Injectable side effects, so `runUsageRefresh` is drivable without the daemon. */
export interface UsageRefreshDeps {
  now?: number;
  /** Local-credential accounts to consider (one per unique usage key). */
  listAccounts: () => Promise<LocalUsageAccount[]>;
  /** Persist a fresh snapshot to the usage cache (writeClaudeUsageCache). */
  writeUsageCache: (usageKey: string, snapshot: UsageSnapshot) => void;
  /**
   * Epoch ms this provider — or, when `usageKey` is given, this specific
   * account — is backed off until; null when free (usageRateLimitedUntil).
   * Per-account scope (RUSH-3036): one throttled account must not park its
   * siblings, which previously starved every account after the first 429 in
   * this loop's fixed iteration order.
   */
  backoffUntil: (agentId: AgentId, usageKey?: string) => number | null;
}

export interface UsageRefreshResult {
  refreshed: number;
  skippedNotDue: number;
  skippedBackoff: number;
  skippedCap: number;
  failed: number;
}

/**
 * One refresher tick: for each local account that is due, under its hourly cap,
 * and not backed off, live-fetch its usage, update the cache, and
 * reschedule from the new burn projection. Never throws — a single account's
 * failed fetch leaves its cache untouched and counts as `failed`.
 */
export async function runUsageRefresh(deps: UsageRefreshDeps): Promise<UsageRefreshResult> {
  const now = deps.now ?? Date.now();
  const result: UsageRefreshResult = {
    refreshed: 0,
    skippedNotDue: 0,
    skippedBackoff: 0,
    skippedCap: 0,
    failed: 0,
  };

  const cache = readHeadroomCache();
  const accounts = orderUsageAccounts(
    await deps.listAccounts(),
    cache,
    Math.floor(now / USAGE_REFRESH_TICK_MS),
  );
  const updates: Record<string, HeadroomEntry> = {};

  for (const [index, account] of accounts.entries()) {
    const entry = cache[account.usageKey] ?? null;

    // A penalized account/provider is off-limits — poking it re-arms the
    // penalty (the whole reason usage-backoff exists).
    if ((deps.backoffUntil(account.agentId, account.usageKey) ?? 0) > now) {
      updates[account.usageKey] = skippedHeadroomEntry(entry, account.usageKey, now, index);
      result.skippedBackoff += 1;
      continue;
    }
    if (!shouldRefreshAccount(entry, now)) {
      if (entry && now < entry.nextRefreshAt) result.skippedNotDue += 1;
      else result.skippedCap += 1;
      continue;
    }

    try {
      const usage = await account.fetch();
      if (usage.snapshot?.source === 'live') {
        deps.writeUsageCache(account.usageKey, usage.snapshot);
        updates[account.usageKey] = nextHeadroomEntry(entry, usage.snapshot, now);
        result.refreshed += 1;
      } else {
        // No live snapshot (expired token / fetch miss): don't rewrite the usage
        // cache, but still record the call + reschedule so a broken account
        // isn't retried every tick.
        updates[account.usageKey] = failedHeadroomEntry(entry, now);
        result.failed += 1;
      }
    } catch {
      updates[account.usageKey] = failedHeadroomEntry(entry, now);
      result.failed += 1;
    }
  }

  if (Object.keys(updates).length > 0) writeHeadroomEntries(updates);
  return result;
}
