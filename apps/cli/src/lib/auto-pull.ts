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
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getFetchCacheDir } from './state.js';
import { backgroundSpawnOptions } from './platform/process.js';

/** Where lock files and per-repo status markers live. */
function fetchStateDir(): string {
  return getFetchCacheDir();
}

/** Per-repo lock file path. mtime acts as a recency check. */
export function lockFilePath(alias: string): string {
  return path.join(fetchStateDir(), `${alias}.lock`);
}

/** Per-repo status marker path (for user/extras only). */
export function statusFilePath(alias: string): string {
  return path.join(fetchStateDir(), `${alias}.status.json`);
}

export interface FetchStatusMarker {
  alias: string;
  dir: string;
  ahead: number;
  behind: number;
  branch: string;
  fetchedAt: number;
}

/** Spawn the detached worker. No-op when AGENTS_NO_AUTOPULL=1 is set. */
export function spawnDetachedSync(): void {
  if (process.env.AGENTS_NO_AUTOPULL === '1') return;

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
