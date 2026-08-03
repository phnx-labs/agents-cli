/**
 * Disposable performance warehouse — SQLite under ~/.agents/.cache/perf/.
 *
 * Design:
 *  - Loss is acceptable (cache dir). No FKs into sessions.db.
 *  - Identity columns use the same *string shapes* as sessions/events
 *    (session_id, session_short, agent, machine, actor, cwd) for soft joins.
 *  - Producers call {@link recordSample} (fail-soft). Hook shims append NDJSON
 *    to a spool file; the next open drains it into the table.
 *  - Retention defaults to 30 days; wipe anytime with `rm -rf ~/.agents/.cache/perf`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../sqlite.js';
import { getPerfDbPath, getPerfDir, getPerfSpoolPath } from '../state.js';
import { localMachineId } from '../session/origin-machine.js';

export const PERF_SCHEMA_VERSION = 1;
export const DEFAULT_RETENTION_DAYS = 30;

export type PerfKind = 'hook.fire' | 'perf.timing' | 'command.end' | string;

export interface PerfSample {
  tsMs?: number;
  kind: PerfKind;
  label: string;
  durationMs: number;
  /** Full session id — same string as sessions.id when known. */
  sessionId?: string;
  /** First 8 chars of sessionId (sessions.short_id shape). */
  sessionShort?: string;
  agent?: string;
  agentVersion?: string;
  /** Fleet registry name (sessions.machine), preferred over raw hostname. */
  machine?: string;
  hostname?: string;
  actor?: string;
  cwd?: string;
  cache?: string;
  exitCode?: number;
  status?: string;
  metaJson?: string;
}

export interface PerfAggregateRow {
  kind: string;
  label: string;
  n: number;
  p50Ms: number;
  p99Ms: number;
  meanMs: number;
  maxMs: number;
  minMs: number;
  /** Present for hook.fire rows with cache data. */
  cacheHitPct?: number;
  cacheStalePct?: number;
  cacheMissPct?: number;
  errorCount?: number;
}

export interface AggregateOptions {
  /** Only samples with ts_ms >= now - days*86400000. Default 7. */
  days?: number;
  kinds?: string[];
  label?: string;
  machine?: string;
  agent?: string;
  /** Drop labels with fewer samples than this. Default 1. */
  minN?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  session_id TEXT,
  session_short TEXT,
  agent TEXT,
  agent_version TEXT,
  machine TEXT,
  hostname TEXT,
  actor TEXT,
  cwd TEXT,
  cache TEXT,
  exit_code INTEGER,
  status TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_perf_ts ON samples(ts_ms);
CREATE INDEX IF NOT EXISTS idx_perf_kind_ts ON samples(kind, ts_ms);
CREATE INDEX IF NOT EXISTS idx_perf_label_ts ON samples(label, ts_ms);
CREATE INDEX IF NOT EXISTS idx_perf_machine_ts ON samples(machine, ts_ms);
CREATE INDEX IF NOT EXISTS idx_perf_session ON samples(session_id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let _db: Database.Database | null = null;
let _dbPath: string | null = null;
let _disabled = false;

/** Test seam — redirect the warehouse path (like AGENTS_EVENTS_PATH). */
export function _resetPerfDbForTest(overridePath?: string | null): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  _db = null;
  _dbPath = overridePath === undefined ? null : overridePath;
  _disabled = false;
}

function resolveDbPath(): string {
  return process.env.AGENTS_PERF_DB || _dbPath || getPerfDbPath();
}

function resolveSpoolPath(): string {
  if (process.env.AGENTS_PERF_SPOOL) return process.env.AGENTS_PERF_SPOOL;
  if (_dbPath) return path.join(path.dirname(_dbPath), 'spool.jsonl');
  return getPerfSpoolPath();
}

function isDisabled(): boolean {
  if (_disabled) return true;
  const v = process.env.AGENTS_DISABLE_PERF;
  return v === '1' || v === 'true';
}

/** Short session id: first 8 hex-ish chars of a full id. */
export function shortSessionId(sessionId: string | undefined | null): string | undefined {
  if (!sessionId) return undefined;
  const cleaned = sessionId.replace(/^session_/, '');
  return cleaned.length >= 8 ? cleaned.slice(0, 8) : cleaned || undefined;
}

function openDb(): Database.Database | null {
  if (isDisabled()) return null;
  const dbPath = resolveDbPath();
  if (_db && _dbPath === dbPath) return _db;
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');
    db.exec(SCHEMA);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    if (!row) {
      db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(PERF_SCHEMA_VERSION));
    }
    _db = db;
    _dbPath = dbPath;
    drainSpool(db);
    maybeRetain(db);
    return db;
  } catch {
    _disabled = true;
    return null;
  }
}

/**
 * Insert one timing sample. Never throws — perf must not break the critical path.
 */
export function recordSample(sample: PerfSample): void {
  if (isDisabled()) return;
  if (!sample.label || !Number.isFinite(sample.durationMs)) return;
  try {
    const db = openDb();
    if (!db) return;
    const tsMs = sample.tsMs ?? Date.now();
    const sessionId = sample.sessionId;
    const sessionShort = sample.sessionShort ?? shortSessionId(sessionId);
    const machine = sample.machine ?? localMachineId();
    const hostname = sample.hostname ?? os.hostname();
    db.prepare(`
      INSERT INTO samples (
        ts_ms, kind, label, duration_ms,
        session_id, session_short, agent, agent_version,
        machine, hostname, actor, cwd,
        cache, exit_code, status, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tsMs,
      sample.kind,
      sample.label,
      sample.durationMs,
      sessionId ?? null,
      sessionShort ?? null,
      sample.agent ?? null,
      sample.agentVersion ?? null,
      machine ?? null,
      hostname ?? null,
      sample.actor ?? null,
      sample.cwd ?? null,
      sample.cache ?? null,
      sample.exitCode ?? null,
      sample.status ?? null,
      sample.metaJson ?? null,
    );
  } catch {
    // Fail soft.
  }
}

/** Drain the bash-shim NDJSON spool into samples. Idempotent; truncates on success. */
export function drainSpool(db?: Database.Database): number {
  const spool = resolveSpoolPath();
  if (!fs.existsSync(spool)) return 0;
  let raw: string;
  try {
    raw = fs.readFileSync(spool, 'utf-8');
  } catch {
    return 0;
  }
  if (!raw.trim()) {
    try { fs.writeFileSync(spool, ''); } catch { /* ignore */ }
    return 0;
  }
  const target = db ?? openDb();
  if (!target) return 0;

  let n = 0;
  const insert = target.prepare(`
    INSERT INTO samples (
      ts_ms, kind, label, duration_ms,
      session_id, session_short, agent, agent_version,
      machine, hostname, actor, cwd,
      cache, exit_code, status, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const txn = target.transaction((lines: string[]) => {
    for (const line of lines) {
      if (!line.trim()) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(line); } catch { continue; }
      const label = String(o.label ?? o.hook ?? '');
      const durationMs = Number(o.duration_ms ?? o.durationMs ?? o.ms);
      if (!label || !Number.isFinite(durationMs)) continue;
      const sessionId = o.session_id != null ? String(o.session_id)
        : o.sessionId != null ? String(o.sessionId) : null;
      const tsMs = Number(o.ts_ms ?? o.tsMs) || (typeof o.ts === 'string' ? Date.parse(o.ts) : Date.now());
      insert.run(
        Number.isFinite(tsMs) ? tsMs : Date.now(),
        String(o.kind ?? 'hook.fire'),
        label,
        durationMs,
        sessionId,
        o.session_short != null ? String(o.session_short) : shortSessionId(sessionId) ?? null,
        o.agent != null ? String(o.agent) : null,
        o.agent_version != null ? String(o.agent_version) : o.agentVersion != null ? String(o.agentVersion) : null,
        o.machine != null ? String(o.machine) : localMachineId(),
        o.hostname != null ? String(o.hostname) : os.hostname(),
        o.actor != null ? String(o.actor) : null,
        o.cwd != null ? String(o.cwd) : null,
        o.cache != null ? String(o.cache) : null,
        o.exit_code != null ? Number(o.exit_code) : o.exit != null ? Number(o.exit) : null,
        o.status != null ? String(o.status) : null,
        o.meta_json != null ? String(o.meta_json) : null,
      );
      n++;
    }
  });
  try {
    txn(raw.split('\n'));
    fs.writeFileSync(spool, '');
  } catch {
    return 0;
  }
  return n;
}

function maybeRetain(db: Database.Database): void {
  try {
    const last = db.prepare(`SELECT value FROM meta WHERE key = 'last_retain_ms'`).get() as { value: string } | undefined;
    const lastMs = last ? parseInt(last.value, 10) : 0;
    const now = Date.now();
    // At most once per hour.
    if (now - lastMs < 3_600_000) return;
    const cutoff = now - DEFAULT_RETENTION_DAYS * 86_400_000;
    db.prepare(`DELETE FROM samples WHERE ts_ms < ?`).run(cutoff);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('last_retain_ms', ?)`).run(String(now));
  } catch {
    // ignore
  }
}

/** Percentile of a sorted-ascending array. p in [0,100]. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Aggregate samples by (kind, label) with p50/p99. Drains the spool first.
 */
export function aggregateSamples(opts: AggregateOptions = {}): PerfAggregateRow[] {
  const db = openDb();
  if (!db) return [];
  drainSpool(db);

  const days = opts.days ?? 7;
  const sinceMs = Date.now() - days * 86_400_000;
  const minN = opts.minN ?? 1;

  const clauses = ['ts_ms >= ?'];
  const params: unknown[] = [sinceMs];
  if (opts.kinds && opts.kinds.length > 0) {
    clauses.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
    params.push(...opts.kinds);
  }
  if (opts.label) {
    clauses.push('label = ?');
    params.push(opts.label);
  }
  if (opts.machine) {
    clauses.push('machine = ?');
    params.push(opts.machine);
  }
  if (opts.agent) {
    clauses.push('agent = ?');
    params.push(opts.agent);
  }

  const rows = db.prepare(
    `SELECT kind, label, duration_ms, cache, exit_code
     FROM samples WHERE ${clauses.join(' AND ')}`
  ).all(...params) as Array<{
    kind: string;
    label: string;
    duration_ms: number;
    cache: string | null;
    exit_code: number | null;
  }>;

  type Bucket = {
    kind: string;
    label: string;
    durations: number[];
    hits: number;
    stale: number;
    misses: number;
    errors: number;
  };
  const map = new Map<string, Bucket>();
  for (const r of rows) {
    const key = `${r.kind}\0${r.label}`;
    let b = map.get(key);
    if (!b) {
      b = { kind: r.kind, label: r.label, durations: [], hits: 0, stale: 0, misses: 0, errors: 0 };
      map.set(key, b);
    }
    b.durations.push(Number(r.duration_ms));
    if (r.cache === 'hit') b.hits++;
    else if (r.cache === 'stale-prefetch') b.stale++;
    else if (r.cache === 'miss' || r.cache === 'none') b.misses++;
    if (typeof r.exit_code === 'number' && r.exit_code !== 0) b.errors++;
  }

  const out: PerfAggregateRow[] = [];
  for (const b of map.values()) {
    if (b.durations.length < minN) continue;
    const sorted = b.durations.slice().sort((a, c) => a - c);
    const n = sorted.length;
    const sum = sorted.reduce((a, c) => a + c, 0);
    const row: PerfAggregateRow = {
      kind: b.kind,
      label: b.label,
      n,
      p50Ms: Math.round(percentile(sorted, 50)),
      p99Ms: Math.round(percentile(sorted, 99)),
      meanMs: Math.round(sum / n),
      maxMs: sorted[n - 1],
      minMs: sorted[0],
    };
    if (b.hits + b.stale + b.misses > 0) {
      row.cacheHitPct = Math.round((b.hits / n) * 100);
      row.cacheStalePct = Math.round((b.stale / n) * 100);
      row.cacheMissPct = Math.round((b.misses / n) * 100);
    }
    if (b.errors > 0) row.errorCount = b.errors;
    out.push(row);
  }
  out.sort((a, b) => b.p99Ms - a.p99Ms);
  return out;
}

/** Absolute path of the warehouse (for help / doctor). */
export function perfDbPath(): string {
  return resolveDbPath();
}

/** Absolute path of the spool (for shim generation). */
export function perfSpoolPath(): string {
  return resolveSpoolPath();
}

/** Ensure the perf dir exists and return it (for shims). */
export function ensurePerfDir(): string {
  const dir = process.env.AGENTS_PERF_DIR || (_dbPath ? path.dirname(_dbPath) : getPerfDir());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
