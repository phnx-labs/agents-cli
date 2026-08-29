/**
 * A shared, cross-process request budget for the Linear API — the proactive half
 * of the frugality story `linear-cache.ts` started.
 *
 * Linear meters requests per API KEY at 2500/hr (complexity is 99.999% untouched,
 * so requests are the only budget that binds — see `linear-cache.ts`). The
 * failure this exists to stop: this box routinely runs ~13 agent sessions on ONE
 * key, each a separate short-lived process, and nothing coordinated their
 * spending. `linear-cache.ts` already caches reads and backs off AFTER a 429
 * lands (`isRateLimited`/`noteRateLimited`), but that is reactive — by the time
 * the 429 arrives the budget is already gone and every agent's status update is
 * throttled fleet-wide (PHNX-2310). This adds the missing PROACTIVE gate: before
 * a request goes out, it must fit inside a shared hourly budget, so the N agents
 * degrade to serving the (stale) cache instead of collectively blowing the limit.
 *
 * ## The budget lives in the FILENAMES, and that is the whole design
 *
 * State is on disk, not in memory, because the spenders are separate processes.
 * The obvious shape — one JSON document holding a counter — is read-modify-write,
 * and without a lock two agents reserving at once both read the old count and let
 * the lower write land last, silently under-counting. That is not theoretical
 * here: the triggering condition is a burst of concurrent agents, which is
 * exactly what a fleet drain issues. This is the same race `usage-backoff.ts`
 * documents, and the answer is the same: no shared mutable document.
 *
 * Each reserved request is its own empty file, `<createdMs>.<pid>.<seq>`, and the
 * count is `readdir().length` after elapsed files (older than the window) are
 * swept. Two concurrent writers create two DIFFERENT files and neither can erase
 * the other, so the count can only be under-read by an in-flight peer that has
 * not yet created its file — never corrupted, and never over-counted. A sliding
 * one-hour window of stamp files is a token bucket whose tokens refill as the
 * oldest requests age out, with no lock on a path every reservation touches.
 *
 * The budget is set BELOW Linear's hard 2500/hr ({@link LINEAR_HOURLY_REQUEST_BUDGET}).
 * Two reasons: it leaves headroom for a human running `projects status` by hand
 * (the CLI is not the only caller of the key), and it absorbs the small
 * check-then-create race — N agents reserving in the same instant can each read
 * `count < budget` and all create, overshooting by at most (N-1). Bounding the
 * budget under the real ceiling keeps that overshoot from ever reaching a real 429.
 *
 * State is per KEY (hashed, so the raw key never lands on disk), because the
 * 2500/hr quota is per key: two different keys spend independently.
 *
 * Scope is per MACHINE. The state lives under `getCacheDir()`
 * (`~/.agents/.cache/`), which is machine-local and NOT fleet-synced — so this
 * budgets the many concurrent agent processes on one box against each other, the
 * case that actually exhausted the key (~13 sessions on one machine). Two
 * different boxes sharing the same key each keep their own budget, so their
 * aggregate can still exceed 2500/hr; coordinating the budget across devices
 * (a synced or served counter) is a known limitation, not yet built.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from './state.js';

/** One hour, the window Linear's request quota is measured over. */
export const LINEAR_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The shared proactive budget, one key's requests per rolling hour. Deliberately
 * under Linear's hard 2500/hr so it leaves headroom for a human using the key and
 * absorbs the concurrent check-then-create overshoot (at most N-1 for N racing
 * agents) without ever reaching a real 429.
 */
export const LINEAR_HOURLY_REQUEST_BUDGET = 2400;

/**
 * Test seam, mirroring `setUsageBackoffDirForTest`. The cache dir resolves `HOME`
 * once at import time, so a test that swaps `process.env.HOME` afterwards would
 * otherwise read and WRITE the developer's real cache and throttle their own
 * Linear reads. Returns the previous value so a test can restore it.
 */
let rateLimitDirOverride: string | null = null;
export function setLinearRateLimitDirForTest(dir: string | null): string | null {
  const prev = rateLimitDirOverride;
  rateLimitDirOverride = dir;
  return prev;
}

function rateLimitRoot(): string {
  return rateLimitDirOverride ?? path.join(getCacheDir(), 'linear-rate-limit');
}

/**
 * Per-key directory. The key is hashed so the raw credential never touches disk;
 * a short hex prefix is collision-safe enough for the handful of keys one fleet
 * uses and keeps the path short.
 */
function keyDir(apiKey: string): string {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return path.join(rateLimitRoot(), hash);
}

/** Parse `<createdMs>.<pid>.<seq>` back to its creation instant, or null if it is not one of ours. */
function createdMsOf(name: string): number | null {
  const first = name.indexOf('.');
  if (first <= 0) return null;
  const head = name.slice(0, first);
  if (!/^\d+$/.test(head)) return null;
  const n = Number(head);
  return Number.isFinite(n) ? n : null;
}

/**
 * Count this key's requests inside the rolling window, sweeping elapsed stamp
 * files as it goes (they can only accumulate at the rate requests are issued, and
 * this is the one place that already lists them). Pure read otherwise.
 */
export function linearRequestsInWindow(apiKey: string, nowMs: number = Date.now()): number {
  const dir = keyDir(apiKey);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // no directory yet — nothing spent
  }
  const cutoff = nowMs - LINEAR_RATE_WINDOW_MS;
  let live = 0;
  for (const name of names) {
    const created = createdMsOf(name);
    if (created === null) continue;
    if (created <= cutoff) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        /* another process may have swept it already */
      }
    } else {
      live++;
    }
  }
  return live;
}

let reserveSeq = 0;

/**
 * Try to reserve one Linear request against the shared hourly budget.
 *
 * Returns `true` and records the reservation when there is room, `false` when the
 * budget is exhausted — the caller then serves the cache instead of spending a
 * request that would 429. The write is a single empty file whose NAME carries the
 * whole record, so a concurrent reserver can neither clobber it nor be clobbered
 * by it.
 */
export function reserveLinearRequest(apiKey: string, nowMs: number = Date.now()): boolean {
  if (linearRequestsInWindow(apiKey, nowMs) >= LINEAR_HOURLY_REQUEST_BUDGET) return false;
  const dir = keyDir(apiKey);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // `<createdMs>.<pid>.<seq>`: pid separates processes, the in-process counter
    // separates two reservations in the same millisecond, so the name is unique
    // without a lock or a random token. Empty contents — the name is the record.
    fs.writeFileSync(path.join(dir, `${nowMs}.${process.pid}.${reserveSeq++}`), '');
    return true;
  } catch {
    // An unwritable cache dir costs the cross-process budget, not correctness: if
    // we cannot record the reservation we still let the request through rather
    // than blocking a caller on a broken cache dir. The reactive 429 backoff in
    // linear-cache.ts remains the backstop.
    return true;
  }
}
