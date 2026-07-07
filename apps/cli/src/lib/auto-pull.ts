/**
 * Background sync for tracked git repos:
 *   - System repo (~/.agents/.system/) is read-only locally — fast-forward auto-pull is safe.
 *   - User repo (~/.agents/) and enabled extras may have local commits, so we only
 *     `git fetch` and write a status marker. Next CLI invocation surfaces a one-line
 *     notice if upstream is ahead. Pulling is left to the user via `agents repo pull`.
 *
 * Public API:
 *   spawnDetachedSync()           — fire-and-forget; never blocks the foreground command.
 *   printPendingUpdateNotices()   — synchronous; reads markers and prints + consumes them.
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
    const child = spawn(process.execPath, [workerPath], {
      ...backgroundSpawnOptions(),
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    /* best-effort: never break the foreground command */
  }
}

/**
 * Read any pending status markers and print one-line notices for repos that
 * are behind upstream. Markers are deleted after printing so notices don't
 * repeat on every invocation. Synchronous, cheap (small JSON files).
 */
export function printPendingUpdateNotices(): void {
  const dir = fetchStateDir();
  if (!fs.existsSync(dir)) return;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!name.endsWith('.status.json')) continue;
    const file = path.join(dir, name);
    let marker: FetchStatusMarker | null = null;
    try {
      marker = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      continue;
    }
    if (!marker || marker.behind <= 0) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      continue;
    }

    const repoLabel = marker.alias === 'user' ? '~/.agents/' : marker.alias;
    process.stderr.write(
      `agents-cli: ${repoLabel} is ${marker.behind} commit${marker.behind === 1 ? '' : 's'} ` +
        `behind ${marker.branch} — run 'agents repo pull ${marker.alias}' to update.\n`,
    );
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}
