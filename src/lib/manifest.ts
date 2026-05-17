/**
 * agents.yaml manifest reading, writing, and serialization.
 *
 * The manifest file (agents.yaml) is the central configuration for version defaults,
 * repository overrides, dependencies, and MCP server declarations.
 */
import * as fs from 'fs';
import * as yaml from 'yaml';
<<<<<<< HEAD
import { ensureLockTarget, atomicWriteFileSync, withFileLock } from './fs-atomic.js';
=======
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';
>>>>>>> b1dcb42faa80b58f7aeddf399bba73b81e67e5f5
import type { Manifest } from './types.js';
import { safeJoin } from './paths.js';

/** Canonical filename for the manifest in any agents repo or project root. */
export const MANIFEST_FILENAME = 'agents.yaml';
const MANIFEST_LOCK_STALE_MS = 5_000;
const MANIFEST_LOCK_RETRIES = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Per-path re-entrancy depth so withManifestLock is safe against recursive calls.
const manifestLockDepth = new Map<string, number>();

/** Parse a YAML string into a typed Manifest object. */
export function parseManifest(content: string): Manifest {
  return yaml.parse(content) as Manifest;
}

/** Serialize a Manifest object to a YAML string with 2-space indentation. */
export function serializeManifest(manifest: Manifest): string {
  return yaml.stringify(manifest, { indent: 2 });
}

/** Read and parse agents.yaml from a directory. Returns null if the file does not exist. */
export function readManifest(repoPath: string): Manifest | null {
  const manifestPath = safeJoin(repoPath, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const content = fs.readFileSync(manifestPath, 'utf-8');
  return parseManifest(content);
}

<<<<<<< HEAD
function withManifestLock<T>(filePath: string, fn: () => T): T {
  const depth = manifestLockDepth.get(filePath) ?? 0;
  if (depth > 0) {
    manifestLockDepth.set(filePath, depth + 1);
    try {
      return fn();
    } finally {
      manifestLockDepth.set(filePath, depth);
    }
  }
  // Project manifests are shared (no restricted dir mode unlike ~/.agents).
  ensureLockTarget(filePath);
  return withFileLock(filePath, () => {
    manifestLockDepth.set(filePath, 1);
    try {
      return fn();
    } finally {
      manifestLockDepth.delete(filePath);
    }
  });
=======
function ensureLockTarget(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) return;
  try {
    fs.writeFileSync(filePath, '', { encoding: 'utf-8', flag: 'wx' });
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
>>>>>>> b1dcb42faa80b58f7aeddf399bba73b81e67e5f5
}

/** Write a Manifest object to agents.yaml in the given directory. */
export function writeManifest(repoPath: string, manifest: Manifest): void {
  const manifestPath = safeJoin(repoPath, MANIFEST_FILENAME);
  const content = serializeManifest(manifest);
<<<<<<< HEAD
  withManifestLock(manifestPath, () => atomicWriteFileSync(manifestPath, content));
=======
  ensureLockTarget(manifestPath);
  let release: (() => void) | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt <= MANIFEST_LOCK_RETRIES; attempt++) {
    try {
      release = lockfile.lockSync(manifestPath, { stale: MANIFEST_LOCK_STALE_MS });
      break;
    } catch (err) {
      lastError = err;
      if (attempt < MANIFEST_LOCK_RETRIES) sleepSync(50 * (attempt + 1));
    }
  }
  if (!release) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Could not acquire lock for ${manifestPath}: ${message}`);
  }
  try {
    atomicWriteFileSync(manifestPath, content);
  } finally {
    release();
  }
>>>>>>> b1dcb42faa80b58f7aeddf399bba73b81e67e5f5
}

/** Create a Manifest with sensible defaults for a fresh agents repo. */
export function createDefaultManifest(): Manifest {
  return {
    agents: {},
    dependencies: {},
    mcp: {},
    defaults: {
      method: 'symlink',
      scope: 'global',
      agents: ['claude', 'codex', 'gemini', 'cursor', 'opencode'],
    },
  };
}
