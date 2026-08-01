/**
 * Active-session detection across every context an agent can run in:
 *
 *   - `terminal` — agents launched from VS Code / Cursor / Codium via the
 *     agents-cli extension. Published to `~/.agents/.cache/terminals/live-terminals.json`
 *     with PID + session UUID per entry.
 *   - `teams`    — agents spawned by `agents teams add`, tracked in
 *     `~/.agents/teams/agents/<id>/meta.json` with a PID the manager polls.
 *   - `cloud`    — dispatched to Rush / Codex Cloud / Factory, tracked in
 *     the SQLite cache at `~/.agents/cloud/tasks.db`.
 *   - `headless` — bare `claude` / `codex` / `gemini` / `cursor-agent` /
 *     `opencode` processes that don't belong to any of the above. Detected
 *     by `ps` minus the PIDs we've already attributed.
 *
 * `running` vs `idle` is a secondary classification within the alive set:
 * the process is holding its session file, but the file's mtime is older
 * than ACTIVE_MTIME_WINDOW_MS, so it's probably waiting on the user.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { listActiveTasks } from '../cloud/store.js';
import type { CloudTaskStatus } from '../cloud/types.js';
import { AgentManager } from '../teams/agents.js';
import { getTerminalsDir } from '../state.js';
import { readPidSessionEntry, listPidSessionEntries, prunePidSessionRegistry, type PidSessionEntry } from './pid-registry.js';
import { loadHookSessionIndex, resolveHookSessionRecord, type HookSessionIndex, type HookSessionRecord } from './hook-sessions.js';
import { buildClaudeLabelMap } from './discover.js';
import { buildRunNameMap } from './run-names.js';
import { latestSessionFileForCwd } from './db.js';
import { extractSessionTopic } from './prompt.js';
import { readSessionTailWithRaw } from './tail.js';
import { computeTokPerSec } from './throughput.js';
import { inferSessionState, type SessionState, type SessionActivity, type AwaitingReason, type StructuredQuestion, type TodoProgress, type DetectedPr, type DetectedWorktree, type DetectedTicket } from './state.js';
import type { SessionAttachment } from './types.js';
import { detectProvenance, type SessionProvenance } from './provenance.js';
import { loadDevices, type DeviceRegistry } from '../devices/registry.js';
import { presenceFromStore, type Presence } from './detached.js';
import { mapBounded } from '../concurrency.js';

const execFileAsync = promisify(execFile);

/**
 * Per-PID `lsof` probes run bounded and staggered rather than as one parallel
 * fan-out: a simultaneous system-wide `lsof` burst reads to behavioral EDR
 * (CrowdStrike Falcon) as lateral-movement recon. Results are identical — the
 * cwds are just gathered at a bounded spawn rate instead of a single burst.
 */
export const LSOF_CONCURRENCY = 4;
const LSOF_STAGGER_MS = 10;

/**
 * Hard ceilings on the two syscalls the status path shells out to. Without them
 * a single hung probe (a wedged NFS `lsof`, an EDR that stalls the `ps` snapshot)
 * pins a bounded worker slot forever and silently drops live sessions to a
 * fallback status. On timeout the call rejects, is caught, and the row degrades
 * honestly (unknown / empty table) instead of the sweep hanging.
 */
const LSOF_TIMEOUT_MS = 5_000;
const PS_SNAPSHOT_TIMEOUT_MS = 10_000;

export type ActiveContext = 'terminal' | 'teams' | 'cloud' | 'headless';

/**
 * `unknown` = the process is alive but we cannot introspect what it is doing —
 * a live harness whose transcript format we do not parse (everything but
 * claude/codex), or a resolvable transcript whose `stat` momentarily failed. It
 * is NOT a synonym for idle: idle is a positive "not mid-turn, not waiting on
 * you" conclusion drawn from a readable transcript; unknown is the honest "we
 * can't tell", which we refuse to fake as idle.
 */
export type ActiveStatus = 'running' | 'idle' | 'queued' | 'input_required' | 'unknown';

export interface ActiveSession {
  context: ActiveContext;
  kind: string;
  /** Specific host app — 'code', 'cursor', 'codium', 'iterm', 'terminal', 'warp', 'tmux', etc. */
  host?: string;
  pid?: number;
  sessionId?: string;
  cwd?: string;
  /** User-given name from /rename command. */
  label?: string;
  /** Durable `agents run --name` launch handle, when the run was named. */
  name?: string;
  /** First meaningful line of the initial prompt (extracted topic). */
  topic?: string;
  /** Live preview: the latest turn (agent message or tool action), from the state engine. */
  preview?: string;
  /** Inferred activity: working / waiting_input / idle (from the transcript tail). */
  activity?: SessionActivity;
  /**
   * Output-token throughput (tokens/sec) over a rolling 60s window, from the
   * transcript tail. The number the Factory Floor shows next to a running agent;
   * absent when no transcript is resolvable or the agent format reports no usage.
   */
  tokPerSec?: number;
  /** Why the agent is waiting, when activity is waiting_input. */
  awaitingReason?: AwaitingReason;
  /** The structured decision (question/plan/permission + options) the agent is waiting on. */
  question?: StructuredQuestion;
  /**
   * Plan markdown from the last `ExitPlanMode` tool call. Present when the
   * transcript ever entered plan-review; `awaitingReason === 'plan_review'`
   * says whether it is still pending.
   */
  plan?: string;
  /**
   * Live plan progress from the most recent `TodoWrite` (RUSH-1380): the checklist
   * items + a done/total tally + the current step. The Factory Floor renders this
   * as an N/M pill + checklist for every session — including remote and
   * device-dispatched agents that have no local tool-call stream to parse.
   */
  todos?: TodoProgress;
  /** Last few assistant turns (most-recent last), for at-a-glance context in the UI. */
  tail?: string[];
  /** PR opened during the session. */
  pr?: DetectedPr;
  /** Worktree the session runs in. */
  worktree?: DetectedWorktree;
  /** Tracker ticket the session is tied to. */
  ticket?: DetectedTicket;
  /** Per-session rate/usage limit detected in the transcript (RUSH-1523). */
  rateLimited?: boolean;
  /** Tracker refs the session CREATED (Linear create_issue / gh issue create). */
  createdTickets?: string[];
  /** Team name the session SPAWNED via `agents teams create/add`. */
  spawnedTeam?: string;
  /** Files/screenshots attached to the session prompt. */
  attachments?: SessionAttachment[];
  sessionFile?: string;
  startedAtMs?: number;
  /**
   * Last-activity epoch — the transcript's last write (mtime). Distinct from
   * {@link startedAtMs} (session START): a session begun 3h ago but last touched
   * 20s ago has an old start and a fresh last-activity. The Floor renders "Xs ago"
   * off this so an idle-but-old session doesn't read as freshly active.
   */
  lastActivityMs?: number;
  status: ActiveStatus;
  /**
   * Foreground/background presence for the detach/attach model:
   *   `attached`   — live interactive TUI you're watching;
   *   `background` — detached: running headless, unattended (via `agents sessions detach`);
   *   `parked`     — the headless continuation has exited; the transcript is durable.
   * Absent for ad-hoc headless runs and cloud/team rows, which aren't on the
   * foreground/background axis. Folded on at the end of {@link getActiveSessions}
   * from the detach store — never asserted by a source.
   */
  presence?: Presence;
  /** How many live PIDs resolve to this same session (subagents/forks). 1 unless collapsed. */
  pidCount?: number;
  /**
   * Where the process actually lives — machine host, local vs SSH, tmux pane,
   * and whether a rail exists to type back into it. Read from the process env
   * (`/proc/<pid>/environ` on Linux, `ps eww` on macOS) during enrichment.
   * Absent for cloud sessions (no local pid) and any pid whose env is unreadable.
   */
  provenance?: SessionProvenance;
  /**
   * The machine this session runs on, as a normalized device id (machineId()
   * form). Set when merging cross-machine results so the grouped `--active`
   * view can bucket by computer. Absent for a purely local query (the renderer
   * falls back to provenance.host, then the local machine).
   */
  machine?: string;
  teamName?: string;
  agentId?: string;
  cloudProvider?: string;
  cloudTaskId?: string;
  cloudStatus?: string;
  /**
   * IDE window that owns this terminal. Source of truth is the per-window
   * slice key in `live-terminals.json` (computeWindowId in the swarmify
   * extension): `${vscode.env.sessionId}-${extension-host pid}`. Lets the
   * renderer cluster terminals that belong to the same IDE window even when
   * two windows have the same cwd open. Only populated for `terminal` context.
   */
  windowId?: string;
  /**
   * Controlling TTY of the agent process (e.g. 'ttys003'), from the `ps -A`
   * read. macOS/Linux terminal sessions only; '??'/none normalized to undefined.
   * A disambiguation bridge (and the basis for future terminal addressing).
   */
  tty?: string;
  /**
   * Ghostty tab index (1-based) the session is shown in, when it can be matched
   * to a Ghostty surface by working directory (+ title). Transient, populated by
   * the renderer just before printing — NOT part of the pure discovery path.
   */
  ghosttyTab?: number;
  /**
   * Resolved tmux attach target (`session:window.pane`) for a tmux-hosted local
   * session, from the pane id via `mapPanesToTargets`. Transient, renderer-set
   * (after the --json/--waiting gates) — NOT emitted on the discovery path.
   */
  tmuxTarget?: string;
  /**
   * Which host app + tab a tmux-hosted session is currently being VIEWED in,
   * resolved from the attached tmux client (its terminal PID -> app via
   * HOST_MATCHERS, its tab via the per-app resolver). `undefined` means no
   * client is attached — the session is running detached. Transient,
   * renderer-set (see src/lib/session/viewing-in.ts) — NOT on the discovery path.
   */
  viewingIn?: { app: string; tab?: number };
}

export function activeStatusFromCloudStatus(status: CloudTaskStatus): ActiveStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'idle':
      return 'idle';
    case 'input_required':
      return 'input_required';
    default:
      return 'queued';
  }
}

export interface ActiveQueryOptions {
  /** Skip the `ps` scan for ad-hoc headless agents. */
  skipHeadless?: boolean;
}

const HOME = os.homedir();
const LIVE_TERMINALS_FILE = path.join(getTerminalsDir(), 'live-terminals.json');

/**
 * A process is classified `running` if its session file was touched in the
 * last 2 minutes. Every Claude/Codex tool-call appends an event, so a
 * healthy session writes several times a minute.
 */
const ACTIVE_MTIME_WINDOW_MS = 2 * 60_000;

/**
 * A live process can only borrow an indexed session file if that transcript
 * has been touched recently enough to plausibly belong to the process. This is
 * deliberately wider than ACTIVE_MTIME_WINDOW_MS: an inactive-but-live CLI can
 * be idle for longer than 2 minutes, but it must not attach to a weeks-old
 * transcript just because a GUI app service with the same basename is alive.
 */
export const ACTIVE_SESSION_STALE_MS = 24 * 60 * 60_000;

/** Executables we recognize as agent CLIs when scanning the process table. */
const AGENT_CLI_NAMES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  'cursor-agent': 'cursor',
  opencode: 'opencode',
  droid: 'droid',
};

/**
 * Resolve an agent kind from a process's reported executable. `comm` may be an
 * absolute path (shim-launched agents), and Windows image names carry an
 * `.exe` suffix (`claude.exe`), so basename + suffix-strip before the lookup.
 */
export function agentKindFromComm(commRaw: string): string | undefined {
  // A GUI desktop app can bundle a binary with the SAME name as an agent CLI: the
  // Codex desktop app ships `/Applications/Codex.app/Contents/Resources/codex` (its
  // `app-server`), whose basename `codex` would otherwise match the codex CLI and
  // surface the app's background server as a phantom agent session — running at cwd
  // '/', so it shows up unattributed in the feed. A real agent CLI is never inside a
  // `.app` bundle, so exclude those. (The Claude desktop app is a separate case,
  // already excluded by name below: its process is 'Claude', not the CLI's 'claude'.)
  if (commRaw.includes('.app/Contents/')) return undefined;
  const base = path.basename(commRaw);
  const stripped = base.replace(/\.exe$/i, '');
  // Windows image names compare case-insensitively; POSIX comms stay exact —
  // macOS's Claude desktop app process is named 'Claude' and must NOT match.
  const key = stripped === base ? base : stripped.toLowerCase();
  return AGENT_CLI_NAMES[key];
}

/**
 * A process that began more than this long AFTER a session's recorded
 * `startedAtMs` cannot be that session's process — the OS handed its pid to
 * something newer. The window absorbs clock granularity (`ps -o lstart=` reports
 * whole seconds) and the gap between a process spawning and the SessionStart
 * hook recording `startedAtMs`; it is far below the minutes-to-hours it takes the
 * pid space to wrap and actually recycle a pid, so it never false-kills a live
 * session.
 */
const PID_REUSE_TOLERANCE_MS = 60_000;

/**
 * Epoch-ms start time of the process at `pid`, or null if unknowable.
 *
 * Distinct from teams/agents.ts's `captureProcessStartTime`, which returns an
 * opaque token only meaningful for equality against a prior capture of the SAME
 * pid. Here we need a value comparable to a session's `startedAtMs`, so we read
 * `ps -o lstart=` — a ctime string on both macOS and Linux — and parse it to
 * epoch ms. Windows and any exec/parse failure return null, so the caller falls
 * back to a bare existence check (never worse than before).
 */
function processStartMs(pid: number): number | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * True when `pid` names a live process AND — when a session's recorded
 * `startedAtMs` is supplied — that process is plausibly the SAME one, not a later
 * process that recycled the pid. The OS reuses pids, so a bare
 * `process.kill(pid, 0)` existence check reports a dead session as alive (a
 * "zombie") once its pid is handed to an unrelated process. A genuine session
 * process starts at or before its own recorded start, so a process that began
 * meaningfully AFTER `startedAtMs` is a reused pid and the session is dead. When
 * the start time can't be read, we keep the existence answer.
 */
export function isPidAlive(pid: number, startedAtMs?: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    // EPERM means the pid exists but is owned by another user — still "alive",
    // fall through to the identity check. Any other error means no such process.
    if (err?.code !== 'EPERM') return false;
  }
  if (startedAtMs && startedAtMs > 0) {
    const procStartMs = processStartMs(pid);
    if (procStartMs !== null && procStartMs > startedAtMs + PID_REUSE_TOLERANCE_MS) {
      return false; // pid recycled by a newer process — this session is gone
    }
  }
  return true;
}

interface LiveTerminalEntry {
  sessionId: string;
  pid: number;
  kind: string;
  label?: string | null;
  cwd?: string | null;
  startedAtMs: number;
  /** Slice key from the registry — the IDE window that owns this terminal. */
  windowId?: string;
}

/** Read the live-terminals registry, dedupe by sessionId, keep only pid-alive entries. */
function readLiveTerminals(): LiveTerminalEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(LIVE_TERMINALS_FILE, 'utf8');
  } catch {
    return [];
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];

  const merged = new Map<string, LiveTerminalEntry>();
  for (const [windowId, slice] of Object.entries(parsed) as [string, any][]) {
    for (const e of (slice?.entries ?? []) as LiveTerminalEntry[]) {
      if (!e?.sessionId || !isPidAlive(e.pid, e.startedAtMs)) continue;
      merged.set(e.sessionId, { ...e, windowId });
    }
  }
  return Array.from(merged.values());
}

/** Convert an absolute cwd to the Claude-project folder name (slashes and dots → dashes). */
function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Locate the active Claude session file for a process. If we know the session
 * UUID (from terminal env or team parent), prefer the exact match. Otherwise
 * fall back to the most-recent-mtime .jsonl in the project's folder.
 */
function findClaudeSessionFile(cwd: string, sessionId?: string): string | undefined {
  return pickSessionFile(path.join(HOME, '.claude', 'projects', claudeProjectDirName(cwd)), sessionId);
}

/**
 * Pick a Claude transcript file within a project dir.
 *
 * With a CONCRETE session id: return that id's `<id>.jsonl` or undefined — NEVER a
 * sibling's. Falling back to the newest file here is the bug that made N distinct
 * co-located sessions (e.g. several editor tabs in one cwd, or two worktree siblings)
 * all collapse onto ONE file and render identical preview + topic (they look like
 * duplicate cards). The mtime fallback is only sound when NO id is known.
 *
 * With NO id: return the newest `.jsonl` by mtime (the legitimate single-session
 * heuristic for a directly-launched agent with no registry entry).
 */
export function pickSessionFile(projectDir: string, sessionId?: string): string | undefined {
  if (sessionId) {
    const specific = path.join(projectDir, `${sessionId}.jsonl`);
    return fs.existsSync(specific) ? specific : undefined;
  }

  let files: string[];
  try {
    files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }

  let best: { path: string; mtime: number } | null = null;
  for (const f of files) {
    const p = path.join(projectDir, f);
    try {
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.mtime) best = { path: p, mtime: m };
    } catch { /* file vanished between readdir and stat */ }
  }
  return best?.path;
}

/**
 * One `stat` → the transcript's creation (≈ session start) and last-write (≈ last
 * activity) epochs. Both `undefined` when the file can't be stat'd (vanished /
 * unresolved). `birthtimeMs` can be 0 on filesystems without creation time — coerce
 * that to `undefined` so callers fall through to a real signal instead of epoch 0.
 */
export function sessionFileTimes(sessionFile: string | undefined): { birthtimeMs?: number; mtimeMs?: number } {
  if (!sessionFile) return {};
  try {
    const st = fs.statSync(sessionFile);
    return { birthtimeMs: st.birthtimeMs || undefined, mtimeMs: st.mtimeMs || undefined };
  } catch {
    return {};
  }
}

/**
 * The ONE place a fallback status is decided when no rich transcript state is
 * available — a non-Claude/Codex kind we cannot parse, or a Claude/Codex tail
 * that was empty or unreadable. Honest by construction: it never asserts a status
 * it cannot justify from a measured signal.
 *
 *   - Resolvable transcript, readable mtime → the MEASURED freshness signal:
 *     written within ACTIVE_MTIME_WINDOW_MS ⇒ `running`, else `idle`.
 *   - Resolvable transcript whose `stat` throws (file vanished / permission) → we
 *     genuinely cannot tell ⇒ `unknown`. (This branch previously returned
 *     `running`, which contradicted the `idle` default one branch up.)
 *   - No resolvable transcript but the process is alive → alive-but-opaque ⇒
 *     `unknown`. This is the truthful answer for a live gemini / droid / cursor /
 *     opencode whose format we don't parse — NOT a fabricated `idle` (which the
 *     UI reads as "done and waiting"), and it never lies as `running` either.
 *   - No transcript and the process is not known alive → nothing to report ⇒ `idle`.
 */
export function resolveFallbackStatus(sessionFile: string | undefined, pidAlive: boolean): ActiveStatus {
  if (!sessionFile) return pidAlive ? 'unknown' : 'idle';
  try {
    const mtimeMs = fs.statSync(sessionFile).mtimeMs;
    return Date.now() - mtimeMs < ACTIVE_MTIME_WINDOW_MS ? 'running' : 'idle';
  } catch {
    return 'unknown';
  }
}

/**
 * Locate the live transcript for an agent process. Claude files are keyed by
 * cwd (+ optional session uuid); Codex files are date-partitioned, so we resolve
 * the newest indexed Codex session for the cwd instead.
 */
export function findSessionFileForKind(kind: string, cwd?: string, sessionId?: string): string | undefined {
  if (!cwd) return undefined;
  if (kind === 'claude') return findClaudeSessionFile(cwd, sessionId);
  if (kind === 'codex') return latestSessionFileForCwd('codex', cwd, { maxAgeMs: ACTIVE_SESSION_STALE_MS });
  return undefined;
}

/** Recover the session UUID from a transcript filename (Claude `<uuid>.jsonl`, Codex `rollout-…-<uuid>.jsonl`). */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function sessionIdFromFile(file?: string): string | undefined {
  if (!file) return undefined;
  return path.basename(file).match(UUID_RE)?.[0];
}

/** Live per-session signals derived from one transcript-tail read. */
interface LiveSignals {
  /** Rich inferred state (activity/preview/badges). Undefined when unreadable. */
  state?: SessionState;
  /** Rolling output-token throughput (tokens/sec). Undefined when no usage in the tail. */
  tokPerSec?: number;
}

/**
 * Read a session file's tail ONCE and derive both the inferred state and the
 * output-token throughput from it. State needs the normalized event model;
 * throughput needs the raw lines the event model drops (Codex `token_count`), so
 * both come off the same {@link readSessionTailWithRaw} read. Only Claude/Codex
 * carry live state; other kinds yield an empty signal set.
 */
function computeLiveSignals(kind: string, sessionFile: string | undefined, cwd: string | undefined, pidAlive: boolean): LiveSignals {
  if (!sessionFile) return {};
  const agent = kind === 'codex' ? 'codex' : 'claude';
  const { events, content } = readSessionTailWithRaw(sessionFile, agent);
  if (events.length === 0) return {};
  let mtimeMs: number | undefined;
  try { mtimeMs = fs.statSync(sessionFile).mtimeMs; } catch { /* vanished between calls */ }
  const state = inferSessionState(events, { cwd, pidAlive, mtimeMs, activeWindowMs: ACTIVE_MTIME_WINDOW_MS });
  const tokPerSec = computeTokPerSec(content, agent);
  return { state, tokPerSec: tokPerSec > 0 ? tokPerSec : undefined };
}

/** Map inferred activity onto the coarse ActiveStatus used by the renderer and counts. */
function statusFromActivity(activity: SessionActivity): ActiveStatus {
  return activity === 'working' ? 'running' : activity === 'waiting_input' ? 'input_required' : 'idle';
}

/**
 * Fold a computed SessionState onto an active-session row: rich status +
 * preview + PR/worktree/ticket badges. With no state (unreadable/non-Claude/
 * Codex file) it degrades to {@link resolveFallbackStatus}, which needs
 * `pidAlive` to tell an alive-but-opaque process (`unknown`) from a dead one
 * (`idle`).
 */
function applyState(base: Omit<ActiveSession, 'status'>, state: SessionState | undefined, fallbackFile: string | undefined, pidAlive: boolean): ActiveSession {
  if (!state) return { ...base, status: resolveFallbackStatus(fallbackFile, pidAlive) };
  return {
    ...base,
    status: statusFromActivity(state.activity),
    activity: state.activity,
    awaitingReason: state.awaitingReason,
    question: state.question,
    plan: state.plan,
    todos: state.todos,
    tail: state.tail,
    // Prefer the live preview (latest turn); keep the first-prompt topic as a fallback.
    preview: state.preview ?? base.preview,
    pr: state.pr,
    worktree: state.worktree,
    ticket: state.ticket,
    createdTickets: state.createdTickets,
    spawnedTeam: state.spawnedTeam,
    attachments: state.attachments,
    rateLimited: state.rateLimited,
  };
}

/**
 * Extract the first user message's content from a Claude JSONL file.
 * Reads only the first ~50 lines for speed, since the user message is
 * typically near the top (after system/queue events).
 */
function extractClaudeUserText(parsed: any): string | undefined {
  const msg = parsed.message;
  if (!msg?.content) return undefined;
  const content = Array.isArray(msg.content) ? msg.content : [msg.content];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') texts.push(block);
    else if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.join('\n').trim() || undefined;
}

function quickExtractTopic(sessionFile: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(sessionFile, 'r');
  } catch {
    return undefined;
  }

  try {
    const chunkSize = 256 * 1024;
    const maxBytes = 2 * 1024 * 1024;
    let buffer = '';
    let totalRead = 0;
    let linesChecked = 0;
    const maxLines = 30;

    while (totalRead < maxBytes && linesChecked < maxLines) {
      const chunk = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(fd, chunk, 0, chunkSize, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
      buffer += chunk.toString('utf8', 0, bytesRead);

      let lineStart = 0;
      let lineEnd: number;
      while ((lineEnd = buffer.indexOf('\n', lineStart)) !== -1 && linesChecked < maxLines) {
        const line = buffer.slice(lineStart, lineEnd);
        lineStart = lineEnd + 1;
        linesChecked++;

        if (!line.trim()) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        if (parsed.type === 'user') {
          const text = extractClaudeUserText(parsed);
          if (text) {
            const topic = extractSessionTopic(text);
            if (topic) return topic;
          }
        }
      }
      buffer = buffer.slice(lineStart);
    }
  } finally {
    fs.closeSync(fd);
  }

  return undefined;
}

/** Live teams teammates. Reuses AgentManager which already polls PIDs via `kill -0`. */
export async function listTeamsActive(): Promise<ActiveSession[]> {
  const mgr = new AgentManager();
  const running = await mgr.listRunning();
  return running.map((a): ActiveSession => {
    const sessionId = a.parentSessionId ?? a.remoteSessionId ?? undefined;
    const sessionFile = findSessionFileForKind(a.agentType, a.cwd ?? undefined, sessionId ?? undefined);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const pidAlive = a.pid ? isPidAlive(a.pid) : true;
    const { state, tokPerSec } = computeLiveSignals(a.agentType, sessionFile, a.cwd ?? undefined, pidAlive);
    return applyState({
      context: 'teams',
      kind: a.agentType,
      pid: a.pid ?? undefined,
      sessionId: sessionId ?? sessionIdFromFile(sessionFile),
      cwd: a.cwd ?? undefined,
      label: a.name ?? undefined,
      topic,
      tokPerSec,
      sessionFile,
      startedAtMs: a.startedAt.getTime(),
      lastActivityMs: sessionFileTimes(sessionFile).mtimeMs,
      teamName: a.taskName,
      agentId: a.agentId,
    }, state, sessionFile, pidAlive);
  });
}

/** Live editor-terminal agents across every IDE window. */
export async function listTerminalsActive(): Promise<ActiveSession[]> {
  const entries = readLiveTerminals();
  if (entries.length === 0) return [];

  // Walk the shell PIDs through the process table once so we can name the host
  // (code / cursor / codium) per entry rather than a generic 'terminal'.
  const procByPid = new Map<number, ProcRow>();
  for (const r of await readProcessTable()) procByPid.set(r.pid, r);

  // Build label map from Claude's sessions/*.json for /rename support
  const labelMap = buildClaudeLabelMap();
  // Run-name handles (`agents run --name`) keyed by session id, for the same
  // sessionId → handle resolution as labels.
  const runNameMap = buildRunNameMap();

  return entries.map((t): ActiveSession => {
    // The id cached in live-terminals.json goes stale when Claude rotates its
    // transcript uuid on resume/compact, so it often no longer matches any
    // <id>.jsonl. When the pid registry knows this pid's current id, prefer it —
    // the same source the headless path uses. NOTE: live-terminals.json stores the
    // SHELL pid, while the by-pid registry is keyed by the AGENT pid, so for
    // editor-launched terminals this lookup returns undefined today and we fall
    // back to the stale cached id — the duplicate-card fix comes from
    // pickSessionFile no longer borrowing a sibling, not from this lookup. Kept as
    // a forward-looking hook for the cases where the pid does line up.
    const resolvedId = readPidSessionEntry(t.pid)?.sessionId ?? t.sessionId;
    const sessionFile = findSessionFileForKind(t.kind, t.cwd ?? undefined, resolvedId);
    // Prefer label from live terminal, fall back to Claude's session label
    const label = t.label ?? (t.sessionId ? labelMap.get(t.sessionId) : undefined) ?? undefined;
    // Durable run name from `agents run --name`, resolved by the run's session id.
    const name = resolvedId ? runNameMap.get(resolvedId) ?? undefined : undefined;
    // Extract topic from session file (first meaningful user message)
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const pidAlive = isPidAlive(t.pid, t.startedAtMs);
    const { state, tokPerSec } = computeLiveSignals(t.kind, sessionFile, t.cwd ?? undefined, pidAlive);
    return applyState({
      context: 'terminal',
      kind: t.kind,
      host: detectHost(t.pid, procByPid),
      tty: procByPid.get(t.pid)?.tty,
      pid: t.pid,
      sessionId: t.sessionId ?? sessionIdFromFile(sessionFile),
      cwd: t.cwd ?? undefined,
      label,
      name,
      topic,
      tokPerSec,
      sessionFile,
      startedAtMs: t.startedAtMs,
      lastActivityMs: sessionFileTimes(sessionFile).mtimeMs,
      windowId: t.windowId,
    }, state, sessionFile, pidAlive);
  });
}

/** Cloud tasks still in a non-terminal state. `tasks.db` may not exist; that's fine. */
export function listCloudActive(): ActiveSession[] {
  let tasks;
  try {
    tasks = listActiveTasks();
  } catch {
    return [];
  }
  return tasks.map((t): ActiveSession => ({
    context: 'cloud',
    kind: t.agent || 'cloud',
    label: t.prompt.length > 60 ? t.prompt.slice(0, 57) + '...' : t.prompt,
    startedAtMs: Date.parse(t.createdAt) || undefined,
    status: activeStatusFromCloudStatus(t.status),
    cloudProvider: t.provider,
    cloudTaskId: t.id,
    cloudStatus: t.status,
  }));
}

interface ProcRow { pid: number; ppid: number; tty?: string; comm: string; kind?: string; }

/**
 * Ordered ancestor-process matchers. First match wins (most specific to least),
 * so an IDE renderer is preferred over the terminal-app that launched the IDE,
 * and a terminal-app is preferred over the multiplexer inside it.
 */
const HOST_MATCHERS: Array<{ host: string; tokens: string[] }> = [
  // IDE renderers (Electron helper processes on macOS, image names on Windows)
  { host: 'code',     tokens: ['Code Helper', 'Code - Insiders Helper', 'Code.exe'] },
  { host: 'cursor',   tokens: ['Cursor Helper', 'Cursor.exe'] },
  { host: 'codium',   tokens: ['VSCodium Helper', 'VSCodium.exe'] },
  { host: 'windsurf', tokens: ['Windsurf Helper', 'Windsurf.exe'] },
  // Native terminal apps
  { host: 'iterm',    tokens: ['iTerm2', 'iTermServer', 'iTerm'] },
  { host: 'terminal', tokens: ['Terminal.app', '/Applications/Utilities/Terminal.app', 'WindowsTerminal.exe'] },
  { host: 'warp',     tokens: ['Warp.app', 'stable_'] },
  { host: 'alacritty',tokens: ['alacritty', 'Alacritty'] },
  { host: 'kitty',    tokens: ['kitty'] },
  { host: 'hyper',    tokens: ['Hyper.app', 'Hyper Helper'] },
  { host: 'wezterm',  tokens: ['wezterm', 'WezTerm'] },
  { host: 'ghostty',  tokens: ['ghostty', 'Ghostty'] },
  // Multiplexers (fallback — only if no UI found above them)
  { host: 'tmux',     tokens: ['tmux'] },
  { host: 'screen',   tokens: ['screen'] },
];

/**
 * Snapshot the whole process table in one `ps` call. Includes ppid so we can
 * walk ancestry chains to attribute child processes to their terminal hosts.
 * `comm` may be an absolute path for shim-launched agents, so basename before
 * matching against AGENT_CLI_NAMES.
 */
async function readProcessTable(): Promise<ProcRow[]> {
  if (process.platform === 'win32') return readProcessTableWin32();
  let out: string;
  try {
    ({ stdout: out } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: PS_SNAPSHOT_TIMEOUT_MS }));
  } catch {
    return [];
  }
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    // pid ppid tty comm — tty is a single token ('ttys003', 's003', or '??'/'?'
    // for none); comm stays last so it may contain spaces.
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const ttyRaw = m[3];
    const tty = ttyRaw === '??' || ttyRaw === '?' || ttyRaw === '-' ? undefined : ttyRaw;
    const commRaw = m[4].trim();
    rows.push({ pid, ppid, tty, comm: commRaw, kind: agentKindFromComm(commRaw) });
  }
  return rows;
}

/**
 * Windows process table in one CIM query (`wmic` is removed on current
 * Windows 11, so PowerShell is the stable interface). Same pid/ppid/comm
 * shape as the POSIX `ps` snapshot; `Name` is the image name (`claude.exe`).
 */
async function readProcessTableWin32(): Promise<ProcRow[]> {
  let out: string;
  try {
    ({ stdout: out } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: PS_SNAPSHOT_TIMEOUT_MS }));
  } catch {
    return [];
  }
  return parseWin32ProcessCsv(out);
}

/** Parse `ConvertTo-Csv` output of Win32_Process rows. Exported for tests. */
export function parseWin32ProcessCsv(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^"(\d+)","(\d+)","(.*)"$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const comm = m[3].replace(/""/g, '"');
    rows.push({ pid, ppid, comm, kind: agentKindFromComm(comm) });
  }
  return rows;
}

/**
 * True when any ancestor in pid's parent chain is a known attributed PID.
 * VS Code / Cursor terminals store the *shell* PID in live-terminals.json,
 * while `ps` reports the *child* claude PID, so a direct set lookup misses.
 */
function hasAttributedAncestor(pid: number, ppidMap: Map<number, number>, attributed: Set<number>): boolean {
  let cur: number | undefined = ppidMap.get(pid);
  const seen = new Set<number>();
  while (cur && cur > 1 && !seen.has(cur)) {
    if (attributed.has(cur)) return true;
    seen.add(cur);
    cur = ppidMap.get(cur);
  }
  return false;
}

/**
 * Resolve every candidate PID's cwd, bounded and staggered so the probes no
 * longer fan out as one simultaneous system-wide `lsof` burst (a behavioral-EDR
 * recon trigger). Order matches the input `pids`. The `probe` seam is injectable
 * for testing the bound; production always uses the real `lsof`-backed probe.
 */
export function resolveCwds(
  pids: number[],
  probe: (pid: number) => Promise<string | undefined> = getCwdForPid,
): Promise<(string | undefined)[]> {
  return mapBounded(pids, probe, { concurrency: LSOF_CONCURRENCY, staggerMs: LSOF_STAGGER_MS });
}

/**
 * Resolve a process's current working directory via `lsof`. The `-a` flag
 * ANDs the filters; without it macOS treats `-p` and `-d` as a union and
 * returns the cwd of every process on the system.
 */
async function getCwdForPid(pid: number): Promise<string | undefined> {
  // No lsof on Windows and no cheap foreign-process cwd API; the pid registry
  // written by `ag run` supplies the cwd for registry-launched agents instead.
  if (process.platform === 'win32') return undefined;
  let out: string;
  try {
    const res = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: LSOF_TIMEOUT_MS,
    });
    out = res.stdout;
  } catch {
    return undefined;
  }
  for (const line of out.split('\n')) {
    if (line.startsWith('n')) return line.slice(1);
  }
  return undefined;
}

/**
 * Walk a pid's ancestor chain and return the most specific host app found.
 * Checks each HOST_MATCHERS entry against every ancestor, returns the first
 * host whose tokens match — so IDEs beat terminal apps, terminals beat
 * multiplexers. Returns undefined if nothing is recognised (true headless).
 */
function detectHost(pid: number, procByPid: Map<number, ProcRow>): string | undefined {
  const chain: string[] = [];
  let cur: number | undefined = procByPid.get(pid)?.ppid;
  const seen = new Set<number>();
  while (cur && cur > 1 && !seen.has(cur)) {
    const row = procByPid.get(cur);
    if (!row) break;
    chain.push(row.comm);
    seen.add(cur);
    cur = row.ppid;
  }

  for (const { host, tokens } of HOST_MATCHERS) {
    if (chain.some(c => tokens.some(t => c.includes(t)))) return host;
  }
  return undefined;
}

/**
 * Resolve the host app for a single pid by walking its process ancestry with the
 * same HOST_MATCHERS logic `detectHost` uses. Reads the whole process table per
 * call, so it's for the low-cardinality renderer path (one tmux client per
 * session), not a hot loop. Returns undefined when nothing above the pid is a
 * recognised UI. Exported for the "viewing in <app>" resolver.
 */
export async function hostFromPid(pid: number): Promise<string | undefined> {
  if (!pid || pid < 1) return undefined;
  const procByPid = new Map<number, ProcRow>();
  for (const r of await readProcessTable()) procByPid.set(r.pid, r);
  return detectHost(pid, procByPid);
}

/** IDE / terminal / multiplexer hosts all count as UI-hosted. Absence = truly headless. */
const UI_HOSTS = new Set<string>([
  'code', 'cursor', 'codium', 'windsurf',
  'iterm', 'terminal', 'warp', 'alacritty', 'kitty', 'hyper', 'wezterm', 'ghostty',
  'tmux', 'screen',
]);

export interface AgentCandidate { pid: number; kind: string; }

/**
 * Find the launch registry entry recorded by a WRAPPER of this process. The
 * shim delegate records the pid it spawned, but on Windows the `.cmd` shell
 * path makes that a cmd.exe intermediary whose child is the real agent binary
 * — so the agent pid itself has no entry and the wrapper one ancestor up does.
 * The nearest entry wins, and only if its agent matches the candidate's kind:
 * a claude session shelling out to codex must not hand codex its identity.
 */
export function readAncestorSessionEntry(
  pid: number,
  ppidMap: Map<number, number>,
  kind: string,
  readEntry: (pid: number) => PidSessionEntry | undefined = readPidSessionEntry,
): PidSessionEntry | undefined {
  let cur = ppidMap.get(pid);
  const seen = new Set<number>();
  while (cur && cur > 1 && !seen.has(cur)) {
    const entry = readEntry(cur);
    if (entry) return entry.agent === kind ? entry : undefined;
    seen.add(cur);
    cur = ppidMap.get(cur);
  }
  return undefined;
}

/**
 * Collapse agent processes spawned by another live agent process of the same
 * kind onto their nearest kept ancestor. Claude runs subagents, forks, and
 * even its bundled ripgrep as child `claude` processes — on POSIX those
 * children resolve to the parent's cwd and collapse in dedupeBySession, but
 * where no cwd can be recovered (Windows has no lsof) every fork would print
 * as its own headless row. Two exceptions keep their own row: a candidate with
 * its own registry entry — on its pid OR on a wrapper ancestor strictly below
 * the pid it would fold into (the shim's entry lands on the cmd.exe
 * intermediary on Windows) — and a child of a *different* agent kind (claude
 * shelling out to codex is a real second session, not a fork).
 * Returns the kept roots plus, per root pid, how many descendants folded in.
 */
export function foldSubordinateAgents(
  candidates: AgentCandidate[],
  ppidMap: Map<number, number>,
  readEntry: (pid: number) => PidSessionEntry | undefined,
): { kept: AgentCandidate[]; foldedByRoot: Map<number, number> } {
  const kindByPid = new Map(candidates.map(c => [c.pid, c.kind]));

  const nearestSameKindAncestor = (pid: number, kind: string): number | undefined => {
    let cur = ppidMap.get(pid);
    const seen = new Set<number>();
    while (cur && cur > 1 && !seen.has(cur)) {
      if (kindByPid.get(cur) === kind) return cur;
      seen.add(cur);
      cur = ppidMap.get(cur);
    }
    return undefined;
  };

  // Own launch identity: a matching-kind registry entry on the candidate or on
  // any wrapper between it and the pid it would fold into (exclusive). Entries
  // above the fold target belong to that ancestor's session, not this one.
  const hasOwnSession = (c: AgentCandidate, stopPid: number): boolean => {
    if (readEntry(c.pid)?.agent === c.kind) return true;
    let cur = ppidMap.get(c.pid);
    const seen = new Set<number>();
    while (cur && cur > 1 && cur !== stopPid && !seen.has(cur)) {
      if (readEntry(cur)?.agent === c.kind) return true;
      seen.add(cur);
      cur = ppidMap.get(cur);
    }
    return false;
  };

  const keptPids = new Set<number>();
  for (const c of candidates) {
    const foldTarget = nearestSameKindAncestor(c.pid, c.kind);
    if (foldTarget === undefined || hasOwnSession(c, foldTarget)) {
      keptPids.add(c.pid);
    }
  }

  const kept: AgentCandidate[] = [];
  const foldedByRoot = new Map<number, number>();
  for (const c of candidates) {
    if (keptPids.has(c.pid)) { kept.push(c); continue; }
    // Walk up through folded intermediates to the nearest kept same-kind pid.
    let cur = nearestSameKindAncestor(c.pid, c.kind);
    const seen = new Set<number>();
    while (cur !== undefined && !keptPids.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = nearestSameKindAncestor(cur, c.kind);
    }
    // A fold target must itself be a kept row (a ppid cycle from pid reuse
    // can orphan the whole chain) — otherwise keep the row rather than drop it.
    if (cur === undefined || !keptPids.has(cur)) { kept.push(c); continue; }
    foldedByRoot.set(cur, (foldedByRoot.get(cur) ?? 0) + 1);
  }
  return { kept, foldedByRoot };
}

/**
 * Agent processes not attributed to a team or the runtime registry.
 * Classified by walking the ppid chain: any recognised UI ancestor (IDE
 * helper, terminal-app, or multiplexer) means `terminal`; nothing of the
 * sort means `headless` (daemon, launchd-spawned, orphan).
 */
export async function listUnattributedActive(attributed: Set<number>): Promise<ActiveSession[]> {
  const table = await readProcessTable();
  const procByPid = new Map<number, ProcRow>();
  const ppidMap = new Map<number, number>();
  for (const r of table) {
    procByPid.set(r.pid, r);
    ppidMap.set(r.pid, r.ppid);
  }

  // Candidate PIDs first — we only shell out to lsof for these, not the whole table.
  const candidates: AgentCandidate[] = [];
  for (const { pid, kind } of table) {
    if (!kind) continue;
    if (attributed.has(pid)) continue;
    if (hasAttributedAncestor(pid, ppidMap, attributed)) continue;
    candidates.push({ pid, kind });
  }

  // Forks/subagents of a live agent process collapse onto their root before
  // the cwd probes — fewer spawns, and one session stays one row even when
  // cwd-based dedupe is unavailable (Windows).
  const { kept, foldedByRoot } = foldSubordinateAgents(candidates, ppidMap, readPidSessionEntry);

  // Bounded + staggered lsof probes: same cwds, but a trickle of spawns instead
  // of one simultaneous system-wide burst that behavioral EDR flags as recon.
  const cwds = await resolveCwds(kept.map(c => c.pid));

  // The hook state dir is scanned at most ONCE per active-scan, and the ppid map
  // is inverted at most once — both built lazily on the first candidate that
  // lacks an exact launch-time id, so an all-Claude set does neither. The ~3s
  // poll must not re-read the dir (or re-invert the map) per candidate.
  let hookIndex: HookSessionIndex | undefined;
  let childrenByParent: Map<number, number[]> | undefined;
  // Durable `agents run --name` handles keyed by session id — the same source the
  // terminal path uses to name a row. Headless agents have no live-terminals
  // label and no /rename, so without this a `--name`d headless run would surface
  // with only a topic and no tab title. Built once per scan.
  const runNameMap = buildRunNameMap();
  const ensureChildren = (): Map<number, number[]> => {
    if (childrenByParent) return childrenByParent;
    const m = new Map<number, number[]>();
    // The hook records under the agent pid; a wrapper/shell pid we recorded has
    // the agent as a child, so we resolve via a recorded pid's immediate children.
    for (const [childPid, parentPid] of ppidMap) {
      const arr = m.get(parentPid);
      if (arr) arr.push(childPid);
      else m.set(parentPid, [childPid]);
    }
    childrenByParent = m;
    return m;
  };

  const out: ActiveSession[] = [];
  for (let i = 0; i < kept.length; i++) {
    const { pid, kind } = kept[i];
    // The per-pid registry (written by `ag run` and the shim delegate) gives
    // the EXACT session id this pid was launched with — so N agents in one cwd
    // resolve to N distinct sessions instead of all collapsing onto the newest
    // .jsonl. The shim's entry may sit on a wrapper ancestor (Windows .cmd
    // path). Absent entirely (direct launch outside agents-cli) → heuristic.
    const entry = readPidSessionEntry(pid) ?? readAncestorSessionEntry(pid, ppidMap, kind);
    // Exact session id, in priority: (1) the id we recorded at launch (Claude,
    // known up front via --session-id); (2) the agent's OWN SessionStart hook,
    // authoritative for non-Claude and for agents we didn't launch, joined by
    // launchId/terminalId/pid and kind-guarded against a stale reused-pid file;
    // (3) the newest-jsonl heuristic (sessionIdFromFile, below).
    let exactId = entry?.sessionId;
    // The hook record (when we fall to it) also carries the SessionStart `ts` — the
    // real session-start epoch. Capture it so terminal/headless rows get a
    // `startedAtMs` instead of rendering "0s ago" (they set none before this).
    let hookRec: HookSessionRecord | undefined;
    if (!exactId) {
      hookIndex ??= loadHookSessionIndex();
      hookRec = resolveHookSessionRecord(hookIndex, {
        pid,
        kind,
        launchId: entry?.launchId,
        terminalId: entry?.terminalId,
        childPids: ensureChildren().get(pid),
      });
      exactId = hookRec?.session_id;
    }
    const cwd = cwds[i] ?? entry?.cwd ?? undefined;
    const sessionFile = findSessionFileForKind(kind, cwd, exactId);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const host = detectHost(pid, procByPid);
    const context: ActiveContext = host && UI_HOSTS.has(host) ? 'terminal' : 'headless';
    // pidAlive is true by construction: this pid was just enumerated from the
    // live process table, so an opaque (non-parseable) kind resolves to
    // `unknown`, not a fake `idle`.
    const { state, tokPerSec } = computeLiveSignals(kind, sessionFile, cwd, true);
    const { birthtimeMs, mtimeMs } = sessionFileTimes(sessionFile);
    // Durable run name from `agents run --name`, resolved by the run's session id
    // — the tab-title handle for a run we launched by name. A headless row carries
    // no /rename label and no live-terminals label, so this handle IS its label
    // (mirrors listTeamsActive `label: a.name`). Absent a `--name`, label stays
    // undefined and the display falls back to the topic on its own — no band-aid.
    const resolvedId = exactId ?? sessionIdFromFile(sessionFile);
    const name = resolvedId ? runNameMap.get(resolvedId) ?? undefined : undefined;
    const label = name;
    out.push(applyState({
      context,
      kind,
      host,
      tty: procByPid.get(pid)?.tty,
      pid,
      cwd,
      sessionId: resolvedId,
      label,
      name,
      topic,
      tokPerSec,
      sessionFile,
      // Session start: the hook's authoritative SessionStart `ts`, else the
      // transcript's creation time. Last activity: the transcript's last write.
      startedAtMs: hookRec?.ts ?? birthtimeMs,
      lastActivityMs: mtimeMs,
      pidCount: 1 + (foldedByRoot.get(pid) ?? 0),
    }, state, sessionFile, true));
  }
  // Housekeeping: drop registry files for pids that have since died.
  prunePidSessionRegistry(isPidAlive);
  return out;
}

/** One tmux pane's resolved agent identity for the authoritative source. */
export interface PaneIdentity {
  agent: string;
  /** Exact session id when resolvable (launch registry, or the hook join). */
  sessionId?: string;
  /** The agent's OS pid from the launch registry (may differ from `pane_pid`). */
  pid?: number;
}

/**
 * Attribute a single tmux pane to the agent actually running in it.
 *
 * The launch registry — written per bare-spawn AND per wrap, each stamped with the
 * `tmuxPane` it targeted (see src/lib/exec.ts) — is the EXACT, per-pane source of
 * truth. So an agent spawned into an EXISTING pane (a split, where `$TMUX` is
 * already set so no new session meta is stamped) is attributed to its OWN launch,
 * not the session's original agent — closing the gap where such an agent was
 * dropped by this source and left to the weaker ps-scan fallback. Session-meta
 * labels remain the fallback for the wrapped origin pane of a session whose
 * registry entry is absent (a failed best-effort write, or a legacy session that
 * predates the registry's `tmuxPane` field) — and ONLY for that origin pane
 * (`meta.pane`), so a split shell pane of a labeled session isn't mis-attributed
 * the wrapped agent. When `meta.pane` is unknown (attach-existing sessions), any
 * labeled pane is accepted and the caller's per-session dedupe keeps one.
 * `source: 'teams'` panes are skipped — teammates are surfaced by listTeamsActive.
 * Pure so it is unit-tested without tmux.
 */
export function resolvePaneIdentity(
  pane: string,
  meta: { labels?: Record<string, string>; source?: string; pane?: string } | null,
  liveEntry: PidSessionEntry | undefined,
  getHookIndex: () => HookSessionIndex,
): PaneIdentity | undefined {
  if (meta?.source === 'teams') return undefined;
  if (liveEntry) {
    // Exact id: the id recorded at launch (Claude), else the agent's own
    // SessionStart hook joined by launchId/terminalId (non-Claude, or agents we
    // didn't launch) — kind-guarded against a stale reused-pid file.
    const sessionId = liveEntry.sessionId
      ?? resolveHookSessionRecord(getHookIndex(), {
        pid: liveEntry.pid,
        kind: liveEntry.agent,
        launchId: liveEntry.launchId,
        terminalId: liveEntry.terminalId,
      })?.session_id;
    return { agent: liveEntry.agent, sessionId, pid: liveEntry.pid };
  }
  const agent = meta?.labels?.agent;
  const sessionId = meta?.labels?.sessionId;
  if (agent && sessionId && (meta?.pane == null || meta.pane === pane)) return { agent, sessionId };
  return undefined;
}

/**
 * Agents hosted in the shared-socket tmux server — the authoritative source for
 * tmux-hosted interactive spawns (see src/lib/exec.ts `runInTmux`). Enumerates
 * every pane on the shared socket and attributes each to the agent running in it
 * via {@link resolvePaneIdentity}: the per-pane launch registry (exact) first, the
 * session-meta labels as fallback. Because tmux (not a per-window
 * `live-terminals.json`) is the source of truth, a tmux-hosted agent is captured
 * with its exact `%pane` even when the extension registry is stale — INCLUDING an
 * agent bare-spawned into a split of an existing session, which older logic dropped
 * (it kept only the first pane per session meta). `source: 'teams'` is skipped.
 */
export async function listTmuxAgentSessions(): Promise<ActiveSession[]> {
  const { getDefaultSocketPath } = await import('../tmux/paths.js');
  const { readSessionMeta } = await import('../tmux/session.js');
  const { runTmux } = await import('../tmux/binary.js');
  const socket = getDefaultSocketPath();
  if (!fs.existsSync(socket)) return [];

  let res;
  try {
    res = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_path}'],
      throwOnError: false,
    });
  } catch {
    return [];
  }
  if (res.code !== 0) return [];

  // Index live launches by the pane they target, so a pane we did NOT wrap (a
  // split) resolves to its own agent. Newest launch wins a pane (pid reuse), and
  // only live pids count — a dead agent's stale entry can't light up its old pane.
  const liveByPane = new Map<string, PidSessionEntry>();
  for (const e of listPidSessionEntries()) {
    if (!e.tmuxPane || !isPidAlive(e.pid, e.startedAtMs)) continue;
    const prev = liveByPane.get(e.tmuxPane);
    if (!prev || e.startedAtMs > prev.startedAtMs) liveByPane.set(e.tmuxPane, e);
  }
  // Hook index is scanned lazily — only when a live launch lacks a recorded id
  // (a non-Claude split) and needs the SessionStart-hook join.
  let hookIndex: HookSessionIndex | undefined;
  const getHookIndex = (): HookSessionIndex => (hookIndex ??= loadHookSessionIndex());

  const out: ActiveSession[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [pane, sessName, pidRaw, curPath] = line.split('\t');
    if (!pane || !sessName) continue;
    const meta = readSessionMeta(sessName);
    const liveEntry = liveByPane.get(pane);
    const id = resolvePaneIdentity(pane, meta, liveEntry, getHookIndex);
    if (!id) continue;
    // Dedupe by resolved session id; an as-yet-unresolved id (a hookless/lagging
    // split) keys on the unique pane so it still surfaces as its own row.
    const dedupKey = id.sessionId ?? pane;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // Prefer the registry pid (the agent), falling back to the pane leaf pid. A
    // pid we emit here goes into getActiveSessions' attributed set, so the ps-scan
    // does NOT also surface this agent as a duplicate headless row.
    const pid = id.pid ?? (parseInt(pidRaw, 10) || undefined);
    const cwd = liveEntry?.cwd ?? meta?.cwd ?? (curPath || undefined);
    const sessionFile = findSessionFileForKind(id.agent, cwd, id.sessionId);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const pidAlive = pid ? isPidAlive(pid, liveEntry?.startedAtMs) : true;
    const { state, tokPerSec } = computeLiveSignals(id.agent, sessionFile, cwd, pidAlive);
    const { birthtimeMs, mtimeMs } = sessionFileTimes(sessionFile);
    // The mux/reply rails are known exactly here (the pane IS a tmux pane), so we
    // stamp them off the pane. `transport:'local'` is only a placeholder: the pane
    // can't reveal how the shell above it was reached. enrichProvenance later reads
    // the pane process's env and upgrades this to 'ssh' (with the real origin) when
    // SSH_CONNECTION is present, while preserving this mux/reply.
    const provenance: SessionProvenance = {
      host: os.hostname(),
      transport: 'local',
      mux: { kind: 'tmux', socket, pane },
      reply: { rail: 'tmux', target: pane, socket },
    };
    out.push(applyState({
      context: 'terminal',
      kind: id.agent,
      host: 'tmux',
      pid,
      sessionId: id.sessionId ?? sessionIdFromFile(sessionFile),
      cwd,
      topic,
      tokPerSec,
      sessionFile,
      // tmux panes carry no start timestamp; derive both from the transcript
      // (creation ≈ start, last write ≈ last activity).
      startedAtMs: birthtimeMs,
      lastActivityMs: mtimeMs,
      provenance,
    }, state, sessionFile, pidAlive));
  }
  return out;
}

/**
 * Union of all sources. Teams and terminals spawn actual CLI processes that
 * also show up in `ps`, so headless attribution runs last with the already-
 * attributed PIDs removed. The tmux source goes FIRST into the dedupe so a
 * tmux-hosted agent's row (which carries the exact `%pane`) wins over a staler
 * terminal/headless row for the same session id.
 */
export async function getActiveSessions(opts: ActiveQueryOptions = {}): Promise<ActiveSession[]> {
  const [tmuxAgents, teams, terminals, cloud] = await Promise.all([
    listTmuxAgentSessions().catch(() => [] as ActiveSession[]),
    listTeamsActive().catch(() => [] as ActiveSession[]),
    listTerminalsActive().catch(() => [] as ActiveSession[]),
    Promise.resolve(listCloudActive()),
  ]);

  const knownPids = new Set<number>();
  for (const s of tmuxAgents) if (s.pid) knownPids.add(s.pid);
  for (const s of teams) if (s.pid) knownPids.add(s.pid);
  for (const s of terminals) if (s.pid) knownPids.add(s.pid);

  const unattributed = opts.skipHeadless ? [] : await listUnattributedActive(knownPids);

  const merged = dedupeBySession([...tmuxAgents, ...teams, ...terminals, ...cloud, ...unattributed]);
  await enrichProvenance(merged);
  await resolveOrigins(merged);
  foldPresence(merged);
  return merged;
}

/**
 * Fold detach/attach presence onto each row from the detach store. A stored
 * record wins (`background`/`parked`); otherwise a live terminal session is
 * `attached`. Ad-hoc headless runs and cloud/team rows stay unmarked — they are
 * not on the foreground/background axis.
 */
function foldPresence(rows: ActiveSession[]): void {
  for (const s of rows) {
    if (!s.sessionId) continue;
    const stored = presenceFromStore(s.sessionId);
    if (stored) s.presence = stored;
    else if (s.context === 'terminal') s.presence = 'attached';
  }
}

/**
 * Attach provenance (host / local-vs-SSH / tmux pane / reply rail) to every
 * session that has a live pid. Mutates in place. Runs after dedupe so we probe
 * each session once, not once per fork pid. Probes run in parallel — each is a
 * single /proc read (Linux) or `ps` call (macOS); failures leave `provenance`
 * undefined rather than blocking the listing.
 *
 * A row that already carries provenance (the tmux path, which knows its exact
 * mux/reply from the pane) is not skipped — it is probe-and-MERGED. The tmux
 * path can only stamp a `transport:'local'` placeholder because the pane alone
 * doesn't reveal how the shell above it was reached; the process env does. So we
 * still read the env and fill in the real SSH origin/term, while preserving the
 * authoritative mux/reply the pane already gave us. Skipping this (the old
 * behavior) is exactly why ssh-launched tmux sessions rendered as local.
 */
async function enrichProvenance(sessions: ActiveSession[]): Promise<void> {
  await Promise.all(
    sessions.map(async (s) => {
      if (!s.pid) return;
      const probed = await detectProvenance(s.pid);
      if (!probed) return;
      if (!s.provenance) {
        s.provenance = probed;
        return;
      }
      // Row already carries exact mux/reply (the tmux path). Fill only what a
      // pre-set provenance can't know from the pane alone: the real launch origin.
      if (probed.transport === 'ssh' && !s.provenance.ssh) {
        s.provenance.transport = 'ssh';
        s.provenance.ssh = probed.ssh;
      }
      if (probed.term && !s.provenance.term) s.provenance.term = probed.term;
    }),
  );
}

/**
 * Match an SSH client IP to a registered device (pure — testable with a plain
 * registry object). Returns the device name + ssh login user when the IP is a
 * known device address.
 */
export function matchOriginDevice(
  clientIp: string,
  reg: DeviceRegistry,
): { device: string; user?: string } | undefined {
  for (const d of Object.values(reg)) {
    if (d.address?.ip && d.address.ip === clientIp) {
      return { device: d.name, ...(d.user ? { user: d.user } : {}) };
    }
  }
  return undefined;
}

/**
 * Resolve the initiating device for every ssh-transport session by matching its
 * `ssh.clientIp` against the device registry. Read-only and best-effort: a
 * registry that can't be loaded, or an IP that matches no device, leaves
 * `origin` undefined (the raw client IP is still on `ssh`). Mutates in place.
 */
async function resolveOrigins(sessions: ActiveSession[]): Promise<void> {
  const needing = sessions.filter((s) => s.provenance?.ssh && !s.provenance.origin);
  if (needing.length === 0) return;
  let reg: DeviceRegistry;
  try {
    reg = await loadDevices();
  } catch {
    return;
  }
  for (const s of needing) {
    const match = matchOriginDevice(s.provenance!.ssh!.clientIp, reg);
    if (match) s.provenance!.origin = match;
  }
}

/**
 * Identity for a row the scan could not tie to a session: a daemon's worker
 * processes (an OpenClaw gateway spawning `codex`, a supervisor pool) have no
 * session id, no transcript file, and no cloud/run handle — nothing tells two of
 * them apart, because nothing distinguishes them. Same binary + same working
 * directory + same context IS the identity, so N indistinguishable workers
 * collapse to one row carrying `pidCount: N`.
 *
 * Returns undefined with no cwd: without it there is no stable identity, and
 * keying on kind alone would fold unrelated agents onto one row.
 */
function anonymousWorkerKey(s: ActiveSession): string | undefined {
  if (!s.cwd) return undefined;
  return `anon\0${s.kind}\0${s.context}\0${s.cwd}`;
}

/**
 * Collapse rows that resolve to the *same* session — a session with many
 * subagent/fork PIDs (all matched to one transcript file) would otherwise print
 * dozens of identical rows. Keyed by session id, falling back to the transcript
 * file, then the cloud/run handle, then {@link anonymousWorkerKey}. The first row
 * wins and carries a `pidCount`.
 */
export function dedupeBySession(sessions: ActiveSession[]): ActiveSession[] {
  const out: ActiveSession[] = [];
  const byKey = new Map<string, ActiveSession>();
  for (const s of sessions) {
    const key = s.sessionId || s.sessionFile || s.cloudTaskId || s.agentId || anonymousWorkerKey(s);
    if (!key) { out.push(s); continue; }
    const existing = byKey.get(key);
    if (existing) {
      // Carry pre-folded fork counts (headless rows arrive with pidCount set).
      existing.pidCount = (existing.pidCount ?? 1) + (s.pidCount ?? 1);
    } else {
      s.pidCount = s.pidCount ?? 1;
      byKey.set(key, s);
      out.push(s);
    }
  }
  return out;
}
