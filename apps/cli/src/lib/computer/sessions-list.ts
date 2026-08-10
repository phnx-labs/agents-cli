/**
 * Read-only task/run history over the `computer.action` event ledger
 * (`~/.agents/.history/events/YYYY-MM-DD/events.jsonl`, see `../events.ts`) —
 * the durable, already-existing audit log every `agents computer <verb>`
 * invocation (the explicit CLI verbs in `commands/computer-actions.ts`, and
 * the embedded `computer run` loop in `computer/dispatch.ts`) writes through
 * `emitComputerAction()`. Backs both `agents computer sessions` and the
 * `agents sessions --computer` alias.
 *
 * There is no separate capture directory the way browser tasks have
 * `.cache/browser/<profile>/sessions/<task>/` — a computer action drives a
 * live GUI in place and leaves no artifact of its own, so the event ledger
 * IS the canonical execution source for this history (RUSH-2432, the
 * computer counterpart of `../browser/sessions-list.ts`'s RUSH-2407
 * task-first grouping).
 *
 * Retention/privacy: `events.ts` already bounds and prunes this log
 * (`DEFAULT_RETENTION_DAYS` / `DEFAULT_MAX_STORAGE_BYTES` — 7 days / 50 MiB
 * by default, gzip-rotated at 10 MiB) — nothing here adds a second retention
 * policy or a second pruner. Nothing sensitive is persisted: `type` /
 * `type-text` events already carry only `textLength`, never the typed text
 * (see `commands/computer-actions.ts` `emitComputerAction` call sites) — the
 * mission this module fulfils changes NONE of that. A `run --task`
 * description is the agent's OWN instruction, not typed-into-a-target-app
 * content (the same class of thing `agents sessions` already stores
 * unredacted as a session prompt) — it is kept, but bounded to
 * {@link TASK_PREVIEW_MAX_CHARS} via `events.ts`'s `truncate()` before it is
 * ever written (see `computer.ts` `registerRunCommand`), never the full
 * unbounded text, and it is not the wire-shape `prompt` field so it is a
 * deliberate exception to (not a bypass of) the automatic prompt-redaction
 * path in `events.ts` `sanitizePayload`.
 *
 * Grouping key: `emitComputerAction()` stamps one random `invocationId` for
 * the lifetime of the emitting CLI process. The event's own `pid` field is the emitting
 * CLI PROCESS's pid, never the target app's (that's `targetPid` — see
 * `computer-actions.ts` `emitComputerAction`, and its `#11` test guarding
 * this). One `agents computer <verb>` invocation is one process, and
 * `computer run`'s whole embedded observe/act/verify loop is ALSO one
 * process. Grouping by `invocationId` gives exactly one row per CLI invocation without
 * conflating unrelated processes when the OS later reuses a pid: a
 * single explicit verb collapses to a one-action row, and a `run --task`
 * loop collapses to one row holding every verb the model drove. That row is
 * the "run" a task-first view groups by.
 *
 * Session identity: unlike a browser task (which only ever learns its
 * `launchId`, requiring the join `buildLaunchSessionIndex`/
 * `resolveLaunchSession` perform), a `computer.action` event is emitted
 * IN-PROCESS by the CLI invocation itself, so `stampProvenance()`
 * (`../event-provenance.ts`) already stamps its own `sessionId` directly
 * onto the record — no join needed for the common case. This module still
 * falls back to the shared launchId join — imported from
 * `../browser/sessions-list.ts`, never duplicated — for the case where
 * `sessionId` doesn't resolve (a rotated/unindexed session) but `launchId`
 * still does via the more authoritative pid registry.
 */
import { query, truncate, type EventRecord } from '../events.js';
import { formatRelativeTime } from '../session/relative-time.js';
import type { SessionMeta } from '../session/types.js';
import { getSessionById, listComputerSessionRecords } from '../session/db.js';
import {
  buildLaunchSessionIndex,
  resolveLaunchSession,
} from '../browser/sessions-list.js';

/** Max chars of a `run --task` description persisted to the ledger — see the
 *  module docblock's retention/privacy note. */
export const TASK_PREVIEW_MAX_CHARS = 200;

/** Cap on how many raw ledger rows a single read scans/returns. `query()`
 *  already reads newest-first and stops at this cutoff mid-scan, so raising
 *  it only ever costs as much as the history actually holds. */
const DEFAULT_ACTION_LIMIT = 5000;

/** One `computer.action` ledger entry, narrowed to the fields this module
 *  renders or groups by. */
export interface ComputerAction {
  /** CLI verb: `click`, `type`, `screenshot`, … or `run` for the task marker
   *  `registerRunCommand` emits before entering the model loop. */
  verb: string;
  ts: string;
  tsMs: number;
  /** The emitting CLI process's own pid — the run/task grouping key. */
  pid: number;
  /** Unique for the emitting CLI process; absent only on legacy ledger rows. */
  invocationId?: string;
  /** The driven app's pid, when resolved. */
  targetPid?: number;
  bundle?: string;
  /** `--host <device>` target when this action drove a remote daemon. */
  host?: string;
  /** Truncated `--task` text; only ever present on a `verb: 'run'` marker. */
  task?: string;
  sessionId?: string;
  launchId?: string;
  agent?: string;
  machineId?: string;
  hostname?: string;
}

function recordToAction(r: EventRecord): ComputerAction | null {
  if (typeof r.command !== 'string' || typeof r.pid !== 'number') return null;
  const tsMs = Date.parse(r.ts);
  if (Number.isNaN(tsMs)) return null;
  return {
    verb: r.command,
    ts: r.ts,
    tsMs,
    pid: r.pid,
    invocationId: typeof r.invocationId === 'string' ? r.invocationId : undefined,
    targetPid: typeof r.targetPid === 'number' ? r.targetPid : undefined,
    bundle: typeof r.bundle === 'string' ? r.bundle : undefined,
    host: typeof r.host === 'string' ? r.host : undefined,
    task: typeof r.task === 'string' ? r.task : undefined,
    sessionId: typeof r.sessionId === 'string' ? r.sessionId : undefined,
    launchId: typeof r.launchId === 'string' ? r.launchId : undefined,
    agent: typeof r.agent === 'string' ? r.agent : undefined,
    machineId: typeof r.machineId === 'string' ? r.machineId : undefined,
    hostname: typeof r.hostname === 'string' ? r.hostname : undefined,
  };
}

/** Read `computer.action` events straight from the durable event ledger,
 *  newest first, bounded by `limit`. Malformed/legacy records (missing
 *  `command` or `pid`, or an unparseable `ts`) are skipped, never thrown —
 *  the ledger is a plain rotated JSONL file another process can be mid-write
 *  or mid-rotate against. */
export function listComputerActions(opts: { limit?: number } = {}): ComputerAction[] {
  const records = query({ eventTypes: ['computer.action'], limit: opts.limit ?? DEFAULT_ACTION_LIMIT });
  const out: ComputerAction[] = [];
  for (const r of records) {
    const a = recordToAction(r);
    if (a) out.push(a);
  }
  return out;
}

/** Why a row carries no session digest: `linked` resolved one, `unresolved`
 *  has a sessionId/launchId but no matching indexed session, `unlinked` has
 *  neither (a bare terminal invocation with no agent session env at all). */
export type ComputerRunLinkStatus = 'linked' | 'unresolved' | 'unlinked';

/** One task-first row: every `computer.action` emitted by one CLI process
 *  (see the module docblock's "Grouping key" note), plus the agent session
 *  it links to when resolvable. */
export interface ComputerRunRow {
  pid: number;
  invocationId?: string;
  /** Truncated task description — present only for a `computer run --task`
   *  invocation; a bare verb call has none. */
  task?: string;
  /** Invoking machine's hostname — the CLI's own machine, not necessarily
   *  the driven one (see `remoteHost`). */
  machine: string;
  machineId?: string;
  /** `--host <device>` target when the run drove a remote (Windows) daemon. */
  remoteHost?: string;
  /** Best-known target app bundle across the run's actions. */
  bundle?: string;
  agent?: string;
  sessionId?: string;
  launchId?: string;
  linkStatus: ComputerRunLinkStatus;
  linkedSession?: SessionMeta;
  /** Newest first; excludes the `run` task marker itself. */
  actions: ComputerAction[];
  /** Per-verb counts over `actions` (never includes the `run` marker). */
  counts: Record<string, number>;
  /** Oldest action's mtime — the row's start. */
  startMs: number;
  /** Newest action's mtime — the row's sort/age key. */
  endMs: number;
}

/**
 * Group flat ledger actions into task-first rows, newest first. Pure:
 * session resolvers are passed in, so this has no filesystem/session-index
 * dependency and is unit-testable with synthetic data (see
 * {@link buildComputerSessionRows} for the impure disk/index-reading caller).
 */
export function groupIntoComputerRuns(
  actions: ComputerAction[],
  resolveSession?: (sessionId: string) => SessionMeta | null,
  resolveLaunch?: (launchId: string) => SessionMeta | null,
): ComputerRunRow[] {
  const byInvocation = new Map<string, ComputerAction[]>();
  for (const [index, a] of actions.entries()) {
    // Legacy rows have no trustworthy process identity. Pids are recyclable,
    // so preserve each event separately instead of inventing a relationship.
    const key = a.invocationId ?? `legacy:${a.pid}:${a.tsMs}:${index}`;
    const list = byInvocation.get(key) ?? [];
    list.push(a);
    byInvocation.set(key, list);
  }

  const rows: ComputerRunRow[] = [];
  for (const group of byInvocation.values()) {
    const pid = group[0].pid;
    group.sort((a, b) => b.tsMs - a.tsMs); // newest first

    const marker = group.find((a) => a.verb === 'run');
    const driving = group.filter((a) => a.verb !== 'run');
    const counts: Record<string, number> = {};
    for (const a of driving) counts[a.verb] = (counts[a.verb] ?? 0) + 1;

    const bundle = group.find((a) => a.bundle)?.bundle;
    const remoteHost = group.find((a) => a.host)?.host;
    const identity = group.find((a) => a.sessionId || a.launchId) ?? group[0];
    const machine = group.find((a) => a.hostname)?.hostname ?? 'unknown';
    const machineId = group.find((a) => a.machineId)?.machineId;

    let linkedSession: SessionMeta | null = null;
    if (identity.sessionId) linkedSession = resolveSession?.(identity.sessionId) ?? null;
    if (!linkedSession && identity.launchId) linkedSession = resolveLaunch?.(identity.launchId) ?? null;

    const times = group.map((a) => a.tsMs);
    rows.push({
      pid,
      invocationId: group[0].invocationId,
      task: marker?.task,
      machine,
      machineId,
      remoteHost,
      bundle,
      agent: identity.agent,
      sessionId: identity.sessionId,
      launchId: identity.launchId,
      linkStatus: linkedSession ? 'linked' : (identity.sessionId || identity.launchId) ? 'unresolved' : 'unlinked',
      linkedSession: linkedSession ?? undefined,
      actions: driving,
      counts,
      startMs: Math.min(...times),
      endMs: Math.max(...times),
    });
  }

  rows.sort((a, b) => b.endMs - a.endMs);
  return rows;
}

/**
 * Add runs the event ledger no longer holds, from the durable
 * `computer_sessions` table (RUSH-2549).
 *
 * The ledger is deliberately bounded — it prunes at 7 days / 50 MiB — so before
 * this, a run simply disappeared from `agents sessions --computer` on day 8 even
 * though it had happened and its identity was known. The DB row is metadata
 * only, so a recovered row carries its identity, timing and action COUNT but no
 * per-verb breakdown: those individual actions lived in the pruned ledger and
 * are genuinely gone. It is listed as a real run with an empty `actions` list
 * rather than silently omitted, and never fabricated back.
 *
 * Ledger rows win on collision: while both exist the ledger is richer.
 */
function appendPrunedRunsFromDb(rows: ComputerRunRow[]): void {
  const seen = new Set(rows.map((r) => r.invocationId));
  for (const record of listComputerSessionRecords()) {
    if (seen.has(record.invocationId)) continue;
    const linked = record.sessionId ? getSessionById(record.sessionId) : null;
    rows.push({
      pid: 0,
      invocationId: record.invocationId,
      task: record.taskPreview,
      machine: record.machine,
      machineId: record.machine,
      bundle: undefined,
      remoteHost: undefined,
      agent: undefined,
      sessionId: record.sessionId,
      launchId: record.launchId,
      linkStatus: linked ? 'linked' : (record.sessionId || record.launchId) ? 'unresolved' : 'unlinked',
      linkedSession: linked ?? undefined,
      actions: [],
      counts: {},
      startMs: record.startedAt,
      endMs: record.lastActivity ?? record.startedAt,
    });
  }
}

/** Build task-first rows from the real ledger, resolving each row's owning
 *  session against the live indexes. The interactive picker's (and the
 *  flat/`--json` printer's) data source. `machine` narrows to rows whose
 *  invoking hostname, machineId, or `--host` target contains the substring. */
export function buildComputerSessionRows(opts: { limit?: number; machine?: string } = {}): ComputerRunRow[] {
  const actions = listComputerActions({ limit: opts.limit });
  const index = buildLaunchSessionIndex();
  const rows = groupIntoComputerRuns(
    actions,
    (sessionId) => getSessionById(sessionId),
    (launchId) => resolveLaunchSession(index, launchId),
  );
  appendPrunedRunsFromDb(rows);
  rows.sort((a, b) => b.endMs - a.endMs);
  if (!opts.machine) return rows;
  const q = opts.machine.toLowerCase();
  return rows.filter(
    (r) =>
      r.machine.toLowerCase().includes(q) ||
      r.remoteHost?.toLowerCase().includes(q) ||
      r.machineId?.toLowerCase().includes(q),
  );
}

/**
 * Search predicate for the interactive picker: task text, machine/remote
 * host, target bundle, the linked session's agent/topic/label, or any
 * driven verb in the row.
 */
export function matchesComputerSessionRow(row: ComputerRunRow, queryText: string): boolean {
  const q = queryText.trim().toLowerCase();
  if (!q) return true;
  if (row.task?.toLowerCase().includes(q)) return true;
  if (row.machine.toLowerCase().includes(q)) return true;
  if (row.remoteHost?.toLowerCase().includes(q)) return true;
  if (row.bundle?.toLowerCase().includes(q)) return true;
  const s = row.linkedSession;
  if (s && (s.agent.toLowerCase().includes(q) || s.topic?.toLowerCase().includes(q) || s.label?.toLowerCase().includes(q))) {
    return true;
  }
  return row.actions.some((a) => a.verb.toLowerCase().includes(q));
}

/** Human one-line summary of a row's per-verb action counts, most frequent
 *  first — shared by the flat table and the interactive picker's label. */
export function formatActionCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([verb, n]) => `${verb} ${n}`);
  return parts.join(', ') || '(no actions)';
}

/** Human table for the CLI. Returns lines (no trailing newline). */
export function renderComputerSessionRows(rows: ComputerRunRow[]): string {
  if (rows.length === 0) return 'No computer actions recorded.';
  const lines: string[] = [];
  for (const r of rows) {
    const when = formatRelativeTime(new Date(r.endMs).toISOString());
    const where = r.remoteHost ? `${r.machine} -> ${r.remoteHost}` : r.machine;
    const label = r.task ? truncate(r.task, 60) : (r.bundle ?? `pid ${r.pid}`);
    const link =
      r.linkStatus === 'linked' && r.linkedSession
        ? `${r.linkedSession.agent} — ${r.linkedSession.label || r.linkedSession.topic || r.linkedSession.shortId}`
        : r.linkStatus === 'unresolved'
          ? 'unresolved (session not indexed here)'
          : 'unlinked';
    lines.push(`${when.padEnd(12)}  ${where.padEnd(24)}  ${String(label ?? '').padEnd(40)}  ${link}`);
    lines.push(`  ${formatActionCounts(r.counts)}`);
  }
  return lines.join('\n');
}

/** Default row cap for the flat/non-interactive table. A computer row is
 *  much finer-grained than a browser task — real usage is mostly one
 *  standalone verb per CLI invocation, not a `run --task` loop, so an
 *  unbounded flat dump against real history reads as hundreds of one-action
 *  rows (confirmed against a real machine's history while building this).
 *  The interactive picker has no such cap (it's searchable); only the
 *  static table needs one. `--limit` overrides. */
export const DEFAULT_ROW_DISPLAY_LIMIT = 50;

/** Slice `rows` to at most `limit` (newest first, rows are already sorted),
 *  and report how many were dropped — pure, so the cap arithmetic and the
 *  trailer condition are unit-testable without a console spy. */
export function applyRowDisplayLimit(
  rows: ComputerRunRow[],
  limit: number = DEFAULT_ROW_DISPLAY_LIMIT,
): { shown: ComputerRunRow[]; more: number } {
  const shown = rows.slice(0, limit);
  return { shown, more: rows.length - shown.length };
}

/**
 * Shared CLI action for `agents computer sessions` and `agents sessions
 * --computer`. Non-interactive by design (the interactive routing decision
 * lives in `commands/computer-sessions-picker.ts`, mirroring
 * `runBrowserSessions`/`runBrowserSessionsCommand`'s split).
 */
export function runComputerSessions(opts: { machine?: string; json?: boolean; limit?: number }): void {
  const rows = buildComputerSessionRows({ machine: opts.machine });
  printComputerSessionRows(rows, opts);
}

/** Print already-collected rows. Fleet callers use this after merging local and
 * remote JSON so text, limits, and JSON keep exactly one renderer. */
export function printComputerSessionRows(
  rows: ComputerRunRow[],
  opts: { json?: boolean; limit?: number },
): void {
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const { shown, more } = applyRowDisplayLimit(rows, opts.limit ?? DEFAULT_ROW_DISPLAY_LIMIT);
  console.log(renderComputerSessionRows(shown));
  if (more > 0) console.log(`\n… (${more} more; --limit ${rows.length} or --json to see all, --machine to narrow)`);
}
