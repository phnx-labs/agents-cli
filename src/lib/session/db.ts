/**
 * SQLite-backed session index and full-text search.
 *
 * Stores session metadata and user-prompt text in a WAL-mode SQLite database
 * at ~/.agents/sessions/sessions.db. Provides incremental upsert, scan-stamp
 * ledger (mtime/size tracking to skip unchanged files), FTS5 search with
 * BM25 ranking, and label-first search for /rename'd sessions.
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from '../sqlite.js';
import type { SessionAgentId, SessionMeta } from './types.js';
import { getSessionsDir, getSessionsDbPath } from '../state.js';

const SESSIONS_DIR = getSessionsDir();
const DB_PATH = getSessionsDbPath();

/** Current schema version; bumped when migrations are added. */
const SCHEMA_VERSION = 6;

/**
 * Canonicalize a file path for use as a scan_ledger key. The same physical
 * session file is reachable via multiple aliases — `~/.claude/projects/x.jsonl`
 * (when `~/.claude` is a symlink to a versioned home) and
 * `~/.agents/versions/claude/<v>/home/.claude/projects/x.jsonl`. Keying the
 * ledger by the raw path means switching between these aliases (e.g. via
 * `agents use`) misses the cache and forces a full re-parse. Realpath collapses
 * all aliases to one stable key.
 */
function canonicalLedgerKey(filePath: string): string {
  if (!filePath) return filePath;
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

// BM25 column weights for session_text: label > topic > project > content.
// Higher weights make matches in that column rank higher.
/** BM25 column weights for FTS5: label > topic > project > content. */
const BM25_WEIGHTS = [5.0, 2.0, 1.5, 1.0] as const;

/** DDL for the sessions database (tables, indexes, FTS5 virtual table). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  version TEXT,
  account TEXT,
  timestamp TEXT NOT NULL,
  project TEXT,
  cwd TEXT,
  git_branch TEXT,
  topic TEXT,
  label TEXT,
  message_count INTEGER,
  token_count INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  file_path TEXT NOT NULL,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  scanned_at INTEGER,
  is_team_origin INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON sessions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_file_path ON sessions(file_path);
CREATE INDEX IF NOT EXISTS idx_sessions_short_id ON sessions(short_id);

CREATE VIRTUAL TABLE IF NOT EXISTS session_text USING fts5(
  session_id UNINDEXED,
  label,
  topic,
  project,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Tracks every file we've stat'd during a scan, regardless of whether it
-- produced a session row. Decouples "did we already look at this?" from
-- "do we have a session from it?" — essential for files that don't parse
-- into a session (no id) or session rows whose file_path is synthetic.
CREATE TABLE IF NOT EXISTS scan_ledger (
  file_path TEXT PRIMARY KEY,
  file_mtime_ms INTEGER NOT NULL,
  file_size INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL
);
`;

/** Raw row shape returned from the sessions table. */
export interface SessionRow {
  id: string;
  short_id: string;
  agent: string;
  version: string | null;
  account: string | null;
  timestamp: string;
  project: string | null;
  cwd: string | null;
  git_branch: string | null;
  topic: string | null;
  label: string | null;
  message_count: number | null;
  token_count: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  file_path: string;
  file_mtime_ms: number | null;
  file_size: number | null;
  scanned_at: number | null;
  is_team_origin: number;
}

/** File stat snapshot used to detect changes between scan runs. */
export interface ScanStamp {
  fileMtimeMs: number;
  fileSize: number;
}

/** Filter and pagination options for querying the sessions table. */
export interface QueryOptions {
  agent?: SessionAgentId;
  agents?: SessionAgentId[];
  version?: string;
  cwd?: string;
  /** Match any session whose cwd equals this or is a descendant of it. */
  cwdPrefix?: string;
  project?: string;
  /** Match the full session id or short id, case-insensitively (exact). */
  idExact?: string;
  /** Match sessions whose id or short id begins with this (case-insensitive prefix). */
  idPrefix?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
  /** Drop rows flagged as team-origin before LIMIT is applied. */
  excludeTeamOrigin?: boolean;
  /** Keep only team-origin rows (for hidden-count queries). */
  onlyTeamOrigin?: boolean;
  /**
   * Column to order by, all descending. 'timestamp' (default) sorts newest
   * first; 'cost' and 'duration' put the priciest / longest sessions on top,
   * with NULLs sorted last so unpriced rows never crowd out real data.
   */
  sortBy?: 'timestamp' | 'cost' | 'duration';
}

let dbInstance: Database.Database | null = null;

/**
 * Apply schema migrations from `fromVersion` → SCHEMA_VERSION. The new
 * `CREATE IF NOT EXISTS` at SCHEMA doesn't help when column sets or FTS
 * column definitions change — those need explicit migration here.
 */
function migrateSchema(db: Database.Database, fromVersion: number): void {
  if (fromVersion < 2) {
    // v1 → v2: add `label` column to sessions and switch session_text from
    // single `content` column to multi-column (label, topic, project, content).
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'label')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN label TEXT`);
    }
    // FTS5 virtual tables can't be ALTERed — drop and recreate. Scan ledger
    // is cleared so every file gets re-parsed on next run, repopulating FTS5.
    db.exec(`
      DROP TABLE IF EXISTS session_text;
      CREATE VIRTUAL TABLE session_text USING fts5(
        session_id UNINDEXED,
        label,
        topic,
        project,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      DELETE FROM scan_ledger;
    `);
  }
  if (fromVersion < 3) {
    // v2 → v3: topic extraction now strips team-spawn wrapper prompts
    // (HEADLESS PLAN MODE prefix + summary suffix). Force a rescan so cached
    // topics like "You are running in HEADLESS PLAN MODE..." get re-extracted.
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 4) {
    // v3 → v4: team-origin is now captured structurally from the JSONL
    // `entrypoint` field at scan time. Add the column and force a rescan so
    // every existing Claude session gets its flag populated.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'is_team_origin')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN is_team_origin INTEGER DEFAULT 0`);
    }
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 5) {
    // v4 → v5: ledger is now keyed by realpath instead of the as-discovered
    // path, so symlink/version-relative aliases for the same physical file
    // collapse to one row. Old aliased rows are dropped — next scan will
    // repopulate under canonical keys.
    db.exec(`DELETE FROM scan_ledger;`);
  }
  if (fromVersion < 6) {
    // v5 → v6: cost ($) and wall-clock duration are now computed at scan time
    // from raw per-model token usage. Add the columns and force a full rescan
    // so every existing session gets its cost_usd / duration_ms populated.
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'cost_usd')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN cost_usd REAL`);
    }
    if (!cols.some(c => c.name === 'duration_ms')) {
      db.exec(`ALTER TABLE sessions ADD COLUMN duration_ms INTEGER`);
    }
    db.exec(`DELETE FROM scan_ledger;`);
  }
}

/** Open (or return the cached) sessions database, applying migrations as needed. */
export function getDB(): Database.Database {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  // Wait up to 30s instead of failing immediately on SQLITE_BUSY. Multiple
  // agents (CLIs, skills, hooks) open this DB concurrently. The first scan of
  // a new version home can take longer than 10s; concurrent callers need enough
  // headroom to wait. The ledger-recheck in upsertSessionsBatch makes
  // subsequent writers near-instant, so 30s is a rarely-reached safety net.
  db.pragma('busy_timeout = 30000');
  db.exec(SCHEMA);

  const current = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  const currentVersion = current ? parseInt(current.value, 10) : 0;

  if (!current) {
    db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  } else if (currentVersion < SCHEMA_VERSION) {
    migrateSchema(db, currentVersion);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  }

  // One-shot cleanup of the pre-SQLite JSONL indexes. Safe — nothing reads
  // them anymore. Guarded by a meta flag so we only try once.
  const cleaned = db.prepare(`SELECT value FROM meta WHERE key = 'legacy_indexes_removed'`).get() as { value: string } | undefined;
  if (!cleaned) {
    for (const p of [
      path.join(SESSIONS_DIR, 'index.jsonl'),
      path.join(SESSIONS_DIR, 'content_index.jsonl'),
      path.join(SESSIONS_DIR, 'index.jsonl.bak'),
    ]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    }
    db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES ('legacy_indexes_removed', '1')`).run();
  }

  dbInstance = db;
  return db;
}

/** Close the cached database connection. */
export function closeDB(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// ---------------------------------------------------------------------------
// Scan coordinator — prevents concurrent full scans across processes
// ---------------------------------------------------------------------------

/** How long a scan claim is trusted before it's considered stale (ms). */
const SCAN_CLAIM_TTL_MS = 120_000; // 2 minutes

function isProcessAlive(pid: number): boolean {
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to claim the right to run the incremental scan. Returns true if this
 * process should proceed with scanning, false if another live process is
 * already scanning (caller should skip the scan and serve from the DB).
 *
 * Uses the `meta` table so it survives crashes — dead PIDs are detected via
 * process.kill(pid, 0), stale entries via TTL. No external lock files needed.
 *
 * Wrapped in db.transaction() (BEGIN IMMEDIATE) so the read-then-write is
 * atomic and busy_timeout retries correctly — bare auto-commit DML in WAL
 * mode can return SQLITE_BUSY_SNAPSHOT which bypasses the busy handler.
 */
export function tryClaimScan(pid: number): boolean {
  const db = getDB();

  const txn = db.transaction((): boolean => {
    const existing = db
      .prepare(`SELECT value FROM meta WHERE key = 'scan_in_progress'`)
      .get() as { value: string } | undefined;

    if (existing) {
      const parts = existing.value.split(':');
      const existingPid = parseInt(parts[0], 10);
      const existingTs = parseInt(parts[1], 10);
      const ageMs = Date.now() - existingTs;
      if (isProcessAlive(existingPid) && ageMs < SCAN_CLAIM_TTL_MS) {
        return false; // another live process is scanning — skip
      }
      // Dead PID or expired TTL — take over below
    }

    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('scan_in_progress', ?)`)
      .run(`${pid}:${Date.now()}`);
    return true;
  });

  return txn();
}

/**
 * Release the scan claim written by tryClaimScan. Only deletes the entry
 * if it still belongs to this process (guards against TTL takeovers).
 */
export function releaseScan(pid: number): void {
  const db = getDB();
  const txn = db.transaction((): void => {
    const existing = db
      .prepare(`SELECT value FROM meta WHERE key = 'scan_in_progress'`)
      .get() as { value: string } | undefined;
    if (!existing) return;
    const claimPid = parseInt(existing.value.split(':')[0], 10);
    if (claimPid === pid) {
      db.prepare(`DELETE FROM meta WHERE key = 'scan_in_progress'`).run();
    }
  });
  txn();
}

/** Return the absolute path to the sessions database file. */
export function getDBPath(): string {
  return DB_PATH;
}

/**
 * Look up the file stat stamp we stored the last time we scanned a given file path.
 * Callers compare this to the current fs.stat to decide whether to rescan.
 */
export function getScanStampByPath(filePath: string): ScanStamp | null {
  const db = getDB();
  const row = db
    .prepare(`SELECT file_mtime_ms, file_size FROM scan_ledger WHERE file_path = ? LIMIT 1`)
    .get(canonicalLedgerKey(filePath)) as { file_mtime_ms: number; file_size: number } | undefined;
  return row ? { fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size } : null;
}

/**
 * Bulk-load the stamp ledger for a set of file paths in a single SQL query.
 * This is the fast path used by the incremental scanner — avoids N+1 queries.
 */
export function getScanStampsForPaths(filePaths: string[]): Map<string, ScanStamp> {
  const result = new Map<string, ScanStamp>();
  if (filePaths.length === 0) return result;
  const db = getDB();

  // Multiple input paths can resolve to the same canonical key (e.g. the same
  // session JSONL reachable via `~/.claude/...` and `~/.agents/versions/...`).
  // We query DB by canonical key, then fan results back out to every original
  // alias so callers can `.get(filePath)` with the path they passed in.
  const canonicalToOriginals = new Map<string, string[]>();
  for (const fp of filePaths) {
    const canonical = canonicalLedgerKey(fp);
    const aliases = canonicalToOriginals.get(canonical);
    if (aliases) aliases.push(fp);
    else canonicalToOriginals.set(canonical, [fp]);
  }

  const canonicalKeys = [...canonicalToOriginals.keys()];

  // SQLite parameter limit is typically 999 / 32766 — chunk defensively.
  const CHUNK = 500;
  for (let i = 0; i < canonicalKeys.length; i += CHUNK) {
    const chunk = canonicalKeys.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT file_path, file_mtime_ms, file_size
        FROM scan_ledger
        WHERE file_path IN (${placeholders})
      `)
      .all(...chunk) as Array<{ file_path: string; file_mtime_ms: number; file_size: number }>;

    for (const row of rows) {
      const stamp = { fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size };
      for (const original of canonicalToOriginals.get(row.file_path) || []) {
        result.set(original, stamp);
      }
    }
  }
  return result;
}

/**
 * Record scan stamps for files we've looked at. Covers both files that produced
 * a session and files we looked at but chose not to index (e.g. malformed).
 */
export function recordScans(entries: Array<{ filePath: string; scan: ScanStamp }>): void {
  if (entries.length === 0) return;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      scanned_at = excluded.scanned_at
  `);
  const now = Date.now();
  const txn = db.transaction((items: typeof entries) => {
    for (const { filePath, scan } of items) {
      stmt.run(canonicalLedgerKey(filePath), scan.fileMtimeMs, scan.fileSize, now);
    }
  });
  txn(entries);
}

const upsertSessionStmt = (db: Database.Database) => db.prepare(`
  INSERT INTO sessions (
    id, short_id, agent, version, account, timestamp,
    project, cwd, git_branch, topic, label, message_count, token_count,
    cost_usd, duration_ms,
    file_path, file_mtime_ms, file_size, scanned_at, is_team_origin
  ) VALUES (
    @id, @short_id, @agent, @version, @account, @timestamp,
    @project, @cwd, @git_branch, @topic, @label, @message_count, @token_count,
    @cost_usd, @duration_ms,
    @file_path, @file_mtime_ms, @file_size, @scanned_at, @is_team_origin
  )
  ON CONFLICT(id) DO UPDATE SET
    short_id = excluded.short_id,
    agent = excluded.agent,
    version = excluded.version,
    account = excluded.account,
    timestamp = excluded.timestamp,
    project = excluded.project,
    cwd = excluded.cwd,
    git_branch = excluded.git_branch,
    topic = excluded.topic,
    label = excluded.label,
    message_count = excluded.message_count,
    token_count = excluded.token_count,
    cost_usd = excluded.cost_usd,
    duration_ms = excluded.duration_ms,
    file_path = excluded.file_path,
    file_mtime_ms = excluded.file_mtime_ms,
    file_size = excluded.file_size,
    scanned_at = excluded.scanned_at,
    is_team_origin = excluded.is_team_origin
`);

const deleteTextStmt = (db: Database.Database) =>
  db.prepare(`DELETE FROM session_text WHERE session_id = ?`);
const insertTextStmt = (db: Database.Database) =>
  db.prepare(`INSERT INTO session_text (session_id, label, topic, project, content) VALUES (?, ?, ?, ?, ?)`);

let cachedStmts: {
  upsert?: Database.Statement<SessionRow>;
  delText?: Database.Statement<unknown[]>;
  insText?: Database.Statement<unknown[]>;
} = {};

function stmts(db: Database.Database) {
  if (!cachedStmts.upsert) {
    cachedStmts = {
      upsert: upsertSessionStmt(db) as Database.Statement<SessionRow>,
      delText: deleteTextStmt(db),
      insText: insertTextStmt(db),
    };
  }
  return cachedStmts as Required<typeof cachedStmts>;
}

/**
 * Upsert a session row and replace its FTS5 content in a single transaction.
 * `content` is the tokenizable user-prompt text; pass '' to leave the row unsearchable.
 */
export function upsertSession(meta: SessionMeta, content: string, scan?: ScanStamp): void {
  const db = getDB();
  const { upsert, delText, insText } = stmts(db);
  const row: SessionRow = {
    id: meta.id,
    short_id: meta.shortId,
    agent: meta.agent,
    version: meta.version ?? null,
    account: meta.account ?? null,
    timestamp: meta.timestamp,
    project: meta.project ?? null,
    cwd: meta.cwd ?? null,
    git_branch: meta.gitBranch ?? null,
    topic: meta.topic ?? null,
    label: meta.label ?? null,
    message_count: meta.messageCount ?? null,
    token_count: meta.tokenCount ?? null,
    cost_usd: meta.costUsd ?? null,
    duration_ms: meta.durationMs ?? null,
    file_path: meta.filePath,
    file_mtime_ms: scan?.fileMtimeMs ?? null,
    file_size: scan?.fileSize ?? null,
    scanned_at: Date.now(),
    is_team_origin: meta.isTeamOrigin ? 1 : 0,
  };

  const txn = db.transaction(() => {
    upsert.run(row);
    delText.run(meta.id);
    insText.run(
      meta.id,
      meta.label ?? '',
      meta.topic ?? '',
      meta.project ?? '',
      content ?? '',
    );
  });
  txn();
}

/** Batch-upsert sessions with their FTS5 content and scan stamps in a single transaction. */
export function upsertSessionsBatch(
  entries: Array<{ meta: SessionMeta; content: string; scan?: ScanStamp }>,
): void {
  if (entries.length === 0) return;
  const db = getDB();
  const { upsert, delText, insText } = stmts(db);
  const now = Date.now();
  const ledger = db.prepare(`
    INSERT INTO scan_ledger (file_path, file_mtime_ms, file_size, scanned_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_mtime_ms = excluded.file_mtime_ms,
      file_size = excluded.file_size,
      scanned_at = excluded.scanned_at
  `);

  // Build a lookup from canonical file path → entry, used inside the write
  // transaction to re-check the ledger AFTER acquiring the lock. When a
  // concurrent process already committed the same files between our
  // filterChangedFiles call and now, the ledger will have matching (mtime, size)
  // rows — we skip those entries, making the second writer's transaction a
  // near-instant no-op rather than redundant work.
  const byPath = new Map(
    entries
      .filter(e => e.scan && e.meta.filePath)
      .map(e => [canonicalLedgerKey(e.meta.filePath), e]),
  );

  const txn = db.transaction((items: typeof entries) => {
    // Re-read the ledger now that we hold the write lock. Any file committed
    // by a concurrent process since our pre-scan is visible here.
    const CHUNK = 500; // stay under SQLite's 999-variable limit
    const alreadyIndexed = new Set<string>();
    const paths = [...byPath.keys()];
    for (let i = 0; i < paths.length; i += CHUNK) {
      const chunk = paths.slice(i, i + CHUNK);
      const phs = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT file_path, file_mtime_ms, file_size FROM scan_ledger WHERE file_path IN (${phs})`)
        .all(...chunk) as Array<{ file_path: string; file_mtime_ms: number; file_size: number }>;
      for (const row of rows) {
        const entry = byPath.get(row.file_path);
        if (entry && row.file_mtime_ms === entry.scan!.fileMtimeMs && row.file_size === entry.scan!.fileSize) {
          alreadyIndexed.add(entry.meta.id);
        }
      }
    }

    for (const { meta, content, scan } of items) {
      if (alreadyIndexed.has(meta.id)) continue;
      upsert.run({
        id: meta.id,
        short_id: meta.shortId,
        agent: meta.agent,
        version: meta.version ?? null,
        account: meta.account ?? null,
        timestamp: meta.timestamp,
        project: meta.project ?? null,
        cwd: meta.cwd ?? null,
        git_branch: meta.gitBranch ?? null,
        topic: meta.topic ?? null,
        label: meta.label ?? null,
        message_count: meta.messageCount ?? null,
        token_count: meta.tokenCount ?? null,
        cost_usd: meta.costUsd ?? null,
        duration_ms: meta.durationMs ?? null,
        file_path: meta.filePath,
        file_mtime_ms: scan?.fileMtimeMs ?? null,
        file_size: scan?.fileSize ?? null,
        scanned_at: now,
        is_team_origin: meta.isTeamOrigin ? 1 : 0,
      });
      delText.run(meta.id);
      insText.run(
        meta.id,
        meta.label ?? '',
        meta.topic ?? '',
        meta.project ?? '',
        content ?? '',
      );
      if (scan && meta.filePath) {
        ledger.run(canonicalLedgerKey(meta.filePath), scan.fileMtimeMs, scan.fileSize, now);
      }
    }
  });
  txn(entries);
}

/**
 * Sync labels for a set of sessions. For each id in the map, if the stored
 * label differs, update both `sessions.label` and the FTS5 label column.
 * Leaves FTS5 content/topic/project untouched — cheap to call every run.
 */
export function syncLabels(labelMap: Map<string, string | null>): number {
  if (labelMap.size === 0) return 0;
  const db = getDB();
  const ids = [...labelMap.keys()];
  const CHUNK = 500;
  const updates: Array<{ id: string; label: string | null }> = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, label FROM sessions WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: string; label: string | null }>;
    for (const row of rows) {
      const live = labelMap.get(row.id) ?? null;
      if ((live ?? '') !== (row.label ?? '')) {
        updates.push({ id: row.id, label: live });
      }
    }
  }
  if (updates.length === 0) return 0;

  const updSessions = db.prepare(`UPDATE sessions SET label = ? WHERE id = ?`);
  const updFts = db.prepare(`UPDATE session_text SET label = ? WHERE session_id = ?`);

  const txn = db.transaction((items: typeof updates) => {
    for (const { id, label } of items) {
      updSessions.run(label, id);
      updFts.run(label ?? '', id);
    }
  });
  txn(updates);
  return updates.length;
}

/**
 * Sync topics (session titles) for a set of sessions, keyed by id. For agents
 * whose human-readable title lives in a side index that updates independently
 * of the transcript (Codex `session_index.jsonl`), the per-file scan can't see
 * a title that lands later. This applies those titles by id, updating both
 * `sessions.topic` and the FTS5 topic column. Only ever sets a non-empty title
 * and only when it differs from the stored value — cheap to call every run.
 * Returns the number of rows updated.
 */
export function syncTopics(topicMap: Map<string, string>): number {
  if (topicMap.size === 0) return 0;
  const db = getDB();
  const ids = [...topicMap.keys()];
  const CHUNK = 500;
  const updates: Array<{ id: string; topic: string }> = [];

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, topic FROM sessions WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<{ id: string; topic: string | null }>;
    for (const row of rows) {
      const live = topicMap.get(row.id) ?? '';
      if (live && live !== (row.topic ?? '')) {
        updates.push({ id: row.id, topic: live });
      }
    }
  }
  if (updates.length === 0) return 0;

  const updSessions = db.prepare(`UPDATE sessions SET topic = ? WHERE id = ?`);
  const updFts = db.prepare(`UPDATE session_text SET topic = ? WHERE session_id = ?`);

  const txn = db.transaction((items: typeof updates) => {
    for (const { id, topic } of items) {
      updSessions.run(topic, id);
      updFts.run(topic, id);
    }
  });
  txn(updates);
  return updates.length;
}

/** Convert a raw database row into a SessionMeta object. */
function rowToMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    shortId: row.short_id,
    agent: row.agent as SessionAgentId,
    timestamp: row.timestamp,
    project: row.project ?? undefined,
    cwd: row.cwd ?? undefined,
    filePath: row.file_path,
    gitBranch: row.git_branch ?? undefined,
    messageCount: row.message_count ?? undefined,
    tokenCount: row.token_count ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    version: row.version ?? undefined,
    account: row.account ?? undefined,
    topic: row.topic ?? undefined,
    label: row.label ?? undefined,
    isTeamOrigin: row.is_team_origin === 1,
  };
}

/** Build a parameterized WHERE clause from query options. */
function buildSessionWhere(options: QueryOptions): { clause: string; params: any[] } {
  const where: string[] = [];
  const params: any[] = [];

  if (options.agent) {
    where.push('agent = ?');
    params.push(options.agent);
  } else if (options.agents && options.agents.length > 0) {
    where.push(`agent IN (${options.agents.map(() => '?').join(',')})`);
    params.push(...options.agents);
  }

  if (options.version) {
    where.push('version = ?');
    params.push(options.version);
  }

  if (options.cwd) {
    where.push('cwd = ?');
    params.push(options.cwd);
  }

  if (options.cwdPrefix) {
    // Stored cwd uses the host path separator (normalizeCwd → path.resolve), so
    // the subdir wildcard must too — a hardcoded '/' never matches a Windows
    // `C:\a\b` subpath and the listing comes back empty.
    where.push('(cwd = ? OR cwd LIKE ?)');
    params.push(options.cwdPrefix, options.cwdPrefix + path.sep + '%');
  }

  if (options.project) {
    where.push('LOWER(IFNULL(project, \'\')) LIKE ?');
    params.push(`%${options.project.toLowerCase()}%`);
  }

  // id lookup. SQLite's LIKE is case-insensitive for ASCII, so a lowercased
  // pattern matches mixed-case ids; the `=` exact compare adds COLLATE NOCASE
  // for the same reason. short_id carries its own index (idx_sessions_short_id);
  // id is the PRIMARY KEY.
  if (options.idExact) {
    where.push('(id = ? COLLATE NOCASE OR short_id = ? COLLATE NOCASE)');
    params.push(options.idExact, options.idExact);
  }
  if (options.idPrefix) {
    where.push('(id LIKE ? OR short_id LIKE ?)');
    params.push(`${options.idPrefix}%`, `${options.idPrefix}%`);
  }

  if (typeof options.sinceMs === 'number') {
    // Compare as strings; ISO 8601 timestamps sort lexicographically.
    where.push('timestamp >= ?');
    params.push(new Date(options.sinceMs).toISOString());
  }

  if (typeof options.untilMs === 'number') {
    where.push('timestamp <= ?');
    params.push(new Date(options.untilMs).toISOString());
  }

  if (options.excludeTeamOrigin) {
    where.push('IFNULL(is_team_origin, 0) = 0');
  }
  if (options.onlyTeamOrigin) {
    where.push('IFNULL(is_team_origin, 0) = 1');
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return { clause, params };
}

/** Query sessions from the database, applying filters and ordering by timestamp descending. */
export function querySessions(options: QueryOptions = {}): SessionMeta[] {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  // When a LIMIT is in play, we still need to filter stale rows AFTER the query,
  // so over-fetch a small buffer. Without this, a page of 50 rows where the first
  // 5 are stale would return only 45 to the caller even when there are more.
  const limitClause = options.limit
    ? `LIMIT ${Math.max(1, Math.floor(options.limit)) + 16}`
    : '';
  // NULLs last so unpriced / duration-less rows never crowd out real data when
  // sorting by cost or duration. timestamp is never null (NOT NULL column).
  const orderClause =
    options.sortBy === 'cost'
      ? 'ORDER BY cost_usd IS NULL, cost_usd DESC, timestamp DESC'
      : options.sortBy === 'duration'
        ? 'ORDER BY duration_ms IS NULL, duration_ms DESC, timestamp DESC'
        : 'ORDER BY timestamp DESC';
  const sql = `SELECT * FROM sessions ${clause} ${orderClause} ${limitClause}`;
  const rows = db.prepare(sql).all(...params) as SessionRow[];
  // Belt-and-suspenders: drop rows whose JSONL no longer exists on disk. The
  // authoritative fix is to keep file_path in sync (see updateSessionFilePaths
  // callers), but skipping vanished rows here prevents phantom sessions from
  // surfacing in the Factory UI if any code path forgets to rewrite (#136).
  // Synthetic rows (OpenClaw channels/cron — see scanOpenClawIncremental) carry
  // an empty file_path and are exempt; they're keyed by CLI output, not files.
  const live = rows.filter(r => !r.file_path || fs.existsSync(r.file_path));
  const trimmed = options.limit ? live.slice(0, options.limit) : live;
  return trimmed.map(rowToMeta);
}

/** Count sessions matching the given filter options. */
export function countSessions(options: QueryOptions = {}): number {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  const sql = `SELECT COUNT(*) AS n FROM sessions ${clause}`;
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row ? row.n : 0;
}

/** One grouped row in a cost/duration rollup. */
export interface UsageRollupRow {
  /** Grouping key value: the agent id, project name, or ISO date (YYYY-MM-DD). */
  key: string;
  costUsd: number;
  durationMs: number;
  sessionCount: number;
  tokenCount: number;
}

/** What to group a usage rollup by. */
export type UsageRollupGroup = 'agent' | 'project' | 'day';

/**
 * Aggregate cost / duration / tokens across sessions, grouped by agent,
 * project, or calendar day. Honors the same filter shape as querySessions
 * (agent, since/until, team-origin) so `agents cost --since 7d --by day`
 * lines up with what `agents sessions` would list. Ordered by cost desc.
 */
export function queryUsageRollup(
  options: QueryOptions & { groupBy: UsageRollupGroup },
): UsageRollupRow[] {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  const keyExpr =
    options.groupBy === 'agent'
      ? 'agent'
      : options.groupBy === 'project'
        ? `IFNULL(NULLIF(project, ''), '(no project)')`
        // ISO timestamps are lexicographically date-sortable; the date is the
        // first 10 chars (YYYY-MM-DD).
        : `substr(timestamp, 1, 10)`;

  const sql = `
    SELECT
      ${keyExpr} AS key,
      IFNULL(SUM(cost_usd), 0) AS costUsd,
      IFNULL(SUM(duration_ms), 0) AS durationMs,
      COUNT(*) AS sessionCount,
      IFNULL(SUM(token_count), 0) AS tokenCount
    FROM sessions
    ${clause}
    GROUP BY key
    ORDER BY costUsd DESC, key ASC
  `;
  return db.prepare(sql).all(...params) as UsageRollupRow[];
}

/** A session with its cost, for the top-N-by-cost listing. */
export interface TopCostSession {
  meta: SessionMeta;
  costUsd: number;
  durationMs: number;
}

/**
 * Return the N most expensive sessions (cost_usd DESC, NULLs excluded),
 * honoring the same filter shape as querySessions. Drops rows whose JSONL
 * vanished, mirroring querySessions' liveness filter.
 */
export function topSessionsByCost(
  n: number,
  options: QueryOptions = {},
): TopCostSession[] {
  const db = getDB();
  const { clause, params } = buildSessionWhere(options);
  const whereCost = clause ? `${clause} AND cost_usd IS NOT NULL` : 'WHERE cost_usd IS NOT NULL';
  const limit = Math.max(1, Math.floor(n));
  // Over-fetch a small buffer to survive the on-disk liveness filter below.
  const sql = `SELECT * FROM sessions ${whereCost} ORDER BY cost_usd DESC, timestamp DESC LIMIT ${limit + 16}`;
  const rows = db.prepare(sql).all(...params) as SessionRow[];
  const live = rows.filter(r => !r.file_path || fs.existsSync(r.file_path));
  return live.slice(0, limit).map(r => ({
    meta: rowToMeta(r),
    costUsd: r.cost_usd ?? 0,
    durationMs: r.duration_ms ?? 0,
  }));
}

/** Return the set of all file paths currently tracked in the sessions table. */
export function getAllFilePaths(): Set<string> {
  const db = getDB();
  const rows = db.prepare(`SELECT file_path FROM sessions`).all() as { file_path: string }[];
  return new Set(rows.map(r => r.file_path));
}

/** Look up sessions by their source file paths. */
export function getSessionsByFilePaths(paths: string[]): Map<string, SessionMeta> {
  if (paths.length === 0) return new Map();
  const db = getDB();
  const placeholders = paths.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE file_path IN (${placeholders})`)
    .all(...paths) as SessionRow[];
  const result = new Map<string, SessionMeta>();
  for (const row of rows) result.set(row.file_path, rowToMeta(row));
  return result;
}

/** Look up a single session by its unique ID. */
export function getSessionById(id: string): SessionMeta | null {
  const db = getDB();
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  return row ? rowToMeta(row) : null;
}

/**
 * Resolve a full-or-partial session id against the index, exact-first then
 * prefix — the DB-backed equivalent of resolveSessionById() that runs over the
 * SQLite table instead of a pre-loaded array. Matches both the full id and the
 * short id. An exact hit short-circuits so a complete id never also drags in its
 * prefix siblings. `scope` narrows by agent / version / project (cwd) so an
 * ambiguous prefix disambiguates against the caller's context.
 */
export function findSessionsById(
  idQuery: string,
  scope: Pick<QueryOptions, 'agent' | 'version' | 'cwd' | 'project'> = {},
): SessionMeta[] {
  const q = idQuery.trim();
  if (!q) return [];
  const exact = querySessions({ ...scope, idExact: q });
  if (exact.length > 0) return exact;
  return querySessions({ ...scope, idPrefix: q });
}

/** A single full-text search result with ranking score. */
export interface FtsHit {
  sessionId: string;
  score: number;
  matchedTerms: string[];
}

/**
 * Escape a raw user query into a safe FTS5 MATCH expression.
 * Splits on non-word characters, keeps tokens >= 2 chars, and OR-joins
 * them with a prefix wildcard so partial typing ('rush dep') matches.
 */
export function buildFtsQuery(input: string): { expr: string; terms: string[] } {
  const terms = input.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  if (terms.length === 0) return { expr: '', terms: [] };
  const expr = terms.map(t => `${t}*`).join(' OR ');
  return { expr, terms };
}

/**
 * Label-first search. Sessions whose custom label substring-matches the query
 * always rank ahead of FTS5 hits — this gives predictable behavior when a user
 * types the exact name they gave a session via /rename.
 *
 * Tiers (highest → lowest):
 *   1. Exact label match (case-insensitive): score 1_000_000
 *   2. Label prefix match:                   score   900_000
 *   3. Label contains query:                 score   800_000
 *   4. FTS5 BM25 hits:                       score   1..1000 (scaled)
 *
 * Note: FTS5's bm25() returns negative numbers; we flip the sign for tier 4
 * so "higher = better" is consistent across all tiers.
 */
export function ftsSearch(input: string, limit = 200): FtsHit[] {
  const db = getDB();
  const trimmed = input.trim();
  if (!trimmed) return [];

  const { expr, terms } = buildFtsQuery(input);
  const lower = trimmed.toLowerCase();
  const seen = new Set<string>();
  const hits: FtsHit[] = [];

  // Tier 1-3: label-based matches, ordered by exactness.
  const labelRows = db.prepare(`
    SELECT id, label FROM sessions
    WHERE label IS NOT NULL AND LOWER(label) LIKE ?
  `).all(`%${lower}%`) as Array<{ id: string; label: string }>;

  let hasExactLabelMatch = false;
  for (const row of labelRows) {
    const labelLower = row.label.toLowerCase();
    let score: number;
    if (labelLower === lower) {
      score = 1_000_000;
      hasExactLabelMatch = true;
    } else if (labelLower.startsWith(lower)) {
      score = 900_000;
    } else {
      score = 800_000;
    }
    // matchedTerms is empty for label hits — the picker can render the label
    // itself as the highlight, no badge needed.
    hits.push({ sessionId: row.id, score, matchedTerms: [] });
    seen.add(row.id);
  }

  // If the query exactly names a labeled session, don't dilute the result
  // with FTS5 content hits — the user typed a specific thing, show just it.
  if (hasExactLabelMatch) {
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  // Tier 4: FTS5 content match, skipping anything already surfaced via label.
  if (expr) {
    try {
      const rows = db
        .prepare(`
          SELECT session_id, bm25(session_text, ${BM25_WEIGHTS.join(', ')}) AS rank
          FROM session_text
          WHERE session_text MATCH ?
          ORDER BY rank ASC
          LIMIT ?
        `)
        .all(expr, limit) as { session_id: string; rank: number }[];

      for (const r of rows) {
        if (seen.has(r.session_id)) continue;
        hits.push({ sessionId: r.session_id, score: -r.rank, matchedTerms: terms });
        seen.add(r.session_id);
      }
    } catch {
      /* invalid MATCH expression — tier 4 just yields nothing */
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Return the total row counts for the sessions and FTS5 tables (diagnostic). */
export function getRowCount(): { sessions: number; textRows: number } {
  const db = getDB();
  const sessions = (db.prepare(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c;
  const textRows = (db.prepare(`SELECT COUNT(*) AS c FROM session_text`).get() as { c: number }).c;
  return { sessions, textRows };
}

/**
 * Rewrite file_path for all sessions whose path starts with oldPrefix, replacing
 * it with newPrefix + the unchanged suffix. Also clears the matching scan_ledger
 * entries so they are re-indexed from the new location on the next scan.
 *
 * Used by removeVersion after soft-deleting a version directory to trash, so
 * that session reads (transcript view, /continue) still work from the trash path.
 * Returns the number of session rows updated.
 */
export function updateSessionFilePaths(oldPrefix: string, newPrefix: string): number {
  const db = getDB();
  const rows = db
    .prepare(`SELECT id, file_path FROM sessions WHERE file_path LIKE ?`)
    .all(oldPrefix + '%') as { id: string; file_path: string }[];

  if (rows.length === 0) return 0;

  const txn = db.transaction(() => {
    for (const { id, file_path } of rows) {
      const newPath = newPrefix + file_path.slice(oldPrefix.length);
      db.prepare(`UPDATE sessions SET file_path = ? WHERE id = ?`).run(newPath, id);
      db.prepare(`DELETE FROM scan_ledger WHERE file_path = ?`).run(canonicalLedgerKey(file_path));
    }
  });
  txn();
  return rows.length;
}
