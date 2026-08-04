/**
 * Singleflight + short-TTL disk cache for the `agents doctor --json` OVERVIEW
 * payload (the bare, no-target form the menu-bar helper and other pollers read).
 *
 * Why this exists (RUSH-2153): the bare `doctor --json` overview is expensive —
 * it probes every host CLI, spawns every installed agent CLI for its sign-in,
 * and diffs every agent×version against its source. On an idle box that is a few
 * seconds; on a loaded one it is minutes. The menu-bar helper polls it on a 60s
 * timer with a per-*process* in-flight guard, so nothing coalesces ACROSS
 * processes: a helper relaunch (or any second poller) each launches its own
 * live compute, and a helper killed mid-run orphans its `doctor --json` child,
 * which keeps spinning. In steady state this stacked to dozens of concurrent
 * `doctor --json` processes pinning ~14 cores and driving load to ~300.
 *
 * The fix mirrors the {@link readStatsCache}/`writeStatsCache` mirror-file
 * convention: reads are cache-first, and when a live compute IS needed exactly
 * ONE runs at a time (a lock-directory singleflight). Concurrent callers serve
 * the winner's fresh result — or the last snapshot — instead of each launching
 * their own fan-out. N pollers → 1 compute.
 *
 * The lock is a directory (`mkdir` is atomic across processes) with an mtime
 * staleness steal, so a computer that dies without releasing never wedges the
 * gate. The cache write is tmp+rename so a concurrent reader never sees a
 * partial file. All IO is best-effort: a failure degrades to a live compute,
 * never a throw.
 */
import * as fs from 'fs';
import * as path from 'path';

import { getCacheDir } from '../state.js';

const CACHE_FILE = '.doctor-overview.json';
const LOCK_DIR = '.doctor-overview.lock';

/** Serve a cached snapshot without recomputing while it is younger than this. */
export const DOCTOR_OVERVIEW_FRESH_MS = 90_000;
/** A lock directory older than this is assumed abandoned and stolen. */
const LOCK_STALE_MS = 120_000;
/** A caller that lost the race waits at most this long for the winner's write. */
const WAIT_TIMEOUT_MS = 12_000;
const WAIT_POLL_MS = 250;

interface CacheFile {
  version: 1;
  fetchedAt: number;
  payload: unknown;
}

/** Injectable IO + clock so tests exercise the real fs at a temp dir, no mocks. */
export interface DoctorOverviewCacheDeps {
  /** Cache directory (default: the real `~/.agents/.cache`). */
  dir?: string;
  /** Clock (default: {@link Date.now}). */
  now?: () => number;
  /** Async sleep (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

function cachePath(dir: string): string {
  return path.join(dir, CACHE_FILE);
}
function lockPath(dir: string): string {
  return path.join(dir, LOCK_DIR);
}

/** Read the last snapshot (best-effort; missing/corrupt/wrong-version → null). */
export function readDoctorOverviewCache(
  deps: DoctorOverviewCacheDeps = {},
): { fetchedAt: number; payload: unknown } | null {
  const dir = deps.dir ?? getCacheDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(dir), 'utf-8')) as CacheFile;
    if (parsed && parsed.version === 1 && typeof parsed.fetchedAt === 'number') {
      return { fetchedAt: parsed.fetchedAt, payload: parsed.payload };
    }
  } catch {
    // missing or corrupt — treat as no snapshot
  }
  return null;
}

/** Persist a fresh overview payload (best-effort; tmp+rename so reads are atomic). */
export function writeDoctorOverviewCache(payload: unknown, deps: DoctorOverviewCacheDeps = {}): void {
  const dir = deps.dir ?? getCacheDir();
  const now = deps.now ?? Date.now;
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const body: CacheFile = { version: 1, fetchedAt: now(), payload };
    const tmp = `${cachePath(dir)}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, cachePath(dir));
  } catch {
    // best-effort; a failed write just means the next read falls back to live
  }
}

/**
 * Result of {@link enterDoctorOverviewGate}.
 *  - `cached` non-null → the caller MUST print this string and return; no compute.
 *  - `cached` null     → the caller holds the singleflight lock: compute the
 *    overview, call {@link writeDoctorOverviewCache}, and invoke `release()`
 *    exactly on the way out (idempotent; call it in a `finally`).
 */
export interface OverviewGate {
  cached: string | null;
  release?: () => void;
}

function makeRelease(lp: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      fs.rmdirSync(lp);
    } catch {
      // already gone / stolen — nothing to do
    }
  };
}

/** Try to become the sole computer. Steals a lock older than {@link LOCK_STALE_MS}. */
function tryAcquireLock(lp: string, now: () => number): boolean {
  try {
    fs.mkdirSync(lp);
    return true;
  } catch {
    // Lock exists — steal it only if abandoned (stale mtime).
    try {
      const age = now() - fs.statSync(lp).mtimeMs;
      if (age > LOCK_STALE_MS) {
        try {
          fs.rmdirSync(lp);
        } catch {
          /* raced with another stealer */
        }
        try {
          fs.mkdirSync(lp);
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      // stat failed (lock vanished under us) — let the caller retry via the loop
    }
    return false;
  }
}

/**
 * Enter the doctor-overview singleflight gate. Returns a cached string to print,
 * or a lock token telling the caller to compute (and then write + release).
 *
 * Contract:
 *  - Fresh snapshot present (and not `forceRefresh`) → `{ cached }`, no lock.
 *  - Otherwise exactly one concurrent caller gets `{ cached: null, release }`
 *    and everyone else is served the winner's fresh write (or, if the winner is
 *    slow past {@link WAIT_TIMEOUT_MS}, the last snapshot) rather than launching
 *    their own compute.
 *  - Never throws: any IO failure degrades to a compute token.
 */
export async function enterDoctorOverviewGate(
  opts: { forceRefresh?: boolean; freshMs?: number } = {},
  deps: DoctorOverviewCacheDeps = {},
): Promise<OverviewGate> {
  const dir = deps.dir ?? getCacheDir();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const freshMs = opts.freshMs ?? DOCTOR_OVERVIEW_FRESH_MS;
  const lp = lockPath(dir);

  // 1. Fast path: a fresh snapshot serves without any compute or lock.
  if (!opts.forceRefresh) {
    const c = readDoctorOverviewCache({ dir });
    if (c && now() - c.fetchedAt < freshMs) return { cached: JSON.stringify(c.payload, null, 2) };
  }

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    // If we can't even make the cache dir, fall back to an unguarded compute.
    return { cached: null, release: () => {} };
  }

  // 2. Singleflight: win the lock → compute; lose → wait for the winner.
  if (tryAcquireLock(lp, now)) return { cached: null, release: makeRelease(lp) };

  const startedAt = now();
  const deadline = startedAt + WAIT_TIMEOUT_MS;
  while (now() < deadline) {
    await sleep(WAIT_POLL_MS);
    const c = readDoctorOverviewCache({ dir });
    // Accept only a write the winner made AFTER we began waiting.
    if (c && c.fetchedAt >= startedAt) return { cached: JSON.stringify(c.payload, null, 2) };
    // Winner may have died without writing → its lock goes stale → take over.
    if (tryAcquireLock(lp, now)) return { cached: null, release: makeRelease(lp) };
  }

  // 3. Winner is slow. Serve the last snapshot (stale) rather than pile on; if
  //    there is genuinely none, force the lock and compute as a last resort.
  const stale = readDoctorOverviewCache({ dir });
  if (stale) return { cached: JSON.stringify(stale.payload, null, 2) };
  try {
    fs.rmdirSync(lp);
  } catch {
    /* already gone */
  }
  try {
    fs.mkdirSync(lp);
  } catch {
    /* someone else grabbed it — compute unguarded rather than hang */
  }
  return { cached: null, release: makeRelease(lp) };
}
