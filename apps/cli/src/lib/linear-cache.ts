/**
 * Disk TTL cache for the Linear answers behind the `agents projects` card.
 *
 * Linear meters two budgets independently, and only one of them binds. Observed
 * on this account's response headers:
 *
 *   x-ratelimit-requests-limit:   2500      remaining: 2
 *   x-ratelimit-complexity-limit: 3000000   remaining: 2999987
 *
 * Requests are scarce; complexity is 99.999% untouched. So the thing to
 * optimize is the NUMBER of calls, not their cost — and the way to spend 2500
 * of them is an agent (or a watch loop) running `projects status` repeatedly.
 * A human typing it is not the exhauster.
 *
 * The CLI is a short-lived process, so an in-memory memo would only help within
 * one invocation, which is the case that never needed help. This caches to
 * disk, mirroring `auth-health.ts`'s `getCacheDir()` snapshot.
 *
 * The load-bearing behavior is what happens on FAILURE: a stale entry keeps
 * being served, marked stale, instead of the line vanishing. That rule is
 * borrowed from `mergeAuthHealthEntries` — one 8s timeout must not flip a
 * populated chip to empty — and it is the fix for the card silently losing its
 * Linear line mid-session when the request budget ran out.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from './state.js';

/** Matches `SKILL_INDEX_TTL_MS` (`lib/registry.ts`) — the repo's TTL convention. */
export const LINEAR_CACHE_TTL_MS = 10 * 60_000;

const CACHE_FILE = '.linear-projects.json';

/** One cached answer, keyed by Linear project id. */
interface CacheEntry<T> {
  /** Epoch ms the value was fetched. */
  at: number;
  value: T;
}

interface CacheFile<T> {
  entries: Record<string, CacheEntry<T>>;
  /**
   * Epoch ms until which the API is known to be rate-limited, from a 429's
   * `x-ratelimit-requests-reset`. Until then every fetch is skipped outright —
   * spending a request to be told there are none left helps nobody.
   */
  rateLimitedUntil?: number;
}

/**
 * Where the snapshot lives. `AGENTS_LINEAR_CACHE_PATH` overrides it, mirroring
 * `AGENTS_FACTORY_PROJECTS_PATH` (`auto-dispatch.ts`) — `getCacheDir()` resolves
 * `HOME` once at module load, so a test that swaps `process.env.HOME` afterwards
 * would otherwise read and WRITE the developer's real cache.
 */
function cachePath(): string {
  return process.env.AGENTS_LINEAR_CACHE_PATH ?? path.join(getCacheDir(), CACHE_FILE);
}

/** The directory the cache file lives in, whichever path is in effect. */
function cacheDir(): string {
  return path.dirname(cachePath());
}

function read<T>(): CacheFile<T> {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as CacheFile<T>;
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') return raw;
  } catch {
    /* absent or corrupt — an empty cache is always a valid answer */
  }
  return { entries: {} };
}

function write<T>(file: CacheFile<T>): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(file), 'utf8');
  } catch {
    /* best-effort: an unwritable cache degrades to no cache, never to an error */
  }
}

/** What a lookup found, and how much to trust it. */
export interface CacheHit<T> {
  value: T;
  /** Age in ms. Past the TTL the value is still returned, flagged stale. */
  ageMs: number;
  stale: boolean;
}

/** Look up a project's cached answer. Returns stale entries too — the caller decides. */
export function readCached<T>(projectId: string, nowMs: number): CacheHit<T> | undefined {
  const entry = read<T>().entries[projectId];
  if (!entry || typeof entry.at !== 'number') return undefined;
  const ageMs = nowMs - entry.at;
  return { value: entry.value, ageMs, stale: ageMs > LINEAR_CACHE_TTL_MS };
}

/** Store a freshly fetched answer. */
export function writeCached<T>(projectId: string, value: T, nowMs: number): void {
  const file = read<T>();
  file.entries[projectId] = { at: nowMs, value };
  write(file);
}

/** True when a prior 429 said the budget is exhausted and has not yet reset. */
export function isRateLimited(nowMs: number): boolean {
  const until = read().rateLimitedUntil;
  return typeof until === 'number' && until > nowMs;
}

/**
 * Record a 429 so the next runs don't spend a request learning the same thing.
 * `resetAtMs` comes from the response's `x-ratelimit-requests-reset` header
 * (epoch ms); without it, back off for one TTL.
 */
export function noteRateLimited(resetAtMs: number | undefined, nowMs: number): void {
  const file = read();
  file.rateLimitedUntil = resetAtMs && resetAtMs > nowMs ? resetAtMs : nowMs + LINEAR_CACHE_TTL_MS;
  write(file);
}

/** Drop one project's entry — used when `projects link` re-points a definition. */
export function invalidateCached(projectId: string): void {
  const file = read();
  if (file.entries[projectId]) {
    delete file.entries[projectId];
    write(file);
  }
}
