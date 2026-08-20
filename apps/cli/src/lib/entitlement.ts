/**
 * Plan-tier entitlement — the one place agents-cli reads a user's live billing
 * tier for plan gates (the `agents accounts` per-harness cap, the `agents
 * insights` paid split). Fetches `GET /api/v1/billing/subscription?agent=agi-cli`
 * using the Rush session token from `~/.rush/user.yaml` (same read pattern as
 * `lib/cloud/rush.ts` / `lib/secrets/drivers/rush.ts` — this module does not
 * import either, since neither exports its token reader), caches the result on
 * disk with a TTL, and stays offline-tolerant: a stale cache is honored over a
 * failed network call rather than silently dropping a paid account to free, and
 * no session file at all resolves straight to the free tier with no request.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { getCacheDir } from './state.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';

const PROXY_BASE = process.env.RUSH_PROXY_BASE ?? 'https://api.prix.dev';
const SUBSCRIPTION_PATH = '/api/v1/billing/subscription?agent=agi-cli';

/** How long a cached tier is trusted before the next call re-fetches. */
export const ENTITLEMENT_CACHE_TTL_MS = 15 * 60_000;

export type EntitlementSource = 'live' | 'cache' | 'offline' | 'no-session';

export interface EntitlementTier {
  /** The raw tier name from the backend ('free', 'admin', or a paid tier name). */
  tierName: string;
  /** true for 'admin' or any tier name other than 'free'. */
  isPaid: boolean;
  /** Where this value came from — mainly for diagnostics/tests. */
  source: EntitlementSource;
}

const FREE_TIER: Omit<EntitlementTier, 'source'> = { tierName: 'free', isPaid: false };

interface RushUserYaml {
  session?: { access_token?: string };
}

interface EntitlementCacheFile {
  version: 1;
  tierName: string;
  isPaid: boolean;
  fetchedAt: number;
}

interface SubscriptionResponse {
  tierName?: string;
  [key: string]: unknown;
}

// ─── Injectable seams (tests only — the lib's own real read/write paths) ────

let userYamlPathOverride: string | null = null;
let cachePathOverride: string | null = null;
let fetchImpl: typeof globalThis.fetch = globalThis.fetch;

export function setEntitlementUserYamlPathForTest(value: string | null): void {
  userYamlPathOverride = value;
}

export function setEntitlementCachePathForTest(value: string | null): void {
  cachePathOverride = value;
}

export function setEntitlementFetchForTest(fn: typeof globalThis.fetch): void {
  fetchImpl = fn;
}

function userYamlPath(): string {
  return userYamlPathOverride ?? path.join(os.homedir(), '.rush', 'user.yaml');
}

export function entitlementCachePath(): string {
  return cachePathOverride ?? path.join(getCacheDir(), '.entitlement-cache.json');
}

function readRushToken(): string | null {
  const file = userYamlPath();
  if (!fs.existsSync(file)) return null;
  try {
    const data = yaml.parse(fs.readFileSync(file, 'utf-8')) as RushUserYaml;
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}

function readCache(): EntitlementCacheFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(entitlementCachePath(), 'utf-8')) as EntitlementCacheFile;
    if (parsed?.version === 1 && typeof parsed.tierName === 'string' && typeof parsed.fetchedAt === 'number') return parsed;
  } catch {
    // missing or corrupt — treat as no cache
  }
  return null;
}

/** Best-effort write; a failed cache write just means the next call re-fetches. */
function writeCache(tierName: string, isPaid: boolean): void {
  try {
    const target = entitlementCachePath();
    ensureLockTarget(target);
    withFileLock(target, () => {
      const entry: EntitlementCacheFile = { version: 1, tierName, isPaid, fetchedAt: Date.now() };
      atomicWriteFileSync(target, JSON.stringify(entry, null, 2));
    });
  } catch {
    // best-effort
  }
}

/**
 * Only `tierName: "free"` (or an absent tier name) reads as free — every other
 * name (`admin`, or a real paid-tier name once agi-cli has a pricing manifest,
 * see the integration spec §4.4 G3) is treated as paid. Backend tier config for
 * agi-cli doesn't exist yet, so this deliberately does not lean on
 * `hasSubscription`/`needsUpgrade` nuance the backend isn't populating meaningfully
 * for this agent today.
 */
function classifySubscription(sub: SubscriptionResponse): { tierName: string; isPaid: boolean } {
  const tierName = typeof sub.tierName === 'string' && sub.tierName ? sub.tierName : 'free';
  return { tierName, isPaid: tierName !== 'free' };
}

/**
 * The live plan tier, cache-first with a TTL.
 *
 * - No `~/.rush/user.yaml` at all → free, no network call.
 * - A fresh cache entry (within {@link ENTITLEMENT_CACHE_TTL_MS}) is returned
 *   with no network call.
 * - A stale or missing cache triggers a live fetch; on success the result is
 *   cached and returned.
 * - A failed fetch (offline, timeout, non-2xx) falls back to a stale cache if
 *   one exists — never silently drops a known-paid account to free just
 *   because the network hiccuped — and only falls back to free when there is
 *   no cache at all to fall back to.
 */
export async function getTier(): Promise<EntitlementTier> {
  const token = readRushToken();
  if (!token) return { ...FREE_TIER, source: 'no-session' };

  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < ENTITLEMENT_CACHE_TTL_MS) {
    return { tierName: cached.tierName, isPaid: cached.isPaid, source: 'cache' };
  }

  try {
    const res = await fetchImpl(`${PROXY_BASE}${SUBSCRIPTION_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`billing/subscription responded ${res.status}`);
    const sub = (await res.json()) as SubscriptionResponse;
    const { tierName, isPaid } = classifySubscription(sub);
    writeCache(tierName, isPaid);
    return { tierName, isPaid, source: 'live' };
  } catch {
    if (cached) return { tierName: cached.tierName, isPaid: cached.isPaid, source: 'offline' };
    return { ...FREE_TIER, source: 'offline' };
  }
}

/** Per-harness account cap for a tier: 3 on free, 10 on paid/admin. */
export function accountCapForTier(tier: Pick<EntitlementTier, 'isPaid'>): number {
  return tier.isPaid ? 10 : 3;
}
