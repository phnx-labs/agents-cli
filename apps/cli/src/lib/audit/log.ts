/**
 * Run-dispatch recording (issue #347) — now a thin write into the unified
 * event stream (`emit('run.dispatched', …)`). The historical hash-chained file
 * at `~/.agents/.history/audit/log.jsonl` is still readable via
 * `readAuditLog` / `verifyAuditChain` for pre-unification history; new runs do
 * NOT append there. Operators list run outcomes with:
 *
 *   agents events --include runs
 *   agents audit                 # alias of the above
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { sha256 } from '../staleness/fingerprint.js';
import { getHistoryDir } from '../state.js';
import { ensureLockTarget, withFileLock } from '../fs-atomic.js';
import { emit } from '../feed/events.js';

/** First record's `prevHash` — a fixed anchor so the chain has a root. */
export const GENESIS_HASH = 'GENESIS';

/** A run's outcome, derived from its process exit code. */
export type AuditOutcome = 'ok' | 'fail';

/** One immutable audit record. `hash` seals every other field, `prevHash` included. */
export interface AuditRecord {
  ts:       string;        // ISO-8601 UTC timestamp of the append
  agent:    string;        // resolved agent id (claude, codex, ...)
  version:  string;        // resolved version the run executed with
  repo:     string;        // git remote origin url, else the cwd
  mode:     string;        // exec mode (plan/edit/auto/skip/...)
  outcome:  AuditOutcome;  // 'ok' when exit === 0, else 'fail'
  exit:     number;        // raw process exit code
  prevHash: string;        // previous record's hash (or GENESIS_HASH)
  hash:     string;        // sha256(canonicalJSON(this record without `hash`))
}

/** The caller-supplied fields — the chain fields (`prevHash`/`hash`) are computed here. */
export type AuditEntry = Omit<AuditRecord, 'prevHash' | 'hash'>;

/**
 * Absolute path to the append-only audit log. Lives under `.history/` — the
 * durable-but-machine-local runtime bucket that is gitignored and never synced
 * by `agents repo push/pull`. Keeping it here (not under a top-level, tracked
 * `~/.agents/` path) means the token-bearing `repo` field can never leak into a
 * version-controlled DotAgents repo, and no cross-machine pull can fork the chain.
 */
export function getAuditLogPath(): string {
  return path.join(getHistoryDir(), 'audit', 'log.jsonl');
}

/**
 * Deterministic JSON: object keys sorted recursively so the same logical
 * record always serializes to the same bytes (hashing must be reproducible
 * across processes and machines). Values here are all primitives, but the
 * recursion keeps it correct if the record ever nests.
 */
function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

/** Compute the sealing hash for a record whose `prevHash` is already set. */
function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  return sha256(canonicalJSON(record));
}

/** Read + parse every record in the log, oldest-first. Missing file → []. */
function readRecords(logPath: string): AuditRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return []; // no log yet
  }
  const records: AuditRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(JSON.parse(trimmed) as AuditRecord);
  }
  return records;
}

/**
 * Append one record to the hash chain and return it. Links to the previous
 * record's `hash` (or `GENESIS_HASH` for the first), computes the sealing
 * hash, and writes a single JSONL line. Synchronous so the record is durable
 * before the caller proceeds.
 *
 * Read-last-hash + append run under the canonical advisory file lock
 * (`withFileLock`, backed by proper-lockfile). Without it, two concurrent
 * writers — the norm under parallel teams/routines dispatch — both read the
 * same last hash and both write `prevHash=H`, forking the chain into a false
 * "tampered" verdict. The lock forces a total order so every record links off
 * the genuinely-previous one. `ensureLockTarget` creates the file first because
 * proper-lockfile locks an existing path.
 */
export function appendAuditRecord(entry: AuditEntry, logPath: string = getAuditLogPath()): AuditRecord {
  ensureLockTarget(logPath);
  return withFileLock(logPath, () => {
    const existing = readRecords(logPath);
    const prevHash = existing.length ? existing[existing.length - 1].hash : GENESIS_HASH;
    const unsealed: Omit<AuditRecord, 'hash'> = { ...entry, prevHash };
    const record: AuditRecord = { ...unsealed, hash: hashRecord(unsealed) };
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
    return record;
  });
}

/**
 * Walk the chain and confirm every record reproduces. A record is valid when
 * (a) its `prevHash` matches the prior record's `hash` (GENESIS for the first)
 * AND (b) recomputing its sealing hash from its own fields reproduces the
 * stored `hash`. Returns the first failing index in `brokenAt`.
 */
export function verifyAuditChain(logPath: string = getAuditLogPath()): { ok: boolean; brokenAt?: number } {
  let records: AuditRecord[];
  try {
    records = readRecords(logPath);
  } catch (err) {
    // A line that won't even parse is itself tamper evidence — the log is corrupt.
    return { ok: false, brokenAt: 0 };
  }

  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.prevHash !== expectedPrev) return { ok: false, brokenAt: i };
    const { hash, ...unsealed } = r;
    if (hashRecord(unsealed) !== hash) return { ok: false, brokenAt: i };
    expectedPrev = r.hash;
  }
  return { ok: true };
}

/** Read the whole chain, oldest-first. Exposed for `agents audit list`. */
export function readAuditLog(logPath: string = getAuditLogPath()): AuditRecord[] {
  return readRecords(logPath);
}

/**
 * Resolve a stable repo label for a run: the git remote origin url when the
 * cwd is inside a repo with one, otherwise the cwd itself. Best-effort — any
 * failure falls back to the cwd.
 */
function repoLabel(cwd: string): string {
  try {
    const res = spawnSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    const url = res.status === 0 ? res.stdout.trim() : '';
    return url || cwd;
  } catch {
    return cwd;
  }
}

/**
 * Record ONE dispatched run at the single exec chokepoint into the unified
 * event stream. Non-fatal by contract: any failure is caught and warned, never
 * thrown — a log hiccup must not crash a run that already finished.
 */
export function recordDispatchedRun(run: {
  agent:    string;
  version:  string;
  mode:     string;
  cwd:      string;
  exitCode: number;
}): void {
  try {
    const outcome = run.exitCode === 0 ? 'ok' : 'fail';
    emit('run.dispatched', {
      module: 'run',
      agent: run.agent,
      version: run.version,
      mode: run.mode,
      repo: repoLabel(run.cwd),
      cwd: run.cwd,
      outcome,
      exitCode: run.exitCode,
      status: outcome,
    });
  } catch (err) {
    process.stderr.write(`[agents] run.dispatched emit failed: ${(err as Error).message}\n`);
  }
}
