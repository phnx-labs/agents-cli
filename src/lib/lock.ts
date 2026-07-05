/**
 * `agents.lock` — a deterministic SHA-256 manifest of the resolved resource set
 * at a project root, plus the `--frozen` verification that fails closed on any
 * drift. This is the reproducible-CI slice of the governance work (#337); org
 * version pins and bundle signing are deferred follow-ups.
 *
 * Design:
 *  - Content hashing REUSES `fingerprintDir` / `fingerprintFile`
 *    (src/lib/staleness/fingerprint.ts) — the same two-tier fingerprinter every
 *    staleness checker uses. No new recursive file walker is introduced here.
 *  - The resource SET is the layered, resolved source union (project > user >
 *    system > extras), the same precedence `resolveResource` / `syncResourcesToVersion`
 *    read from. It is enumerated agent-independently on purpose: the lock must be
 *    reproducible on a fresh CI checkout that has no installed agent VERSIONS, so
 *    it snapshots the SOURCES sync copies FROM, not any per-version home.
 *
 * Lock shape (JSON): `{ "version": 1, "resources": { "<relpath>": "<sha256>" } }`,
 * keys sorted so the file is byte-stable across machines and runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fingerprintDir, fingerprintFile } from './staleness/fingerprint.js';
import {
  getProjectAgentsDir,
  getUserAgentsDir,
  getSystemAgentsDir,
  getEnabledExtraRepos,
} from './state.js';

export const LOCK_FILENAME = 'agents.lock';
export const LOCK_VERSION = 1 as const;

/**
 * Resource kinds captured by the lock — the file/dir-backed layered resources
 * shared across every agent. Presence-only kinds handled specially by the sync
 * differ (plugins/promptcuts) are intentionally out of this first slice.
 */
export const LOCK_KINDS = [
  'commands',
  'skills',
  'hooks',
  'rules',
  'mcp',
  'permissions',
  'subagents',
] as const;

/** The on-disk lockfile: relpath -> sha256 hex digest, keys sorted. */
export interface AgentsLock {
  version: typeof LOCK_VERSION;
  resources: Record<string, string>;
}

/**
 * One resolved resource to fingerprint. `path` is an absolute file or directory;
 * `key` is the stable relpath prefix under which its hashes are recorded
 * (e.g. `skills/debug` for a directory, `commands/plan.md` for a single file).
 */
export interface LockSource {
  path: string;
  key: string;
}

/** Added/removed/changed keys between an expected lock and the live resources. */
export interface LockDiff {
  /** Present in the live resources, absent from the lock. */
  added: string[];
  /** Present in the lock, absent from the live resources. */
  removed: string[];
  /** Present in both but the sha256 differs. */
  changed: string[];
}

/** Normalise a filesystem-relative path to POSIX separators for stable keys. */
function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/**
 * Hash every resolved source into a flat `relpath -> sha256` map. Directories are
 * expanded with `fingerprintDir` (every contained file, sorted); single files use
 * `fingerprintFile`. Unreadable / missing sources are skipped — enumeration only
 * ever hands us paths that existed at scan time.
 */
export function hashLockSources(sources: LockSource[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const src of sources) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(src.path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const fp of fingerprintDir(src.path)) {
        const rel = toPosix(path.relative(src.path, fp.path));
        out[`${src.key}/${rel}`] = fp.sha256;
      }
    } else if (stat.isFile()) {
      const fp = fingerprintFile(src.path);
      if (fp) out[src.key] = fp.sha256;
    }
  }
  return out;
}

/** Build a fully-sorted lock object from a resolved source set. */
export function buildLock(sources: LockSource[]): AgentsLock {
  return { version: LOCK_VERSION, resources: sortRecord(hashLockSources(sources)) };
}

/** Return a new record with keys inserted in sorted order (deterministic JSON). */
function sortRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

/** Serialise a lock to the canonical, sorted, newline-terminated JSON form. */
export function serializeLock(lock: AgentsLock): string {
  return JSON.stringify({ version: lock.version, resources: sortRecord(lock.resources) }, null, 2) + '\n';
}

/** Absolute path to the lockfile for a project root. */
export function lockPath(projectRoot: string): string {
  return path.join(projectRoot, LOCK_FILENAME);
}

/**
 * Read + validate an existing lock. Returns null ONLY when the file is absent —
 * a present-but-malformed lock throws, so `--frozen` fails closed instead of
 * silently treating corruption as "no lock".
 */
export function readLock(projectRoot: string): AgentsLock | null {
  const p = lockPath(projectRoot);
  if (!fs.existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    throw new Error(`${LOCK_FILENAME} is not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${LOCK_FILENAME} is malformed (expected an object).`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== LOCK_VERSION) {
    throw new Error(`${LOCK_FILENAME} version ${String(obj.version)} is unsupported (expected ${LOCK_VERSION}).`);
  }
  if (!obj.resources || typeof obj.resources !== 'object') {
    throw new Error(`${LOCK_FILENAME} is missing a resources map.`);
  }
  return { version: LOCK_VERSION, resources: obj.resources as Record<string, string> };
}

/** Write the lock to `<projectRoot>/agents.lock`, returning the path written. */
export function writeLock(projectRoot: string, lock: AgentsLock): string {
  const p = lockPath(projectRoot);
  fs.writeFileSync(p, serializeLock(lock));
  return p;
}

/** Diff a recorded lock against a freshly-computed one. */
export function diffLock(expected: AgentsLock, actual: AgentsLock): LockDiff {
  const e = expected.resources;
  const a = actual.resources;
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of Object.keys(a)) if (!(k in e)) added.push(k);
  for (const k of Object.keys(e)) {
    if (!(k in a)) removed.push(k);
    else if (e[k] !== a[k]) changed.push(k);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

/** True when a diff has no added/removed/changed entries. */
export function lockDiffIsClean(diff: LockDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/** Verify a recorded lock against the live resolved sources. */
export function verifyLock(expected: AgentsLock, sources: LockSource[]): LockDiff {
  return diffLock(expected, buildLock(sources));
}

/**
 * The project root the lockfile lives at: the parent of the discovered project
 * `.agents/` dir, or the cwd itself when none is found.
 */
export function resolveProjectRoot(cwd: string = process.cwd()): string {
  const projectDir = getProjectAgentsDir(cwd);
  return projectDir ? path.dirname(projectDir) : path.resolve(cwd);
}

/**
 * Enumerate the resolved resource sources for a cwd: for each lockable kind, the
 * winning entry per name across layers (project > user > system > extras), keyed
 * `<kind>/<entryName>`. This is a single-level `readdir` per kind dir — the
 * recursive fingerprinting is delegated to `fingerprintDir`.
 *
 * Entry names keep their extension in the key, so a hook script `foo.sh` and its
 * sidecar `foo.yaml` stay distinct (a name-stripped enumerator would collide
 * them). Dotfiles at the kind-dir top level are skipped as noise.
 */
export function enumerateLockSources(cwd: string = process.cwd()): LockSource[] {
  const roots: string[] = [];
  const projectDir = getProjectAgentsDir(cwd);
  if (projectDir) roots.push(projectDir);
  roots.push(getUserAgentsDir());
  roots.push(getSystemAgentsDir());
  for (const extra of getEnabledExtraRepos()) roots.push(extra.dir);

  const sources: LockSource[] = [];
  const seen = new Set<string>();
  for (const kind of LOCK_KINDS) {
    for (const root of roots) {
      const kindDir = path.join(root, kind);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(kindDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const key = `${kind}/${entry.name}`;
        if (seen.has(key)) continue; // project layer wins on same name
        seen.add(key);
        sources.push({ path: path.join(kindDir, entry.name), key });
      }
    }
  }
  return sources.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
