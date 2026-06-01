/**
 * Detached worker entry point for background sync. See auto-pull.ts for the public API.
 *
 * For the system repo: fast-forward pull (safe — repo is read-only locally).
 * For the user repo + enabled extras: `git fetch` + write a status marker the foreground
 * CLI surfaces on its next invocation.
 *
 * Per-repo lock files at ~/.agents-system/.fetch/<alias>.lock prevent concurrent fetches.
 * Lock mtime under 5 min => skip (another invocation already in flight).
 */

import * as fs from 'fs';
import * as path from 'path';
import { simpleGit } from 'simple-git';
import { tryAutoPull, isGitRepo } from './git.js';
import {
  getSystemAgentsDir,
  getUserAgentsDir,
  getEnabledExtraRepos,
  getFetchCacheDir,
} from './state.js';
import { lockFilePath, statusFilePath, type FetchStatusMarker } from './auto-pull.js';

const LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Background auto-pull of ~/.agents-system/ is off by default. When enabled it
 * silently fast-forwards a tracked source tree that the CLI then reads as a
 * source of skills, hooks, install manifests, and commands — anyone with push
 * access to that upstream gets remote code execution on every user the next
 * time they invoke a command that loads a system resource. Operators that
 * really want the convenience can set AGENTS_AUTO_PULL=1.
 */
const ENABLE_AUTO_PULL = process.env.AGENTS_AUTO_PULL === '1';

interface RepoTarget {
  alias: string;
  dir: string;
  /** 'pull' for system (FF auto-merge), 'notify' for user/extras (fetch + marker only). */
  mode: 'pull' | 'notify';
}

function ensureFetchDir(): string {
  const dir = getFetchCacheDir();
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
  return dir;
}

function tryAcquireLock(alias: string): boolean {
  ensureFetchDir();
  const lock = lockFilePath(alias);
  try {
    const stat = fs.statSync(lock);
    if (Date.now() - stat.mtimeMs < LOCK_TTL_MS) return false;
  } catch {
    /* no lock yet */
  }
  try {
    fs.writeFileSync(lock, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function releaseLock(alias: string): void {
  try { fs.unlinkSync(lockFilePath(alias)); } catch { /* ignore */ }
}

function writeStatusMarker(marker: FetchStatusMarker): void {
  ensureFetchDir();
  try {
    fs.writeFileSync(statusFilePath(marker.alias), JSON.stringify(marker));
  } catch {
    /* best-effort */
  }
}

async function notifyRepo(target: RepoTarget): Promise<void> {
  if (!isGitRepo(target.dir)) return;
  const git = simpleGit(target.dir);
  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin');
  if (!origin?.refs?.fetch) return;

  await git.fetch('origin');

  const status = await git.status();
  if (!status.tracking) return;

  writeStatusMarker({
    alias: target.alias,
    dir: target.dir,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
    branch: status.tracking,
    fetchedAt: Date.now(),
  });
}

async function processTarget(target: RepoTarget): Promise<void> {
  if (!tryAcquireLock(target.alias)) return;
  try {
    if (target.mode === 'pull') {
      if (!ENABLE_AUTO_PULL) {
        // Demote to a fetch + notify; the user still sees ahead/behind on the
        // next foreground CLI invocation, but the source tree is never mutated
        // by a detached worker.
        await notifyRepo(target);
      } else {
        await tryAutoPull(target.dir);
      }
    } else {
      await notifyRepo(target);
    }
  } catch {
    /* network / git failures are non-fatal */
  } finally {
    releaseLock(target.alias);
  }
}

async function main(): Promise<void> {
  const targets: RepoTarget[] = [];

  const systemDir = getSystemAgentsDir();
  if (isGitRepo(systemDir)) {
    targets.push({ alias: 'system', dir: systemDir, mode: 'pull' });
  }

  const userDir = getUserAgentsDir();
  if (isGitRepo(userDir)) {
    targets.push({ alias: 'user', dir: userDir, mode: 'notify' });
  }

  for (const extra of getEnabledExtraRepos()) {
    if (isGitRepo(extra.dir)) {
      targets.push({ alias: extra.alias, dir: extra.dir, mode: 'notify' });
    }
  }

  await Promise.all(targets.map(processTarget));
}

main().catch(() => {
  /* swallow — detached worker must never crash the parent's terminal */
  process.exit(0);
});
