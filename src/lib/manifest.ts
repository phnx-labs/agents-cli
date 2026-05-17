/**
 * agents.yaml manifest reading, writing, and serialization.
 *
 * The manifest file (agents.yaml) is the central configuration for version defaults,
 * repository overrides, dependencies, and MCP server declarations.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';
import type { Manifest } from './types.js';
import { safeJoin } from './paths.js';

/** Canonical filename for the manifest in any agents repo or project root. */
export const MANIFEST_FILENAME = 'agents.yaml';
const MANIFEST_LOCK_STALE_MS = 5_000;
const MANIFEST_LOCK_RETRIES = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
}

/** Write a Manifest object to agents.yaml in the given directory. */
export function writeManifest(repoPath: string, manifest: Manifest): void {
  const manifestPath = safeJoin(repoPath, MANIFEST_FILENAME);
  const content = serializeManifest(manifest);
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
