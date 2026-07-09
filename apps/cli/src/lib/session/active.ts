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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { listActiveTasks } from '../cloud/store.js';
import { AgentManager } from '../teams/agents.js';
import { getTerminalsDir } from '../state.js';
import { readPidSessionEntry, prunePidSessionRegistry, type PidSessionEntry } from './pid-registry.js';
import { buildClaudeLabelMap } from './discover.js';
import { buildRunNameMap } from './run-names.js';
import { latestSessionFileForCwd } from './db.js';
import { extractSessionTopic } from './prompt.js';
import { readSessionTail } from './tail.js';
import { inferSessionState, type SessionState, type SessionActivity, type AwaitingReason, type StructuredQuestion, type DetectedPr, type DetectedWorktree, type DetectedTicket } from './state.js';
import { detectProvenance, type SessionProvenance } from './provenance.js';
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

export type ActiveContext = 'terminal' | 'teams' | 'cloud' | 'headless';

export type ActiveStatus = 'running' | 'idle' | 'queued' | 'input_required';

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
  /** Why the agent is waiting, when activity is waiting_input. */
  awaitingReason?: AwaitingReason;
  /** The structured decision (question/plan/permission + options) the agent is waiting on. */
  question?: StructuredQuestion;
  /** Last few assistant turns (most-recent last), for at-a-glance context in the UI. */
  tail?: string[];
  /** PR opened during the session. */
  pr?: DetectedPr;
  /** Worktree the session runs in. */
  worktree?: DetectedWorktree;
  /** Tracker ticket the session is tied to. */
  ticket?: DetectedTicket;
  /** Tracker refs the session CREATED (Linear create_issue / gh issue create). */
  createdTickets?: string[];
  /** Team name the session SPAWNED via `agents teams create/add`. */
  spawnedTeam?: string;
  sessionFile?: string;
  startedAtMs?: number;
  status: ActiveStatus;
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

function isPidAlive(pid: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
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
      if (!e?.sessionId || !isPidAlive(e.pid)) continue;
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

function classifyActivity(sessionFile: string | undefined): 'running' | 'idle' {
  // No resolvable transcript is NOT evidence of activity — default to idle. (Before
  // the no-borrow fix in pickSessionFile this rarely fired because every terminal
  // borrowed the newest file; now a session with an unresolved id lands here, and
  // "running" would wrongly light it up.)
  if (!sessionFile) return 'idle';
  try {
    const mtimeMs = fs.statSync(sessionFile).mtimeMs;
    return Date.now() - mtimeMs < ACTIVE_MTIME_WINDOW_MS ? 'running' : 'idle';
  } catch {
    return 'running';
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
  if (kind === 'codex') return latestSessionFileForCwd('codex', cwd);
  return undefined;
}

/** Recover the session UUID from a transcript filename (Claude `<uuid>.jsonl`, Codex `rollout-…-<uuid>.jsonl`). */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function sessionIdFromFile(file?: string): string | undefined {
  if (!file) return undefined;
  return path.basename(file).match(UUID_RE)?.[0];
}

/** Infer live state from a session file's tail (Claude/Codex). Undefined when unreadable. */
function computeLiveState(kind: string, sessionFile: string | undefined, cwd: string | undefined, pidAlive: boolean): SessionState | undefined {
  if (!sessionFile) return undefined;
  const agent = kind === 'codex' ? 'codex' : 'claude';
  const events = readSessionTail(sessionFile, agent);
  if (events.length === 0) return undefined;
  let mtimeMs: number | undefined;
  try { mtimeMs = fs.statSync(sessionFile).mtimeMs; } catch { /* vanished between calls */ }
  return inferSessionState(events, { cwd, pidAlive, mtimeMs, activeWindowMs: ACTIVE_MTIME_WINDOW_MS });
}

/** Map inferred activity onto the coarse ActiveStatus used by the renderer and counts. */
function statusFromActivity(activity: SessionActivity): ActiveStatus {
  return activity === 'working' ? 'running' : activity === 'waiting_input' ? 'input_required' : 'idle';
}

/**
 * Fold a computed SessionState onto an active-session row: rich status +
 * preview + PR/worktree/ticket badges. With no state (unreadable/non-Claude/
 * Codex file) it degrades to the mtime-only classification.
 */
function applyState(base: Omit<ActiveSession, 'status'>, state: SessionState | undefined, fallbackFile: string | undefined): ActiveSession {
  if (!state) return { ...base, status: classifyActivity(fallbackFile) };
  return {
    ...base,
    status: statusFromActivity(state.activity),
    activity: state.activity,
    awaitingReason: state.awaitingReason,
    question: state.question,
    tail: state.tail,
    // Prefer the live preview (latest turn); keep the first-prompt topic as a fallback.
    preview: state.preview ?? base.preview,
    pr: state.pr,
    worktree: state.worktree,
    ticket: state.ticket,
    createdTickets: state.createdTickets,
    spawnedTeam: state.spawnedTeam,
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
    const state = computeLiveState(a.agentType, sessionFile, a.cwd ?? undefined, a.pid ? isPidAlive(a.pid) : true);
    return applyState({
      context: 'teams',
      kind: a.agentType,
      pid: a.pid ?? undefined,
      sessionId: sessionId ?? sessionIdFromFile(sessionFile),
      cwd: a.cwd ?? undefined,
      label: a.name ?? undefined,
      topic,
      sessionFile,
      startedAtMs: a.startedAt.getTime(),
      teamName: a.taskName,
      agentId: a.agentId,
    }, state, sessionFile);
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
    const state = computeLiveState(t.kind, sessionFile, t.cwd ?? undefined, isPidAlive(t.pid));
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
      sessionFile,
      startedAtMs: t.startedAtMs,
      windowId: t.windowId,
    }, state, sessionFile);
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
    status: t.status === 'running'
      ? 'running'
      : t.status === 'input_required'
        ? 'input_required'
        : 'queued',
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
    ({ stdout: out } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
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
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true }));
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

  const out: ActiveSession[] = [];
  for (let i = 0; i < kept.length; i++) {
    const { pid, kind } = kept[i];
    // The per-pid registry (written by `ag run` and the shim delegate) gives
    // the EXACT session id this pid was launched with — so N agents in one cwd
    // resolve to N distinct sessions instead of all collapsing onto the newest
    // .jsonl. The shim's entry may sit on a wrapper ancestor (Windows .cmd
    // path). Absent entirely (direct launch outside agents-cli) → heuristic.
    const entry = readPidSessionEntry(pid) ?? readAncestorSessionEntry(pid, ppidMap, kind);
    const cwd = cwds[i] ?? entry?.cwd ?? undefined;
    const sessionFile = findSessionFileForKind(kind, cwd, entry?.sessionId);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const host = detectHost(pid, procByPid);
    const context: ActiveContext = host && UI_HOSTS.has(host) ? 'terminal' : 'headless';
    const state = computeLiveState(kind, sessionFile, cwd, true);
    out.push(applyState({
      context,
      kind,
      host,
      tty: procByPid.get(pid)?.tty,
      pid,
      cwd,
      sessionId: entry?.sessionId ?? sessionIdFromFile(sessionFile),
      topic,
      sessionFile,
      pidCount: 1 + (foldedByRoot.get(pid) ?? 0),
    }, state, sessionFile));
  }
  // Housekeeping: drop registry files for pids that have since died.
  prunePidSessionRegistry(isPidAlive);
  return out;
}

/**
 * Agents hosted in the shared-socket tmux server — the authoritative source for
 * tmux-wrapped interactive spawns (see src/lib/exec.ts `runInTmux`). Enumerates
 * every pane on the shared socket and keeps those whose session meta was stamped
 * with `labels.agent` + `labels.sessionId` by the spawn-wrap. Because tmux (not a
 * per-window `live-terminals.json`) is the source of truth, a tmux-hosted agent is
 * ALWAYS captured with its exact `%pane` even when the extension registry is stale
 * or absent. `source: 'teams'` is skipped — teammates are surfaced by listTeamsActive.
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

  const out: ActiveSession[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [pane, sessName, pidRaw, curPath] = line.split('\t');
    if (!pane || !sessName) continue;
    const meta = readSessionMeta(sessName);
    const agent = meta?.labels?.agent;
    const sessionId = meta?.labels?.sessionId;
    if (!agent || !sessionId) continue;      // only our stamped agent sessions
    if (meta?.source === 'teams') continue;  // teammates come from listTeamsActive
    if (seen.has(sessionId)) continue;       // first pane per session wins
    seen.add(sessionId);

    const pid = parseInt(pidRaw, 10) || undefined;
    const cwd = meta?.cwd ?? (curPath || undefined);
    const sessionFile = findSessionFileForKind(agent, cwd, sessionId);
    const topic = sessionFile ? quickExtractTopic(sessionFile) : undefined;
    const state = computeLiveState(agent, sessionFile, cwd, pid ? isPidAlive(pid) : true);
    // Provenance is known exactly here (the pane IS a tmux pane) — set it so
    // enrichProvenance skips it and the locator/reply rails resolve off the pane.
    const provenance: SessionProvenance = {
      host: os.hostname(),
      transport: 'local',
      mux: { kind: 'tmux', socket, pane },
      reply: { rail: 'tmux', target: pane, socket },
    };
    out.push(applyState({
      context: 'terminal',
      kind: agent,
      host: 'tmux',
      pid,
      sessionId,
      cwd,
      topic,
      sessionFile,
      provenance,
    }, state, sessionFile));
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
  return merged;
}

/**
 * Attach provenance (host / local-vs-SSH / tmux pane / reply rail) to every
 * session that has a live pid. Mutates in place. Runs after dedupe so we probe
 * each session once, not once per fork pid. Probes run in parallel — each is a
 * single /proc read (Linux) or `ps` call (macOS); failures leave `provenance`
 * undefined rather than blocking the listing.
 */
async function enrichProvenance(sessions: ActiveSession[]): Promise<void> {
  await Promise.all(
    sessions.map(async (s) => {
      if (s.provenance || !s.pid) return;
      s.provenance = await detectProvenance(s.pid);
    }),
  );
}

/**
 * Collapse rows that resolve to the *same* session — a session with many
 * subagent/fork PIDs (all matched to one transcript file) would otherwise print
 * dozens of identical rows. Keyed by session id (falling back to the file), the
 * first row wins and carries a `pidCount`. Rows with no session identity (cloud,
 * unresolved headless) pass through untouched.
 */
function dedupeBySession(sessions: ActiveSession[]): ActiveSession[] {
  const out: ActiveSession[] = [];
  const byKey = new Map<string, ActiveSession>();
  for (const s of sessions) {
    const key = s.sessionId || s.sessionFile;
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
