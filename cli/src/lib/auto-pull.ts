/**
 * Background sync for tracked git repos:
 *   - System repo (~/.agents/.system/) is read-only locally — fast-forward auto-pull is safe.
 *   - User repo (~/.agents/) and enabled extras may have local commits, so we only
 *     `git fetch` and write a status marker. `agents doctor` surfaces these markers
 *     as a "Repo updates" section instead of printing to stderr on every command.
 *     Pulling is left to the user via `agents repo pull`.
 *
 * Public API:
 *   spawnDetachedSync()      — fire-and-forget; never blocks the foreground command.
 *   readRepoBehindMarkers()  — synchronous; reads markers without consuming them.
 *   shouldSkipDetachedSync() — parent-side recency gate (RUSH-2324).
 *   markDetachedSyncComplete() — worker stamps a completed cycle for the parent gate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getFetchCacheDir } from './state.js';
import { backgroundSpawnOptions } from './platform/process.js';

/**
 * Shared 5-minute recency window for per-repo locks (worker) and the parent
 * spawn gate (RUSH-2324). Worker skips a repo when its lock mtime is younger
 * than this; the parent skips the entire detached spawn when a recent cycle
 * completed or every existing lock is still within the window.
 */
export const SYNC_LOCK_TTL_MS = 5 * 60 * 1000;

/** Where lock files and per-repo status markers live. */
function fetchStateDir(): string {
  return getFetchCacheDir();
}

/** Per-repo lock file path. mtime acts as a recency check. */
export function lockFilePath(alias: string, fetchDir?: string): string {
  return path.join(fetchDir ?? fetchStateDir(), `${alias}.lock`);
}

/** Per-repo status marker path (for user/extras only). */
export function statusFilePath(alias: string, fetchDir?: string): string {
  return path.join(fetchDir ?? fetchStateDir(), `${alias}.status.json`);
}

/**
 * Stamp written at the end of every detached-worker cycle (including the
 * no-target / all-locks-skipped path). Parent `spawnDetachedSync` stats this
 * one file instead of forking a child on every ordinary CLI invocation.
 */
export function lastSyncStampPath(fetchDir?: string): string {
  return path.join(fetchDir ?? fetchStateDir(), '.last-sync');
}

export interface FetchStatusMarker {
  alias: string;
  dir: string;
  ahead: number;
  behind: number;
  branch: string;
  fetchedAt: number;
}

function isMtimeFresh(filePath: string, now: number, ttlMs: number): boolean {
  try {
    return now - fs.statSync(filePath).mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

/**
 * Whether the parent should skip forking the detached auto-pull worker.
 *
 * True when either:
 *   1. `.last-sync` exists and its mtime is within {@link SYNC_LOCK_TTL_MS}
 *      (a prior cycle completed recently — the common warm path), or
 *   2. the fetch dir has at least one `*.lock` and every lock is still within
 *      the same window (a worker is mid-flight, or a cycle left locks that
 *      still count as fresh).
 *
 * False (spawn) when the stamp is missing/stale and there are no fresh locks
 * — including a missing fetch dir and an empty one. Cheap: one `stat` or one
 * `readdir` + a few `stat`s; never spawns and never reads git.
 *
 * @param fetchDir - Override the fetch state dir (for tests). Defaults to the
 *   production getFetchCacheDir() path.
 * @param now - Override the clock (for tests).
 * @param ttlMs - Override the recency window (for tests).
 */
export function shouldSkipDetachedSync(
  fetchDir?: string,
  now: number = Date.now(),
  ttlMs: number = SYNC_LOCK_TTL_MS,
): boolean {
  const dir = fetchDir ?? fetchStateDir();
  if (isMtimeFresh(lastSyncStampPath(dir), now, ttlMs)) return true;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const locks = entries.filter((name) => name.endsWith('.lock'));
  if (locks.length === 0) return false;
  return locks.every((name) => isMtimeFresh(path.join(dir, name), now, ttlMs));
}

/**
 * Record that a detached-worker cycle finished (success, empty targets, or
 * every repo skipped by its lock). Best-effort; a failed write just means the
 * next foreground invocation will re-spawn the worker.
 */
export function markDetachedSyncComplete(fetchDir?: string): void {
  const dir = fetchDir ?? fetchStateDir();
  const stamp = lastSyncStampPath(dir);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stamp, String(Date.now()));
  } catch {
    /* best-effort */
  }
}

/** Spawn the detached worker. No-op when AGENTS_NO_AUTOPULL=1 is set. */
export function spawnDetachedSync(fetchDir?: string): void {
  if (process.env.AGENTS_NO_AUTOPULL === '1') return;

  // RUSH-2324: the spawn itself costs ~7ms mean on a warm box, and the worker
  // almost always no-ops when a cycle ran in the last five minutes. Inspect
  // the last-sync stamp + lock mtimes in the parent and skip the fork when
  // everything is still fresh.
  if (shouldSkipDetachedSync(fetchDir)) return;

  // Resolve the worker path relative to the compiled location of this module.
  // After `tsc`, both files land in the same directory under dist/lib/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'auto-pull-worker.js');
  if (!fs.existsSync(workerPath)) return;

  try {
    // Scrub AGENTS_BRAND so the background sync always reconciles the FULL
    // resource set into the shared agent homes. Otherwise a branded foreground
    // invocation (e.g. `jack …`) would leak its curated/reduced profile into the
    // detached sync and silently strip skills/plugins for the plain `agents`
    // user (last-writer-wins on shared homes). Brand curation must stay a
    // foreground, in-process view — never a background mutation of shared state.
    const { AGENTS_BRAND: _brand, ...unbrandedEnv } = process.env;
    const child = spawn(process.execPath, [workerPath], {
      ...backgroundSpawnOptions(),
      stdio: 'ignore',
      env: unbrandedEnv,
    });
    child.unref();
  } catch {
    /* best-effort: never break the foreground command */
  }
}

/**
 * Read all current status markers and return those where the local repo is
 * behind upstream. Markers are NOT deleted — they persist until the next
 * background fetch overwrites them with fresh data.
 *
 * Synchronous, cheap (small JSON files). Used by `agents doctor` to surface
 * repo-behind warnings in one place instead of printing to stderr on every
 * command.
 *
 * @param fetchDir - Override the fetch state dir (for tests). Defaults to the
 *   production getFetchCacheDir() path.
 */
export function readRepoBehindMarkers(fetchDir?: string): FetchStatusMarker[] {
  const dir = fetchDir ?? fetchStateDir();
  if (!fs.existsSync(dir)) return [];

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const result: FetchStatusMarker[] = [];
  for (const name of entries) {
    if (!name.endsWith('.status.json')) continue;
    const file = path.join(dir, name);
    let marker: FetchStatusMarker | null = null;
    try {
      marker = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    if (!marker || marker.behind <= 0) continue;
    result.push(marker);
  }
  return result;
}
