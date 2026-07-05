/**
 * Cross-agent, tamper-evident audit log of every dispatched run (issue #347).
 *
 * Every run that reaches the single dispatch chokepoint in `agents run`
 * (src/commands/exec.ts) appends ONE record here. Records form a hash chain:
 * each record embeds the previous record's `hash` as `prevHash`, and its own
 * `hash` is `sha256(canonicalJSON(record-without-hash))`. Because `prevHash`
 * is part of the hashed payload, rewriting or reordering any record breaks the
 * chain from that point forward — `verifyAuditChain()` reports the first index
 * that fails to reproduce.
 *
 * Storage is append-only JSONL under the user repo (`~/.agents/audit/log.jsonl`),
 * one record per line. The write path is deliberately cheap and non-fatal: a
 * logging failure must never crash a run (see `recordDispatchedRun`).
 *
 * Governance context: this is the evidence trail an operator needs to answer
 * "which agent, at which version, ran against which repo, and did it succeed?"
 * — the kind of automated-decision logging the EU AI Act (Art. 12) expects of
 * high-risk systems, kept tamper-evident so the log itself can be trusted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { sha256 } from '../staleness/fingerprint.js';
import { getUserAgentsDir } from '../state.js';

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

/** Absolute path to the append-only audit log. */
export function getAuditLogPath(): string {
  return path.join(getUserAgentsDir(), 'audit', 'log.jsonl');
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
 */
export function appendAuditRecord(entry: AuditEntry, logPath: string = getAuditLogPath()): AuditRecord {
  const existing = readRecords(logPath);
  const prevHash = existing.length ? existing[existing.length - 1].hash : GENESIS_HASH;
  const unsealed: Omit<AuditRecord, 'hash'> = { ...entry, prevHash };
  const record: AuditRecord = { ...unsealed, hash: hashRecord(unsealed) };

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  return record;
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
 * Record ONE dispatched run at the single exec chokepoint. Non-fatal by
 * contract: any failure is caught and warned, never thrown — an audit-log
 * hiccup must not crash a run that already finished.
 */
export function recordDispatchedRun(run: {
  agent:    string;
  version:  string;
  mode:     string;
  cwd:      string;
  exitCode: number;
}): void {
  try {
    appendAuditRecord({
      ts:      new Date().toISOString(),
      agent:   run.agent,
      version: run.version,
      repo:    repoLabel(run.cwd),
      mode:    run.mode,
      outcome: run.exitCode === 0 ? 'ok' : 'fail',
      exit:    run.exitCode,
    });
  } catch (err) {
    process.stderr.write(`[agents] audit log write failed: ${(err as Error).message}\n`);
  }
}
