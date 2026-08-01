/**
 * Session discovery across Claude, Codex, Gemini, OpenCode, and OpenClaw.
 *
 * Performs incremental scans: each agent's session files are stat'd and compared
 * to a scan-stamp ledger in SQLite. Only files whose mtime or size changed since
 * the last run are re-parsed. All metadata is upserted into the sessions DB so
 * subsequent queries are served entirely from the cache.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from '../sqlite.js';
import { getAgentsDir, getUserAgentsDir, getHistoryDir, getRunsDir } from '../state.js';
import { shortCodexHome } from '../codex-home.js';

const execFileAsync = promisify(execFile);
import type { SessionAgentId, SessionMeta } from './types.js';
import type { AgentId } from '../types.js';
import { AGENTS, agentConfigDirName, getCliVersion } from '../agents.js';
import { walkForFilesWithStat } from '../fs-walk.js';
import { getConfigSymlinkVersion } from '../shims.js';
import { SESSION_AGENTS } from './types.js';
import { extractSessionTopic } from './prompt.js';
import { parseAntigravity } from './parse.js';
import { extractPrUrl, detectWorktree, detectTicket, isPrCreateCommand, detectSpawnedTeam, isTicketCreateTool, extractCreatedTicket } from './state.js';
import { costOfUsage } from '../pricing/index.js';
import { machineId } from './sync/config.js';
import { mapBounded } from '../concurrency.js';
import {
  getDB,
  getScanStampByPath,
  getScanStampsForPaths,
  getDirLedgerForPaths,
  recordDirScans,
  recordScans,
  syncLabels,
  seedLabelsFromNames,
  syncTopics,
  upsertSessionsBatch,
  querySessions,
  countSessions,
  ftsSearch,
  tryClaimScan,
  releaseScan,
  type ScanStamp,
  type DirStamp,
  type QueryOptions,
} from './db.js';
import { buildRunNameMap } from './run-names.js';

const HOME = os.homedir();
// Versions can live under either repo: the user repo (current canonical
// location, ~/.agents/.history/versions/) or the system repo (legacy / npm-shipped,
// ~/.agents-system/versions/). Both must be scanned — sessions written by
// any installed version end up in that version's projects/ dir, and the user
// can be running one repo's version while another repo holds older versions
// whose JSONLs the user still wants to search.
const VERSIONS_ROOTS = [getHistoryDir(), getAgentsDir()];
const RUSH_SESSIONS_DIR = path.join(HOME, '.rush', 'sessions');
const HERMES_SESSIONS_DIR = path.join(HOME, '.hermes', 'sessions');

/** How long OpenClaw channel/cron snapshots stay valid before we re-shell-out. */
const OPENCLAW_TTL_MS = 60_000;
const ACTIVE_APPEND_RESCAN_DEBOUNCE_MS = 5_000;

/**
 * How recently a file must have been scanned to be treated as "hot" — a
 * candidate for an in-place append even when its parent dir's mtime hasn't
 * moved. A dir-ledger match lets us skip the per-file stat of everything in a
 * leaf dir EXCEPT its hot set; a file is hot if it lives under the agent's live
 * `~/.<agent>` root (the only tree an agent appends to live) or was scanned
 * within this window. 10 minutes comfortably covers a session that paused
 * between `agents sessions` calls but is still being written to.
 */
const HOT_FILE_WINDOW_MS = 600_000;

/**
 * Kill-switch: set `AGENTS_SESSIONS_NO_DIR_LEDGER=1` to force the old full-walk
 * path (readdir + per-file stat every dir, every run — the pre-A-2 behavior),
 * skipping the dir_ledger short-circuit entirely. One env var reverts a field
 * regression to today's behavior.
 */
function dirLedgerDisabled(): boolean {
  const v = process.env.AGENTS_SESSIONS_NO_DIR_LEDGER;
  return v === '1' || v === 'true';
}

let cachedOpenClawWorkspaces: Map<string, string> | null = null;

/** Options controlling which sessions to discover and how to report progress. */
export interface DiscoverOptions {
  agent?: SessionAgentId;
  /**
   * Include sessions from the user's own (unmanaged) `~/.<agent>` alongside managed
   * version homes. Defaults to true only when the agent has no managed versions, so
   * a user who has never run `agents add` sees exactly what they see today.
   */
  includeUnmanaged?: boolean;
  /** Called with how many rows the managed-only default hid, so callers can say so. */
  onHiddenUnmanaged?: (count: number) => void;
  version?: string;
  project?: string;
  all?: boolean;
  cwd?: string;
  /** Match any session whose cwd equals this or is a descendant. Overrides `cwd`. */
  cwdPrefix?: string;
  limit?: number;
  /** Filter sessions newer than this (ISO timestamp or "7d", "30d", "90d") */
  since?: string;
  /** Filter sessions older than this (ISO timestamp) */
  until?: string;
  /** Drop team-spawned sessions at the DB level, before LIMIT. */
  excludeTeamOrigin?: boolean;
  /** Keep only team-spawned sessions (used for hidden-count queries). */
  onlyTeamOrigin?: boolean;
  /** Keep only sessions from this source. */
  origin?: 'cli' | 'routine';
  /** Column to order results by (all descending): 'timestamp' (default), 'cost', or 'duration'. */
  sortBy?: 'timestamp' | 'cost' | 'duration';
  /** Called as each agent makes parsing progress. Totals count only files that need re-parsing (cache misses). */
  onProgress?: (progress: ScanProgress) => void;
}

/** Progress report emitted during incremental scanning. */
export interface ScanProgress {
  agent: SessionAgentId;
  parsed: number;
  total: number;
}

/** Lightweight metadata extracted from a Claude JSONL file during incremental scan. */
interface ClaudeSessionScan {
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  topic?: string;
  messageCount: number;
  tokenCount?: number;
  /** Real generated (output) tokens, excluding cache-read/-write context. */
  outputTokens?: number;
  /** Total USD cost accumulated from per-(model, direction) token usage. */
  costUsd?: number;
  /** Wall-clock duration in ms between the first and last timestamped event. */
  durationMs?: number;
  /** ISO time of the last timestamped event — the session's last activity. */
  lastActivity?: string;
  /**
   * Value of the JSONL `entrypoint` field on the first event that carries it.
   * 'cli' for real interactive sessions, 'sdk-cli' for team-spawned ones.
   */
  entrypoint?: string;
  /** Concatenated user message text, ready to hand to FTS5. */
  contentText?: string;
  /** Durable state signals persisted to the index by the session-state engine. */
  prUrl?: string;
  prNumber?: number;
  worktreeSlug?: string;
  ticketId?: string;
  /** Tracker refs the session CREATED (Linear create_issue / gh issue create). */
  createdTickets?: string[];
  /** Team name this session SPAWNED via `agents teams create/add` (not team-of-origin). */
  spawnedTeam?: string;
  /** Plan markdown from the last ExitPlanMode tool call (Claude sessions only). */
  plan?: string;
}

/** Lightweight metadata extracted from a Codex JSONL file during incremental scan. */
interface CodexSessionScan {
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  topic?: string;
  messageCount: number;
  tokenCount?: number;
  /** Real generated (output) tokens, excluding cache-read/-write context. */
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  lastActivity?: string;
  contentText?: string;
  prUrl?: string;
  prNumber?: number;
  worktreeSlug?: string;
  ticketId?: string;
  createdTickets?: string[];
  spawnedTeam?: string;
}

const cachedAgentVersions = new Map<SessionAgentId, Promise<string | undefined>>();

/** A session ready for batch upsert: metadata, searchable text, and file stamp. */
interface ScanEntry {
  meta: SessionMeta;
  content: string;
  scan: ScanStamp;
}

/**
 * Discover sessions. Scans only files whose (mtime, size) have changed since
 * the last run; everything else is served from the SQLite cache.
 *
 * Only one process runs the incremental scan at a time. When many agents boot
 * simultaneously (e.g. after a restart), the first to claim the scan slot does
 * the work; the rest skip parsing entirely and serve from the DB. The claim is
 * stored in the `meta` table — crash-safe via dead-PID detection and a 2-min
 * TTL, no external lock files needed.
 */
export async function discoverSessions(options?: DiscoverOptions): Promise<SessionMeta[]> {
  // Touch the DB so the schema is ready and connection is cached for this run.
  getDB();

  const agents = options?.agent ? [options.agent] : SESSION_AGENTS;
  const onProgress = options?.onProgress;

  if (tryClaimScan(process.pid)) {
    try {
      // Bounded + staggered instead of a single Promise.all: scanning every
      // agent's dotfile dir (~/.claude, ~/.codex, ~/.gemini, …) simultaneously
      // reads to behavioral EDR (CrowdStrike Falcon) as a ransomware-style bulk
      // file-enumeration sweep. Same dirs, same results — just not all at once.
      await scanAgentsBounded(agents, agent => dispatchAgentScan(agent, onProgress));
      await scanAgentsBounded(agents, agent => scanRoutineArchivesIncremental(agent, onProgress));
      // Seed labels from `agents run --name` handles onto the freshly-scanned
      // rows by id. Runs AFTER the per-agent scans (which applied agent-generated
      // titles via syncLabels), so a real title always wins and the seed only
      // backfills sessions that would otherwise be unnamed.
      seedLabelsFromNames(buildRunNameMap());
    } finally {
      releaseScan(process.pid);
    }
  }

  const sessions = querySessions(buildQueryOptions(options, agents, { includeLimit: true }));
  for (const s of sessions) s.machine = machineForSessionFile(s.filePath, s.agent);
  return scopeToManaged(sessions, agents, options);
}

/**
 * Drop unmanaged rows for agents that HAVE managed versions.
 *
 * Scoping happens here, at query time, rather than by narrowing the scan: the index
 * stays complete, so `--unmanaged` needs no re-scan and every other consumer of the
 * DB (watchdog, the Factory watcher, `--roots`) is unaffected.
 *
 * An agent with no managed versions is left alone entirely — someone who has never
 * run `agents add` sees exactly what they saw before.
 */
function scopeToManaged(
  sessions: SessionMeta[],
  agents: readonly SessionAgentId[],
  options?: DiscoverOptions,
): SessionMeta[] {
  if (options?.includeUnmanaged) return sessions;
  if (!anyManagedVersions()) return sessions;

  const kept = sessions.filter((s) => isManagedSessionFile(s.filePath));
  const hidden = sessions.length - kept.length;
  if (hidden > 0) options?.onHiddenUnmanaged?.(hidden);
  return kept;
}

/**
 * True once agents-cli manages ANY agent version. Until then it manages nothing, so
 * scoping to "managed only" would leave the listing empty for a user who has never
 * run `agents add` — the browser is most of the tool's value before you install
 * anything through it.
 */
function anyManagedVersions(): boolean {
  for (const root of VERSIONS_ROOTS) {
    const base = path.join(root, 'versions');
    let agentDirs: fs.Dirent[];
    try {
      agentDirs = fs.readdirSync(base, { withFileTypes: true });
    } catch { continue; }
    for (const a of agentDirs) {
      if (!a.isDirectory()) continue;
      try {
        if (fs.readdirSync(path.join(base, a.name), { withFileTypes: true }).some((e) => e.isDirectory())) return true;
      } catch { /* unreadable */ }
    }
  }
  return false;
}

/**
 * How many agents' dotfile dirs we scan at once, and the minimum spacing between
 * successive scan starts. A small bound + stagger turns a simultaneous bulk
 * multi-dotfile sweep (a behavioral-EDR file-enumeration trigger) into a trickle.
 */
export const DOTFILE_SCAN_CONCURRENCY = 2;
const DOTFILE_SCAN_STAGGER_MS = 15;

/** Run each agent's incremental scan, bounded + staggered. Order is irrelevant (each scan writes its own rows). */
export function scanAgentsBounded<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
): Promise<void[]> {
  return mapBounded(items, run, {
    concurrency: DOTFILE_SCAN_CONCURRENCY,
    staggerMs: DOTFILE_SCAN_STAGGER_MS,
  });
}

/** Dispatch a single agent's incremental dotfile scan. */
function dispatchAgentScan(
  agent: SessionAgentId,
  onProgress?: (p: ScanProgress) => void,
): Promise<void> {
  switch (agent) {
    case 'claude': return scanClaudeIncremental(onProgress);
    case 'codex': return scanCodexIncremental(onProgress);
    case 'gemini': return scanGeminiIncremental(onProgress);
    case 'antigravity': return scanAntigravityIncremental(onProgress);
    case 'opencode': return scanOpenCodeIncremental();
    case 'openclaw': return scanOpenClawIncremental();
    case 'rush': return scanRushIncremental(onProgress);
    case 'hermes': return scanHermesIncremental(onProgress);
    case 'kimi': return scanKimiIncremental(onProgress);
    case 'droid': return scanDroidIncremental(onProgress);
    case 'grok': return scanGrokIncremental(onProgress);
    default: return Promise.resolve();
  }
}

let _localMachineId: string | undefined;

/**
 * The machine a discovered session originated on. Cross-machine sync mirrors a
 * remote transcript to backups/<agent>/<machine>/<subdir>/… (see mirrorPath in
 * sync/agents.ts); every other transcript is a live-home file on this box. So:
 * when the path sits under the agent's backups root, the first segment below it
 * is the origin machine id; otherwise it's the local machine.
 */
/**
 * True when this transcript belongs to a version agents-cli manages — i.e. it lives
 * under a version home (or a backup mirror of one) rather than in the user's own
 * `~/.<agent>`.
 *
 * `agents sessions` scans both, which is right for indexing: the DB stays a complete
 * picture and `--unmanaged` can surface everything without a re-scan. But listing
 * *by default* is a different question. Once you have managed versions, an unmanaged
 * install's history is not really agents-cli's to show — most visibly after
 * `agents add --isolated`, where the whole point was to keep the two apart.
 */
export function isManagedSessionFile(filePath: string): boolean {
  // Synthetic rows (OpenClaw workspace sessions, cloud/remote entries) have no local
  // transcript to classify. They are produced BY agents-cli rather than read out of
  // someone's dotfile dir, so scoping must not silently swallow them.
  if (!filePath || !path.isAbsolute(filePath)) return true;

  const roots = [
    ...VERSIONS_ROOTS.map((root) => path.join(root, 'versions')),
    path.join(getHistoryDir(), 'backups'),
    // Codex's managed home is not always under versions/. On macOS the versioned path
    // overflows SUN_LEN for codex's control socket, so the shim relocates it to
    // `<agentsUserDir>/.codex-homes/<version>/` (lib/codex-home.ts).
    path.join(getUserAgentsDir(), '.codex-homes'),
    // Routine archives are agents-cli's OWN run output — managed by definition.
    getRunsDir(),
  ];

  // Compare realpaths as well as the literal roots. A transcript's stored path is
  // resolved, so on macOS (`/var` -> `/private/var`) a temp-dir HOME yields
  // `/private/var/...` for the file and `/var/...` for the root, and a plain prefix
  // test silently classifies every managed session as the user's own.
  const real = safeRealpathSync(filePath) || filePath;
  return roots.some((root) => {
    if (filePath.startsWith(root + path.sep)) return true;
    const realRoot = safeRealpathSync(root);
    return !!realRoot && real.startsWith(realRoot + path.sep);
  });
}


export function machineForSessionFile(filePath: string, agent: string): string {
  const base = path.join(getHistoryDir(), 'backups', agent) + path.sep;
  if (filePath.startsWith(base)) {
    const seg = filePath.slice(base.length).split(path.sep)[0];
    if (seg) return seg;
  }
  return (_localMachineId ??= machineId());
}

/**
 * Count sessions in scope without running an incremental scan. Assumes the DB
 * is already fresh (typically true because `discoverSessions` ran first this
 * turn). Uses the exact same filter shape as the discover query.
 */
export function countSessionsInScope(options: DiscoverOptions): number {
  const agents = options.agent ? [options.agent] : SESSION_AGENTS;
  return countSessions(buildQueryOptions(options, agents, { includeLimit: false }));
}

/** Translate DiscoverOptions into the QueryOptions shape expected by the DB layer. */
function buildQueryOptions(
  options: DiscoverOptions | undefined,
  agents: SessionAgentId[],
  opts: { includeLimit: boolean },
): QueryOptions {
  const projectQuery = options?.project?.trim();
  const sinceMs = options?.since ? parseTimeFilter(options.since) : undefined;
  const untilMs = options?.until ? new Date(options.until).getTime() : undefined;

  let cwdFilter: string | undefined;
  let cwdPrefixFilter: string | undefined;
  if (options?.cwdPrefix) {
    cwdPrefixFilter = normalizeCwd(options.cwdPrefix);
  } else if (!options?.all && !projectQuery && options?.agent !== 'rush' && options?.agent !== 'hermes') {
    // Rush and Hermes sessions are cloud/gateway-bound and have no cwd — skip
    // cwd filtering when the user explicitly asked for them.
    cwdFilter = normalizeCwd(options?.cwd || process.cwd());
  }

  return {
    agent: options?.agent,
    agents: options?.agent ? undefined : agents,
    version: options?.version,
    cwd: cwdFilter,
    cwdPrefix: cwdPrefixFilter,
    project: projectQuery,
    sinceMs,
    untilMs: Number.isFinite(untilMs as number) ? untilMs : undefined,
    limit: opts.includeLimit ? (options?.limit ?? 50) : undefined,
    excludeTeamOrigin: options?.excludeTeamOrigin,
    onlyTeamOrigin: options?.onlyTeamOrigin,
    origin: options?.origin,
    sortBy: options?.sortBy,
  };
}

/** Resolve and canonicalize a working directory path (follows symlinks). */
function normalizeCwd(cwd?: string): string {
  if (!cwd) return '';
  const resolved = path.resolve(cwd);
  return safeRealpathSync(resolved) || resolved;
}

/**
 * Resolve a session by full or short ID. Accepts a pre-loaded session list
 * (fast path from discoverSessions) and falls back to a DB lookup for the
 * "I only know the id" case.
 */
export function resolveSessionById(sessions: SessionMeta[], idQuery: string): SessionMeta[] {
  const query = idQuery.toLowerCase();
  const exact = sessions.filter(s =>
    s.id.toLowerCase() === query ||
    s.shortId.toLowerCase() === query ||
    s.routineRunId?.toLowerCase() === query,
  );
  if (exact.length > 0) return exact;
  return sessions.filter(s =>
    s.id.toLowerCase().startsWith(query) ||
    s.shortId.toLowerCase().startsWith(query) ||
    s.routineRunId?.toLowerCase().startsWith(query),
  );
}

// ---------------------------------------------------------------------------
// Content-index search (FTS5-backed)
// ---------------------------------------------------------------------------

/**
 * Run an FTS5 search over the DB and intersect with the given session list,
 * preserving the existing SessionMeta[] contract so sessions.ts is unchanged.
 */
export function searchContentIndex(
  sessions: SessionMeta[],
  query: string,
): Map<string, SessionMeta> {
  if (!query.trim()) return new Map();
  const hits = ftsSearch(query);
  if (hits.length === 0) return new Map();

  const byId = new Map(sessions.map(s => [s.id, s]));
  const result = new Map<string, SessionMeta>();
  for (const hit of hits) {
    const session = byId.get(hit.sessionId);
    if (!session) continue;
    result.set(hit.sessionId, {
      ...session,
      _matchedTerms: hit.matchedTerms,
      _bm25Score: hit.score,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Incremental scan orchestration
// ---------------------------------------------------------------------------

/**
 * For a list of files, stat each, compare to the DB ledger, and return only
 * the ones that need rescanning. One bulk DB query for the whole list.
 *
 * Actively running agents append to their JSONL every few seconds. Without a
 * small debounce, repeated `agents sessions` invocations stream-parse the same
 * growing transcript over and over. The cached row is good enough for a few
 * seconds; once writes settle or the debounce expires, the file is parsed once.
 */
export function filterChangedFiles(
  filePaths: string[],
): Array<{ filePath: string; scan: ScanStamp }> {
  const entries: PreStatEntry[] = [];
  for (const filePath of filePaths) {
    const stat = safeStatSync(filePath);
    if (!stat) continue;
    entries.push({ filePath, fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
  }
  return filterChangedEntries(entries);
}

/** A path already stat'd by the walk — mtime is the raw (unfloored) fs value. */
export interface PreStatEntry {
  filePath: string;
  fileMtimeMs: number;
  fileSize: number;
}

/**
 * Ledger-compare pre-stat'd entries (from the walk's own stat) without a second
 * stat. Same debounce and change-detection as filterChangedFiles; the raw
 * mtime is floored here so warm files match the ledger exactly as the stat path
 * does (Math.floor(stat.mtimeMs)).
 */
export function filterChangedEntries(
  entries: PreStatEntry[],
): Array<{ filePath: string; scan: ScanStamp }> {
  const ledger = getScanStampsForPaths(entries.map(e => e.filePath));
  const out: Array<{ filePath: string; scan: ScanStamp }> = [];
  const now = Date.now();
  for (const entry of entries) {
    const scan: ScanStamp = {
      fileMtimeMs: Math.floor(entry.fileMtimeMs),
      fileSize: entry.fileSize,
    };
    const prev = ledger.get(entry.filePath);
    if (prev && prev.fileMtimeMs === scan.fileMtimeMs && prev.fileSize === scan.fileSize) {
      continue;
    }
    if (prev && shouldDeferRecentAppend(prev, scan, now)) {
      continue;
    }
    out.push({ filePath: entry.filePath, scan });
  }
  return out;
}

export function shouldDeferRecentAppend(
  prev: ScanStamp,
  current: ScanStamp,
  nowMs: number,
  debounceMs = ACTIVE_APPEND_RESCAN_DEBOUNCE_MS,
): boolean {
  if (prev.scannedAt === undefined) return false;
  if (current.fileSize <= prev.fileSize) return false;
  if (current.fileMtimeMs < prev.fileMtimeMs) return false;
  return nowMs - prev.scannedAt < debounceMs;
}

// ---------------------------------------------------------------------------
// Directory-ledger short-circuit (A-2)
// ---------------------------------------------------------------------------

/** One leaf directory of transcripts to change-detect, plus its live-root flag. */
export interface LeafDir {
  /** Absolute path to the directory that directly holds transcript files. */
  dirPath: string;
  /**
   * True if this dir is under the agent's LIVE `~/.<agent>` root — the only tree
   * an agent process appends to live. Every file in such a dir is treated as
   * hot (always re-stat'd), so an in-place append is never missed there.
   */
  isLiveRoot: boolean;
}

/** The changed files a leaf-dir walk surfaced, ready to parse + upsert. */
export interface LeafDirScan {
  /** Files whose (mtime, size) changed vs the ledger — the parse set. */
  changed: Array<{ filePath: string; scan: ScanStamp }>;
  /**
   * Every transcript file seen across all leaf dirs (changed or not), in
   * live-root-first order, each tagged with whether its dir is a live root.
   * Lets a caller restore cross-root, session-id precedence (prefer the live
   * copy of a session over a frozen backup copy) independent of which copy
   * happened to be flagged "changed" this run.
   */
  allFiles: Array<{ filePath: string; isLiveRoot: boolean }>;
}

/**
 * Walk a set of leaf transcript directories and return the files that changed,
 * skipping the per-file `stat` of directories whose (mtime, entry_count) matches
 * the dir_ledger.
 *
 * Per leaf dir:
 *   - `stat` the dir once and `readdir` it (one cheap syscall) to get the entry
 *     count and the file list.
 *   - If the dir matches the dir_ledger (floored mtime AND entry_count), no file
 *     was created / deleted / renamed since we last walked it. We then stat ONLY
 *     the hot files (live-root files, or files scanned within HOT_FILE_WINDOW_MS)
 *     and run just those through the ledger compare — so an in-place append to a
 *     still-live session is still caught, while immutable backup/version dirs
 *     collapse to a single dir stat and zero per-file stats.
 *   - Else (changed dir, or no ledger row) we stat every file (today's full
 *     walk) and record the fresh dir stamp so the next run can short-circuit.
 *
 * The kill-switch (`AGENTS_SESSIONS_NO_DIR_LEDGER=1`) forces the full-walk branch
 * for every dir and never consults or records the dir_ledger.
 */
export function collectChangedFilesInLeafDirs(
  leafDirs: LeafDir[],
  ext: string,
): LeafDirScan {
  const disabled = dirLedgerDisabled();
  const dirStamps = disabled ? new Map<string, DirStamp>() : getDirLedgerForPaths(leafDirs.map(d => d.dirPath));
  const now = Date.now();

  // Files whose per-file stat we still need to ledger-compare this run.
  const toCompare: PreStatEntry[] = [];
  const allFiles: Array<{ filePath: string; isLiveRoot: boolean }> = [];
  const dirScansToRecord: Array<{ dirPath: string; dirMtimeMs: number; entryCount: number }> = [];

  for (const { dirPath, isLiveRoot } of leafDirs) {
    const dirStat = safeStatSync(dirPath);
    if (!dirStat?.isDirectory()) continue;

    let names: string[];
    try {
      names = fs.readdirSync(dirPath).filter(f => f.endsWith(ext));
    } catch {
      continue;
    }
    const files = names.map(f => path.join(dirPath, f));
    for (const filePath of files) allFiles.push({ filePath, isLiveRoot });

    const dirMtimeMs = Math.floor(dirStat.mtimeMs);
    const entryCount = names.length;
    const prevDir = dirStamps.get(dirPath);
    const dirUnchanged =
      !disabled && prevDir !== undefined && prevDir.dirMtimeMs === dirMtimeMs && prevDir.entryCount === entryCount;

    if (dirUnchanged) {
      // Contents did not change (no create/delete/rename). Stat only the hot
      // files; the rest are served from the DB with no stat. An immutable backup
      // dir (not a live root, nothing recently scanned) does zero per-file stats.
      //
      // A live-root dir treats every file as hot — that is the tree an agent
      // appends to live, and an append does NOT bump the parent-dir mtime, so
      // without this a growing session would be silently skipped. A non-live
      // file is hot only if it was scanned within HOT_FILE_WINDOW_MS (bulk ledger
      // lookup), covering a session under a version/backup path that is somehow
      // still being written.
      const stamps = isLiveRoot ? null : getScanStampsForPaths(files);
      for (const filePath of files) {
        let hot = isLiveRoot;
        if (!hot && stamps) {
          const s = stamps.get(filePath);
          hot = s?.scannedAt !== undefined && now - s.scannedAt <= HOT_FILE_WINDOW_MS;
        }
        if (!hot) continue;
        const stat = safeStatSync(filePath);
        if (!stat) continue;
        toCompare.push({ filePath, fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
      }
      // No dir stamp to record — nothing about the dir changed.
    } else {
      // Changed dir (or cold ledger): full per-file stat, exactly as today.
      for (const filePath of files) {
        const stat = safeStatSync(filePath);
        if (!stat) continue;
        toCompare.push({ filePath, fileMtimeMs: stat.mtimeMs, fileSize: stat.size });
      }
      if (!disabled) dirScansToRecord.push({ dirPath, dirMtimeMs, entryCount });
    }
  }

  const changed = filterChangedEntries(toCompare);
  if (dirScansToRecord.length > 0) recordDirScans(dirScansToRecord);
  return { changed, allFiles };
}

// ---------------------------------------------------------------------------
// Multi-version directory scanning
// ---------------------------------------------------------------------------

/**
 * Collect all directories to scan for an agent's sessions. Deduplicates by
 * realpath to avoid double-counting symlinked version homes.
 */
export function getAgentSessionDirs(agent: string, subdir: string): string[] {
  const resolved = new Set<string>();
  const dirs: string[] = [];

  function addDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const real = safeRealpathSync(dir);
    const key = real || dir;
    if (resolved.has(key)) return;
    resolved.add(key);
    dirs.push(dir);
  }

  // Config-dir name relative to home — handles nested layouts (antigravity →
  // .gemini/antigravity-cli) and ~/.config agents (amp, goose) as well as kimi
  // (.kimi-code). Falls back to `.${agent}` for ids not in the registry.
  const configDirName = agent in AGENTS ? agentConfigDirName(agent as AgentId) : `.${agent}`;

  addDir(path.join(HOME, configDirName, subdir));

  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', agent);
    if (!fs.existsSync(versionsBase)) continue;
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        addDir(path.join(versionsBase, version, 'home', configDirName, subdir));
        // Codex's managed home is not always where the version layout says. On macOS
        // the versioned path overflows SUN_LEN (104 bytes) for codex's control
        // socket, so the shim relocates the home to
        // `<agentsUserDir>/.codex-homes/<version>/.codex` (lib/codex-home.ts). Every
        // transcript an isolated codex writes lands there, and nothing scanned it —
        // `agents sessions --roots` listed only the user's own ~/.codex, so a managed
        // copy's own history was invisible. addDir skips what does not exist, so this
        // is inert on Linux and for versions that never needed relocating.
        if (agent === 'codex') {
          addDir(path.join(shortCodexHome(getUserAgentsDir(), version), subdir));
        }
      }
    } catch { /* dir unreadable */ }
  }

  const backupsBase = path.join(getHistoryDir(), 'backups', agent);
  if (fs.existsSync(backupsBase)) {
    try {
      for (const ts of fs.readdirSync(backupsBase)) {
        addDir(path.join(backupsBase, ts, subdir));
      }
    } catch { /* dir unreadable */ }
  }

  return dirs;
}

/**
 * The (agent, subdir) pairs `discoverSessions` walks for JSONL transcripts —
 * the single source of truth for which directories hold live session files.
 * `getSessionRoots` expands each pair to its concrete directories so a consumer
 * (the Factory extension's fs.watch, see issue #741) can configure its watcher
 * from the CLI instead of hardcoding `~/.claude|.codex|.gemini`. Adding a new
 * on-disk agent here makes every consumer watch it automatically.
 */
const SESSION_ROOT_SPECS: ReadonlyArray<{ agent: SessionAgentId; subdir: string }> = [
  { agent: 'claude', subdir: 'projects' },
  { agent: 'codex', subdir: 'sessions' },
  { agent: 'gemini', subdir: 'tmp' },
  { agent: 'antigravity', subdir: 'conversations' },
  { agent: 'droid', subdir: 'sessions' },
  { agent: 'kimi', subdir: 'sessions' },
  { agent: 'grok', subdir: 'sessions' },
];

function sessionRootSubdir(agent: SessionAgentId): string | null {
  return SESSION_ROOT_SPECS.find((spec) => spec.agent === agent)?.subdir ?? null;
}

/** A session-agent's on-disk watch roots (every version home + backup mirror). */
export interface SessionRoots {
  agent: SessionAgentId;
  /** Absolute directories that hold this agent's transcripts, existing right now. */
  dirs: string[];
}

/**
 * The directories `agents sessions` scans for each on-disk session agent,
 * resolved to what exists on this machine. Emitted by `agents sessions --roots
 * --json` so external watchers stay in lockstep with the CLI's discovery paths.
 * Agents with no directories present are omitted.
 */
export function getSessionRoots(): SessionRoots[] {
  const out: SessionRoots[] = [];
  for (const { agent, subdir } of SESSION_ROOT_SPECS) {
    const dirs = getAgentSessionDirs(agent, subdir);
    dirs.push(...getRoutineArchiveSessionDirs(agent, subdir));
    if (dirs.length > 0) out.push({ agent, dirs });
  }
  return out;
}

function getRoutineArchiveSessionDirs(agent: SessionAgentId, subdir: string): string[] {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) return [];
  const dirs: string[] = [];

  let jobDirs: fs.Dirent[];
  try {
    jobDirs = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return dirs;
  }

  for (const jobDir of jobDirs) {
    if (!jobDir.isDirectory()) continue;
    const jobRunsDir = path.join(runsDir, jobDir.name);
    let runDirs: fs.Dirent[];
    try {
      runDirs = fs.readdirSync(jobRunsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) continue;
      const dir = path.join(jobRunsDir, runDir.name, 'sessions', agent, subdir);
      if (fs.existsSync(dir)) dirs.push(dir);
    }
  }

  return dirs;
}

function routineArchiveInfo(filePath: string): { jobName: string; runId: string } | null {
  const rel = path.relative(getRunsDir(), filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length < 6 || parts[2] !== 'sessions') return null;
  return { jobName: parts[0], runId: parts[1] };
}

function decorateRoutineSession(
  meta: SessionMeta,
  info: { jobName: string; runId: string },
): SessionMeta {
  return {
    ...meta,
    origin: 'routine',
    routineName: info.jobName,
    routineRunId: info.runId,
    project: info.jobName,
    label: info.jobName,
  };
}

async function readRoutineArchiveMeta(
  agent: SessionAgentId,
  filePath: string,
): Promise<{ meta: SessionMeta; content: string } | null> {
  const info = routineArchiveInfo(filePath);
  if (!info) return null;

  if (agent === 'claude') {
    const sessionId = path.basename(filePath).replace(/\.jsonl$/, '');
    const result = await readClaudeMeta(filePath, sessionId);
    return result ? { ...result, meta: decorateRoutineSession(result.meta, info) } : null;
  }

  if (agent === 'codex') {
    const result = await readCodexMeta(filePath);
    return result ? { ...result, meta: decorateRoutineSession(result.meta, info) } : null;
  }

  return null;
}

async function scanRoutineArchivesIncremental(
  agent: SessionAgentId,
  onProgress?: (p: ScanProgress) => void,
): Promise<void> {
  const subdir = sessionRootSubdir(agent);
  if (!subdir) return;

  const ext = agent === 'gemini' ? '.json' : '.jsonl';
  const prestat: PreStatEntry[] = [];
  for (const sessionsDir of getRoutineArchiveSessionDirs(agent, subdir)) {
    for (const f of walkForFilesWithStat(sessionsDir, ext, 100_000)) {
      prestat.push({ filePath: f.path, fileMtimeMs: f.mtimeMs, fileSize: f.size });
    }
  }

  const changed = filterChangedEntries(prestat);
  if (changed.length === 0) return;

  onProgress?.({ agent, parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = await readRoutineArchiveMeta(agent, filePath);
      if (result) entries.push({ meta: result.meta, content: result.content, scan });
      else touched.push({ filePath, scan });
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent, parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

// ---------------------------------------------------------------------------
// Claude account info
// ---------------------------------------------------------------------------

let cachedClaudeAccount: string | undefined;

/** Read the Claude OAuth account email from .claude.json across all version homes. */
function getClaudeAccount(): string | undefined {
  if (cachedClaudeAccount !== undefined) return cachedClaudeAccount || undefined;

  // Claude's active config lives at $CLAUDE_CONFIG_DIR/.claude.json; for our shim
  // that's <version>/home/.claude/.claude.json. The home-level .claude.json is a
  // legacy path used when Claude runs without CLAUDE_CONFIG_DIR set.
  const candidates = [
    path.join(HOME, '.claude', '.claude.json'),
    path.join(HOME, '.claude.json'),
  ];

  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', 'claude');
    if (!fs.existsSync(versionsBase)) continue;
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        candidates.push(path.join(versionsBase, version, 'home', '.claude', '.claude.json'));
        candidates.push(path.join(versionsBase, version, 'home', '.claude.json'));
      }
    } catch { /* versions dir unreadable */ }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      const name = data.oauthAccount?.emailAddress || data.oauthAccount?.displayName;
      if (name) {
        cachedClaudeAccount = name;
        return name;
      }
    } catch { /* auth file unreadable or malformed */ }
  }

  cachedClaudeAccount = '';
  return undefined;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/**
 * Build a map of Claude sessionId -> user-given label from ~/.claude/sessions/*.json.
 * Each JSON has shape { pid, sessionId, cwd, startedAt, name?, ... }. The
 * `name` field only exists if the user ran /rename in that session.
 * For sessionId collisions (re-resume of the same session), prefer the most
 * recent startedAt.
 */
export function buildClaudeLabelMap(): Map<string, string | null> {
  const map = new Map<string, { label: string | null; startedAt: number }>();
  const dir = path.join(HOME, '.claude', 'sessions');
  if (!fs.existsSync(dir)) return new Map();

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return new Map();
  }

  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (typeof data.sessionId !== 'string') continue;
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
      const startedAt = typeof data.startedAt === 'number' ? data.startedAt : 0;
      const existing = map.get(data.sessionId);
      if (!existing || startedAt > existing.startedAt) {
        map.set(data.sessionId, { label: name, startedAt });
      }
    } catch { /* unreadable session metadata file */ }
  }

  const out = new Map<string, string | null>();
  for (const [sid, { label }] of map) out.set(sid, label);
  return out;
}

/** Incrementally re-scan changed Claude session files and upsert into the DB. */
async function scanClaudeIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const account = getClaudeAccount();
  const labelMap = buildClaudeLabelMap();

  // Enumerate every leaf project dir across all Claude roots. The FIRST root
  // returned by getAgentSessionDirs is the agent's live `~/.claude/projects` —
  // the only tree Claude appends to in place, so its project dirs are live roots
  // (every file hot). Version-home + backup roots are immutable: their dirs
  // short-circuit to a single dir stat when unchanged.
  const roots = getAgentSessionDirs('claude', 'projects');
  const leafDirs: LeafDir[] = [];
  const seenLeaf = new Set<string>();
  roots.forEach((projectsDir, rootIdx) => {
    const isLiveRoot = rootIdx === 0;
    let projectDirs: string[];
    try {
      projectDirs = fs.readdirSync(projectsDir);
    } catch {
      return;
    }
    for (const dirName of projectDirs) {
      const dirPath = path.join(projectsDir, dirName);
      const key = safeRealpathSync(dirPath) || dirPath;
      if (seenLeaf.has(key)) continue;
      seenLeaf.add(key);
      leafDirs.push({ dirPath, isLiveRoot });
    }
  });

  const { changed: changedAll, allFiles } = collectChangedFilesInLeafDirs(leafDirs, '.jsonl');
  // Restore the pre-A-2 cross-root precedence: a session id present in multiple
  // roots is ALWAYS served from its live path, never a frozen backup/version
  // copy. Pre-A-2, dedup happened at enumeration time via a live-first `seen`
  // set, so a non-live copy was never even stat'd when a live copy existed. This
  // PR must not regress that to "whichever copy changed this run wins" — a cold
  // (unchanged) live copy paired with a freshly-written backup snapshot would
  // otherwise flip the row's file_path to the backup path.
  //
  // allFiles is every transcript file across all roots in live-first order, so
  // the FIRST occurrence of each session id is its live (or highest-precedence)
  // path — the durable winner, independent of which copy was flagged changed.
  const sessionIdOf = (fp: string) => path.basename(fp).replace('.jsonl', '');
  const winnerBySession = new Map<string, string>();
  for (const { filePath } of allFiles) {
    const id = sessionIdOf(filePath);
    if (!winnerBySession.has(id)) winnerBySession.set(id, filePath);
  }
  // Keep a changed entry only if it is its session's winner. A changed non-live
  // copy is dropped whenever a live copy exists anywhere; the winning path is
  // parsed only when it itself changed (a cold winner needs no re-parse — its DB
  // row already points at the live path).
  const changed = changedAll.filter(e => winnerBySession.get(sessionIdOf(e.filePath)) === e.filePath);

  if (changed.length > 0) {
    onProgress?.({ agent: 'claude', parsed: 0, total: changed.length });

    const entries: ScanEntry[] = [];
    const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
    let parsed = 0;
    for (const { filePath, scan } of changed) {
      try {
        const sessionId = path.basename(filePath).replace('.jsonl', '');
        const label = labelMap.get(sessionId) ?? undefined;
        const result = await readClaudeMeta(filePath, sessionId, account, label);
        if (result) {
          entries.push({ meta: result.meta, content: result.content, scan });
        } else {
          touched.push({ filePath, scan });
        }
      } catch {
        touched.push({ filePath, scan });
      }
      parsed++;
      onProgress?.({ agent: 'claude', parsed, total: changed.length });
    }

    upsertSessionsBatch(entries);
    recordScans(touched);
  }

  // Pick up /rename changes on sessions whose JSONL didn't change.
  // Only bother for sessions we actually have a Claude row for.
  if (labelMap.size > 0) syncLabels(labelMap);
}

/** Stream-parse a single Claude JSONL file to extract session metadata. */
async function readClaudeMeta(
  filePath: string,
  sessionId: string,
  account?: string,
  label?: string,
): Promise<{ meta: SessionMeta; content: string } | null> {
  const scan = await scanClaudeSession(filePath);
  const isTeamOrigin = scan.entrypoint === 'sdk-cli';

  let meta: SessionMeta;
  if (scan.timestamp) {
    const cwd = normalizeCwd(scan.cwd || '');
    meta = {
      id: sessionId,
      shortId: sessionId.slice(0, 8),
      agent: 'claude',
      timestamp: scan.timestamp,
      lastActivity: scan.lastActivity,
      project: cwd ? path.basename(cwd) : undefined,
      cwd,
      filePath,
      gitBranch: scan.gitBranch,
      version: scan.version,
      account,
      topic: scan.topic,
      label,
      messageCount: scan.messageCount,
      tokenCount: scan.tokenCount,
      outputTokens: scan.outputTokens,
      costUsd: scan.costUsd,
      durationMs: scan.durationMs,
      isTeamOrigin,
      prUrl: scan.prUrl,
      prNumber: scan.prNumber,
      worktreeSlug: scan.worktreeSlug,
      ticketId: scan.ticketId,
      createdTickets: scan.createdTickets,
      spawnedTeam: scan.spawnedTeam,
      plan: scan.plan,
    };
  } else {
    const stat = safeStatSync(filePath);
    meta = {
      id: sessionId,
      shortId: sessionId.slice(0, 8),
      agent: 'claude',
      timestamp: stat ? stat.mtime.toISOString() : new Date().toISOString(),
      lastActivity: scan.lastActivity,
      filePath,
      account,
      label,
      messageCount: scan.messageCount,
      tokenCount: scan.tokenCount,
      outputTokens: scan.outputTokens,
      costUsd: scan.costUsd,
      durationMs: scan.durationMs,
      topic: scan.topic,
      isTeamOrigin,
      prUrl: scan.prUrl,
      prNumber: scan.prNumber,
      worktreeSlug: scan.worktreeSlug,
      ticketId: scan.ticketId,
      createdTickets: scan.createdTickets,
      spawnedTeam: scan.spawnedTeam,
      plan: scan.plan,
    };
  }

  return { meta, content: scan.contentText || '' };
}

// ---------------------------------------------------------------------------
// Codex account info
// ---------------------------------------------------------------------------

let cachedCodexAccount: string | undefined;

/** Number of times the auth.json JWT was actually base64-decoded. Test seam for the lazy-decode contract. */
let codexAccountResolveCount = 0;

/**
 * Base64url-decode a JWT and return its `email` claim, if present. Split out so
 * the decode is a single, testable step — and so it only runs when someone
 * actually reads the Codex account (see the lazy resolution below).
 */
export function decodeJwtEmail(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    return typeof payload.email === 'string' ? payload.email : undefined;
  } catch {
    return undefined; // malformed JWT
  }
}

/**
 * Extract the Codex account email from the JWT id_token in auth.json.
 *
 * Memoized and resolved LAZILY: the credential-harvesting-shaped JWT decode
 * (base64-decoding ~/.codex/auth.json) only runs when the account is actually
 * needed to build a session's metadata — never eagerly during the bulk scan.
 * A scan with no changed Codex files never touches the auth file.
 */
function getCodexAccount(): string | undefined {
  if (cachedCodexAccount !== undefined) return cachedCodexAccount || undefined;
  codexAccountResolveCount++;

  const candidates = [path.join(HOME, '.codex', 'auth.json')];

  for (const root of VERSIONS_ROOTS) {
    const versionsBase = path.join(root, 'versions', 'codex');
    if (!fs.existsSync(versionsBase)) continue;
    try {
      for (const version of fs.readdirSync(versionsBase)) {
        candidates.push(path.join(versionsBase, version, 'home', '.codex', 'auth.json'));
      }
    } catch { /* versions dir unreadable */ }
  }

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      const idToken = data.tokens?.id_token;
      if (idToken) {
        const email = decodeJwtEmail(idToken);
        if (email) {
          cachedCodexAccount = email;
          return email;
        }
      }
    } catch { /* auth file malformed */ }
  }

  cachedCodexAccount = '';
  return undefined;
}

/** Test seam: how many times getCodexAccount has actually resolved (decoded) since the last reset. */
export function __codexAccountResolveCountForTest(): number {
  return codexAccountResolveCount;
}

/** Test seam: clear the memoized account + resolve counter so laziness can be observed from a clean slate. */
export function __resetCodexAccountCacheForTest(): void {
  cachedCodexAccount = undefined;
  codexAccountResolveCount = 0;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Incrementally re-scan changed Codex session files and upsert into the DB. */
async function scanCodexIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  // Lazy: getCodexAccount (the auth.json JWT decode) is only resolved by
  // readCodexMeta when a changed session actually needs it — never eagerly here,
  // so a no-op scan (changed.length === 0) never touches the credential file.
  const currentVersion = await getCurrentAgentVersion('codex');

  const prestat: PreStatEntry[] = [];
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    // High limit: the walk stats each file once here; parsing is gated by the
    // ledger match below, which reuses that stat instead of re-stat'ing.
    for (const f of walkForFilesWithStat(sessionsDir, '.jsonl', 100_000)) {
      prestat.push({ filePath: f.path, fileMtimeMs: f.mtimeMs, fileSize: f.size });
    }
  }

  const changed = filterChangedEntries(prestat);

  // Codex keeps human-readable titles (`thread_name`) in `session_index.jsonl`,
  // which updates independently of the rollout files. Stat each index against the
  // ledger *without reading it*; only read + re-apply titles when the index (or a
  // rollout) actually changed. On a fully unchanged scan this collapses to a
  // couple of stat() calls instead of a full read + a `syncTopics` DB pass.
  const titleIndex = diffCodexTitleIndexes();

  if (changed.length === 0 && !titleIndex.changed) return;

  const titles = readCodexThreadNames();

  if (changed.length === 0) {
    // No rollouts changed, but the title index did — apply the new titles.
    syncTopics(titles);
    recordScans(titleIndex.stamps);
    return;
  }

  onProgress?.({ agent: 'codex', parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = await readCodexMeta(filePath, getCodexAccount, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        // Prefer the Codex-generated title over the first-prompt fallback.
        const title = titles.get(result.meta.id);
        if (title) result.meta.topic = title;
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'codex', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
  // Only when the title index changed can an *unchanged* rollout have gained a
  // title since the last scan; the inline titles applied above already cover
  // every changed session, so skip the extra sync when the index is untouched.
  if (titleIndex.changed) syncTopics(titles);
  recordScans(titleIndex.stamps);
}

/** Parse the lines of a Codex `session_index.jsonl` into a session id -> title map. */
export function parseCodexThreadNameIndex(raw: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const id = typeof entry.id === 'string' ? entry.id : '';
      const name = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
      if (id && name) titles.set(id, name);
    } catch {
      // skip malformed line
    }
  }
  return titles;
}

/**
 * Stat every Codex `session_index.jsonl` and diff it against the scan ledger
 * *without reading it*. Returns the fresh stamps (persisted only after a
 * successful title sync) and whether any index changed since the last scan — the
 * signal that lets a no-op scan skip the file read + `syncTopics` entirely.
 *
 * The index path is a sibling of `sessions/` (never inside it), so it is never
 * walked as a rollout and its ledger row can't collide with a transcript's.
 */
function diffCodexTitleIndexes(): {
  stamps: Array<{ filePath: string; scan: ScanStamp }>;
  changed: boolean;
} {
  const stamps: Array<{ filePath: string; scan: ScanStamp }> = [];
  let changed = false;
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    const indexPath = path.join(path.dirname(sessionsDir), 'session_index.jsonl');
    const stat = safeStatSync(indexPath);
    if (!stat) continue; // no index in this home
    const scan: ScanStamp = { fileMtimeMs: Math.floor(stat.mtimeMs), fileSize: stat.size };
    const prev = getScanStampByPath(indexPath);
    if (!prev || prev.fileMtimeMs !== scan.fileMtimeMs || prev.fileSize !== scan.fileSize) {
      changed = true;
    }
    stamps.push({ filePath: indexPath, scan });
  }
  return { stamps, changed };
}

/**
 * Read Codex session titles across every Codex home (live + versioned). The
 * `session_index.jsonl` file sits beside each `sessions/` rollout tree.
 */
function readCodexThreadNames(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const sessionsDir of getAgentSessionDirs('codex', 'sessions')) {
    const indexPath = path.join(path.dirname(sessionsDir), 'session_index.jsonl');
    let raw: string;
    try {
      raw = fs.readFileSync(indexPath, 'utf-8');
    } catch {
      continue; // no index in this home
    }
    for (const [id, name] of parseCodexThreadNameIndex(raw)) titles.set(id, name);
  }
  return titles;
}

/**
 * Stream-parse a single Codex JSONL file to extract session metadata.
 *
 * `resolveAccount` is a lazy thunk (not a resolved string): the JWT decode it
 * performs is deferred until we know this file is a real session worth building
 * metadata for, and only then — never during the file walk / stat phase.
 */
export async function readCodexMeta(
  filePath: string,
  resolveAccount?: () => string | undefined,
  currentVersion?: string,
): Promise<{ meta: SessionMeta; content: string } | null> {
  const scan = await scanCodexSession(filePath);
  const sessionId = scan.sessionId || '';
  if (!sessionId) return null;

  const cwd = normalizeCwd(scan.cwd || '');
  const meta: SessionMeta = {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'codex',
    // Codex `session_meta` only carries the start time; use file mtime when
    // it's newer so long-running sessions register as recently active.
    timestamp: pickLatestCodexTimestamp(scan.timestamp, filePath),
    lastActivity: scan.lastActivity,
    project: cwd ? path.basename(cwd) : undefined,
    cwd,
    filePath,
    gitBranch: scan.gitBranch,
    version: resolveSessionVersion('codex', filePath, scan.version, currentVersion),
    topic: scan.topic,
    messageCount: scan.messageCount,
    tokenCount: scan.tokenCount,
    outputTokens: scan.outputTokens,
    costUsd: scan.costUsd,
    durationMs: scan.durationMs,
    account: resolveAccount?.(),
    prUrl: scan.prUrl,
    prNumber: scan.prNumber,
    worktreeSlug: scan.worktreeSlug,
    ticketId: scan.ticketId,
    createdTickets: scan.createdTickets,
    spawnedTeam: scan.spawnedTeam,
  };
  return { meta, content: scan.contentText || '' };
}

/**
 * Codex writes `session_meta` (with the start timestamp) on the first line of a
 * rollout and never updates it. For long-running sessions that's stale by
 * hours — `--since 2h` would drop a session still being actively written.
 * Compare against the file's mtime and use whichever is newer.
 */
function pickLatestCodexTimestamp(metaTimestamp: string | undefined, filePath: string): string {
  const fallback = new Date().toISOString();
  let mtimeIso: string | null = null;
  try {
    mtimeIso = fs.statSync(filePath).mtime.toISOString();
  } catch {
    /* file vanished between scan and stat */
  }

  const candidates = [metaTimestamp, mtimeIso].filter((v): v is string => !!v);
  if (candidates.length === 0) return fallback;

  return candidates.reduce((best, cur) => (cur > best ? cur : best));
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/** Incrementally re-scan changed Gemini session files and upsert into the DB. */
async function scanGeminiIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('gemini');
  const projectMap = buildGeminiProjectMap();

  // Each `<tmpDir>/<hashDir>/chats` is a leaf dir of Gemini transcripts. The
  // FIRST tmp root is the live `~/.gemini/tmp` — its chats dirs are live roots;
  // version-home + backup roots are immutable and short-circuit when unchanged.
  const tmpRoots = getAgentSessionDirs('gemini', 'tmp');
  const leafDirs: LeafDir[] = [];
  const seenLeaf = new Set<string>();
  tmpRoots.forEach((tmpDir, rootIdx) => {
    const isLiveRoot = rootIdx === 0;
    let hashDirs: string[];
    try {
      hashDirs = fs.readdirSync(tmpDir);
    } catch {
      return;
    }
    for (const hashDir of hashDirs) {
      const chatsDir = path.join(tmpDir, hashDir, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      const key = safeRealpathSync(chatsDir) || chatsDir;
      if (seenLeaf.has(key)) continue;
      seenLeaf.add(key);
      leafDirs.push({ dirPath: chatsDir, isLiveRoot });
    }
  });

  const { changed } = collectChangedFilesInLeafDirs(leafDirs, '.json');
  const changedByPath = new Map(changed.map(c => [c.filePath, c.scan]));
  if (changedByPath.size === 0) return;

  onProgress?.({ agent: 'gemini', parsed: 0, total: changedByPath.size });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    // The hashDir is the directory two levels up: <hashDir>/chats/<file>.json.
    const hashDir = path.basename(path.dirname(path.dirname(filePath)));
    try {
      const result = readGeminiMeta(filePath, hashDir, projectMap, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        // Gemini file without a sessionId — record scan so we don't re-parse it next run.
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'gemini', parsed, total: changedByPath.size });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

/** Parse a single Gemini JSON session file to extract session metadata. */
function readGeminiMeta(
  filePath: string,
  hashDir: string,
  projectMap: Map<string, { name: string; path: string }>,
  currentVersion?: string,
): { meta: SessionMeta; content: string } | null {
  let session: any;
  try {
    session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
  const startTime = typeof session.startTime === 'string' ? session.startTime : '';
  const projectHash = typeof session.projectHash === 'string' ? session.projectHash : '';
  const embeddedVersion = typeof session.version === 'string'
    ? session.version
    : typeof session.cliVersion === 'string'
      ? session.cliVersion
      : undefined;
  if (!sessionId) return null;

  const projectInfo = projectMap.get(projectHash || hashDir);
  const project = projectInfo?.name || hashDir.slice(0, 12);
  const cwd = projectInfo?.path ? normalizeCwd(projectInfo.path) : undefined;

  const stat = safeStatSync(filePath);

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const sessionModel = typeof session.model === 'string' ? session.model : undefined;
  let topic: string | undefined;
  let messageCount = 0;
  let tokenCount = 0;
  let outputTokens = 0;
  let sawTokenCount = false;
  let costUsd = 0;
  let sawCost = false;
  let firstTsMs: number | undefined;
  let lastTsMs: number | undefined;
  const userTexts: string[] = [];

  for (const message of messages) {
    if (message.type === 'user') {
      const text = extractGeminiMessageText(message.content);
      if (text) {
        messageCount++;
        userTexts.push(text);
        if (!topic) topic = extractSessionTopic(text);
      }
    } else if (message.type === 'gemini') {
      if (extractGeminiMessageText(message.content)) {
        messageCount++;
      }
    }

    // Duration: messages carry a `timestamp` on most Gemini CLI versions.
    const tsRaw = message.timestamp ?? message.time;
    if (typeof tsRaw === 'string' || typeof tsRaw === 'number') {
      const ms = new Date(tsRaw).getTime();
      if (!Number.isNaN(ms)) {
        if (firstTsMs === undefined || ms < firstTsMs) firstTsMs = ms;
        if (lastTsMs === undefined || ms > lastTsMs) lastTsMs = ms;
      }
    }

    const total = getGeminiTokenCount(message.tokens);
    if (total !== null) {
      tokenCount += total;
      sawTokenCount = true;
    }
    // Output tokens: sum directional generation fields per message (output +
    // thoughts + tool), mirroring the cost path — never `tokens.total`, which
    // may be cumulative and would double-count when summed.
    const gtk = message.tokens;
    if (gtk && typeof gtk === 'object') {
      outputTokens +=
        (typeof gtk.output === 'number' ? gtk.output : 0) +
        (typeof gtk.thoughts === 'number' ? gtk.thoughts : 0) +
        (typeof gtk.tool === 'number' ? gtk.tool : 0);
    }

    // Per-message cost: directional tokens × this message's model price.
    const msgModel = (typeof message.model === 'string' ? message.model : undefined) || sessionModel;
    const tk = message.tokens;
    if (msgModel && tk && typeof tk === 'object') {
      const c = costOfUsage({
        model: msgModel,
        inputTokens: typeof tk.input === 'number' ? tk.input : undefined,
        outputTokens:
          (typeof tk.output === 'number' ? tk.output : 0) +
          (typeof tk.thoughts === 'number' ? tk.thoughts : 0) +
          (typeof tk.tool === 'number' ? tk.tool : 0),
        cacheReadTokens: typeof tk.cached === 'number' ? tk.cached : undefined,
      });
      if (c > 0) {
        costUsd += c;
        sawCost = true;
      }
    }
  }

  const durationMs =
    firstTsMs !== undefined && lastTsMs !== undefined && lastTsMs > firstTsMs
      ? lastTsMs - firstTsMs
      : undefined;

  const meta: SessionMeta = {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'gemini',
    timestamp: startTime || (stat ? stat.mtime.toISOString() : new Date().toISOString()),
    lastActivity: lastTsMs !== undefined ? new Date(lastTsMs).toISOString() : undefined,
    project,
    cwd,
    filePath,
    version: resolveSessionVersion('gemini', filePath, embeddedVersion, currentVersion),
    topic,
    messageCount,
    tokenCount: sawTokenCount ? tokenCount : undefined,
    outputTokens: sawTokenCount ? outputTokens : undefined,
    costUsd: sawCost ? costUsd : undefined,
    durationMs,
  };
  return { meta, content: userTexts.join('\n') };
}

/** Build a hash-to-project mapping from Gemini's projects.json and history directories. */
function buildGeminiProjectMap(): Map<string, { name: string; path: string }> {
  const map = new Map<string, { name: string; path: string }>();
  const projectsJsonPath = path.join(HOME, '.gemini', 'projects.json');

  if (fs.existsSync(projectsJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(projectsJsonPath, 'utf-8'));
      const projects = data.projects;

      if (typeof projects === 'object' && projects !== null) {
        if (Array.isArray(projects)) {
          for (const p of projects) {
            if (typeof p === 'string') {
              const hash = sha256(p);
              map.set(hash, { name: path.basename(p), path: p });
              map.set(p, { name: path.basename(p), path: p });
            }
          }
        } else {
          for (const [p, name] of Object.entries(projects)) {
            const hash = sha256(p);
            map.set(hash, { name: String(name), path: p });
          }
        }
      }
    } catch { /* projects.json missing or malformed */ }
  }

  const historyDir = path.join(HOME, '.gemini', 'history');
  if (fs.existsSync(historyDir)) {
    try {
      for (const name of fs.readdirSync(historyDir)) {
        const rootFile = path.join(historyDir, name, '.project_root');
        if (fs.existsSync(rootFile)) {
          try {
            const projectPath = fs.readFileSync(rootFile, 'utf-8').trim();
            if (projectPath) {
              const hash = sha256(projectPath);
              map.set(hash, { name, path: projectPath });
            }
          } catch { /* history entry unreadable */ }
        }
      }
    } catch { /* history entry unreadable */ }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Antigravity
//
// Antigravity stores one SQLite DB per conversation at
// ~/.gemini/antigravity-cli/conversations/<trajectory-uuid>.db. The filename
// (minus .db) is the canonical session id. Each DB is stat'd against the ledger;
// only changed DBs are re-parsed (via parseAntigravity, which shells out to
// sqlite3). Tool count doubles as the message count; the toolSummary of the
// first tool call becomes the topic, and any run_command's Cwd fills in cwd.
// ---------------------------------------------------------------------------

/** Incrementally re-scan changed Antigravity conversation DBs and upsert into the DB. */
async function scanAntigravityIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('antigravity');

  const filePaths: string[] = [];
  const seenPaths = new Set<string>();
  for (const conversationsDir of getAgentSessionDirs('antigravity', 'conversations')) {
    let files: string[];
    try {
      files = fs.readdirSync(conversationsDir).filter(f => f.endsWith('.db'));
    } catch {
      continue;
    }
    for (const file of files) {
      const fp = path.join(conversationsDir, file);
      if (seenPaths.has(fp)) continue;
      seenPaths.add(fp);
      filePaths.push(fp);
    }
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'antigravity', parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readAntigravityMeta(filePath, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'antigravity', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

/** Parse a single Antigravity conversation DB to extract session metadata. */
function readAntigravityMeta(
  filePath: string,
  currentVersion?: string,
): { meta: SessionMeta; content: string } | null {
  const sessionId = path.basename(filePath).replace(/\.db$/, '');
  if (!sessionId) return null;

  const events = parseAntigravity(filePath);

  // cwd: first run_command carries the working directory in its Cwd arg.
  let cwd: string | undefined;
  const contentParts: string[] = [];
  for (const e of events) {
    if (!cwd && typeof e.args?.Cwd === 'string' && e.args.Cwd) cwd = e.args.Cwd;
    if (e.content) contentParts.push(e.content);
  }
  const normalizedCwd = cwd ? normalizeCwd(cwd) : undefined;

  // Topic: the first tool's human summary is a decent one-line label.
  const topic = events.find(e => e.content)?.content;

  const stat = safeStatSync(filePath);
  const meta: SessionMeta = {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'antigravity',
    timestamp: stat ? stat.mtime.toISOString() : new Date().toISOString(),
    project: normalizedCwd ? path.basename(normalizedCwd) : undefined,
    cwd: normalizedCwd,
    filePath,
    version: resolveSessionVersion('antigravity', filePath, undefined, currentVersion),
    topic: topic ? topic.slice(0, 120) : undefined,
    messageCount: events.length,
  };
  return { meta, content: contentParts.join('\n') };
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');

let cachedOpenCodeAccount: string | undefined;

/** Query the active OpenCode account email from its SQLite database. */
async function getOpenCodeAccount(): Promise<string | undefined> {
  if (cachedOpenCodeAccount !== undefined) return cachedOpenCodeAccount || undefined;

  // Read through the node/bun SQLite wrapper (not the `sqlite3` CLI) so this
  // works on every OS — the CLI is absent on Windows.
  let db: Database.Database | undefined;
  try {
    if (fs.existsSync(OPENCODE_DB)) {
      db = new Database(OPENCODE_DB);
      const row = db
        .prepare('SELECT email FROM control_account WHERE active=1 LIMIT 1;')
        .get() as { email?: unknown } | undefined;
      const out = typeof row?.email === 'string' ? row.email.trim() : '';
      if (out) {
        cachedOpenCodeAccount = out;
        return out;
      }
    }
  } catch { /* DB not accessible, sqlite module unavailable, or query failed */ }
  finally {
    try { db?.close(); } catch { /* best-effort close */ }
  }

  cachedOpenCodeAccount = '';
  return undefined;
}

/** Scan OpenCode sessions from its SQLite database when the DB file has changed. */
async function scanOpenCodeIncremental(): Promise<void> {
  if (!fs.existsSync(OPENCODE_DB)) return;

  const stat = safeStatSync(OPENCODE_DB);
  if (!stat) return;

  // OpenCode is one big DB; we use its mtime/size as the ledger for the
  // entire fleet of OpenCode sessions.
  const currentScan: ScanStamp = {
    fileMtimeMs: Math.floor(stat.mtimeMs),
    fileSize: stat.size,
  };
  const prev = getScanStampByPath(OPENCODE_DB);
  if (prev && prev.fileMtimeMs === currentScan.fileMtimeMs && prev.fileSize === currentScan.fileSize) {
    return;
  }

  const account = await getOpenCodeAccount();
  const currentVersion = await getCurrentAgentVersion('opencode');

  // Read through the node/bun SQLite wrapper (not the `sqlite3` CLI) so this
  // works on every OS — the CLI is absent on Windows.
  let db: Database.Database | undefined;
  try {
    const query = `
      SELECT
        s.id AS id,
        s.title AS title,
        s.directory AS directory,
        s.version AS version,
        s.time_created AS time_created,
        s.time_updated AS time_updated,
        COALESCE(stats.message_count, 0) AS message_count,
        stats.token_count AS token_count,
        stats.output_tokens AS output_tokens,
        COALESCE(stats.has_token_data, 0) AS has_token_data
      FROM session s
      LEFT JOIN (
        SELECT
          session_id,
          COUNT(*) AS message_count,
          SUM(
            COALESCE(json_extract(data, '$.tokens.input'), 0) +
            COALESCE(json_extract(data, '$.tokens.output'), 0) +
            COALESCE(json_extract(data, '$.tokens.reasoning'), 0) +
            COALESCE(json_extract(data, '$.tokens.cache.read'), 0) +
            COALESCE(json_extract(data, '$.tokens.cache.write'), 0)
          ) AS token_count,
          SUM(COALESCE(json_extract(data, '$.tokens.output'), 0)) AS output_tokens,
          MAX(CASE WHEN json_type(data, '$.tokens') IS NOT NULL THEN 1 ELSE 0 END) AS has_token_data
        FROM message
        GROUP BY session_id
      ) stats ON stats.session_id = s.id
      WHERE s.parent_id IS NULL
      ORDER BY time_created DESC
      LIMIT 1000;
    `.replace(/\n/g, ' ');

    db = new Database(OPENCODE_DB);
    const rows = db.prepare(query).all() as Array<{
      id: unknown;
      title: unknown;
      directory: unknown;
      version: unknown;
      time_created: unknown;
      time_updated: unknown;
      message_count: unknown;
      token_count: unknown;
      output_tokens: unknown;
      has_token_data: unknown;
    }>;

    const entries: ScanEntry[] = [];
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) continue;
      const title = typeof row.title === 'string' ? row.title : '';
      const directory = typeof row.directory === 'string' ? row.directory : '';
      const version = typeof row.version === 'string' ? row.version : '';

      const asInt = (v: unknown): number =>
        typeof v === 'number' ? v : parseInt(String(v), 10);
      const timeCreated = asInt(row.time_created);
      const timeUpdated = asInt(row.time_updated);
      const messageCount = asInt(row.message_count);
      const tokenCount = asInt(row.token_count);
      const outputTokens = asInt(row.output_tokens);
      const hasTokenData = asInt(row.has_token_data) === 1;
      const timestamp = isNaN(timeCreated) ? new Date().toISOString() : new Date(timeCreated).toISOString();
      // OpenCode is one shared DB, not one file per session — its row carries a
      // per-session updated time. Set lastActivity explicitly (falling back to
      // creation, never the whole-DB mtime the ScanStamp would otherwise supply).
      const lastActivity = Number.isNaN(timeUpdated) ? timestamp : new Date(timeUpdated).toISOString();
      const topic = title || undefined;

      const meta: SessionMeta = {
        id,
        shortId: id.replace(/^ses_/, '').slice(0, 8),
        agent: 'opencode',
        timestamp,
        lastActivity,
        project: directory ? path.basename(directory) : undefined,
        cwd: directory ? normalizeCwd(directory) : undefined,
        filePath: `${OPENCODE_DB}#${id}`,
        version: resolveSessionVersion('opencode', OPENCODE_DB, version || undefined, currentVersion),
        account,
        topic,
        messageCount: Number.isNaN(messageCount) ? undefined : messageCount,
        tokenCount: hasTokenData && !Number.isNaN(tokenCount) ? tokenCount : undefined,
        outputTokens: hasTokenData && !Number.isNaN(outputTokens) ? outputTokens : undefined,
      };

      entries.push({ meta, content: topic || '', scan: currentScan });
    }

    upsertSessionsBatch(entries);
    // Stamp the OpenCode DB itself so we can short-circuit on the next run.
    recordScans([{ filePath: OPENCODE_DB, scan: currentScan }]);
  } catch (err: any) {
    if (process.stderr.isTTY) {
      console.error(`Warning: Could not query OpenCode sessions: ${err.message}`);
    }
  } finally {
    try { db?.close(); } catch { /* best-effort close */ }
  }
}

// ---------------------------------------------------------------------------
// OpenClaw
// ---------------------------------------------------------------------------

/** Scan active OpenClaw channels and cron jobs via the openclaw CLI. */
async function scanOpenClawIncremental(): Promise<void> {
  // Check if openclaw is installed — silently skip if not.
  try {
    await execFileAsync('which', ['openclaw']);
  } catch {
    return;
  }

  // TTL cache: skip subprocess calls if we scanned recently. Stored in the
  // meta table so we skip even when no channels/cron exist to produce rows.
  const db = getDB();
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'openclaw_last_scan_ms'`).get() as { value: string } | undefined;
  const lastScanMs = row ? parseInt(row.value, 10) : 0;
  if (lastScanMs && Date.now() - lastScanMs < OPENCLAW_TTL_MS) {
    return;
  }

  const currentVersion = await getCurrentAgentVersion('openclaw');
  const now = Date.now();
  const scan: ScanStamp = { fileMtimeMs: now, fileSize: 0 };
  const entries: ScanEntry[] = [];

  try {
    const { stdout: output } = await execFileAsync('openclaw', ['channels', 'status'], {
      encoding: 'utf-8',
    });

    for (const line of output.split('\n')) {
      const match = line.match(/^-\s+\w+\s+(\S+)\s+\((\w+)\):\s*(.+)/);
      if (!match) continue;
      const [, agentId, name, statusStr] = match;
      if (!statusStr.includes('running')) continue;

      entries.push({
        meta: {
          id: `openclaw-${agentId}`,
          shortId: agentId.slice(0, 8),
          agent: 'openclaw',
          timestamp: new Date().toISOString(),
          project: name,
          cwd: getOpenClawSessionCwd(agentId),
          version: currentVersion,
          filePath: '',
        },
        content: `${name} ${agentId}`,
        scan,
      });
    }
  } catch {
    /* channels command failed */
  }

  try {
    const { stdout: output } = await execFileAsync('openclaw', ['cron', 'list'], {
      encoding: 'utf-8',
    });

    const lines = output.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const headMatch = line.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)/);
      if (!headMatch) continue;
      const jobId = headMatch[1];
      const jobName = headMatch[2];

      const rest = line.slice(headMatch[0].length).trim();
      const cols = rest.split(/\s{2,}/);
      const agentId = cols[4] || '';

      entries.push({
        meta: {
          id: `openclaw-cron-${jobId}`,
          shortId: jobId.slice(0, 8),
          agent: 'openclaw',
          timestamp: new Date().toISOString(),
          project: `${jobName} (${agentId || 'unknown'})`,
          cwd: getOpenClawSessionCwd(agentId),
          version: currentVersion,
          filePath: '',
        },
        content: `${jobName} ${agentId}`,
        scan,
      });
    }
  } catch {
    /* cron command failed */
  }

  upsertSessionsBatch(entries);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('openclaw_last_scan_ms', ?)`).run(String(Date.now()));
}

// ---------------------------------------------------------------------------
// Rush
//
// Rush sessions live at ~/.rush/sessions/<session-id>/messages.jsonl.
// Each line is { id, session_id, agent_id, role, type, content, created_at, ... }.
// The directory name is the canonical session id. Rush sessions are cloud-bound
// (not tied to a local cwd), so cwd is left unset.
// ---------------------------------------------------------------------------

interface RushSessionScan {
  timestamp?: string;
  topic?: string;
  agentId?: string;
  messageCount: number;
  contentText?: string;
}

/** Incrementally re-scan changed Rush session files and upsert into the DB. */
async function scanRushIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  if (!fs.existsSync(RUSH_SESSIONS_DIR)) return;

  const filePaths: string[] = [];
  let dirNames: string[];
  try {
    dirNames = fs.readdirSync(RUSH_SESSIONS_DIR);
  } catch {
    return;
  }

  for (const dirName of dirNames) {
    const sessionDir = path.join(RUSH_SESSIONS_DIR, dirName);
    const stat = safeStatSync(sessionDir);
    if (!stat?.isDirectory()) continue;
    const messagesPath = path.join(sessionDir, 'messages.jsonl');
    if (!fs.existsSync(messagesPath)) continue;
    filePaths.push(messagesPath);
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'rush', parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const sessionId = path.basename(path.dirname(filePath));
      const result = await readRushMeta(filePath, sessionId);
      if (result) {
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'rush', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

/** Stream-parse a single Rush messages.jsonl file to extract session metadata. */
async function readRushMeta(
  filePath: string,
  sessionId: string,
): Promise<{ meta: SessionMeta; content: string } | null> {
  const scan = await scanRushSession(filePath);

  const stat = safeStatSync(filePath);
  const timestamp = scan.timestamp
    || (stat ? stat.mtime.toISOString() : new Date().toISOString());

  const shortId = sessionId.replace(/^session_/, '').slice(0, 8);

  const meta: SessionMeta = {
    id: sessionId,
    shortId,
    agent: 'rush',
    timestamp,
    project: scan.agentId,
    filePath,
    topic: scan.topic,
    messageCount: scan.messageCount,
  };

  return { meta, content: scan.contentText || '' };
}

/** Stream a Rush messages.jsonl file and extract scan-level metadata. */
async function scanRushSession(filePath: string): Promise<RushSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let timestamp: string | undefined;
  let topic: string | undefined;
  let agentId: string | undefined;
  let messageCount = 0;
  const userTexts: string[] = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (!timestamp && typeof parsed.created_at === 'string') {
        timestamp = parsed.created_at;
      }
      if (!agentId && typeof parsed.agent_id === 'string') {
        agentId = parsed.agent_id;
      }

      if (parsed.type !== 'message') continue;
      const text = typeof parsed.content?.text === 'string' ? parsed.content.text.trim() : '';
      if (!text) continue;

      const cleaned = text
        .replace(/^<user_input>/, '')
        .replace(/<\/user_input>$/, '')
        .trim();
      if (!cleaned) continue;
      if (parsed.role === 'system' && cleaned === 'execution_start') continue;

      messageCount++;
      if (parsed.role === 'user') {
        userTexts.push(cleaned);
        if (!topic) topic = extractSessionTopic(cleaned);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    timestamp,
    topic,
    agentId,
    messageCount,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
  };
}

// ---------------------------------------------------------------------------
// Hermes
//
// Hermes sessions live at ~/.hermes/sessions/session_<id>.json (one JSON
// file per session). Shape:
//   { session_id, model, platform, session_start, last_updated,
//     system_prompt, message_count, messages: [{role, content}, ...] }
// request_dump_*.json files in the same dir are per-turn debug dumps — skip.
// Hermes is a gateway/API agent, so cwd is left unset.
// ---------------------------------------------------------------------------

/** Incrementally re-scan changed Hermes session files and upsert into the DB. */
async function scanHermesIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  if (!fs.existsSync(HERMES_SESSIONS_DIR)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(HERMES_SESSIONS_DIR);
  } catch {
    return;
  }

  const filePaths: string[] = [];
  for (const name of entries) {
    if (!name.startsWith('session_') || !name.endsWith('.json')) continue;
    filePaths.push(path.join(HERMES_SESSIONS_DIR, name));
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'hermes', parsed: 0, total: changed.length });

  const scanEntries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readHermesMeta(filePath);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        scanEntries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'hermes', parsed, total: changed.length });
  }

  upsertSessionsBatch(scanEntries);
  recordScans(touched);
}

/** Parse a single Hermes session JSON file to extract session metadata. */
function readHermesMeta(filePath: string): { meta: SessionMeta; content: string } | null {
  let session: any;
  try {
    session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionId = typeof session.session_id === 'string' ? session.session_id : '';
  if (!sessionId) return null;

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const userTexts: string[] = [];
  let topic: string | undefined;
  let messageCount = 0;
  for (const msg of messages) {
    const text = extractHermesMessageText(msg?.content);
    if (!text) continue;
    messageCount++;
    if (msg?.role === 'user') {
      userTexts.push(text);
      if (!topic) topic = extractSessionTopic(text);
    }
  }

  const stat = safeStatSync(filePath);
  const timestamp = typeof session.last_updated === 'string'
    ? session.last_updated
    : typeof session.session_start === 'string'
      ? session.session_start
      : stat ? stat.mtime.toISOString() : new Date().toISOString();

  const shortId = sessionId.replace(/^api-/, '').slice(0, 8);
  const model = typeof session.model === 'string' ? session.model : undefined;
  const platform = typeof session.platform === 'string' ? session.platform : undefined;

  const meta: SessionMeta = {
    id: sessionId,
    shortId,
    agent: 'hermes',
    timestamp,
    project: platform,
    filePath,
    version: model,
    topic,
    messageCount: messageCount || (typeof session.message_count === 'number' ? session.message_count : undefined),
  };

  return { meta, content: userTexts.join('\n') };
}

/** Extract plain text from a Hermes message content field (string or list of parts). */
function extractHermesMessageText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      return '';
    })
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Droid (Factory)
// ---------------------------------------------------------------------------

/** Lightweight metadata extracted from a Droid JSONL file during incremental scan. */
interface DroidSessionScan {
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  topic?: string;
  model?: string;
  messageCount: number;
  durationMs?: number;
  lastActivity?: string;
  contentText?: string;
}

/**
 * Incrementally re-scan changed Droid (Factory) session files and upsert into
 * the DB. Droid writes one `<uuid>.jsonl` transcript plus a sibling
 * `<uuid>.settings.json` (model + token usage) under
 * `~/.factory/sessions/<encoded-cwd>/`.
 */
async function scanDroidIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('droid');

  const prestat: PreStatEntry[] = [];
  for (const sessionsDir of getAgentSessionDirs('droid', 'sessions')) {
    // High limit: the walk stats each file once here; parsing is gated by the
    // ledger match below, which reuses that stat instead of re-stat'ing.
    for (const f of walkForFilesWithStat(sessionsDir, '.jsonl', 100_000)) {
      prestat.push({ filePath: f.path, fileMtimeMs: f.mtimeMs, fileSize: f.size });
    }
  }

  const changed = filterChangedEntries(prestat);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'droid', parsed: 0, total: changed.length });

  const entries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = await readDroidMeta(filePath, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        entries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'droid', parsed, total: changed.length });
  }

  upsertSessionsBatch(entries);
  recordScans(touched);
}

/** Stream-parse a single Droid JSONL file (+ sibling settings) into session metadata. */
async function readDroidMeta(
  filePath: string,
  currentVersion?: string,
): Promise<{ meta: SessionMeta; content: string } | null> {
  const scan = await scanDroidSession(filePath);
  // The filename is the canonical session id; fall back to the session_start id.
  const sessionId = path.basename(filePath).replace(/\.jsonl$/, '') || scan.sessionId || '';
  if (!sessionId) return null;

  // Token usage and cost live only in the sibling `<uuid>.settings.json`.
  const settings = readDroidSettings(filePath.replace(/\.jsonl$/, '.settings.json'));
  const model = settings.model || scan.model;
  const tokenCount = settings.tokenCount;
  const costUsd = model && settings.usage
    ? costOfUsage({
        model,
        inputTokens: settings.usage.inputTokens,
        outputTokens: settings.usage.outputTokens,
        cacheReadTokens: settings.usage.cacheReadTokens,
        cacheCreationTokens: settings.usage.cacheCreationTokens,
      })
    : 0;

  const stat = safeStatSync(filePath);
  const cwd = normalizeCwd(scan.cwd || '');
  const meta: SessionMeta = {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'droid',
    timestamp: scan.timestamp || (stat ? stat.mtime.toISOString() : new Date().toISOString()),
    lastActivity: scan.lastActivity,
    project: cwd ? path.basename(cwd) : undefined,
    cwd,
    filePath,
    version: resolveSessionVersion('droid', filePath, undefined, currentVersion),
    topic: scan.topic,
    messageCount: scan.messageCount,
    tokenCount,
    outputTokens: settings.usage?.outputTokens,
    costUsd: costUsd > 0 ? costUsd : undefined,
    durationMs: scan.durationMs,
  };
  return { meta, content: scan.contentText || '' };
}

/** Read model + token usage from a Droid `<uuid>.settings.json` sidecar. */
function readDroidSettings(settingsPath: string): {
  model?: string;
  tokenCount?: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
} {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const model = typeof data.model === 'string' ? data.model : undefined;
    const u = data.tokenUsage;
    if (!u || typeof u !== 'object') return { model };
    const usage = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheCreationTokens: u.cacheCreationTokens,
    };
    const tokenCount = sumKnownNumbers([
      u.inputTokens,
      u.outputTokens,
      u.cacheCreationTokens,
      u.cacheReadTokens,
    ]) ?? undefined;
    return { model, tokenCount, usage };
  } catch {
    return {};
  }
}

/** Stream a Droid JSONL file and extract scan-level metadata (id, cwd, topic, model, duration). */
async function scanDroidSession(filePath: string): Promise<DroidSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | undefined;
  let timestamp: string | undefined;
  let cwd: string | undefined;
  let title: string | undefined;
  let sessionTitle: string | undefined;
  let firstUserTopic: string | undefined;
  let model: string | undefined;
  let messageCount = 0;
  let firstTsMs: number | undefined;
  let lastTsMs: number | undefined;
  const userTexts: string[] = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.type === 'session_start') {
        sessionId = typeof parsed.id === 'string' ? parsed.id : sessionId;
        cwd = typeof parsed.cwd === 'string' ? parsed.cwd : cwd;
        // Droid auto-generates `sessionTitle`; `title` is the raw first prompt.
        if (typeof parsed.sessionTitle === 'string' && parsed.sessionTitle.trim()) {
          sessionTitle = parsed.sessionTitle.trim();
        }
        if (typeof parsed.title === 'string' && parsed.title.trim()) {
          title = parsed.title.trim();
        }
        continue;
      }

      if (parsed.type !== 'message') continue;

      // Track duration across every timestamped message.
      if (typeof parsed.timestamp === 'string') {
        const ms = new Date(parsed.timestamp).getTime();
        if (!Number.isNaN(ms)) {
          if (firstTsMs === undefined || ms < firstTsMs) firstTsMs = ms;
          if (lastTsMs === undefined || ms > lastTsMs) lastTsMs = ms;
        }
      }
      if (!timestamp && typeof parsed.timestamp === 'string') timestamp = parsed.timestamp;

      const msg = parsed.message || {};
      if (typeof msg.modelId === 'string') model = msg.modelId;

      const text = extractDroidMessageText(msg.content);
      if (!text) continue;
      messageCount++;
      if (msg.role === 'user') {
        userTexts.push(text);
        if (!firstUserTopic) firstUserTopic = extractSessionTopic(text);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const durationMs =
    firstTsMs !== undefined && lastTsMs !== undefined && lastTsMs > firstTsMs
      ? lastTsMs - firstTsMs
      : undefined;

  return {
    sessionId,
    timestamp,
    cwd,
    // Prefer Droid's auto-title, then the raw first-prompt title, then the
    // derived first-user-message topic.
    topic: sessionTitle || title || firstUserTopic,
    model,
    messageCount,
    durationMs,
    lastActivity: lastTsMs !== undefined ? new Date(lastTsMs).toISOString() : undefined,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
  };
}

/** Extract plain text from a Droid message content field (Anthropic-shaped blocks). */
function extractDroidMessageText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => (typeof part?.text === 'string' && part.type === 'text' ? part.text : ''))
    // Droid front-loads injected context (date, skills list) as <system-reminder>
    // text blocks on the first user turn — drop them so topic/content stay clean.
    .filter((text: string) => text.trim() && !text.trim().startsWith('<system-reminder>'))
    .join('\n')
    .trim();
}

/** Stream a Claude JSONL file and extract scan-level metadata (timestamp, cwd, topic, tokens). */
export async function scanClaudeSession(filePath: string): Promise<ClaudeSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let timestamp: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let topic: string | undefined;
  // Explicit session titles: `/rename` writes a `custom-title` event; Claude
  // auto-generates an `ai-title`. Both can repeat across the file — last wins.
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let entrypoint: string | undefined;
  let messageCount = 0;
  let tokenCount = 0;
  let outputTokens = 0;
  let sawTokenCount = false;
  let costUsd = 0;
  let sawCost = false;
  // Track the first and last timestamped event to derive wall-clock duration.
  let firstTsMs: number | undefined;
  let lastTsMs: number | undefined;
  const seenAssistantIds = new Set<string>();
  const userTexts: string[] = [];
  // Durable PR signal: set only when an actual `gh pr create` Bash *command*
  // runs (structural — the command field, not any prose mentioning it), then
  // capture the pull URL from a later tool_result's output.
  let sawPrCreate = false;
  let prUrl: string | undefined;
  let prNumber: number | undefined;

  // Artifacts the session PRODUCED: tracker refs it created and any team it spawned.
  // Ticket creation spans two events — a create_issue tool_use, then the tool_result
  // carrying the new id — so we hold the pending tool_use ids until their result lands.
  const createdTickets = new Set<string>();
  const pendingTicketTools = new Set<string>();
  let spawnedTeam: string | undefined;
  // The LAST ExitPlanMode plan wins so a re-planned session surfaces its most
  // recent plan, matching the semantic the extension's re-parser relied on.
  let plan: string | undefined;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      // entrypoint ships on the first envelope event (attachment/user/assistant)
      // and is the clean structural signal for "was this a team spawn?"
      if (!entrypoint && typeof parsed.entrypoint === 'string') {
        entrypoint = parsed.entrypoint;
      }

      // Produced-artifact signals, structurally (independent of the PR gate below):
      //   - a Bash `agents teams create/add` command → the team it spawned
      //   - a Linear create_issue / `gh issue create` tool_use → its result carries
      //     the new ticket ref, read from the matching tool_result.
      if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
        for (const b of parsed.message.content) {
          if (b?.type !== 'tool_use') continue;
          if (!spawnedTeam && typeof b?.input?.command === 'string') {
            const team = detectSpawnedTeam(b.input.command);
            if (team) spawnedTeam = team;
          }
          if (typeof b?.id === 'string' && isTicketCreateTool(b?.name, b?.input?.command)) {
            pendingTicketTools.add(b.id);
          }
          // ExitPlanMode plan markdown — last one wins so a re-planned session
          // reports its most recent plan.
          if (b?.name === 'ExitPlanMode' && typeof b?.input?.plan === 'string') {
            const p = b.input.plan.trim();
            if (p) plan = b.input.plan;
          }
        }
      }
      if (pendingTicketTools.size > 0 && parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
        for (const b of parsed.message.content) {
          if (b?.type !== 'tool_result' || typeof b?.tool_use_id !== 'string') continue;
          if (!pendingTicketTools.has(b.tool_use_id)) continue;
          pendingTicketTools.delete(b.tool_use_id);
          const text = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content) ? b.content.map((c: any) => c?.text || '').join('\n') : '';
          const t = extractCreatedTicket(text);
          if (t) createdTickets.add(t);
        }
      }

      // PR signal, structurally: a Bash tool_use whose command is `gh pr create`
      // marks intent; the pull URL is then read from a tool_result's output.
      if (!prUrl) {
        if (!sawPrCreate && parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
          for (const b of parsed.message.content) {
            if (b?.type === 'tool_use' && typeof b?.input?.command === 'string' && isPrCreateCommand(b.input.command)) {
              sawPrCreate = true;
            }
          }
        }
        if (sawPrCreate && parsed.type === 'user' && Array.isArray(parsed.message?.content)) {
          for (const b of parsed.message.content) {
            if (b?.type !== 'tool_result') continue;
            const text = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content) ? b.content.map((c: any) => c?.text || '').join('\n') : '';
            const pr = extractPrUrl(text);
            if (pr) { prUrl = pr.url; prNumber = pr.number; }
          }
        }
      }

      // Track duration across every timestamped event, not just the first.
      if (typeof parsed.timestamp === 'string') {
        const ms = new Date(parsed.timestamp).getTime();
        if (!Number.isNaN(ms)) {
          if (firstTsMs === undefined || ms < firstTsMs) firstTsMs = ms;
          if (lastTsMs === undefined || ms > lastTsMs) lastTsMs = ms;
        }
      }

      if (!timestamp && (parsed.type === 'user' || parsed.type === 'assistant') && parsed.timestamp) {
        timestamp = parsed.timestamp;
        cwd = parsed.cwd || '';
        gitBranch = parsed.gitBranch || undefined;
        version = parsed.version || undefined;
      }

      if (parsed.type === 'custom-title') {
        const t = typeof parsed.customTitle === 'string' ? parsed.customTitle.trim() : '';
        if (t) customTitle = t;
        continue;
      }
      if (parsed.type === 'ai-title') {
        const t = typeof parsed.aiTitle === 'string' ? parsed.aiTitle.trim() : '';
        if (t) aiTitle = t;
        continue;
      }

      if (parsed.type === 'user') {
        const text = extractClaudeUserText(parsed);
        if (text) {
          messageCount++;
          userTexts.push(text);
          if (!topic) topic = extractSessionTopic(text);
        }
        continue;
      }

      if (parsed.type !== 'assistant') continue;

      const assistantId = typeof parsed.message?.id === 'string'
        ? parsed.message.id
        : typeof parsed.uuid === 'string'
          ? parsed.uuid
          : undefined;

      const logicalId = assistantId || `${parsed.timestamp || ''}:${seenAssistantIds.size}`;
      if (seenAssistantIds.has(logicalId)) continue;
      seenAssistantIds.add(logicalId);
      messageCount++;

      const usageObj = parsed.message?.usage || parsed.usage;
      const usage = getClaudeUsageTotal(usageObj);
      if (usage !== null) {
        tokenCount += usage;
        sawTokenCount = true;
      }
      if (typeof usageObj?.output_tokens === 'number') outputTokens += usageObj.output_tokens;
      // Per-assistant-message cost: each event carries its own model, so we
      // multiply that event's raw token directions by that model's price.
      const model = parsed.message?.model;
      if (model && usageObj && typeof usageObj === 'object') {
        const eventCost = costOfUsage({
          model,
          inputTokens: usageObj.input_tokens,
          outputTokens: usageObj.output_tokens,
          cacheReadTokens: usageObj.cache_read_input_tokens,
          cacheCreationTokens: usageObj.cache_creation_input_tokens,
        });
        if (eventCost > 0) {
          costUsd += eventCost;
          sawCost = true;
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const durationMs =
    firstTsMs !== undefined && lastTsMs !== undefined && lastTsMs > firstTsMs
      ? lastTsMs - firstTsMs
      : undefined;

  // Prefer an explicit session title (user `/rename` > Claude auto-title) over
  // the first-prompt topic.
  const resolvedTopic = customTitle || aiTitle || topic;
  const worktree = detectWorktree(cwd, gitBranch);
  const ticket = detectTicket(userTexts.join('\n') || undefined, gitBranch);

  return {
    timestamp,
    cwd,
    gitBranch,
    version,
    topic: resolvedTopic,
    entrypoint,
    messageCount,
    tokenCount: sawTokenCount ? tokenCount : undefined,
    outputTokens: sawTokenCount ? outputTokens : undefined,
    costUsd: sawCost ? costUsd : undefined,
    durationMs,
    lastActivity: lastTsMs !== undefined ? new Date(lastTsMs).toISOString() : undefined,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
    prUrl,
    prNumber,
    worktreeSlug: worktree?.slug,
    ticketId: ticket?.id,
    createdTickets: createdTickets.size > 0 ? [...createdTickets] : undefined,
    spawnedTeam,
    plan,
  };
}

/** Stream a Codex JSONL file and extract scan-level metadata (session ID, cwd, topic, tokens). */
async function scanCodexSession(filePath: string): Promise<CodexSessionScan> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sessionId: string | undefined;
  let timestamp: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let topic: string | undefined;
  let messageCount = 0;
  let tokenCount: number | undefined;
  let model: string | undefined;
  let lastTotalTokenUsage: any;
  let firstTsMs: number | undefined;
  let lastTsMs: number | undefined;
  const userTexts: string[] = [];
  let sawPrCreate = false;
  let prUrl: string | undefined;
  let prNumber: number | undefined;
  // Produced artifacts (mirror of the Claude scan): created tracker refs + spawned team.
  const createdTickets = new Set<string>();
  const pendingTicketTools = new Set<string>();
  let spawnedTeam: string | undefined;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      // PR signal, structurally: a Codex `function_call` whose command is
      // `gh pr create`, then the pull URL from a `function_call_output`.
      if (parsed.type === 'response_item') {
        const p = parsed.payload || {};
        if (p.type === 'function_call') {
          let cmd = '';
          try {
            const args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments || {});
            cmd = String(args.command || args.cmd || '');
          } catch { /* non-JSON args */ }
          if (!prUrl && !sawPrCreate && isPrCreateCommand(cmd)) sawPrCreate = true;
          if (!spawnedTeam) {
            const team = detectSpawnedTeam(cmd);
            if (team) spawnedTeam = team;
          }
          if (typeof p.call_id === 'string' && isTicketCreateTool(p.name, cmd)) {
            pendingTicketTools.add(p.call_id);
          }
        }
        if (p.type === 'function_call_output') {
          if (!prUrl && sawPrCreate) {
            const pr = extractPrUrl(String(p.output || ''));
            if (pr) { prUrl = pr.url; prNumber = pr.number; }
          }
          if (typeof p.call_id === 'string' && pendingTicketTools.has(p.call_id)) {
            pendingTicketTools.delete(p.call_id);
            const t = extractCreatedTicket(String(p.output || ''));
            if (t) createdTickets.add(t);
          }
        }
      }

      // Track duration across every timestamped event.
      if (typeof parsed.timestamp === 'string') {
        const ms = new Date(parsed.timestamp).getTime();
        if (!Number.isNaN(ms)) {
          if (firstTsMs === undefined || ms < firstTsMs) firstTsMs = ms;
          if (lastTsMs === undefined || ms > lastTsMs) lastTsMs = ms;
        }
      }

      if (parsed.type === 'session_meta') {
        const payload = parsed.payload || {};
        sessionId = payload.id || sessionId;
        timestamp = payload.timestamp || parsed.timestamp || timestamp;
        cwd = payload.cwd || cwd;
        gitBranch = payload.git?.branch || gitBranch;
        version = payload.cli_version || payload.version || version;
        model = payload.model || model;
        continue;
      }

      if (parsed.type === 'response_item' && parsed.payload?.type === 'message') {
        const role = parsed.payload.role === 'user' || parsed.payload.role === 'developer'
          ? 'user'
          : 'assistant';
        const text = extractCodexMessageText(parsed.payload.content, role);
        if (!text) continue;
        messageCount++;
        if (role === 'user') {
          userTexts.push(text);
          if (!topic) topic = extractSessionTopic(text);
        }
        continue;
      }

      if (parsed.type === 'event_msg' && parsed.payload?.type === 'token_count') {
        const totalUsage = parsed.payload.info?.total_token_usage;
        const total = getCodexTokenCount(totalUsage);
        if (total !== null) tokenCount = total;
        // token_count is cumulative — keep the latest snapshot and price it once
        // after the stream, so we don't double-count across intermediate events.
        if (totalUsage && typeof totalUsage === 'object') lastTotalTokenUsage = totalUsage;
        // Codex also stamps the model on the rate_limits/token_count payload on
        // some versions; prefer session_meta but fall back to it.
        if (!model && typeof parsed.payload.info?.model === 'string') model = parsed.payload.info.model;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  // Price the final cumulative token snapshot once, against the session model.
  let costUsd: number | undefined;
  if (model && lastTotalTokenUsage) {
    const c = costOfUsage({
      model,
      inputTokens: lastTotalTokenUsage.input_tokens,
      outputTokens: (lastTotalTokenUsage.output_tokens ?? 0) + (lastTotalTokenUsage.reasoning_output_tokens ?? 0),
      cacheReadTokens: lastTotalTokenUsage.cached_input_tokens,
    });
    if (c > 0) costUsd = c;
  }

  const durationMs =
    firstTsMs !== undefined && lastTsMs !== undefined && lastTsMs > firstTsMs
      ? lastTsMs - firstTsMs
      : undefined;

  const worktree = detectWorktree(cwd, gitBranch);
  const ticket = detectTicket(userTexts.join('\n') || undefined, gitBranch);

  return {
    sessionId,
    timestamp,
    cwd,
    gitBranch,
    version,
    topic,
    messageCount,
    tokenCount,
    outputTokens: lastTotalTokenUsage
      ? (lastTotalTokenUsage.output_tokens ?? 0) + (lastTotalTokenUsage.reasoning_output_tokens ?? 0)
      : undefined,
    costUsd,
    durationMs,
    lastActivity: lastTsMs !== undefined ? new Date(lastTsMs).toISOString() : undefined,
    contentText: userTexts.length > 0 ? userTexts.join('\n') : undefined,
    prUrl,
    prNumber,
    worktreeSlug: worktree?.slug,
    ticketId: ticket?.id,
    createdTickets: createdTickets.size > 0 ? [...createdTickets] : undefined,
    spawnedTeam,
  };
}

/** Resolve the working directory for an OpenClaw agent from its workspace config. */
function getOpenClawSessionCwd(agentId?: string): string {
  const workspace = agentId ? getOpenClawWorkspaceMap().get(agentId) : undefined;
  if (workspace) return workspace;

  const configDir = AGENTS.openclaw.configDir;
  return safeRealpathSync(configDir) || configDir;
}

/** Build a cached map of OpenClaw agent ID to workspace path from openclaw.json. */
function getOpenClawWorkspaceMap(): Map<string, string> {
  if (cachedOpenClawWorkspaces) return cachedOpenClawWorkspaces;

  const workspaces = new Map<string, string>();
  const configPath = path.join(AGENTS.openclaw.configDir, 'openclaw.json');
  if (!fs.existsSync(configPath)) {
    cachedOpenClawWorkspaces = workspaces;
    return workspaces;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      agents?: { list?: Array<{ id?: string; workspace?: string }> };
    };

    for (const agent of config.agents?.list || []) {
      if (!agent.id || !agent.workspace) continue;
      workspaces.set(agent.id, safeRealpathSync(agent.workspace) || agent.workspace);
    }
  } catch {
    // Ignore invalid OpenClaw config and fall back to ~/.openclaw.
  }

  cachedOpenClawWorkspaces = workspaces;
  return workspaces;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Compute the SHA-256 hex digest of a string. */
function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Stat a path, returning null on any error. */
function safeStatSync(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Resolve a path to its real path, returning null on any error. */
function safeRealpathSync(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Extract meaningful user text from a Claude JSONL user event, skipping meta and local-command messages. */
function extractClaudeUserText(parsed: any): string | undefined {
  if (parsed.isMeta === true) return undefined;

  const content = parsed.message?.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return isLocalCommandMessage(text) ? undefined : text || undefined;
  }

  if (!Array.isArray(content)) return undefined;

  const text = content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => String(block.text || '').trim())
    .find((value: string) => value && !value.startsWith('[Request interrupted'));

  if (!text || isLocalCommandMessage(text)) return undefined;
  return text;
}

/** Check whether a message is a local-command wrapper rather than real user input. */
function isLocalCommandMessage(text: string): boolean {
  return /<local-command-caveat>|<bash-(input|stdout|stderr)>/i.test(text);
}

/** Sum all token usage fields from a Claude assistant message's usage object. */
function getClaudeUsageTotal(usage: any): number | null {
  if (!usage || typeof usage !== 'object') return null;
  return sumKnownNumbers([
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ]);
}

/** Extract text from Codex message content blocks, filtering out system instructions for user messages. */
function extractCodexMessageText(contentBlocks: any, role: 'user' | 'assistant'): string | undefined {
  if (!Array.isArray(contentBlocks)) return undefined;

  const matches = role === 'user'
    ? contentBlocks.filter((block: any) => block.type === 'input_text')
    : contentBlocks.filter((block: any) => block.type === 'output_text');

  const text = matches
    .map((block: any) => String(block.text || '').trim())
    .find((value: string) => {
      if (!value) return false;
      if (role === 'user' && (value.length >= 2000 || value.includes('<permissions instructions>') || value.startsWith('# AGENTS.md instructions'))) {
        return false;
      }
      return true;
    });

  return text || undefined;
}

/** Trim and normalize a version string, returning undefined for empty values. */
function normalizeVersion(version?: string | null): string | undefined {
  const trimmed = version?.trim();
  return trimmed ? trimmed : undefined;
}

/** Extract the version number from a managed versions/<agent>/<version>/... path under either repo. */
function extractVersionFromManagedPath(agent: SessionAgentId, sourcePath?: string): string | undefined {
  if (!sourcePath) return undefined;

  const candidates = [sourcePath, safeRealpathSync(sourcePath) || ''];
  const markers = [`/.agents/versions/${agent}/`, `/.agents-system/versions/${agent}/`];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = candidate.split(path.sep).join('/');
    for (const marker of markers) {
      const start = normalized.indexOf(marker);
      if (start === -1) continue;
      const version = normalized.slice(start + marker.length).split('/')[0];
      if (version) return version;
    }
  }

  return undefined;
}

/** Resolve the current version of an agent CLI (symlink version or live CLI output, cached). */
async function getCurrentAgentVersion(agent: SessionAgentId): Promise<string | undefined> {
  const cached = cachedAgentVersions.get(agent);
  if (cached) return cached;

  const promise = (async () => {
    const symlinkVersion = normalizeVersion(getConfigSymlinkVersion(agent as AgentId));
    if (symlinkVersion) return symlinkVersion;
    return normalizeVersion(await getCliVersion(agent as AgentId));
  })();

  cachedAgentVersions.set(agent, promise);
  return promise;
}

/** Resolve a session's version: embedded in file > extracted from managed path > current CLI version. */
function resolveSessionVersion(
  agent: SessionAgentId,
  sourcePath: string | undefined,
  embeddedVersion?: string,
  currentVersion?: string,
): string | undefined {
  return normalizeVersion(embeddedVersion)
    || extractVersionFromManagedPath(agent, sourcePath)
    || normalizeVersion(currentVersion);
}

/** Sum all token usage fields from a Codex total_token_usage object. */
function getCodexTokenCount(totalTokenUsage: any): number | null {
  if (!totalTokenUsage || typeof totalTokenUsage !== 'object') return null;
  return sumKnownNumbers([
    totalTokenUsage.input_tokens,
    totalTokenUsage.cached_input_tokens,
    totalTokenUsage.output_tokens,
    totalTokenUsage.reasoning_output_tokens,
  ]);
}

/** Extract text from a Gemini message content field (string or array of parts). */
function extractGeminiMessageText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

/** Extract the total token count from a Gemini message's tokens object. */
function getGeminiTokenCount(tokens: any): number | null {
  if (!tokens || typeof tokens !== 'object') return null;
  if (typeof tokens.total === 'number') return tokens.total;
  return sumKnownNumbers([
    tokens.input,
    tokens.output,
    tokens.cached,
    tokens.thoughts,
    tokens.tool,
  ]);
}

/** Sum all numeric values in an array, returning null if none are valid numbers. */
function sumKnownNumbers(values: unknown[]): number | null {
  let total = 0;
  let found = false;

  for (const value of values) {
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    total += value;
    found = true;
  }

  return found ? total : null;
}

// ---------------------------------------------------------------------------
// Time range parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Kimi
// ---------------------------------------------------------------------------
// Kimi stores sessions under ~/.kimi-code/sessions/<workdir_hash>/session_<uuid>/.
// Each session has state.json (metadata) and agents/main/wire.jsonl (conversation).
// A session_index.jsonl at ~/.kimi-code/ maps session IDs to directories.

/** Incrementally re-scan changed Kimi session state.json files and upsert into the DB. */
async function scanKimiIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const filePaths: string[] = [];
  for (const sessionsDir of getAgentSessionDirs('kimi', 'sessions')) {
    if (!fs.existsSync(sessionsDir)) continue;
    let workDirNames: string[];
    try {
      workDirNames = fs.readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const workDirName of workDirNames) {
      const workDir = path.join(sessionsDir, workDirName);
      const stat = safeStatSync(workDir);
      if (!stat?.isDirectory()) continue;
      let sessionNames: string[];
      try {
        sessionNames = fs.readdirSync(workDir);
      } catch {
        continue;
      }
      for (const sessionName of sessionNames) {
        if (!sessionName.startsWith('session_')) continue;
        const statePath = path.join(workDir, sessionName, 'state.json');
        if (!fs.existsSync(statePath)) continue;
        filePaths.push(statePath);
      }
    }
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'kimi', parsed: 0, total: changed.length });

  const scanEntries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readKimiMeta(filePath);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        scanEntries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'kimi', parsed, total: changed.length });
  }

  upsertSessionsBatch(scanEntries);
  recordScans(touched);
}

/** Parse a single Kimi session state.json file to extract session metadata. */
export function readKimiMeta(filePath: string): { meta: SessionMeta; content: string } | null {
  let state: any;
  try {
    state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionDir = path.dirname(filePath);
  const sessionId = path.basename(sessionDir);
  if (!sessionId.startsWith('session_')) return null;

  const title = typeof state.title === 'string' ? state.title : undefined;
  const lastPrompt = typeof state.lastPrompt === 'string' ? state.lastPrompt : undefined;
  const topic = title || lastPrompt || undefined;

  const createdAt = typeof state.createdAt === 'string' ? state.createdAt : undefined;
  const updatedAt = typeof state.updatedAt === 'string' ? state.updatedAt : undefined;
  // Coerce to never-null, the same way every other parser does (Rush/Hermes/Droid/…):
  // a real createdAt/updatedAt still wins; otherwise fall back to the state.json mtime.
  // Kimi was the lone parser that could yield `undefined`, which binds NULL into
  // `timestamp TEXT NOT NULL` and aborts the whole batch index. mtime also matches how
  // the listing already ranks Kimi (last_activity resolves to the file mtime).
  const stat = safeStatSync(filePath);
  const timestamp = updatedAt || createdAt
    || (stat ? stat.mtime.toISOString() : new Date().toISOString());

  const shortId = sessionId.replace(/^session_/, '').slice(0, 8);

  // Try to infer project from session directory path
  // ~/.kimi-code/sessions/<workdir_hash>/session_<uuid>/
  const workDirName = path.basename(path.dirname(sessionDir));
  let project: string | undefined;
  if (workDirName.startsWith('wd_')) {
    const parts = workDirName.slice(3).split('_');
    if (parts.length >= 2) {
      project = parts.slice(0, -1).join('/');
    }
  }

  // Parse wire.jsonl to extract message count and token usage
  const { messageCount, tokenCount, outputTokens } = parseKimiWireMetrics(sessionDir);

  const meta: SessionMeta = {
    id: sessionId,
    shortId,
    agent: 'kimi',
    timestamp,
    project,
    filePath,
    topic,
    messageCount,
    tokenCount: tokenCount > 0 ? tokenCount : undefined,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
  };

  return { meta, content: lastPrompt || '' };
}

/** Parse Kimi's wire.jsonl to extract message count and token usage.
 * TODO: optimize to stream (like scanClaudeSession) to avoid loading large files into memory.
 * For now, synchronous readFileSync matches the pattern of reading state.json and is acceptable
 * since session dirs are usually fresh in FS cache during incremental scans. */
function parseKimiWireMetrics(sessionDir: string): { messageCount: number; tokenCount: number; outputTokens: number } {
  const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  let messageCount = 0;
  let tokenCount = 0;
  let outputTokens = 0;

  if (!fs.existsSync(wirePath)) {
    return { messageCount: 0, tokenCount: 0, outputTokens: 0 };
  }

  try {
    const lines = fs.readFileSync(wirePath, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'context.append_message') {
          messageCount++;
        } else if (event.type === 'usage.record' && event.usage) {
          // Kimi usage structure: inputOther + output + inputCacheRead + inputCacheCreation
          const u = event.usage;
          tokenCount += (u.inputOther || 0) + (u.output || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
          outputTokens += (u.output || 0);
        }
      } catch {
        // Malformed line, skip
      }
    }
  } catch {
    // If wire.jsonl can't be read, return 0s (graceful degradation)
  }

  return { messageCount, tokenCount, outputTokens };
}

/**
 * Scan Grok sessions. Grok stores one directory per session under
 * ~/.grok/sessions/<url-encoded-cwd>/<uuid>/, each holding a summary.json with
 * structured metadata (id, cwd, title, timestamps, message count). Same
 * dir-per-session (L3) shape as Kimi, so it walks two levels and gates the
 * summary.json read through the scan ledger. Before this, Grok had a type slot
 * and a placeholder parser but no scanner, so `agents sessions` never indexed it.
 */
async function scanGrokIncremental(onProgress?: (p: ScanProgress) => void): Promise<void> {
  const currentVersion = await getCurrentAgentVersion('grok');

  const filePaths: string[] = [];
  for (const sessionsDir of getAgentSessionDirs('grok', 'sessions')) {
    if (!fs.existsSync(sessionsDir)) continue;
    let cwdDirNames: string[];
    try {
      cwdDirNames = fs.readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const cwdDirName of cwdDirNames) {
      const cwdDir = path.join(sessionsDir, cwdDirName);
      const stat = safeStatSync(cwdDir);
      if (!stat?.isDirectory()) continue;
      let sessionNames: string[];
      try {
        sessionNames = fs.readdirSync(cwdDir);
      } catch {
        continue;
      }
      for (const sessionName of sessionNames) {
        const summaryPath = path.join(cwdDir, sessionName, 'summary.json');
        if (!fs.existsSync(summaryPath)) continue;
        filePaths.push(summaryPath);
      }
    }
  }

  const changed = filterChangedFiles(filePaths);
  if (changed.length === 0) return;

  onProgress?.({ agent: 'grok', parsed: 0, total: changed.length });

  const scanEntries: ScanEntry[] = [];
  const touched: Array<{ filePath: string; scan: ScanStamp }> = [];
  const seen = new Set<string>();
  let parsed = 0;
  for (const { filePath, scan } of changed) {
    try {
      const result = readGrokMeta(filePath, currentVersion);
      if (result && !seen.has(result.meta.id)) {
        seen.add(result.meta.id);
        scanEntries.push({ meta: result.meta, content: result.content, scan });
      } else {
        touched.push({ filePath, scan });
      }
    } catch {
      touched.push({ filePath, scan });
    }
    parsed++;
    onProgress?.({ agent: 'grok', parsed, total: changed.length });
  }

  upsertSessionsBatch(scanEntries);
  recordScans(touched);
}

/** Parse a single Grok session summary.json into session metadata. */
export function readGrokMeta(
  filePath: string,
  currentVersion?: string,
): { meta: SessionMeta; content: string } | null {
  let summary: any;
  try {
    summary = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }

  const sessionDir = path.dirname(filePath);
  // The uuid directory name is the canonical id; summary.info.id mirrors it.
  const sessionId =
    (typeof summary?.info?.id === 'string' && summary.info.id) || path.basename(sessionDir);
  if (!sessionId) return null;

  const cwd = normalizeCwd(typeof summary?.info?.cwd === 'string' ? summary.info.cwd : '');
  const topic =
    (typeof summary?.generated_title === 'string' && summary.generated_title.trim()) ||
    (typeof summary?.session_summary === 'string' && summary.session_summary.trim()) ||
    undefined;

  // created_at is the session start; last_active_at/updated_at is the latest
  // activity. Coerce timestamp to never-null (NOT NULL column) via the file mtime,
  // matching how the other dir-per-session parsers (Kimi) fall back.
  const createdAt = typeof summary?.created_at === 'string' ? summary.created_at : undefined;
  const lastActivity =
    (typeof summary?.last_active_at === 'string' && summary.last_active_at) ||
    (typeof summary?.updated_at === 'string' && summary.updated_at) ||
    undefined;
  const stat = safeStatSync(filePath);
  const timestamp =
    createdAt || lastActivity || (stat ? stat.mtime.toISOString() : new Date().toISOString());

  const messageCount =
    typeof summary?.num_chat_messages === 'number'
      ? summary.num_chat_messages
      : typeof summary?.num_messages === 'number'
        ? summary.num_messages
        : undefined;

  // Grok records its managed home in summary.grok_home
  // (…/versions/grok/<version>/home/.grok) — recover the version from it.
  let embeddedVersion: string | undefined;
  if (typeof summary?.grok_home === 'string') {
    embeddedVersion = summary.grok_home.match(/versions\/grok\/([^/]+)\//)?.[1];
  }

  const meta: SessionMeta = {
    id: sessionId,
    shortId: sessionId.slice(0, 8),
    agent: 'grok',
    timestamp,
    lastActivity,
    project: cwd ? path.basename(cwd) : undefined,
    cwd: cwd || undefined,
    filePath,
    version: resolveSessionVersion('grok', filePath, embeddedVersion, currentVersion),
    topic,
    messageCount,
  };

  return { meta, content: topic || '' };
}

/** Parse a time filter string (relative like '7d' or ISO timestamp) into epoch milliseconds. */
export function parseTimeFilter(input: string): number {
  // Units: m=minute, h=hour, d=day, w=week, mo=month(30d), y=year(365d). `mo`
  // must precede the single-letter alternatives so "1mo" isn't read as "1m"+"o".
  const relativeMatch = input.match(/^(\d+)(mo|[mhdwy])$/i);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    if (unit === 'm') return Date.now() - value * 60_000;
    if (unit === 'h') return Date.now() - value * 3_600_000;
    if (unit === 'd') return Date.now() - value * 86_400_000;
    if (unit === 'w') return Date.now() - value * 7 * 86_400_000;
    if (unit === 'mo') return Date.now() - value * 30 * 86_400_000;
    if (unit === 'y') return Date.now() - value * 365 * 86_400_000;
  }
  const ts = new Date(input).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}
