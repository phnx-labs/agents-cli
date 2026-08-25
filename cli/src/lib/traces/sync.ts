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
import {
  getDB,
  readSessionInsights,
  readSessionTopics,
  writeSessionInsights,
  writeSessionTopics,
} from '../session/db.js';
import type { SessionAgentId, SessionMeta, SessionRunMode } from '../session/types.js';
import { parseSession } from '../session/parse.js';
import { buildTrajectory, type SessionTrajectory } from '../session/trajectory.js';
import { computeInsightFacets, type InsightFacets } from '../session/insights.js';
import { knownSecretValuesFromEnv, redactSecrets } from '../redact.js';
import { getRuntimeStateDir } from '../state.js';
import { resolveTracesBackend, type TracesBackend } from './backend.js';
import {
  classifyCause,
  classifyTopic,
  computeDriftSignal,
  type BucketStats,
  type ClassifiedTopic,
  type DriftSignal,
  type TraceFailureCause,
  type TraceTopicGroup,
} from './classify.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SyncOpts {
  /** Limit to N sessions (for testing / --dry-run); no limit when undefined. */
  limit?: number;
  /** When true, skip uploading the per-device index shard. */
  skipIndex?: boolean;
  /**
   * Compute the derived shards from this device's real sessions.db and WRITE
   * them to `outDir` instead of uploading. No Phoenix auth, no worker, no
   * network — a local export for verifying the real signal. Ignores the
   * incremental watermark so the export reflects every session.
   */
  dryRun?: boolean;
  /** Directory to write `index.json` + `sessions/<id>.json` when `dryRun` is set. */
  outDir?: string;
}

export interface SyncResult {
  uploaded: number;
  skipped: number;
  errors: number;
}

/** Push derived, redacted trajectories for this device to the traces store. */
export async function syncTraces(opts: SyncOpts = {}): Promise<SyncResult> {
  const dryRun = opts.dryRun === true;
  const outDir = opts.outDir;
  if (dryRun && !outDir) {
    throw new Error('traces sync --dry-run requires --out <dir>');
  }
  // A dry-run computes locally and writes to disk: no Phoenix backend needed.
  const backend = dryRun ? null : resolveTracesBackend();
  const owner = backend?.userId ?? 'local';
  const ledger = readSyncLedger();
  const db = getDB();
  const device = localDevice();

  // Scope to this machine only — the DB can contain peer rows mirrored from the
  // fleet; uploading those under this device's prefix would corrupt the index.
  // NULL machine rows are legacy local sessions (pre-machine-field). A dry-run
  // ignores the incremental watermark so the export covers every session.
  const sinceMtime = dryRun ? 0 : (ledger.lastSyncMtime ?? 0);
  const rows = db
    .prepare(
      'SELECT * FROM sessions WHERE (machine = ? OR machine IS NULL) AND file_mtime_ms > ? ORDER BY file_mtime_ms ASC',
    )
    .all(device, sinceMtime) as SyncRow[];

  const limited = opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
  const knownSecrets = knownSecretValuesFromEnv();

  let uploaded = 0;
  let skipped = 0;
  let errors = 0;
  // Advance the watermark only to the max mtime of successfully uploaded sessions
  // so failures are retried on the next run.
  let maxSuccessMtime = ledger.lastSyncMtime ?? 0;

  if (dryRun && outDir) {
    fs.mkdirSync(path.join(outDir, 'sessions'), { recursive: true });
  }

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
      if (dryRun && outDir) {
        fs.writeFileSync(
          path.join(outDir, 'sessions', `${row.id}.json`),
          JSON.stringify(buildSessionDetail(traj)),
        );
      } else {
        await putSessionTrace(backend!, device, row.id, traj);
      }
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
      // Seed rolling bucket history from the previous shard so drift signals accumulate.
      let prevShard: TracesIndexShard | null = null;
      if (dryRun && outDir) {
        const prevPath = path.join(outDir, 'index.json');
        try {
          prevShard = JSON.parse(fs.readFileSync(prevPath, 'utf8')) as TracesIndexShard;
        } catch { /* first run — no prior shard */ }
      }
      const shard = buildIndexShard(allRows, device, owner, prevShard);
      if (dryRun && outDir) {
        fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(shard, null, 2));
      } else {
        await putIndexShard(backend!, device, owner, shard);
      }
    } catch {
      // index PUT/write failure is not fatal — the per-session data is already written
    }
  }

  // A dry-run never advances the incremental watermark: it is a read-only export.
  if (!dryRun) {
    writeSyncLedger({ lastSyncMtime: maxSuccessMtime });
  }
  return { uploaded, skipped, errors };
}

// ---------------------------------------------------------------------------
// Index shard — per-device aggregated stats strip
// ---------------------------------------------------------------------------

export interface TracesIndexShard {
  schema: 1;
  device: string;
  syncedAt: number;
  owner: string;
  stats: {
    sessionsImported: number;
    medianMs: number;
    p90Ms: number;
    needAttention: number;
    toolErrorRate: number;
  };
  needsAttention: IndexedSession[];
  topics: Array<{ key: string; label: string; count: number; group: TraceTopicGroup }>;
  failures: {
    byToolError: Array<{ tool: string; desc: string; cause: TraceFailureCause; count: number }>;
    byCause: Record<TraceFailureCause, number>;
  };
  /** Rolling 14-day window of per-bucket daily stats. Each inner array is one day. */
  bucketHistory: BucketStats[][];
  /** Movement signals for buckets with ≥3 days of history. */
  driftSignals: DriftSignal[];
}

export interface IndexedSession {
  id: string;
  title: string;
  repo: string;
  device: string;
  agent: string;
  model: string;
  severity: number;
  flags: string[];
}

interface ToolCallRow {
  session_id: string;
  tool: string;
  outcome: string;
  exit_code: number | null;
  status_code: number | null;
  error_code: string | null;
  error: string | null;
  parse_error: string | null;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function failureDescription(call: ToolCallRow, cause: TraceFailureCause): string {
  if (cause === 'guard') return /main-branch-guard/i.test(`${call.error_code ?? ''} ${call.error ?? ''}`)
    ? 'main branch guard' : 'git guard';
  if (cause === 'hook') return 'auto-mode hook denial';
  if (call.status_code != null) return `HTTP ${call.status_code}`;
  if (call.exit_code != null) return `exit ${call.exit_code}`;
  if (call.error_code) return 'tool error code';
  if (call.parse_error) return 'parse error';
  return 'tool error';
}

function attentionFlags(errorCount: number, facets: InsightFacets | undefined): string[] {
  const flags: string[] = [];
  if (errorCount > 0) flags.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
  const friction = facets?.frictionSignals ?? {};
  const corrections = facets?.correctionSignals ?? {};
  const retryCount = Object.entries(friction)
    .filter(([key]) => key.startsWith('failed tool loop:'))
    .reduce((sum, [, count]) => sum + count, 0);
  if (retryCount > 0) flags.push('retry loop');
  const stall = Object.entries(friction).find(([key, count]) => key.startsWith('silent stall:') && count > 0);
  if (stall) flags.push(stall[0].replace('silent stall: ', 'stalled '));
  const correctionCount = Object.values(corrections).reduce((sum, count) => sum + count, 0);
  if (correctionCount > 0) flags.push(`${correctionCount} correction${correctionCount === 1 ? '' : 's'}`);
  return flags;
}

/** Build the redacted rich console shard from indexed metadata and derived caches. */
export function buildIndexShard(
  rows: SyncRow[],
  device: string,
  owner: string,
  prevShard?: TracesIndexShard | null,
): TracesIndexShard {
  const db = getDB();
  const knownSecrets = knownSecretValuesFromEnv();
  const ids = rows.map((row) => row.id);
  const calls: ToolCallRow[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    calls.push(...db.prepare(`
      SELECT session_id, tool, outcome, exit_code, status_code, error_code, error, parse_error
      FROM tool_calls
      WHERE session_id IN (${chunk.map(() => '?').join(',')})
    `).all(...chunk) as ToolCallRow[]);
  }
  const toolMix = new Map<string, Record<string, number>>();
  const errorCounts = new Map<string, number>();
  for (const call of calls) {
    const mix = toolMix.get(call.session_id) ?? {};
    mix[call.tool] = (mix[call.tool] ?? 0) + 1;
    toolMix.set(call.session_id, mix);
    if (call.outcome === 'error') {
      errorCounts.set(call.session_id, (errorCounts.get(call.session_id) ?? 0) + 1);
    }
  }

  const topics = readSessionTopics<ClassifiedTopic>(ids);
  const missingTopics = rows.filter((row) => !topics.has(row.id)).map((row) => {
    const topic = classifyTopic({
      cwd: row.cwd,
      gitBranch: row.git_branch,
      topic: row.topic,
      label: row.label,
      toolMix: toolMix.get(row.id),
    });
    topics.set(row.id, topic);
    return { id: row.id, fileMtimeMs: row.file_mtime_ms, fileSize: row.file_size, topic };
  });
  writeSessionTopics(missingTopics);

  const insights = readSessionInsights<InsightFacets>(ids);
  const missingInsights: Array<{
    id: string;
    fileMtimeMs: number | null;
    fileSize: number | null;
    facets: InsightFacets;
  }> = [];
  for (const row of rows.filter((candidate) => !insights.has(candidate.id))) {
    try {
      const events = parseSession(row.file_path, row.agent as SessionAgentId);
      const facets = computeInsightFacets(events);
      insights.set(row.id, facets);
      missingInsights.push({
        id: row.id,
        fileMtimeMs: row.file_mtime_ms,
        fileSize: row.file_size,
        facets,
      });
    } catch {
      continue;
    }
  }
  writeSessionInsights(missingInsights);

  const needsAttention = rows.flatMap((row): IndexedSession[] => {
    const facets = insights.get(row.id);
    const errorCount = errorCounts.get(row.id) ?? 0;
    const flags = attentionFlags(errorCount, facets);
    if (flags.length === 0) return [];
    const friction = Object.values(facets?.frictionSignals ?? {}).reduce((sum, count) => sum + count, 0);
    const corrections = Object.values(facets?.correctionSignals ?? {}).reduce((sum, count) => sum + count, 0);
    return [{
      id: row.id,
      title: redactSecrets(
        row.label ?? row.topic ?? topics.get(row.id)?.label ?? 'Untitled session',
        knownSecrets,
      ),
      repo: row.project ?? (row.cwd ? path.basename(row.cwd) : 'unknown'),
      device,
      agent: row.agent,
      model: row.model ?? 'unknown',
      severity: errorCount * 2 + friction * 3 + corrections * 2,
      flags,
    }];
  }).sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id));

  const topicCounts = new Map<string, { key: string; label: string; count: number; group: TraceTopicGroup }>();
  for (const topic of topics.values()) {
    const current = topicCounts.get(topic.key) ?? { ...topic, count: 0 };
    current.count++;
    topicCounts.set(topic.key, current);
  }

  const failedCalls = calls.filter((call) => call.outcome === 'error');
  const byCause: Record<TraceFailureCause, number> = { real: 0, guard: 0, hook: 0 };
  const failureCounts = new Map<string, { tool: string; desc: string; cause: TraceFailureCause; count: number }>();
  for (const call of failedCalls) {
    const cause = classifyCause(call);
    const desc = failureDescription(call, cause);
    byCause[cause]++;
    const key = `${call.tool}\u0000${desc}\u0000${cause}`;
    const current = failureCounts.get(key) ?? { tool: call.tool, desc, cause, count: 0 };
    current.count++;
    failureCounts.set(key, current);
  }
  const durations = rows.flatMap((row) => row.duration_ms == null ? [] : [row.duration_ms]);

  // Build today's per-bucket stats for the rolling drift window.
  const todayDate = new Date().toISOString().slice(0, 10);
  const todayStats: BucketStats[] = [...topicCounts.values()].map(({ key }) => {
    const sessionsInBucket = [...topics.entries()]
      .filter(([, t]) => t.key === key)
      .map(([id]) => id);
    const bucketCalls = calls.filter((c) => sessionsInBucket.includes(c.session_id));
    const bucketErrors = bucketCalls.filter((c) => c.outcome === 'error').length;
    const errorRate = bucketCalls.length === 0 ? 0 : bucketErrors / bucketCalls.length;
    const stallCount = sessionsInBucket.filter((id) => {
      const facets = insights.get(id);
      return Object.entries(facets?.frictionSignals ?? {})
        .some(([k, v]) => k.startsWith('silent stall:') && v > 0);
    }).length;
    const stallRate = sessionsInBucket.length === 0 ? 0 : stallCount / sessionsInBucket.length;
    return { key, date: todayDate, count: topicCounts.get(key)!.count, errorRate, stallRate };
  });

  const prevHistory = prevShard?.bucketHistory ?? [];
  const bucketHistory = [...prevHistory, todayStats].slice(-14);
  const driftSignals = computeDriftSignal(prevHistory, todayStats);

  return {
    schema: 1,
    device,
    syncedAt: Date.now(),
    owner,
    stats: {
      sessionsImported: rows.length,
      medianMs: percentile(durations, 0.5),
      p90Ms: percentile(durations, 0.9),
      needAttention: needsAttention.length,
      toolErrorRate: calls.length === 0 ? 0 : failedCalls.length / calls.length,
    },
    needsAttention,
    topics: [...topicCounts.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    failures: {
      byToolError: [...failureCounts.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
      byCause,
    },
    bucketHistory,
    driftSignals,
  };
}

// ---------------------------------------------------------------------------
// HTTP PUT helpers
// ---------------------------------------------------------------------------

/** Per-session drill-down detail the console consumes (sessions/<id>.json). */
export interface SessionDetail {
  schema: 1;
  id: string;
  meta: {
    spanMs: number;
    turns: number;
    tools: number;
    errorCount: number;
    tokens: number;
    costUsd: number;
    outcome: string;
    repo: string;
    agent: string;
    model: string;
  };
  steps: SessionTrajectory['steps'];
  gaps: SessionTrajectory['gaps'];
  /** Steps dropped from `steps` when a run was too long — surfaced so truncation is never silent. */
  truncatedSteps: number;
  whereItWentWrong: string | null;
}

/** Plain-language summary of the friction in a run, or null when it ran clean. */
function buildWhereItWentWrong(traj: SessionTrajectory): string | null {
  const errorSteps = traj.steps.filter((s) => s.outcome === 'error');
  const biggestGap = traj.gaps.reduce<SessionTrajectory['gaps'][number] | null>(
    (max, g) => (!max || g.durationMs > max.durationMs ? g : max),
    null,
  );
  const parts: string[] = [];
  if (errorSteps.length > 0) {
    const first = errorSteps[0];
    const who = first.tool ?? first.lane;
    parts.push(
      `${errorSteps.length} tool error${errorSteps.length === 1 ? '' : 's'} (first: ${who} — ${first.label})`,
    );
  }
  if (biggestGap && biggestGap.durationMs >= 60_000) {
    parts.push(`stalled ${Math.round(biggestGap.durationMs / 60_000)}m`);
  }
  if (parts.length === 0) return null;
  return `This run hit ${parts.join('; ')}.`;
}

/**
 * Map the derived trajectory to the console's SessionDetail shape, stripping
 * local-machine PII (full cwd, account) that would expose filesystem paths if
 * written to R2. `repo` is the cwd basename only.
 */
export function buildSessionDetail(traj: SessionTrajectory): SessionDetail {
  const s = traj.session as SessionMeta & {
    project?: string;
    cwd?: string;
    costUsd?: number;
  };
  const stats = traj.stats as {
    userTurns?: number;
    assistantTurns?: number;
    toolCount?: number;
    outputTokens?: number;
  };
  const repo = s.project ?? (s.cwd ? path.basename(s.cwd) : 'unknown');
  return {
    schema: 1,
    id: s.id,
    meta: {
      spanMs: traj.spanMs,
      turns: (stats.userTurns ?? 0) + (stats.assistantTurns ?? 0),
      tools: stats.toolCount ?? 0,
      errorCount: traj.errorCount,
      tokens: stats.outputTokens ?? 0,
      costUsd: s.costUsd ?? 0,
      outcome: traj.errorCount > 0 ? 'errored' : 'completed',
      repo,
      agent: s.agent,
      model: s.model ?? 'unknown',
    },
    steps: traj.steps,
    gaps: traj.gaps,
    truncatedSteps: traj.truncatedSteps,
    whereItWentWrong: buildWhereItWentWrong(traj),
  };
}

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
    body: JSON.stringify(buildSessionDetail(traj)),
  });
  if (!res.ok) {
    throw new Error(`PUT ${url} → ${res.status}`);
  }
}

async function putIndexShard(
  backend: TracesBackend,
  device: string,
  owner: string,
  shard: TracesIndexShard,
): Promise<void> {
  const full: TracesIndexShard = { ...shard, device, owner, syncedAt: Date.now() };
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

export interface SyncRow {
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
  file_size: number | null;
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
