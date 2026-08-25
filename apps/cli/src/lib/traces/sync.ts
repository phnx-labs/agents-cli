/**
 * Incremental sync of derived, redacted SessionTrajectory blobs to the
 * agents-traces R2 store.
 *
 * Security invariant: only the derived signal (steps + gaps + stats +
 * errorCount + programTimeShare) is uploaded — no raw transcript text.
 * redactSecrets() is called inside buildTrajectory() before we PUT.
 *
 * Sync gate: `sessions.db` `file_mtime_ms` is the source of truth.  A ledger
 * at `getRuntimeStateDir()/traces-sync.json` records the last sync timestamp
 * per device so re-runs skip unchanged sessions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDB } from '../session/db.js';
import type { SessionAgentId, SessionMeta, SessionRunMode } from '../session/types.js';
import { parseSession } from '../session/parse.js';
import { buildTrajectory, type SessionTrajectory } from '../session/trajectory.js';
import { knownSecretValuesFromEnv } from '../redact.js';
import { getRuntimeStateDir } from '../state.js';
import { resolveTracesBackend, type TracesBackend } from './backend.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SyncOpts {
  /** Limit to N sessions (for testing / --dry-run); no limit when undefined. */
  limit?: number;
  /** When true, skip uploading the per-device index shard. */
  skipIndex?: boolean;
}

export interface SyncResult {
  uploaded: number;
  skipped: number;
  errors: number;
}

/** Push derived, redacted trajectories for this device to the traces store. */
export async function syncTraces(opts: SyncOpts = {}): Promise<SyncResult> {
  const backend = resolveTracesBackend();
  const ledger = readSyncLedger();
  const db = getDB();
  const device = localDevice();

  // Scope to this machine only — the DB can contain peer rows mirrored from the
  // fleet; uploading those under this device's prefix would corrupt the index.
  // NULL machine rows are legacy local sessions (pre-machine-field).
  const rows = db
    .prepare(
      'SELECT * FROM sessions WHERE (machine = ? OR machine IS NULL) AND file_mtime_ms > ? ORDER BY file_mtime_ms ASC',
    )
    .all(device, ledger.lastSyncMtime ?? 0) as SyncRow[];

  const limited = opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  const knownSecrets = knownSecretValuesFromEnv();

  let uploaded = 0;
  let skipped = 0;
  let errors = 0;
  // Advance the watermark only to the max mtime of successfully uploaded sessions
  // so failures are retried on the next run.
  let maxSuccessMtime = ledger.lastSyncMtime ?? 0;

  for (const row of limited) {
    if (!row.file_path) {
      skipped++;
      maxSuccessMtime = Math.max(maxSuccessMtime, row.file_mtime_ms ?? 0);
      continue;
    }
    let traj: SessionTrajectory;
    try {
      const session = rowToMeta(row);
      const events = parseSession(row.file_path, row.agent as SessionAgentId);
      traj = buildTrajectory(events, session, { redact: true, knownSecrets });
    } catch {
      errors++;
      continue;
    }
    try {
      await putSessionTrace(backend, device, row.id, traj);
      uploaded++;
      maxSuccessMtime = Math.max(maxSuccessMtime, row.file_mtime_ms ?? 0);
    } catch {
      errors++;
    }
  }

  if (!opts.skipIndex) {
    try {
      const allRows = db
        .prepare('SELECT * FROM sessions WHERE machine = ? OR machine IS NULL')
        .all(device) as SyncRow[];
      const shard = buildIndexShard(allRows);
      await putIndexShard(backend, device, shard);
    } catch {
      // index PUT failure is not fatal — the per-session data is already uploaded
    }
  }

  writeSyncLedger({ lastSyncMtime: maxSuccessMtime });
  return { uploaded, skipped, errors };
}

// ---------------------------------------------------------------------------
// Index shard — per-device aggregated stats strip
// ---------------------------------------------------------------------------

export interface TracesIndexShard {
  device: string;
  syncedAt: string;
  sessionCount: number;
  errorRate: number;
  sessions: IndexedSession[];
}

export interface IndexedSession {
  id: string;
  timestamp: string;
  topic?: string;
  agent: string;
  machine?: string;
}

function buildIndexShard(rows: SyncRow[]): Omit<TracesIndexShard, 'device' | 'syncedAt'> {
  return {
    sessionCount: rows.length,
    errorRate: 0,
    sessions: rows.slice(0, 2000).map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      topic: r.topic ?? undefined,
      agent: r.agent,
      machine: r.machine ?? undefined,
    })),
  };
}

// ---------------------------------------------------------------------------
// HTTP PUT helpers
// ---------------------------------------------------------------------------

async function putSessionTrace(
  backend: TracesBackend,
  device: string,
  sessionId: string,
  traj: SessionTrajectory,
): Promise<void> {
  const url = `${backend.baseUrl}/${backend.userId}/${device}/sessions/${sessionId}.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${backend.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(traj),
  });
  if (!res.ok) {
    throw new Error(`PUT ${url} → ${res.status}`);
  }
}

async function putIndexShard(
  backend: TracesBackend,
  device: string,
  shard: Omit<TracesIndexShard, 'device' | 'syncedAt'>,
): Promise<void> {
  const full: TracesIndexShard = { device, syncedAt: new Date().toISOString(), ...shard };
  const url = `${backend.baseUrl}/${backend.userId}/${device}/index.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${backend.token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(full),
  });
  if (!res.ok) {
    throw new Error(`PUT ${url} → ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Sync ledger — per-device timestamp gate
// ---------------------------------------------------------------------------

interface SyncLedger {
  lastSyncMtime?: number;
}

function ledgerPath(): string {
  return path.join(getRuntimeStateDir(), 'traces-sync.json');
}

export function readSyncLedger(): SyncLedger {
  try {
    const raw = fs.readFileSync(ledgerPath(), 'utf8');
    return JSON.parse(raw) as SyncLedger;
  } catch {
    return {};
  }
}

export function writeSyncLedger(ledger: SyncLedger): void {
  const p = ledgerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Local device name
// ---------------------------------------------------------------------------

function localDevice(): string {
  return (process.env['AGENTS_SYNC_MACHINE_ID'] ?? os.hostname()).toLowerCase().replace(/\.local$/, '');
}

// ---------------------------------------------------------------------------
// Minimal row type for direct DB queries (SessionRow is not exported)
// ---------------------------------------------------------------------------

interface SyncRow {
  id: string;
  short_id: string;
  agent: string;
  origin: string | null;
  routine_name: string | null;
  routine_run_id: string | null;
  version: string | null;
  account: string | null;
  account_key: string | null;
  account_org: string | null;
  mode: string | null;
  timestamp: string;
  last_activity: string | null;
  project: string | null;
  cwd: string | null;
  git_branch: string | null;
  topic: string | null;
  label: string | null;
  message_count: number | null;
  token_count: number | null;
  output_tokens: number | null;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  cost_usd_nocache: number | null;
  duration_ms: number | null;
  model: string | null;
  tool_call_count: number | null;
  file_path: string;
  file_mtime_ms: number | null;
  machine: string | null;
}

/** Minimal subset of rowToMeta needed to satisfy buildTrajectory's SessionMeta param. */
function rowToMeta(row: SyncRow): SessionMeta {
  const SESSION_RUN_MODES: SessionRunMode[] = ['plan', 'edit', 'auto', 'skip'];
  return {
    id: row.id,
    shortId: row.short_id,
    agent: row.agent as SessionAgentId,
    origin: row.origin === 'routine' ? 'routine' : 'cli',
    routineName: row.routine_name ?? undefined,
    routineRunId: row.routine_run_id ?? undefined,
    timestamp: row.timestamp,
    lastActivity: row.last_activity ?? undefined,
    project: row.project ?? undefined,
    cwd: row.cwd ?? undefined,
    filePath: row.file_path,
    gitBranch: row.git_branch ?? undefined,
    messageCount: row.message_count ?? undefined,
    tokenCount: row.token_count ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    cacheReadTokens: row.cache_read_tokens ?? undefined,
    cacheWriteTokens: row.cache_write_tokens ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    costUsdNoCache: row.cost_usd_nocache ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    model: row.model ?? undefined,
    toolCallCount: row.tool_call_count ?? undefined,
    version: row.version ?? undefined,
    account: row.account ?? undefined,
    accountKey: row.account_key ?? undefined,
    accountOrg: row.account_org ?? undefined,
    mode: (SESSION_RUN_MODES as string[]).includes(row.mode ?? '') ? (row.mode as SessionRunMode) : undefined,
    topic: row.topic ?? undefined,
    label: row.label ?? undefined,
    machine: row.machine ?? undefined,
  };
}
