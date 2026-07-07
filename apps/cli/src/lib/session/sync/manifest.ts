/**
 * Manifests and the local upload ledger.
 *
 * Each machine publishes one manifest object (sessions/<machine>/manifest.json)
 * listing every session it holds, keyed by session id, with content hash + size
 * + last event timestamp. Pulling machines diff manifests to fetch only changed
 * objects — no per-tick LIST of thousands of keys.
 *
 * The local upload ledger (cache, per machine) records (size, mtime, hash) of
 * files already pushed, so a tick re-uploads only files that actually grew.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getCacheDir } from '../../state.js';

export interface ManifestEntry {
  /** Storage-relative key, preserved into the mirror layout on the puller. */
  relKey: string;
  size: number;
  /** SHA-256 of the full transcript file. */
  hash: string;
  /** Latest event timestamp in the transcript. */
  lastTs: string;
}

/** sessionId -> entry */
export type AgentManifest = Record<string, ManifestEntry>;

export interface Manifest {
  machine: string;
  updatedAt: string;
  /** agentId -> (sessionId -> entry) */
  agents: Record<string, AgentManifest>;
}

export function emptyManifest(machine: string, updatedAt: string): Manifest {
  return { machine, updatedAt, agents: {} };
}

export function parseManifest(text: string): Manifest | null {
  try {
    const m = JSON.parse(text);
    if (m && typeof m.machine === 'string' && m.agents && typeof m.agents === 'object') return m;
    return null;
  } catch {
    return null;
  }
}

export function hashContent(content: string | Uint8Array): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function stateDir(): string {
  return path.join(getCacheDir(), 'state', 'sessions-sync');
}

// --- local cached copy of our published manifest ---------------------------

function localManifestPath(): string {
  return path.join(stateDir(), 'manifest.json');
}

export function loadLocalManifest(): Manifest | null {
  try {
    return parseManifest(fs.readFileSync(localManifestPath(), 'utf-8'));
  } catch {
    return null;
  }
}

export function saveLocalManifest(m: Manifest): void {
  const p = localManifestPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(m), 'utf-8');
}

// --- pull state: which source signature we last materialized per session ---

/** key `${agent}/${sessionId}` -> signature of applied source hashes */
export type PullState = Record<string, string>;

function pullStatePath(): string {
  return path.join(stateDir(), 'pull-state.json');
}

export function loadPullState(): PullState {
  try {
    return JSON.parse(fs.readFileSync(pullStatePath(), 'utf-8')) as PullState;
  } catch {
    return {};
  }
}

export function savePullState(s: PullState): void {
  const p = pullStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s), 'utf-8');
}

/** Order-independent signature of the source hashes feeding one mirrored session. */
export function sourceSignature(hashes: string[]): string {
  return [...hashes].sort().join(',');
}

// --- local upload ledger ---------------------------------------------------

interface LedgerRow {
  size: number;
  mtimeMs: number;
  hash: string;
}
type Ledger = Record<string, LedgerRow>;

function ledgerPath(): string {
  return path.join(getCacheDir(), 'state', 'sessions-sync', 'upload-ledger.json');
}

export function loadLedger(): Ledger {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(), 'utf-8')) as Ledger;
  } catch {
    return {};
  }
}

export function saveLedger(ledger: Ledger): void {
  const p = ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger), 'utf-8');
}

/** True if the file at absPath is unchanged since we last uploaded it. */
export function ledgerUnchanged(ledger: Ledger, absPath: string, size: number, mtimeMs: number): boolean {
  const row = ledger[absPath];
  return !!row && row.size === size && row.mtimeMs === Math.floor(mtimeMs);
}

export function ledgerRecord(ledger: Ledger, absPath: string, size: number, mtimeMs: number, hash: string): void {
  ledger[absPath] = { size, mtimeMs: Math.floor(mtimeMs), hash };
}
