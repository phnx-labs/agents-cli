/**
 * Daemon-owned adaptive usage refresher.
 *
 * The routing hot path (`agents run` → collectRunCandidates) reads usage
 * CACHE-ONLY (`getUsageInfoForIdentity` `readOnly`, RUSH-2061) and never blocks
 * on a provider fetch. Something still has to keep that cache fresh — this
 * module is that something, running inside the daemon.
 *
 * Design (per account, this host is the SOLE writer — the refresher only ever
 * touches accounts whose credentials live locally, so no cross-host
 * coordination and no shared-token contention):
 *
 *  - **Adaptive cadence from burn rate.** Each refresh stores the session
 *    window's `usedPercent` + `capturedAt`. The next refresh is scheduled from
 *    `deriveUsageHeadroom`'s projected `minutesToLimit`: an account racing
 *    toward its cap is polled more often (down to 90s), an idle one rarely (up
 *    to 15min). `computeNextRefreshDelayMs` is the pure clamp.
 *  - **Hard hourly cap.** Regardless of cadence, at most `HOURLY_CALL_CAP` live
 *    fetches per account per rolling hour, so a fast burn can't turn the 90s
 *    floor into a hammering loop.
 *  - **Respects the existing 429 backoff.** A provider under
 *    `usageRateLimitedUntil` is skipped entirely — the whole point of the
 *    backoff is to stop poking an endpoint that just said no.
 *
 * It also publishes the projected headroom (`minutesToLimit` + status) to a
 * small cache keyed by usage key, so the routing hot path can deprioritize an
 * account projected to cap without recomputing a burn rate it has no prior
 * sample for. `fleet-cache.ts` is the sync reader.
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';
import {
  deriveUsageHeadroom,
  type UsageHeadroom,
  type UsageSnapshot,
} from './usage.js';

/** Floor on the adaptive interval: an account seconds from its cap still isn't
 * polled faster than this. */
export const REFRESH_MIN_MS = 90 * 1000;
/** Ceiling on the adaptive interval: an idle account is still re-checked at
 * least this often so a cache never silently rots. */
export const REFRESH_MAX_MS = 15 * 60 * 1000;
/** Schedule the next refresh at `minutesToLimit / K` — poll well before the cap,
 * not exactly at it. */
export const REFRESH_BURN_DIVISOR = 4;
/** At most this many live fetches per account per rolling hour. */
export const HOURLY_CALL_CAP = 6;
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
    const dir = getCacheDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const merged: HeadroomCacheFile = {
      version: 1,
      entries: { ...readHeadroomCache(), ...entries },
    };
    fs.writeFileSync(headroomCachePath(), JSON.stringify(merged, null, 2));
  } catch {
    // best-effort; a failed write just means the router sees no projection
  }
}

/**
 * The adaptive interval until the next refresh, clamped to [MIN, MAX]. A
 * shorter `minutesToLimit` (closer to the cap) polls sooner; `null` (unknown /
 * idle / not burning) waits the full ceiling.
 */
export function computeNextRefreshDelayMs(
  minutesToLimit: number | null,
  opts: { minMs?: number; maxMs?: number; divisor?: number } = {},
): number {
  const minMs = opts.minMs ?? REFRESH_MIN_MS;
  const maxMs = opts.maxMs ?? REFRESH_MAX_MS;
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
  };
}

/** An account whose credentials live on THIS host — the only ones we refresh. */
export interface LocalUsageAccount {
  usageKey: string;
  agentId: import('./types.js').AgentId;
  /** Live-fetch this account's usage; the daemon passes the real network fetch. */
  fetch: () => Promise<UsageInfo>;
}

interface UsageInfo {
  snapshot: UsageSnapshot | null;
  error: string | null;
}

/** Injectable side effects, so `runUsageRefresh` is drivable without the daemon. */
export interface UsageRefreshDeps {
  now?: number;
  /** Local-credential accounts to consider (one per unique usage key). */
  listAccounts: () => Promise<LocalUsageAccount[]>;
  /** Persist a fresh snapshot to the usage cache (writeClaudeUsageCache). */
  writeUsageCache: (usageKey: string, snapshot: UsageSnapshot) => void;
  /** Epoch ms a provider is backed off until, or null when free (usageRateLimitedUntil). */
  backoffUntil: (agentId: import('./types.js').AgentId) => number | null;
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
 * and not provider-backed-off, live-fetch its usage, update the cache, and
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

  const accounts = await deps.listAccounts();
  const cache = readHeadroomCache();
  const updates: Record<string, HeadroomEntry> = {};

  for (const account of accounts) {
    const entry = cache[account.usageKey] ?? null;

    // A provider under a 429 penalty is off-limits — poking it re-arms the
    // penalty (the whole reason usage-backoff exists).
    if ((deps.backoffUntil(account.agentId) ?? 0) > now) {
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
        updates[account.usageKey] = nextHeadroomEntry(entry, null, now);
        result.failed += 1;
      }
    } catch {
      updates[account.usageKey] = nextHeadroomEntry(entry, null, now);
      result.failed += 1;
    }
  }

  if (Object.keys(updates).length > 0) writeHeadroomEntries(updates);
  return result;
}
