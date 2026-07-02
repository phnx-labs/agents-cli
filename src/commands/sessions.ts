/**
 * Session discovery, search, and rendering commands.
 *
 * Implements `agents sessions` -- the unified interface for finding, browsing,
 * and reading agent conversation transcripts across Claude, Codex, Gemini,
 * and OpenCode. Supports interactive picker mode, text/path search, markdown
 * and JSON rendering, role/turn filtering, artifact inspection, and session
 * resume via agent-native CLI flags.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { AgentId } from '../lib/types.js';
import type { SessionAgentId, SessionMeta, ViewMode } from '../lib/session/types.js';
import { SESSION_AGENTS } from '../lib/session/types.js';
import { discoverArtifacts, readArtifact, resolveArtifact } from '../lib/session/artifacts.js';
import { looksLikePath, toComparablePath, homeDir } from '../lib/platform/index.js';
import { getActiveSessions, type ActiveSession } from '../lib/session/active.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { gatherRemoteActive } from '../lib/session/remote-active.js';
import { stringWidth, truncateToWidth, padToWidth, terminalWidth } from '../lib/session/width.js';
import type { SessionActivity, AwaitingReason } from '../lib/session/state.js';
import { discoverSessions, countSessionsInScope, resolveSessionById, searchContentIndex, parseTimeFilter, type DiscoverOptions, type ScanProgress } from '../lib/session/discover.js';
import { filterTeamSessions } from '../lib/session/team-filter.js';
import { parseSession } from '../lib/session/parse.js';
import { runRemoteSessions } from '../lib/session/remote.js';
import { formatRelativeTime } from '../lib/session/relative-time.js';
import { renderConversationMarkdown, renderSummary, renderSummaryHeader, computeSummaryStats, renderJson, filterEvents, parseRoleList, type FilterOptions } from '../lib/session/render.js';
import { renderMarkdown } from '../lib/markdown.js';
import { colorAgent, resolveAgentName } from '../lib/agents.js';
import { fuzzyMatch, FUZZY_PRESETS } from '../lib/fuzzy.js';
import { resolveVersionAliasLoose } from '../lib/versions.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { sessionPicker, type PickedSession } from './sessions-picker.js';
import { setHelpSections } from '../lib/help.js';
import { registerSessionsTailCommand } from './sessions-tail.js';
import { registerSessionsSyncCommand } from './sessions-sync.js';
import { registerSessionsResumeCommand } from './sessions-resume.js';

const SESSION_AGENT_FILTER_HELP = `Filter by agent, e.g. claude, codex, claude@2.0.65`;

interface SessionFilterOptions {
  agent?: string;
  project?: string;
  all?: boolean;
  teams?: boolean;
  since?: string;
  until?: string;
}

interface SessionsOptions extends SessionFilterOptions {
  limit?: string;
  sort?: string;
  json?: boolean;
  markdown?: boolean;
  noRedact?: boolean;
  include?: string;
  exclude?: string;
  first?: string;
  last?: string;
  artifacts?: boolean;
  artifact?: string;
  active?: boolean;
  cloud?: boolean;
  host?: string[];
  /** Group the listing by directory and drop the id/version columns. */
  tree?: boolean;
  /** With --active: show only sessions waiting on user input; exit 1 if any. */
  waiting?: boolean;
  /** Enrich the listing with live glyphs/preview for running rows. Default on;
   * `--no-live` sets this false. Commander's `--no-` convention. */
  live?: boolean;
  /** With --active: force local-only, skip cross-machine SSH fan-out. */
  local?: boolean;
}

interface ClaudeHistoryEntry {
  sessionId: string;
  display?: string;
  project?: string;
  timestampMs?: number;
  historyPath: string;
}

interface ClaudeResumeMatch {
  session: SessionMeta;
  resumeTimestampMs: number;
  deltaMs: number;
}

const CLAUDE_RESUME_MATCH_WINDOW_MS = 10 * 60_000;

const LOAD_VERBS = ['Loading', 'Scanning', 'Gathering', 'Indexing', 'Reading'];
const FIND_VERBS = ['Finding', 'Searching', 'Locating', 'Matching'];

interface ProgressTracker {
  onProgress: (progress: ScanProgress) => void;
  stop: () => void;
}

/** Build a spinner-backed progress tracker that cycles through verbs while scanning sessions. */
function createScanProgressTracker(
  verbs: string[],
  suffix: string,
  spinner: ReturnType<typeof ora> | null,
): ProgressTracker {
  const counts = new Map<SessionAgentId, { parsed: number; total: number }>();
  let verbIndex = 0;

  const render = (): void => {
    if (!spinner) return;
    const verb = verbs[verbIndex % verbs.length];
    const parts: string[] = [];
    for (const agent of SESSION_AGENTS) {
      const c = counts.get(agent);
      if (!c || c.total === 0) continue;
      parts.push(`${agent} ${c.parsed}/${c.total}`);
    }
    const base = `${verb} ${suffix}...`;
    spinner.text = parts.length > 0 ? `${base} (${parts.join(' · ')})` : base;
  };

  const interval = spinner
    ? setInterval(() => {
        verbIndex++;
        render();
      }, 900)
    : null;

  render();

  return {
    onProgress: (progress: ScanProgress) => {
      counts.set(progress.agent, { parsed: progress.parsed, total: progress.total });
      render();
    },
    stop: () => {
      if (interval) clearInterval(interval);
    },
  };
}

const PICKER_RECENT_COUNT = 15;
const PICKER_POOL_LIMIT = 200;

/**
 * Resolve a path-like query to an absolute directory path.
 */
function resolvePathFilter(query: string): string {
  const expanded = query.startsWith('~')
    ? path.join(os.homedir(), query.slice(1))
    : query;
  return path.resolve(expanded);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function renderArtifactsForSession(
  session: SessionMeta,
  listAll: boolean,
  name?: string,
): Promise<void> {
  const artifacts = discoverArtifacts(session);

  if (name !== undefined) {
    const artifact = resolveArtifact(artifacts, name);
    if (!artifact) {
      console.error(chalk.red(`No artifact matching "${name}" in session ${session.shortId}.`));
      if (artifacts.length > 0) {
        console.error(chalk.gray('Available artifacts:'));
        for (const a of artifacts) {
          console.error(chalk.gray(`  ${a.path}`));
        }
      }
      process.exit(1);
    }
    if (!artifact.exists) {
      console.error(chalk.red(`Artifact exists in session history but the file is no longer on disk: ${artifact.path}`));
      process.exit(1);
    }
    process.stdout.write(readArtifact(artifact));
    return;
  }

  if (artifacts.length === 0) {
    console.log(chalk.gray('No file-write artifacts found in this session.'));
    return;
  }

  const agentColor = colorAgent(session.agent);
  console.log('');
  console.log(
    agentColor(session.agent) +
    chalk.gray(` · ${session.shortId} · ${formatRelativeTime(session.timestamp)}`)
  );
  console.log(chalk.gray('─'.repeat(72)));

  for (const a of artifacts) {
    const exists = a.exists ? chalk.green('yes') : chalk.red('no');
    const size = a.exists && a.sizeBytes !== undefined ? chalk.cyan(formatBytes(a.sizeBytes)) : chalk.gray('-');
    const tool = chalk.yellow(padRight(a.tool, 10));
    const when = chalk.gray(formatRelativeTime(a.timestamp));
    const p = chalk.white(a.path);
    console.log(`  ${exists}  ${size.padEnd(10)}  ${tool}  ${when.padEnd(16)}  ${p}`);
  }

  console.log(chalk.gray(`\n${artifacts.length} artifact${artifacts.length !== 1 ? 's' : ''}.`));
}

function statusColor(status: ActiveSession['status']): (s: string) => string {
  switch (status) {
    case 'running': return chalk.green;
    case 'idle': return chalk.gray;
    case 'queued': return chalk.blue;
    case 'input_required': return chalk.yellow;
  }
}

function contextColor(context: ActiveSession['context']): (s: string) => string {
  switch (context) {
    case 'terminal': return chalk.magenta;
    case 'teams': return chalk.cyan;
    case 'cloud': return chalk.blue;
    case 'headless': return chalk.gray;
  }
}

function shortCwd(cwd?: string): string {
  if (!cwd) return '-';
  const home = homeDir();
  // Compare in normalized form so the `~` shorthand also lands on Windows
  // (case-insensitive, backslash paths); on POSIX this is byte-identical to the
  // previous `cwd.startsWith(home)`. The displayed tail keeps original casing.
  return toComparablePath(cwd).startsWith(toComparablePath(home))
    ? '~' + cwd.slice(home.length)
    : cwd;
}

function formatStartedAt(startedAtMs?: number): string {
  if (!startedAtMs) return '-';
  return formatRelativeTime(new Date(startedAtMs).toISOString());
}

/**
 * Build the live description for an active session: prefer the state engine's
 * preview (the latest turn), then a user label, then the first-prompt topic.
 */
function buildSessionDescription(s: ActiveSession): string {
  if (s.context === 'cloud') {
    return s.preview || `${s.cloudProvider ?? ''}${s.cloudTaskId ? ` · ${s.cloudTaskId.slice(0, 12)}` : ''}`;
  }
  if (s.context === 'teams') {
    const parts = [s.teamName];
    if (s.preview) parts.push(s.preview);
    else if (s.label) parts.push(s.label);
    else if (s.topic) parts.push(s.topic);
    return parts.filter(Boolean).join(' · ');
  }
  // Terminal or headless: prefer the live preview, then label, then topic.
  return s.preview || s.label || s.topic || '';
}

/** Short human word for a session's activity (falls back to the coarse status). */
function activityLabel(s: ActiveSession): string {
  if (s.activity === 'waiting_input') return 'waiting';
  if (s.activity === 'working') return 'working';
  if (s.activity === 'idle') return 'idle';
  return s.status === 'input_required' ? 'waiting' : s.status;
}

/**
 * Index live sessions by their full session UUID so a historical `SessionMeta`
 * row (`meta.id`) can be matched to the session that is still running now.
 * Rows without a sessionId (some cloud/headless probes) are skipped — they
 * can't be correlated back to a transcript on disk.
 */
export function indexActiveBySessionId(active: ActiveSession[]): Map<string, ActiveSession> {
  const byId = new Map<string, ActiveSession>();
  for (const a of active) {
    if (a.sessionId) byId.set(a.sessionId, a);
  }
  return byId;
}

/**
 * The live decoration for a listing row: a status glyph and the latest-turn
 * preview, when the session is still running. `●` running / `◐` waiting on the
 * user / `○` idle, colored by the same `statusColor` the --active view uses.
 * Returns empty strings when there is no live match, so callers render the
 * plain historical row unchanged.
 */
export function liveGlyphAndPreview(a: ActiveSession | undefined): { glyph: string; preview: string } {
  if (!a) return { glyph: '', preview: '' };
  const waiting = a.status === 'input_required' || a.activity === 'waiting_input';
  const running = a.status === 'running' || a.activity === 'working';
  const shape = waiting ? '◐' : running ? '●' : '○';
  return { glyph: statusColor(a.status)(shape), preview: buildSessionDescription(a) };
}

/**
 * The tracker/PR ref for a session's dedicated column: the ticket id when known,
 * else `PR#<n>`, else empty. Pulled out of the trailing badge blob so refs align
 * into a scannable column instead of jamming against a truncated topic.
 */
export function ticketLabel(s: Pick<SessionMeta, 'ticketId' | 'prNumber'>): string {
  return s.ticketId ?? (s.prNumber ? `PR#${s.prNumber}` : '');
}

/**
 * Compact, colour-coded badges for the durable/awaiting signals. Text-only (no
 * emoji, per repo convention): `plan` / `ask` / `perm` for why it's waiting,
 * `PR#N`, `wt:slug`, `TICKET-123`.
 */
function signalBadges(s: Pick<ActiveSession, 'awaitingReason' | 'pr' | 'worktree' | 'ticket'>): string {
  const parts: string[] = [];
  if (s.awaitingReason === 'plan_review') parts.push(chalk.yellow('plan'));
  else if (s.awaitingReason === 'question') parts.push(chalk.yellow('ask'));
  else if (s.awaitingReason === 'permission') parts.push(chalk.yellow('perm'));
  if (s.ticket) parts.push(chalk.cyan(s.ticket.id));
  if (s.pr) parts.push(chalk.blue(`PR#${s.pr.number ?? '?'}`));
  if (s.worktree) parts.push(chalk.magenta(`wt:${s.worktree.slug}`));
  return parts.join(' ');
}

/**
 * Compact provenance badge: how to reach the session, not what it's doing.
 * `ssh` flags a remote host; the tmux pane id is the send-keys target the feed
 * would type back into. Local, non-tmux sessions add nothing (the common case).
 */
function provenanceBadge(p?: ActiveSession['provenance']): string {
  if (!p) return '';
  const parts: string[] = [];
  if (p.transport === 'ssh') parts.push(chalk.red('ssh'));
  if (p.mux?.kind === 'tmux' && p.mux.pane) parts.push(chalk.green(`tmux ${p.mux.pane}`));
  else if (p.mux?.kind === 'screen') parts.push(chalk.green('screen'));
  return parts.join(' ');
}

/**
 * Render a single agent-session row inside an already-printed group header.
 * Indent is the leading whitespace (2 spaces for flat groups, 4 inside a
 * window sub-group). Leads with the 8-char session id (the address to read or
 * resume it); status, badges, and the live preview fill the rest, sized to the
 * terminal width so the row never wraps.
 */
function printActiveRow(s: ActiveSession, indent: string): void {
  const idCol = chalk.dim(padToWidth((s.sessionId?.slice(0, 8)) ?? '-', 9));
  const kindCol = colorAgent(s.kind as any)(padToWidth(truncateToWidth(s.kind, 8), 9));
  const hostCol = chalk.gray(padToWidth(truncateToWidth(s.host ?? '-', 8), 9));
  const statusCol = statusColor(s.status)(padToWidth(truncateToWidth(activityLabel(s), 8), 9));
  const fork = s.pidCount && s.pidCount > 1 ? chalk.dim(`×${s.pidCount} `) : '';
  const badges = (fork ? fork : '') + [signalBadges(s), provenanceBadge(s.provenance)].filter(Boolean).join(' ');
  const desc = buildSessionDescription(s) || '-';
  // Fill the remaining width with the preview so nothing wraps under tmux/SSH.
  const fixed = stringWidth(indent) + 9 + 9 + 9 + 9 + (badges ? stringWidth(badges) + 1 : 0);
  const room = Math.max(12, terminalWidth() - fixed - 1);
  const descCol = chalk.white(truncateToWidth(desc, room));
  console.log(indent + idCol + kindCol + hostCol + statusCol + (badges ? badges + ' ' : '') + descCol);
}

/**
 * Short label for an IDE window. The slice key in live-terminals.json is
 * `${vscode.env.sessionId}-${ext-host pid}`; the trailing pid is the cheap
 * stable disambiguator. We surface it as `ext-pid` so two windows on the
 * same repo are visibly different.
 */
function shortWindowLabel(windowId: string): string {
  const m = windowId.match(/-(\d+)$/);
  return m ? `ext-pid ${m[1]}` : `win ${windowId.slice(0, 8)}`;
}

/** Grouped + sorted view of active sessions for the --active renderer. */
export interface ActiveSessionsLayout {
  workspaces: Array<{
    /** Internal grouping key — `__cloud__`, `__unknown__`, or the cwd. */
    key: string;
    /** Sessions in this workspace, both windowed and flat (preserves total count). */
    total: number;
    /** Terminals grouped by IDE window (sorted by oldest startedAtMs). */
    windows: Array<{ windowId: string; sessions: ActiveSession[] }>;
    /** Everything else in this workspace: cloud, teams, headless, terminals without a windowId. */
    flat: ActiveSession[];
  }>;
}

/**
 * Group sessions by workspace, then split each workspace into IDE-window
 * sub-groups + a flat bucket. Pure function — no I/O — so the renderer's
 * grouping rules can be tested without mocking the session scanner.
 *
 * Sort order:
 *   - workspaces: by session count descending, then key ascending
 *   - windows within a workspace: by oldest startedAtMs ascending
 *   - sessions within a window/flat bucket: input order preserved
 */
export function groupActiveSessions(sessions: ActiveSession[]): ActiveSessionsLayout {
  const byWorkspace = new Map<string, ActiveSession[]>();
  for (const s of sessions) {
    const key = s.cwd ?? (s.context === 'cloud' ? '__cloud__' : '__unknown__');
    const list = byWorkspace.get(key) || [];
    list.push(s);
    byWorkspace.set(key, list);
  }
  const sortedKeys = Array.from(byWorkspace.keys()).sort((a, b) => {
    const aCount = byWorkspace.get(a)!.length;
    const bCount = byWorkspace.get(b)!.length;
    if (aCount !== bCount) return bCount - aCount;
    return a.localeCompare(b);
  });
  const workspaces = sortedKeys.map((key) => {
    const group = byWorkspace.get(key)!;
    const windowedSessions: ActiveSession[] = [];
    const flat: ActiveSession[] = [];
    for (const s of group) {
      if (s.context === 'terminal' && s.windowId) windowedSessions.push(s);
      else flat.push(s);
    }
    const byWindow = new Map<string, ActiveSession[]>();
    for (const s of windowedSessions) {
      const list = byWindow.get(s.windowId!) || [];
      list.push(s);
      byWindow.set(s.windowId!, list);
    }
    const windowKeys = Array.from(byWindow.keys()).sort((a, b) => {
      const aStart = Math.min(...byWindow.get(a)!.map(s => s.startedAtMs ?? Infinity));
      const bStart = Math.min(...byWindow.get(b)!.map(s => s.startedAtMs ?? Infinity));
      return aStart - bStart;
    });
    return {
      key,
      total: group.length,
      windows: windowKeys.map((wid) => ({ windowId: wid, sessions: byWindow.get(wid)! })),
      flat,
    };
  });
  return { workspaces };
}

/** One machine's active sessions, keeping the within-machine workspace layout. */
export interface MachineGroup {
  /** Normalized device id (machineId() form). */
  machine: string;
  /** The machine this command is running on — pinned first and marked. */
  isLocal: boolean;
  total: number;
  layout: ActiveSessionsLayout;
}

/** Active sessions grouped by the machine they run on. */
export interface MachineGroupedLayout {
  machines: MachineGroup[];
}

/**
 * The machine a session belongs to: an explicit tag (set when merging
 * cross-machine results) wins; else the process's provenance host (normalized
 * to the same id form); else the local machine. Never keys off `ActiveSession.host`
 * — that is the terminal *app* (code/tmux), not the computer.
 */
function machineKeyFor(s: ActiveSession, localMachine: string): string {
  if (s.machine) return s.machine;
  if (s.provenance?.host) return normalizeHost(s.provenance.host);
  return localMachine;
}

/**
 * Group active sessions by machine, then delegate each machine's sessions to the
 * existing workspace/window grouping. Local machine is pinned first and flagged;
 * the rest sort by session count descending, then name. Pure — `localMachine` is
 * injected so the function stays testable without reading os.hostname().
 */
export function groupSessionsByMachine(sessions: ActiveSession[], localMachine: string): MachineGroupedLayout {
  const byMachine = new Map<string, ActiveSession[]>();
  for (const s of sessions) {
    const key = machineKeyFor(s, localMachine);
    (byMachine.get(key) ?? byMachine.set(key, []).get(key)!).push(s);
  }
  const keys = Array.from(byMachine.keys()).sort((a, b) => {
    if (a === localMachine) return -1;
    if (b === localMachine) return 1;
    const ac = byMachine.get(a)!.length, bc = byMachine.get(b)!.length;
    if (ac !== bc) return bc - ac;
    return a.localeCompare(b);
  });
  const machines = keys.map((machine) => ({
    machine,
    isLocal: machine === localMachine,
    total: byMachine.get(machine)!.length,
    layout: groupActiveSessions(byMachine.get(machine)!),
  }));
  return { machines };
}

/**
 * Collapse duplicate sessions after a cross-machine merge. Two rows collapse
 * only when they share both machine and session UUID (the same host listed
 * twice, or a local/remote overlap); rows without a sessionId can't be
 * correlated, so they're all kept.
 */
export function dedupeByMachineSession(sessions: ActiveSession[]): ActiveSession[] {
  const seen = new Set<string>();
  const out: ActiveSession[] = [];
  for (const s of sessions) {
    if (!s.sessionId) { out.push(s); continue; }
    const key = `${s.machine ?? ''}:${s.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Print one machine's workspace tree, indented under its machine header. */
function renderWorkspaceLayout(layout: ActiveSessionsLayout, base: string): void {
  let first = true;
  for (const ws of layout.workspaces) {
    if (!first) console.log();
    first = false;

    const header = ws.key === '__cloud__'
      ? chalk.magenta.bold('cloud')
      : ws.key === '__unknown__'
        ? chalk.gray.bold('unknown')
        : chalk.cyan.bold(shortCwd(ws.key));
    console.log(`${base}${header} ${chalk.gray(`(${ws.total})`)}`);

    for (const win of ws.windows) {
      // Host is per-process, but every terminal in the same IDE window shares
      // an ancestor — take the first non-empty host as the window's label.
      const host = win.sessions.find((s) => s.host)?.host ?? 'terminal';
      const winHeader = `${chalk.gray(host)} ${chalk.gray('·')} ${chalk.gray(shortWindowLabel(win.windowId))} ${chalk.gray(`(${win.sessions.length})`)}`;
      console.log(base + '  ' + winHeader);
      for (const s of win.sessions) printActiveRow(s, base + '    ');
    }

    for (const s of ws.flat) printActiveRow(s, base + '  ');
  }
}

/** Machine header: `▸ <name> ← this machine` for the local box (cyan), matching
 * the `ag devices list` treatment; a plain `▸ <name>` for remotes. */
function printMachineHeader(mg: MachineGroup): void {
  const marker = mg.isLocal ? chalk.cyan('▸ ') : chalk.gray('▸ ');
  const name = mg.isLocal ? chalk.bold.cyan(mg.machine) : chalk.bold(mg.machine);
  const here = mg.isLocal ? chalk.cyan('  ← this machine') : '';
  console.log(`${marker}${name} ${chalk.gray(`(${mg.total})`)}${here}`);
}

/**
 * Render the unified active-session view, grouped by machine. Local sessions
 * come from `getActiveSessions()`; unless `--local`, sessions from other
 * machines are folded in over SSH (explicit `--host` targets, else the
 * registered online devices from `ag devices`). A tip is shown when there are
 * no other machines to include.
 */
async function renderActiveSessions(
  asJson: boolean,
  waitingOnly = false,
  opts: { local?: boolean; hosts?: string[] } = {},
): Promise<void> {
  const self = machineId();
  const local = await getActiveSessions();
  for (const s of local) if (!s.machine) s.machine = self;

  let remoteDeviceCount = 0;
  let merged = local;
  if (!opts.local) {
    const remote = await gatherRemoteActive(opts.hosts);
    remoteDeviceCount = remote.deviceCount;
    merged = dedupeByMachineSession([...local, ...remote.sessions]);
  }

  // --waiting: only sessions blocked on the user. Exits non-zero when any are
  // present so a supervising agent or hook can poll it as a gate.
  const sessions = waitingOnly ? merged.filter(s => s.status === 'input_required') : merged;

  if (asJson) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
    if (waitingOnly && sessions.length > 0) process.exitCode = 1;
    return;
  }

  if (sessions.length === 0) {
    console.log(chalk.gray(waitingOnly ? 'No sessions waiting on input.' : 'No active agent sessions.'));
    if (!opts.local && !opts.hosts?.length && remoteDeviceCount === 0) printCrossMachineTip();
    return;
  }

  const grouped = groupSessionsByMachine(sessions, self);
  let firstMachine = true;
  for (const mg of grouped.machines) {
    if (!firstMachine) console.log();
    firstMachine = false;
    printMachineHeader(mg);
    renderWorkspaceLayout(mg.layout, '  ');
  }

  const runningCount = sessions.filter(s => s.status === 'running').length;
  const idleCount = sessions.filter(s => s.status === 'idle').length;
  const queuedCount = sessions.filter(s => s.status === 'queued' || s.status === 'input_required').length;

  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (idleCount > 0) parts.push(`${idleCount} idle`);
  if (queuedCount > 0) parts.push(`${queuedCount} queued`);
  const machineWord = grouped.machines.length === 1 ? 'machine' : 'machines';
  console.log(chalk.gray(`\n${sessions.length} active (${parts.join(', ')}) across ${grouped.machines.length} ${machineWord}.`));

  // Tip only when nothing else could be included and the user didn't opt out.
  if (!opts.local && !opts.hosts?.length && remoteDeviceCount === 0) printCrossMachineTip();

  // Scriptable gate: a non-zero exit when anything is waiting on the user.
  if (waitingOnly && sessions.length > 0) process.exitCode = 1;
}

/** Nudge shown when `--active` has no other machines to fold in. */
function printCrossMachineTip(): void {
  console.log(chalk.gray(
    "\nTip: include sessions from your other machines — register them with 'ag devices sync', then rerun. Use --local to skip.",
  ));
}

/** Main action handler for `agents sessions`. Routes to picker, table, or single-session render. */
async function sessionsAction(query: string | undefined, options: SessionsOptions): Promise<void> {
  // --host WITHOUT --active keeps the legacy per-host stream (each remote's raw
  // stdout under a `── host ──` banner). With --active, the hosts are folded
  // into the merged machine-grouped view instead (handled below).
  if (options.host && options.host.length > 0 && !options.active) {
    try {
      runRemoteSessions(options.host);
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    return;
  }

  if (options.active) {
    // AGENTS_SESSIONS_LOCAL is set by a parent fan-out invocation (see
    // remote-active.ts) so a peer answers for itself without recursing.
    const forceLocal = options.local === true || process.env.AGENTS_SESSIONS_LOCAL === '1';
    await renderActiveSessions(options.json === true, options.waiting === true, {
      local: forceLocal,
      hosts: options.host,
    });
    return;
  }

  if (options.cloud) {
    await runCloudSessions(query, options);
    return;
  }

  let filterOpts: FilterOptions;
  try {
    filterOpts = buildFilterOptions(options);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  const { agent, version } = parseAgentFilter(options.agent);

  // Path-like queries filter by project directory instead of text search.
  let pathFilter: string | undefined;
  let searchQuery: string | undefined;
  if (query && looksLikePath(query)) {
    const resolved = resolvePathFilter(query);
    if (!fs.existsSync(resolved)) {
      console.log(chalk.yellow(`Path not found: ${resolved}`));
      console.log(chalk.gray('Did you mean to search? Use quotes: agents sessions "' + query + '"'));
      return;
    }
    pathFilter = fs.realpathSync(resolved);
  } else {
    searchQuery = query;
  }

  // Artifact flags require a session query.
  if ((options.artifacts || options.artifact !== undefined) && !query) {
    console.error(chalk.red('--artifacts and --artifact require a session ID or query.'));
    process.exit(1);
  }

  const mode = resolveViewMode(options, filterOpts);
  // --markdown or any filter flag forces single-session render.
  const wantsRender = mode === 'markdown' || hasAnyFilter(filterOpts);

  // Artifact-list or artifact-read paths: widen scope and resolve session globally.
  if ((options.artifacts || options.artifact !== undefined) && searchQuery) {
    await renderArtifactsGlobal(searchQuery, options.artifacts ?? false, options.artifact, { agent: options.agent, project: options.project });
    return;
  }

  // When the user explicitly asks to render (via mode flag), resolve the
  // query globally so sessions outside the default cwd/30d window are found.
  if (wantsRender && searchQuery) {
    await renderOneSession(searchQuery, mode, { agent: options.agent, project: options.project, filter: filterOpts, noRedact: options.noRedact });
    return;
  }

  // Interactive picker loads a deep pool but shows only recent sessions
  // until the user starts typing. Non-interactive/JSON uses the explicit limit.
  const isInteractive = !options.json && isInteractiveTerminal();
  const limit = parseInt(options.limit || (isInteractive ? String(PICKER_POOL_LIMIT) : '50'), 10);
  const since = options.since ?? (isInteractive && !options.all ? '30d' : undefined);
  const spinner = options.json ? null : ora().start();
  const tracker = createScanProgressTracker(LOAD_VERBS, 'sessions', spinner);

  try {
    // Team-origin filter is pushed down to SQL so the LIMIT applies AFTER it.
    // Without this, a dev dir with heavy SDK spawn activity (Task subagents,
    // `agents run`, team agents) can fill the top-N window entirely with
    // hidden rows and make real CLI sessions appear to vanish.
    // 'recent' is the user-facing alias for the default timestamp sort.
    const sortBy: DiscoverOptions['sortBy'] =
      options.sort === 'cost' ? 'cost' : options.sort === 'duration' ? 'duration' : 'timestamp';

    const scope: DiscoverOptions = {
      agent,
      version,
      all: pathFilter ? undefined : options.all,
      cwd: process.cwd(),
      cwdPrefix: pathFilter,
      project: options.project,
      since,
      until: options.until,
      sortBy,
    };

    let sessions = await discoverSessions({
      ...scope,
      limit,
      excludeTeamOrigin: !options.teams,
      onProgress: tracker.onProgress,
    });

    tracker.stop();
    spinner?.stop();

    // Version filter is pushed down to SQL via scope.version above; no
    // post-filter needed. Defensive: the team-origin SQL filter covers the
    // ~100% case, but classifyTeamSession also recognizes sessions with a
    // meta.json in ~/.agents/teams/agents whose is_team_origin flag was
    // never set (legacy rows). Keep the in-memory pass so those are still
    // enriched/hidden.
    const { visible: visibleSessions } = filterTeamSessions(sessions, !!options.teams);
    sessions = visibleSessions;

    const hiddenCount = options.teams
      ? 0
      : countSessionsInScope({ ...scope, onlyTeamOrigin: true });

    // Smart ID routing: a bare query that resolves to one session renders
    // directly. If nothing matches in the scoped window and the query looks
    // like a session ID, widen to global scope (incl. Claude /resume history).
    if (searchQuery) {
      const idMatches = resolveSessionById(sessions, searchQuery);
      if (idMatches.length === 1) {
        await renderSession(idMatches[0], mode, filterOpts, options);
        return;
      }
      if (idMatches.length === 0 && looksLikeSessionId(searchQuery)) {
        await renderOneSession(searchQuery, mode, { agent: options.agent, project: options.project, filter: filterOpts, noRedact: options.noRedact });
        return;
      }
    }

    if (options.json) {
      const filtered = searchQuery ? filterSessionsByQuery(sessions, searchQuery) : sessions;
      const serializable = filtered.map(s => {
        const { _matchedTerms, _bm25Score, ...rest } = s;
        return rest;
      });
      process.stdout.write(JSON.stringify(serializable, null, 2) + '\n');
      return;
    }

    if (sessions.length === 0) {
      if (pathFilter) {
        console.log(chalk.gray(`No sessions found for ${pathFilter}.`));
      } else {
        console.log(chalk.gray(formatNoSessionsMessage(options.all, options.project)));
      }
      if (hiddenCount > 0) {
        console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
      }
      return;
    }

    // --tree is a printed grouped listing, not an interactive pick — render it
    // directly even in a TTY.
    if (isInteractiveTerminal() && !options.tree) {
      const message = pathFilter
        ? `Search sessions (${path.basename(pathFilter)}):`
        : formatSearchMessage(options);
      const picked = await pickSessionInteractive(sessions, message, searchQuery, hiddenCount);
      if (picked) {
        await handlePickedSession(picked);
        return;
      }
      return;
    }

    // Non-interactive fallback (piped output)
    const filtered = searchQuery ? filterSessionsByQuery(sessions, searchQuery) : sessions;
    const liveIndex = await maybeLiveIndex(options);
    printSessionTable(filtered, hiddenCount, options.tree === true, liveIndex);
  } catch (err: any) {
    tracker.stop();
    spinner?.stop();
    console.error(chalk.red(`Failed to discover sessions: ${err.message}`));
    process.exit(1);
  }
}

function looksLikeSessionId(query: string): boolean {
  return /^[0-9a-f-]{6,}$/i.test(query.trim());
}

function teamTag(session: SessionMeta): string {
  const origin = session.teamOrigin;
  if (!origin) return '';
  const parts = [origin.handle, origin.mode].filter(Boolean).join(' · ');
  return parts ? `[${parts}] ` : '[team] ';
}

/** Adapt a SessionMeta's persisted signals to the badge renderer's shape. */
function metaSignals(s: SessionMeta): Parameters<typeof signalBadges>[0] {
  return {
    pr: s.prUrl ? { url: s.prUrl, number: s.prNumber } : undefined,
    worktree: s.worktreeSlug ? { path: s.cwd ?? '', slug: s.worktreeSlug } : undefined,
    ticket: s.ticketId ? { id: s.ticketId } : undefined,
  };
}

/** One flat table row:
 *   shortId · agent · version · project · [glyph] label·doing · [ticket] · [wt] · time
 * `doing` is the live preview when running, else the topic. The `ticket` column
 * (tracker/PR ref, pulled out of the badge blob so refs align) is only rendered
 * when `showTicket` — otherwise a listing with no refs would waste a column of
 * dashes and needlessly truncate the topic. Worktree stays a trailing badge. */
function flatSessionRow(session: SessionMeta, live?: ActiveSession, showTicket = false): string {
  const agentColor = colorAgent(session.agent);
  const when = formatRelativeTime(session.timestamp);
  const project = session.project || '-';
  const tag = teamTag(session);
  const label = (session as any).label;
  const { glyph, preview } = liveGlyphAndPreview(live);
  // A running session's live preview says what the agent is doing now; a
  // resting one falls back to its opening topic.
  const doing = preview || (tag ? `${tag}${session.topic ?? ''}` : session.topic);
  const wt = session.worktreeSlug ? chalk.magenta(`wt:${session.worktreeSlug}`) : '';

  const TICKET_W = 10;
  const ticketCell = showTicket
    ? chalk.blue(padToWidth(truncateToWidth(ticketLabel(session) || '-', TICKET_W), TICKET_W + 1))
    : '';
  const glyphW = glyph ? 2 : 0;
  const ticketW = showTicket ? TICKET_W + 1 : 0;
  const wtW = wt ? stringWidth(wt) + 1 : 0;
  const topicW = Math.max(16, terminalWidth() - (10 + 9 + 8 + 16) - glyphW - ticketW - wtW - stringWidth(when) - 1);

  return (
    chalk.white(padToWidth(truncateToWidth(session.shortId, 9), 10)) +
    agentColor(padToWidth(truncateToWidth(session.agent, 8), 9)) +
    chalk.yellow(padToWidth(truncateToWidth(session.version || '-', 7), 8)) +
    chalk.cyan(padToWidth(truncateToWidth(project, 14), 16)) +
    (glyph ? glyph + ' ' : '') +
    renderTopicCell(label, doing, '', topicW, topicW) +
    ticketCell +
    (wt ? wt + ' ' : '') +
    chalk.gray(when)
  );
}

/** One tree-mode row (grouped under a dir header): id · agent · badges · topic · time. No version/project column. */
function treeSessionRow(session: SessionMeta, live?: ActiveSession): string {
  const agentColor = colorAgent(session.agent);
  const when = formatRelativeTime(session.timestamp);
  const tag = teamTag(session);
  const label = (session as any).label;
  const { glyph, preview } = liveGlyphAndPreview(live);
  const topic = (preview || (tag ? `${tag}${session.topic ?? ''}` : session.topic)) || '-';
  const badges = signalBadges(metaSignals(session));
  const badgeW = badges ? stringWidth(badges) + 1 : 0;
  const head = label ? `${label} · ${topic}` : topic;
  const glyphW = glyph ? 2 : 0;
  const topicW = Math.max(12, terminalWidth() - (2 + 9 + 8) - glyphW - badgeW - stringWidth(when) - 1);

  return (
    '  ' +
    chalk.dim(padToWidth(session.shortId, 9)) +
    agentColor(padToWidth(truncateToWidth(session.agent, 7), 8)) +
    (badges ? badges + ' ' : '') +
    (glyph ? glyph + ' ' : '') +
    padToWidth(chalk.white(truncateToWidth(head, topicW)), topicW) +
    ' ' + chalk.gray(when)
  );
}

/**
 * Live-session index for enriching the default listing, or undefined when
 * enrichment is off (`--no-live`) or irrelevant (`--json`, which serializes
 * SessionMeta). Full detection (incl. the headless `ps` scan) is deliberate:
 * bare-CLI and tmux agents are the common case here, and skipping them would
 * leave the glyph almost never showing. The listing is a one-shot user action,
 * not a hot loop, so the `ps`/`lsof` cost is acceptable; `--no-live` is the
 * escape hatch. Never throws — a probe failure just yields a plain listing.
 */
async function maybeLiveIndex(options: SessionsOptions): Promise<Map<string, ActiveSession> | undefined> {
  if (options.live === false || options.json) return undefined;
  try {
    return indexActiveBySessionId(await getActiveSessions());
  } catch {
    return undefined;
  }
}

function printSessionTable(sessions: SessionMeta[], hiddenCount = 0, tree = false, liveIndex?: Map<string, ActiveSession>): void {
  if (tree) {
    // Group by directory; drop the id/version columns from view. The short id
    // stays as each row's leading handle (the address to read/resume it).
    const byDir = new Map<string, SessionMeta[]>();
    for (const s of sessions) {
      const key = s.cwd || s.project || 'unknown';
      (byDir.get(key) ?? byDir.set(key, []).get(key)!).push(s);
    }
    const keys = [...byDir.keys()].sort((a, b) => {
      const d = byDir.get(b)!.length - byDir.get(a)!.length;
      return d !== 0 ? d : a.localeCompare(b);
    });
    let first = true;
    for (const key of keys) {
      if (!first) console.log();
      first = false;
      const group = byDir.get(key)!;
      console.log(`${chalk.cyan.bold(shortCwd(key))} ${chalk.gray(`(${group.length})`)}`);
      for (const s of group) console.log(treeSessionRow(s, liveIndex?.get(s.id)));
    }
    const dirWord = keys.length === 1 ? 'directory' : 'directories';
    console.log(chalk.gray(`\n${sessions.length} session${sessions.length === 1 ? '' : 's'} across ${keys.length} ${dirWord}.`));
    if (hiddenCount > 0) console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
    return;
  }

  // Only show the ticket column when at least one row carries a ref — otherwise
  // it's a column of dashes that steals width from every topic.
  const showTicket = sessions.some((s) => ticketLabel(s) !== '');
  for (const session of sessions) console.log(flatSessionRow(session, liveIndex?.get(session.id), showTicket));

  const countLine = `${sessions.length} session${sessions.length === 1 ? '' : 's'}.`;
  console.log(chalk.gray(`\n${countLine}`));
  if (hiddenCount > 0) {
    console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
  }
}

function buildFilterOptions(options: SessionsOptions): FilterOptions {
  const opts: FilterOptions = {};
  if (options.include) opts.include = parseRoleList(options.include, '--include');
  if (options.exclude) opts.exclude = parseRoleList(options.exclude, '--exclude');
  if (opts.include && opts.exclude) {
    throw new Error('--include and --exclude are mutually exclusive');
  }
  const parseCount = (raw: string, flag: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`${flag} expects a positive integer, got "${raw}"`);
    }
    return n;
  };
  if (options.first !== undefined) opts.first = parseCount(options.first, '--first');
  if (options.last !== undefined) opts.last = parseCount(options.last, '--last');
  if (opts.first !== undefined && opts.last !== undefined) {
    throw new Error('--first and --last are mutually exclusive');
  }
  return opts;
}

function hasAnyFilter(opts: FilterOptions): boolean {
  return !!(opts.include?.length || opts.exclude?.length || opts.first !== undefined || opts.last !== undefined);
}

/**
 * Default is summary. Any explicit format flag wins. When filters are present
 * without a format, default to markdown since summary is an aggregate view
 * that filters don't meaningfully narrow.
 */
function resolveViewMode(options: SessionsOptions, filters: FilterOptions): ViewMode {
  if (options.markdown) return 'markdown';
  if (options.json) return 'json';
  if (hasAnyFilter(filters)) return 'markdown';
  return 'summary';
}

/**
 * Render a session's full transcript to stdout — the non-follow view behind
 * `agents logs <sessionId>`. Reuses the same markdown renderer as
 * `agents sessions <id> --markdown`.
 */
export async function renderSessionLog(session: SessionMeta): Promise<void> {
  await renderSession(session, 'markdown', {});
}

async function renderSession(
  session: SessionMeta,
  mode: ViewMode,
  filters: FilterOptions,
  options: Pick<SessionsOptions, 'noRedact'> = {},
): Promise<void> {
  // OpenCode stores sessions in SQLite; filePath is "db_path#session_id"
  const realPath = session.filePath.split('#')[0];
  if (!fs.existsSync(realPath)) {
    console.log(chalk.yellow('Session transcript not available (file no longer exists).'));
    console.log(chalk.gray(`Path: ${session.filePath}`));
    if (session.version) console.log(chalk.gray(`Version: ${session.agent} ${session.version}`));
    if (session.project) console.log(chalk.gray(`Project: ${session.project}`));
    if (session.account) console.log(chalk.gray(`Account: ${session.account}`));
    console.log(chalk.gray(`Time: ${session.timestamp}`));
    return;
  }

  const spinner = ora(`Parsing ${session.agent} session...`).start();
  let events = parseSession(session.filePath, session.agent);
  spinner.stop();

  events = filterEvents(events, filters);

  const agentColor = colorAgent(session.agent);
  console.log('');

  if (mode === 'summary') {
    const stats = computeSummaryStats(events);
    const modelStr = stats.models.length > 0 ? chalk.yellow(`  ${stats.models.join(', ')}`) : '';
    const branchStr = session.gitBranch ? chalk.gray(` (${session.gitBranch})`) : '';
    const absTime = formatAbsoluteTime(session.timestamp);

    // Auto-inferred title headline (user /rename > Claude ai-title > first-prompt
    // topic) — the fastest way to recognize which task this session is.
    const title = (session as any).label || session.topic;
    if (title) {
      const badges = signalBadges(metaSignals(session));
      console.log(chalk.bold.white(title) + (badges ? '  ' + badges : ''));
    }
    console.log(
      agentColor(session.agent) +
      (session.version ? chalk.yellow(` ${session.version}`) : '') +
      modelStr +
      (session.project ? chalk.cyan(`  ${session.project}`) + branchStr : branchStr) +
      chalk.gray(`  ${absTime} (${formatRelativeTime(session.timestamp)})`) +
      (session.account ? chalk.gray(` · ${session.account}`) : '')
    );
    const statsLine = renderSummaryHeader(stats);
    if (statsLine) console.log(chalk.gray(statsLine));
    console.log(chalk.gray('─'.repeat(60)));

    process.stdout.write(renderSummary(events, session.cwd));
    return;
  }

  if (mode === 'markdown') {
    console.log(
      agentColor(session.agent) +
      (session.version ? chalk.yellow(` ${session.version}`) : '') +
      (session.project ? chalk.cyan(` ${session.project}`) : '') +
      chalk.gray(` ${formatRelativeTime(session.timestamp)}`) +
      (session.account ? chalk.gray(` (${session.account})`) : '')
    );
    console.log(chalk.gray('─'.repeat(60)));
    process.stdout.write(renderMarkdown(renderConversationMarkdown(events, { redact: options.noRedact !== true })));
    return;
  }

  // json — no header, raw events only (pipeable)
  process.stdout.write(renderJson(events));
}

function renderTopicCell(
  label: string | undefined | null,
  topic: string | undefined | null,
  query: string,
  visibleWidth: number,
  paddedWidth: number,
): string {
  const lbl = (label ?? '').trim();
  const tpc = (topic ?? '').trim();
  const sep = ' · ';
  const raw = lbl && tpc ? `${lbl}${sep}${tpc}` : (lbl || tpc);
  // Width-aware: measure/truncate/pad by display cells, not String.length, so
  // ANSI escapes and wide (CJK/emoji) glyphs don't drift the column.
  const visible = truncateToWidth(raw, visibleWidth);
  const padding = ' '.repeat(Math.max(0, paddedWidth - stringWidth(visible)));
  const labelEnd = lbl ? Math.min(lbl.length, visible.length) : 0;

  let matchStart = -1, matchEnd = -1;
  const q = query.trim().toLowerCase();
  if (q) {
    const lower = visible.toLowerCase();
    for (const term of q.split(/\s+/).filter(Boolean)) {
      const idx = lower.indexOf(term);
      if (idx !== -1) { matchStart = idx; matchEnd = idx + term.length; break; }
    }
  }

  const cuts = new Set<number>([0, labelEnd, visible.length]);
  if (matchStart >= 0) { cuts.add(matchStart); cuts.add(matchEnd); }
  const boundaries = [...cuts].sort((a, b) => a - b);

  let out = '';
  for (let i = 0; i < boundaries.length - 1; i++) {
    const s = boundaries[i], e = boundaries[i + 1];
    if (s >= e) continue;
    const text = visible.slice(s, e);
    const isLabel = s < labelEnd;
    const isMatch = matchStart >= 0 && s >= matchStart && e <= matchEnd;
    out += (isMatch || isLabel) ? chalk.bold.white(text) : chalk.white(text);
  }
  return out + padding;
}

export function formatPickerLabel(s: SessionMeta, query: string): string {
  const agentColor = colorAgent(s.agent);
  const when = formatRelativeTime(s.timestamp);
  const project = s.project || '-';
  const tag = teamTag(s);
  const label = (s as any).label;
  const topic = tag ? `${tag}${s.topic ?? ''}` : s.topic;
  const versionStr = s.version || '-';

  return (
    chalk.white(padRight(s.shortId, 10)) +
    agentColor(padRight(truncate(s.agent, 8), 9)) +
    chalk.yellow(padRight(truncate(versionStr, 7), 8)) +
    chalk.cyan(padRight(truncate(project, 14), 16)) +
    renderTopicCell(label, topic, query, 48, 50) +
    chalk.gray(when)
  );
}

export async function pickSessionInteractive(
  sessions: SessionMeta[],
  message = 'Search sessions:',
  initialSearch?: string,
  hiddenCount = 0,
): Promise<PickedSession | null> {
  if (hiddenCount > 0) {
    console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
  }
  try {
    return await sessionPicker({
      message,
      sessions,
      filter: (query: string) => {
        // No query: show the full pool (picker viewport still paginates via pageSize).
        // Typing: search the full pool.
        if (!query.trim()) return sessions;
        return filterSessionsByQuery(sessions, query);
      },
      labelFor: (s: SessionMeta, query: string) => formatPickerLabel(s, query),
      pageSize: PICKER_RECENT_COUNT,
      initialSearch,
    });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

async function handlePickedSession(picked: PickedSession): Promise<void> {
  if (picked.action === 'view') {
    await renderSession(picked.session, 'summary', {});
    return;
  }
  await resumeSessionInPlace(picked.session);
}

/**
 * Resume a session in the current terminal — a foreground takeover of this
 * process. Used by the single-select picker and by `sessions resume` when the
 * chosen destination is "in place" (unknown emulator / off-macOS, single pick).
 * Falls back to the current version via `/continue` when the version-pinned
 * binary is missing (ENOENT).
 */
export async function resumeSessionInPlace(session: SessionMeta): Promise<void> {
  const cwd = session.cwd && fs.existsSync(session.cwd)
    ? session.cwd
    : process.cwd();

  const resume = buildResumeCommand(session);
  if (!resume) {
    console.log(chalk.yellow(
      `Resume is not supported for ${session.agent} sessions yet. Showing summary instead.`
    ));
    await renderSession(session, 'summary', {});
    return;
  }

  console.log(chalk.gray(`Resuming: ${resume.join(' ')} (cwd: ${cwd})`));

  await new Promise<void>((resolve) => {
    const child = spawn(resume[0], resume.slice(1), {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', (err: any) => {
      if (err.code === 'ENOENT' && session.version) {
        const fallback = buildFallbackCommand(session);
        if (fallback) {
          console.log(chalk.gray(
            `Version ${session.version} is not installed. Falling back to current version via /continue...`
          ));
          const fb = spawn(fallback[0], fallback.slice(1), { cwd, stdio: 'inherit', shell: false });
          fb.on('error', (e: any) => { console.error(chalk.red(`Failed: ${e.message}`)); resolve(); });
          fb.on('close', () => resolve());
          return;
        }
      }
      console.error(chalk.red(`Failed to launch ${resume[0]}: ${err.message}`));
      if (err.code === 'ENOENT') {
        console.error(chalk.gray(`Make sure '${resume[0]}' is on your PATH.`));
      }
      resolve();
    });
    child.on('close', () => resolve());
  });
}

/**
 * Build the shell command that resumes a picked session.
 *
 * When the session's originating version is known, uses the version-pinned
 * binary (e.g. `claude@2.1.138`) so the resume always runs in the same
 * isolated HOME where the JSONL was written — regardless of which version is
 * currently the default. Falls back to the bare shim when version is unknown.
 *
 * If the versioned binary is missing (version was removed), the ENOENT
 * handler in handlePickedSession retries via buildFallbackCommand.
 */
export function buildResumeCommand(session: SessionMeta): string[] | null {
  switch (session.agent) {
    case 'claude':
      if (session.version) return [`claude@${session.version}`, '--resume', session.id];
      return ['claude', '--resume', session.id];
    case 'codex':
      if (session.version) return [`codex@${session.version}`, 'resume', session.id];
      return ['codex', 'resume', session.id];
    case 'opencode':
      return ['opencode', '--session', session.id];
    case 'gemini':
    case 'antigravity':
    case 'openclaw':
    case 'rush':
    case 'hermes':
    case 'grok':
    case 'kimi':
    case 'droid':
      // Grok (and some others) sessions are captured artifacts, not resumable the same way.
      return null;
  }
}

/** Fallback resume command when the versioned binary is unavailable (ENOENT). */
function buildFallbackCommand(session: SessionMeta): string[] | null {
  switch (session.agent) {
    case 'claude': return ['claude', `/continue ${session.id}`];
    case 'codex':  return ['codex', `/continue ${session.id}`];
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Cloud session source (--cloud)
// ---------------------------------------------------------------------------

/**
 * Handle `agents sessions --cloud [id] [filters]`.
 * - Without id: list captured cloud-runs, optionally as JSON.
 * - With id: fetch the jsonl, parse with the recorded format, render via
 *   the same pipeline as local sessions (summary / markdown / json).
 */
async function runCloudSessions(query: string | undefined, options: SessionsOptions): Promise<void> {
  const { discoverCloudSessions, ensureCloudSessionCached } = await import('../lib/session/cloud.js');

  let filterOpts: FilterOptions;
  try {
    filterOpts = buildFilterOptions(options);
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  const mode = resolveViewMode(options, filterOpts);
  const spinner = options.json ? null : ora('Loading cloud sessions...').start();

  let sessions: SessionMeta[];
  try {
    sessions = await discoverCloudSessions({ limit: parseInt(options.limit || '50', 10) });
  } catch (err: any) {
    spinner?.stop();
    console.error(chalk.red(`Failed to list cloud sessions: ${err?.message || err}`));
    process.exit(1);
  }
  spinner?.stop();

  if (!query) {
    if (options.json) {
      process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
      return;
    }
    if (sessions.length === 0) {
      console.log(chalk.gray('No cloud sessions captured yet.'));
      return;
    }
    printSessionTable(sessions);
    return;
  }

  const matches = sessions.filter(
    (s) => s.id === query || s.shortId === query || s.id.startsWith(query),
  );
  if (matches.length === 0) {
    console.error(chalk.red(`No cloud session matching: ${query}`));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(chalk.red(`Multiple cloud sessions match "${query}":`));
    for (const m of matches.slice(0, 10)) {
      console.error(chalk.cyan(`  ${m.shortId}  ${m.id}`));
    }
    process.exit(1);
  }

  const meta = matches[0];
  const cachedSpinner = options.json ? null : ora('Fetching session...').start();
  let cachedPath: string;
  try {
    cachedPath = await ensureCloudSessionCached(meta.id);
  } catch (err: any) {
    cachedSpinner?.stop();
    console.error(chalk.red(`Failed to fetch session: ${err?.message || err}`));
    process.exit(1);
  }
  cachedSpinner?.stop();

  // Ensure the SessionMeta points at the local cache path for renderSession.
  await renderSession({ ...meta, filePath: cachedPath }, mode, filterOpts, options);
}


interface AgentFilter {
  agent?: SessionAgentId;
  version?: string;
}

export function parseAgentFilter(agentName?: string): AgentFilter {
  if (!agentName) return {};
  const [name, version] = agentName.split('@', 2);
  let agent: SessionAgentId | null = SESSION_AGENTS.includes(name as SessionAgentId)
    ? (name as SessionAgentId)
    : null;
  if (!agent) {
    // Aliases and single-typo corrections (cladue -> claude). SESSION_AGENTS
    // includes ids (rush, hermes) that resolveAgentName doesn't know, so fall
    // back to fuzzy-matching the session list directly.
    const resolved = resolveAgentName(name);
    if (resolved && SESSION_AGENTS.includes(resolved as SessionAgentId)) {
      agent = resolved as SessionAgentId;
    } else {
      agent = fuzzyMatch(name, SESSION_AGENTS, FUZZY_PRESETS.agents);
    }
  }
  if (!agent) {
    console.error(chalk.red(`Unknown agent: ${name}. Use: ${SESSION_AGENTS.join(', ')}`));
    process.exit(1);
  }
  return { agent, version };
}

function formatSearchMessage(options: SessionFilterOptions): string {
  const filters: string[] = [];
  if (options.agent) filters.push(`agent: ${options.agent}`);
  if (options.project?.trim()) filters.push(`project: ${options.project.trim()}`);
  if (filters.length === 0) return 'Search sessions:';
  return `Search sessions (${filters.join(', ')}):`;
}

/** Filter and rank sessions by a multi-term search query across metadata and content. */
export function filterSessionsByQuery(
  sessions: SessionMeta[],
  query: string | undefined,
): SessionMeta[] {
  const trimmed = query?.trim().toLowerCase() || '';
  if (!trimmed) return sessions;

  const terms = trimmed.split(/\s+/).filter(Boolean);
  const contentIndex = searchContentIndex(sessions, trimmed);

  // If the query exactly matches a session label, short-circuit the structural
  // scorer (which would otherwise surface every session whose topic happens to
  // contain the same words) and return only the label hits.
  const EXACT_LABEL_SCORE = 1_000_000;
  const exactLabelHits = [...contentIndex.values()].filter(
    s => (s._bm25Score ?? 0) >= EXACT_LABEL_SCORE,
  );
  if (exactLabelHits.length > 0) {
    return exactLabelHits.sort(
      (a, b) => (b._bm25Score ?? 0) - (a._bm25Score ?? 0),
    );
  }

  return sessions
    .map(session => ({ session, score: scoreSessionQuery(session, terms) }))
    .filter(entry => {
      // Include if scored by topic/project/etc, or matched by content search
      if (entry.score > 0) return true;
      const contentMatch = contentIndex.get(entry.session.id);
      if (contentMatch && contentMatch._matchedTerms && contentMatch._matchedTerms.length > 0) {
        return true;
      }
      return false;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const cmA = contentIndex.get(a.session.id);
      const cmB = contentIndex.get(b.session.id);
      const bmA = cmA?._bm25Score ?? 0;
      const bmB = cmB?._bm25Score ?? 0;
      if (bmB !== bmA) return bmB - bmA;
      return new Date(b.session.timestamp).getTime() - new Date(a.session.timestamp).getTime();
    })
    .map(entry => {
      // Attach content match terms for highlighting
      const cm = contentIndex.get(entry.session.id);
      if (cm && cm._matchedTerms) {
        return { ...cm };
      }
      return entry.session;
    });
}

function scoreSessionQuery(session: SessionMeta, terms: string[]): number {
  let score = 0;

  for (const term of terms) {
    const exactId = session.id.toLowerCase() === term || session.shortId.toLowerCase() === term;
    const prefixId = session.id.toLowerCase().startsWith(term) || session.shortId.toLowerCase().startsWith(term);
    const topic = session.topic?.toLowerCase() || '';
    const project = session.project?.toLowerCase() || '';
    const account = session.account?.toLowerCase() || '';
    const cwd = session.cwd?.toLowerCase() || '';
    const agent = session.agent.toLowerCase();
    const version = session.version?.toLowerCase() || '';

    let termScore = 0;
    if (exactId) termScore = 1000;
    else if (prefixId) termScore = 900;
    else if (topic.startsWith(term)) termScore = 700;
    else if (project.startsWith(term)) termScore = 600;
    else if (account.startsWith(term)) termScore = 550;
    else if (agent.startsWith(term) || version.startsWith(term)) termScore = 500;
    else if (topic.includes(term)) termScore = 400;
    else if (project.includes(term)) termScore = 300;
    else if (account.includes(term)) termScore = 250;
    else if (cwd.includes(term)) termScore = 200;
    else if (version.includes(term) || agent.includes(term)) termScore = 150;
    else return 0;

    score += termScore;
  }

  return score;
}

/**
 * Narrow a session list by --project and --agent before search resolution.
 * Without this, a query like "scoped search" could match sessions in BOTH
 * the project you specified AND elsewhere, producing an ambiguity error
 * even though the user already pointed at the correct scope.
 */
function applyScopeFilters(
  sessions: SessionMeta[],
  scope: { agent?: string; project?: string },
): SessionMeta[] {
  let filtered = sessions;

  if (scope.project) {
    const projectQuery = scope.project.toLowerCase();
    filtered = filtered.filter((s) => {
      const project = (s.project || '').toLowerCase();
      const cwd = (s.cwd || '').toLowerCase();
      return project.includes(projectQuery) || cwd.includes(projectQuery);
    });
  }

  if (scope.agent) {
    // Accept "claude" or "claude@2.1.112" / "claude@default" / "claude@latest". Version suffix narrows further.
    const [wantAgent, rawVersion] = scope.agent.split('@');
    const resolvedAgent = resolveAgentName(wantAgent);
    const wantVersion = resolvedAgent ? resolveVersionAliasLoose(resolvedAgent, rawVersion) : rawVersion;
    filtered = filtered.filter((s) => {
      if (s.agent !== wantAgent) return false;
      if (wantVersion && s.version !== wantVersion) return false;
      return true;
    });
  }

  return filtered;
}

async function renderArtifactsGlobal(
  query: string,
  listAll: boolean,
  name: string | undefined,
  scope: { agent?: string; project?: string },
): Promise<void> {
  const spinner = ora().start();
  const tracker = createScanProgressTracker(FIND_VERBS, 'session', spinner);

  try {
    const discovered = await discoverSessions({
      all: true,
      cwd: process.cwd(),
      limit: 5000,
      onProgress: tracker.onProgress,
    });
    tracker.stop();

    const allSessions = applyScopeFilters(discovered, scope);
    const matches = resolveSessionById(allSessions, query);
    const queryMatches = matches.length > 0 ? matches : filterSessionsByQuery(allSessions, query);

    if (queryMatches.length === 0) {
      spinner.stop();
      console.error(chalk.red(`No session found matching: ${query}`));
      process.exit(1);
    }
    if (queryMatches.length > 1) {
      spinner.stop();
      console.error(chalk.red(`Multiple sessions match "${query}":`));
      for (const m of queryMatches.slice(0, 10)) {
        console.error(chalk.cyan(`  ${m.shortId}  ${m.id}  ${(m as any).label ?? m.topic ?? ''}`));
      }
      console.error(chalk.gray('Pass a longer ID to narrow it down.'));
      process.exit(1);
    }

    spinner.stop();
    await renderArtifactsForSession(queryMatches[0], listAll, name);
  } catch (err: any) {
    if (isPromptCancelled(err)) return;
    tracker.stop();
    spinner.stop();
    console.error(chalk.red(`Failed to read session: ${err.message}`));
    process.exit(1);
  }
}

async function renderOneSession(
  query: string,
  mode: ViewMode,
  scope: { agent?: string; project?: string; filter: FilterOptions; noRedact?: boolean },
): Promise<void> {
  const spinner = ora().start();
  const tracker = createScanProgressTracker(FIND_VERBS, 'session', spinner);

  try {
    const discovered = await discoverSessions({
      all: true,
      cwd: process.cwd(),
      limit: 5000,
      onProgress: tracker.onProgress,
    });
    tracker.stop();

    const allSessions = applyScopeFilters(discovered, scope);
    let session: SessionMeta | undefined;

    const matches = resolveSessionById(allSessions, query);
    let queryMatches: SessionMeta[] = matches.length > 0 ? matches : filterSessionsByQuery(allSessions, query);

    if (queryMatches.length === 0) {
      const contentResults = searchContentIndex(allSessions, query);
      if (contentResults.size > 0) {
        const matchedSessions = Array.from(contentResults.values())
          .sort((a, b) => (b._bm25Score ?? 0) - (a._bm25Score ?? 0));
        if (matchedSessions.length === 1) {
          session = matchedSessions[0];
        } else {
          queryMatches = matchedSessions;
        }
      }
    }

    if (queryMatches.length === 0 && !session) {
      spinner.stop();
      const historyEntry = findClaudeHistoryEntry(query);
      if (historyEntry) {
        const resumeMatch = resolveClaudeHistoryEntryToTranscript(historyEntry, allSessions);
        if (resumeMatch) {
          session = resumeMatch.session;
        } else {
          renderClaudeHistoryOnlyId(query, historyEntry, allSessions);
          process.exit(1);
        }
      } else {
        console.error(chalk.red(`No session found matching: ${query}`));
        console.error(chalk.gray('Run "agents sessions" to browse sessions.'));
        process.exit(1);
      }
    }

    if (!session) {
      if (queryMatches.length > 1) {
        spinner.stop();
        console.error(chalk.red(`Multiple sessions match "${query}":`));
        for (const match of queryMatches.slice(0, 10)) {
          console.error(chalk.cyan(`  ${match.shortId}  ${match.id}  ${(match as any).label ?? match.topic ?? ''}`));
        }
        console.error(chalk.gray('Pass a longer ID to narrow it down.'));
        process.exit(1);
      } else {
        session = queryMatches[0];
      }
    }

    if (!session) {
      throw new Error('Session resolution failed');
    }

    spinner.stop();
    await renderSession(session, mode, scope.filter, { noRedact: scope.noRedact });
  } catch (err: any) {
    if (isPromptCancelled(err)) return;
    tracker.stop();
    spinner.stop();
    console.error(chalk.red(`Failed to read session: ${err.message}`));
    process.exit(1);
  }
}

/** Register the `agents sessions` command with all its options and help text. */
export function registerSessionsCommands(program: Command): void {
  const sessionsCmd = program
    .command('sessions')
    .argument('[query]', 'Session ID, search query, or path (., ../, /path) to filter by project')
    .description('Find, browse, and read agent conversation transcripts across Claude, Codex, Gemini, and OpenCode.')
    .option('-a, --agent <agent>', 'Filter by agent type and version (e.g., claude, codex@0.116.0)')
    .option('--all', 'Include sessions from every directory (not just current project)')
    .option('--teams', 'Include team-spawned sessions (hidden by default)')
    .option('--project <name>', 'Filter by project name (searches across all directories)')
    .option('--since <time>', 'Only sessions newer than this (e.g., 2h, 7d, 4w, or ISO date)')
    .option('--until <time>', 'Only sessions older than this (ISO timestamp)')
    .option('-n, --limit <n>', 'Maximum number of sessions to return', '50')
    .option('--sort <field>', 'Sort the list by: recent (default), cost, or duration')
    .option('--markdown', 'Render the session as markdown (user, assistant, thinking, tool calls)')
    .option('--no-redact', 'Disable default secret redaction in markdown session output')
    .option('--json', 'Output JSON (session list when browsing, event array when rendering one session)')
    .option('--include <roles>', 'Only include these roles (comma-separated): user, assistant, thinking, tools')
    .option('--exclude <roles>', 'Exclude these roles (comma-separated): user, assistant, thinking, tools')
    .option('--first <n>', 'Keep only the first N turns (a turn starts at each user message)')
    .option('--last <n>', 'Keep only the last N turns (a turn starts at each user message)')
    .option('--artifacts', 'List all files written or edited during a session')
    .option('--artifact <name>', 'Read a specific artifact by filename or path (outputs to stdout)')
    .option('--active', 'Show only sessions running right now across terminals, teams, cloud, and headless agents')
    .option('--local', 'With --active: only this machine — skip the cross-machine SSH fan-out')
    .option('--waiting', 'With --active: show only sessions waiting on your input (exits non-zero if any)')
    .option('--tree', 'Group the listing by directory; drops the id/version columns for readability')
    .option('--no-live', 'Do not enrich the listing with live status/preview for running sessions')
    .option('--cloud', 'Source sessions from Rush Cloud (captured runs) instead of local disk')
    .option('-H, --host <target...>', 'Run this query on remote machine(s) over SSH (host alias or user@host; repeatable)');

  setHelpSections(sessionsCmd, {
    examples: `
      # Search prior sessions in this project by topic, file path, or command
      agents sessions "add auth middleware"

      # Read a session as markdown (user + assistant + thinking + tools)
      agents sessions a1b2c3d4 --markdown

      # Just the user turns — useful for recalling intent
      agents sessions a1b2c3d4 --include user

      # Show only what's running right now (terminals, teams, cloud, headless)
      agents sessions --active

      # Search across every directory, not just this project
      agents sessions "topic" --all

      # Export for analysis
      agents sessions --since 30d --limit 200 --json > sessions.json

      # Search another machine's sessions live over SSH (no sync needed)
      agents sessions "auth bug" --last 3 --host yosemite-s1

      # Fan the same query out across several machines
      agents sessions --all "deploy script" --host box-a --host box-b
    `,
    notes: `
      - --host runs the query on the remote's own index over SSH (host alias or user@host); repeat or pass several to fan out. SSH access is the only auth.
      - --include and --exclude are mutually exclusive.
      - --first and --last are mutually exclusive.
      - A filter flag (--include/--exclude/--first/--last) without --markdown/--json defaults to --markdown output.
      - --cloud sources from Rush Cloud captured runs instead of local disk.
      - Without --teams, team-spawned sessions are hidden by default.
    `,
  });

  sessionsCmd.action(async (query: string | undefined, options: SessionsOptions) => {
    await sessionsAction(query, options);
  });

  registerSessionsTailCommand(sessionsCmd);
  registerSessionsSyncCommand(sessionsCmd);
  registerSessionsResumeCommand(sessionsCmd);
}

function formatNoSessionsMessage(
  showAll: boolean | undefined,
  project?: string,
): string {
  const projectQuery = project?.trim();
  if (projectQuery) {
    return `No sessions found for project "${projectQuery}".`;
  }
  if (showAll) return 'No sessions found.';
  const command = 'agents sessions --all';
  return `No sessions found for ${process.cwd()}. Run "${command}" to see sessions from every directory.`;
}

function formatTeamHiddenFooter(hiddenCount: number): string {
  const noun = hiddenCount === 1 ? 'team session' : 'team sessions';
  return `(${hiddenCount} ${noun} hidden — use --teams to show, or \`agents teams status\`)`;
}

function findClaudeHistoryEntry(idQuery: string): ClaudeHistoryEntry | null {
  const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (!fs.existsSync(historyPath)) return null;

  try {
    const lines = fs.readFileSync(historyPath, 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.sessionId !== idQuery) continue;

      const timestampMs = typeof parsed.timestamp === 'number'
        ? parsed.timestamp
        : typeof parsed.timestamp === 'string'
          ? Date.parse(parsed.timestamp)
          : undefined;

      return {
        sessionId: parsed.sessionId,
        display: typeof parsed.display === 'string' ? parsed.display : undefined,
        project: typeof parsed.project === 'string' ? parsed.project : undefined,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
        historyPath,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function renderClaudeHistoryOnlyId(
  idQuery: string,
  historyEntry: ClaudeHistoryEntry,
  allSessions: SessionMeta[],
): void {
  console.error(chalk.red(`No transcript session found matching: ${idQuery}`));
  console.error(chalk.yellow('This ID exists in Claude history, but not as a saved transcript session.'));
  console.error(chalk.gray(`History file: ${historyEntry.historyPath}`));

  if (historyEntry.display) {
    console.error(chalk.gray(`History entry: ${historyEntry.display}`));
  }

  if (historyEntry.project) {
    console.error(chalk.gray(`Project root: ${historyEntry.project}`));
  }

  if (historyEntry.timestampMs) {
    console.error(chalk.gray(`History time: ${new Date(historyEntry.timestampMs).toISOString()}`));
  }

  const relatedSessions = findClaudeSessionsInProject(allSessions, historyEntry);
  if (relatedSessions.length > 0) {
    console.error(chalk.gray('Claude transcript sessions in the same project tree:'));
    for (const session of relatedSessions) {
      console.error(
        chalk.gray(
          `  ${session.shortId}  ${session.id}  ${session.project || '-'}  ${formatRelativeTime(session.timestamp)}`
        )
      );
    }

    console.error(chalk.gray('Use one of the transcript IDs above with "agents sessions <id>".'));
    return;
  }

  if (historyEntry.display === '/resume') {
    console.error(chalk.gray('This looks like a Claude /resume history entry. In this case, the resumed conversation continued under a different transcript session ID.'));
  }

  const projectHint = historyEntry.project ? path.basename(historyEntry.project) : 'the project';
  console.error(chalk.gray(`Try "agents sessions --agent claude --project ${projectHint}" to find the resumed transcript session.`));
}

function findClaudeSessionsInProject(
  sessions: SessionMeta[],
  historyEntry: ClaudeHistoryEntry,
): SessionMeta[] {
  return findClaudeProjectSessions(sessions, historyEntry)
    .sort((a, b) => sessionDistance(a, historyEntry) - sessionDistance(b, historyEntry))
    .slice(0, 3);
}

function findClaudeProjectSessions(
  sessions: SessionMeta[],
  historyEntry: ClaudeHistoryEntry,
): SessionMeta[] {
  if (!historyEntry.project) return [];
  // Resolve symlinks (e.g. macOS /var -> /private/var) so we match sessions
  // whose cwd was canonicalized at scan time.
  let projectRoot = historyEntry.project;
  try { projectRoot = fs.realpathSync(projectRoot); } catch { /* dir gone */ }

  return sessions.filter(session =>
    session.agent === 'claude' &&
    typeof session.cwd === 'string' &&
    isWithinProject(session.cwd, projectRoot)
  );
}

function resolveClaudeHistoryEntryToTranscript(
  historyEntry: ClaudeHistoryEntry,
  sessions: SessionMeta[],
): ClaudeResumeMatch | null {
  if (historyEntry.display !== '/resume') return null;

  const candidates = findClaudeProjectSessions(sessions, historyEntry);
  const matches: ClaudeResumeMatch[] = [];

  for (const session of candidates) {
    const resumeTimestampMs = findClaudeResumeTimestamp(session.filePath, historyEntry.timestampMs);
    if (resumeTimestampMs === null) continue;

    const deltaMs = historyEntry.timestampMs === undefined
      ? 0
      : Math.abs(resumeTimestampMs - historyEntry.timestampMs);

    if (historyEntry.timestampMs !== undefined && deltaMs > CLAUDE_RESUME_MATCH_WINDOW_MS) {
      continue;
    }

    matches.push({ session, resumeTimestampMs, deltaMs });
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (a.deltaMs !== b.deltaMs) return a.deltaMs - b.deltaMs;
    return b.resumeTimestampMs - a.resumeTimestampMs;
  });

  const [best, second] = matches;
  if (second && best.deltaMs === second.deltaMs && best.resumeTimestampMs === second.resumeTimestampMs) {
    return null;
  }

  return best;
}

function findClaudeResumeTimestamp(filePath: string, targetTimestampMs?: number): number | null {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    let bestTimestampMs: number | null = null;

    for (const line of lines) {
      if (!line.includes('SessionStart:resume')) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (parsed.attachment?.hookName !== 'SessionStart:resume') continue;

      const timestampMs = Date.parse(parsed.timestamp || '');
      if (Number.isNaN(timestampMs)) continue;

      if (targetTimestampMs === undefined) {
        return timestampMs;
      }

      if (bestTimestampMs === null || Math.abs(timestampMs - targetTimestampMs) < Math.abs(bestTimestampMs - targetTimestampMs)) {
        bestTimestampMs = timestampMs;
      }
    }

    return bestTimestampMs;
  } catch {
    return null;
  }
}

function isWithinProject(sessionCwd: string, projectRoot: string): boolean {
  // Compare separator- and case-normalized (Windows folds `\`→`/` and lowercases)
  // so a backslash session cwd matches a forward-slash project root and vice versa.
  const cwd = toComparablePath(sessionCwd);
  const root = toComparablePath(projectRoot);
  return cwd === root || cwd.startsWith(root + '/');
}

function sessionDistance(session: SessionMeta, historyEntry: ClaudeHistoryEntry): number {
  if (!historyEntry.timestampMs) return Number.MAX_SAFE_INTEGER;
  const sessionTime = new Date(session.timestamp).getTime();
  if (Number.isNaN(sessionTime)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(sessionTime - historyEntry.timestampMs);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatAbsoluteTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return isoTimestamp;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '.' : s;
}

