/**
 * Leaf migrator: fold ~/.agents-system/ into ~/.agents/.system/.
 *
 * Kept separate from migrate.ts so the always-on startup hop (index.ts) does
 * not load the hosts/routine/teams/daemon/menubar graph that migrate.ts's
 * static imports pull in (RUSH-2454). migrate.ts re-exports and still calls
 * foldLegacySystemRepo() at the top of runMigration().
 *
 * HOME is resolved at call time (not module load) so tests can point at a
 * fixture tree via process.env.HOME without cache-busting the module.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLink } from './platform/links.js';

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function userDir(): string {
  return path.join(homeDir(), '.agents');
}

function systemDir(): string {
  return path.join(userDir(), '.system');
}

function legacySystemDir(): string {
  return path.join(homeDir(), '.agents-system');
}

/**
 * Fold ~/.agents-system/ into ~/.agents/.system/.
 *
 * MUST run first in runMigration() — every other migrator reads SYSTEM_DIR
 * (the new path), so the contents have to be there before they execute.
 *
 * Strategy:
 *   1. If legacy dir doesn't exist or is already a symlink, no-op.
 *   2. If new path doesn't exist yet, rename in one shot (fast path).
 *   3. If both exist (mid-migration / re-run on partially-migrated state),
 *      merge legacy → new with new winning on collision, then drop legacy.
 *
 * After the contents move, the legacy path becomes a symlink → SYSTEM_DIR
 * so external tooling that still references ~/.agents-system/ keeps
 * resolving correctly. The symlink is harmless on its own and can be
 * removed with `rm ~/.agents-system` once everything has updated.
 *
 * Idempotent: re-running converges to "contents at SYSTEM_DIR, symlink at
 * LEGACY_SYSTEM_DIR" without duplicating data.
 */
export function foldLegacySystemRepo(): void {
  const LEGACY_SYSTEM_DIR = legacySystemDir();
  const SYSTEM_DIR = systemDir();
  const USER_DIR = userDir();

  let legacyStat: fs.Stats | null = null;
  try { legacyStat = fs.lstatSync(LEGACY_SYSTEM_DIR); } catch { /* missing */ }
  if (!legacyStat) return;
  if (legacyStat.isSymbolicLink()) return;
  if (!legacyStat.isDirectory()) return;

  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  } catch { /* best-effort */ }

  if (!fs.existsSync(SYSTEM_DIR)) {
    try {
      fs.renameSync(LEGACY_SYSTEM_DIR, SYSTEM_DIR);
      try { createLink(SYSTEM_DIR, LEGACY_SYSTEM_DIR); } catch { /* best-effort */ }
      console.error('Folded ~/.agents-system/ into ~/.agents/.system/ (left back-compat symlink)');
      return;
    } catch {
      // Cross-device rename or perm issue — fall through to copy + remove.
    }
  }

  try {
    copyDirSkipExisting(LEGACY_SYSTEM_DIR, SYSTEM_DIR);
    fs.rmSync(LEGACY_SYSTEM_DIR, { recursive: true, force: true });
    try { createLink(SYSTEM_DIR, LEGACY_SYSTEM_DIR); } catch { /* best-effort */ }
    console.error('Merged ~/.agents-system/ into ~/.agents/.system/ (left back-compat symlink)');
  } catch { /* best-effort */ }
}

export function copyDirSkipExisting(src: string, dest: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (fs.existsSync(d)) {
      if (entry.isDirectory()) {
        const dStat = fs.lstatSync(d);
        if (dStat.isDirectory()) copyDirSkipExisting(s, d);
      }
      continue;
    }
    try {
      fs.renameSync(s, d);
    } catch {
      try {
        if (entry.isDirectory()) {
          copyDirSkipExisting(s, d);
        } else if (entry.isSymbolicLink()) {
          fs.symlinkSync(fs.readlinkSync(s), d);
        } else {
          fs.copyFileSync(s, d);
        }
      } catch { /* best-effort */ }
    }
  }
}
