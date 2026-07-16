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
import { spawn, type ChildProcess } from 'child_process';
import type { Command } from 'commander';
import chalk from 'chalk';
import { truncate, padRight } from '../lib/format.js';
import ora from 'ora';
import type { AgentId } from '../lib/types.js';
import type { SessionAgentId, SessionMeta, ViewMode } from '../lib/session/types.js';
import { SESSION_AGENTS } from '../lib/session/types.js';
import { discoverArtifacts, readArtifact, resolveArtifact } from '../lib/session/artifacts.js';
import { looksLikePath, toComparablePath, homeDir, needsWindowsShell, findExecutable } from '../lib/platform/index.js';
import { getActiveSessions, type ActiveSession } from '../lib/session/active.js';
import { enumerateGhosttyTabs, assignGhosttyTabs } from '../lib/session/ghostty-tabs.js';
import { mapPanesToTargets, listClients } from '../lib/tmux/session.js';
import { resolveViewingIn } from '../lib/session/viewing-in.js';
import { machineId, normalizeHost } from '../lib/session/sync/config.js';
import { gatherRemoteActive, NO_FANOUT_ENV } from '../lib/session/remote-active.js';
import { gatherRemoteList, runOnPeer } from '../lib/session/remote-list.js';
import { stringWidth, truncateToWidth, padToWidth, terminalWidth } from '../lib/session/width.js';
import type { SessionActivity, AwaitingReason } from '../lib/session/state.js';
import { inferSessionState } from '../lib/session/state.js';
import { discoverSessions, countSessionsInScope, resolveSessionById, searchContentIndex, parseTimeFilter, getSessionRoots, type DiscoverOptions, type ScanProgress } from '../lib/session/discover.js';
import { filterTeamSessions } from '../lib/session/team-filter.js';
import { parseSession } from '../lib/session/parse.js';
import { runRemoteSessions, buildForwardedArgs, ensureWholeIndex } from '../lib/session/remote.js';
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
import { registerGoCommand } from './go.js';
import { registerFocusCommand } from './focus.js';
import { registerSessionsInjectCommand } from './sessions-inject.js';
import { registerSessionsExportCommand } from './sessions-export.js';
import { registerSessionsImportCommand } from './sessions-import.js';
import { runBrowserSessions } from '../lib/browser/sessions-list.js';

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
  query?: string;
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
  /** Emit the on-disk session-scan directories (requires --json); for watchers. */
  roots?: boolean;
  cloud?: boolean;
  host?: string[];
  /** Group the listing by directory and drop the id/version columns. */
  tree?: boolean;
  /** Force the plain flat table instead of the grouped default overview. */
  flat?: boolean;
  /** With --active: show only sessions waiting on user input; exit 1 if any. */
  waiting?: boolean;
  /** Enrich the listing with live glyphs/preview for running rows. Default on;
   * `--no-live` sets this false. Commander's `--no-` convention. */
  live?: boolean;
  /** Force local-only: skip the cross-machine SSH fan-out (both the default
   * listing and --active). */
  local?: boolean;
  /** --device <target...> — alias for --host; resolves against the device registry. */
  device?: string[];
  /** Per-agent shorthands: aliases for `--agent <name>` (prioritized harnesses). */
  claude?: boolean;
  codex?: boolean;
  kimi?: boolean;
  antigravity?: boolean;
  grok?: boolean;
  opencode?: boolean;
}

/**
 * The prioritized harnesses that get a boolean shorthand flag (e.g. `--claude`
 * === `--agent claude`). The rest stay reachable via `--agent <name>`, which
 * also carries version pins like `codex@0.116.0`.
 */
const AGENT_SHORTHANDS = ['claude', 'codex', 'kimi', 'antigravity', 'grok', 'opencode'] as const;

/**
 * Resolve a per-agent shorthand (`--claude`, `--kimi`, …) into `options.agent`.
 * An explicit `--agent` wins; if two shorthands are passed we take the first and
 * ignore the rest (commander gives no ordering, so this is a best-effort alias).
 */
function applyAgentShorthands(options: SessionsOptions): void {
  if (options.agent) return;
  const hit = AGENT_SHORTHANDS.find((name) => (options as Record<string, unknown>)[name] === true);
  if (hit) options.agent = hit;
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
// The grouped default view ("overview"): fetch a generous recency-ordered pool
// for accurate per-project totals, show each project's most-recent rows grouped
// by project, newest-active project first.
const OVERVIEW_ROWS_PER_PROJECT = 5; // recent rows shown per project before "· N more"
const OVERVIEW_POOL_LIMIT = 1000; // fetch cap — accurate per-project totals up to this
const OVERVIEW_MAX_PROJECTS = 12; // project groups shown before "+N more projects"

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
 * Strip terminal/harness noise from a preview so the column stays a single line
 * of plain prose: OSC title escapes, CSI/SGR ANSI, and the harness wrapper tags
 * (`<local-command-stdout>`, `<task-notification>`, `<command-*>`) that leak from
 * a captured transcript tail. Collapses runs of whitespace.
 */
export function cleanPreview(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')        // OSC (title) sequences
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')                    // CSI / SGR ANSI
    .replace(/<\/?(?:local-command-stdout|command-name|command-message|command-args|task-notification|system-reminder)>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the live description for an active session: prefer the state engine's
 * preview (the latest turn), then a user label, then the first-prompt topic.
 */
function buildSessionDescription(s: ActiveSession): string {
  if (s.context === 'cloud') {
    return cleanPreview(s.preview || `${s.cloudProvider ?? ''}${s.cloudTaskId ? ` · ${s.cloudTaskId.slice(0, 12)}` : ''}`);
  }
  if (s.context === 'teams') {
    const parts = [s.teamName];
    if (s.preview) parts.push(s.preview);
    else if (s.label) parts.push(s.label);
    else if (s.topic) parts.push(s.topic);
    return cleanPreview(parts.filter(Boolean).join(' · '));
  }
  // Terminal or headless: prefer the live preview, then label, then topic.
  return cleanPreview(s.preview || s.label || s.topic || '');
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
 * Compact locator badge: how to JUMP to the session, not what it's doing.
 * `ssh` flags a remote host. For tmux, prefer the resolved `session:window.pane`
 * (a real `tmux attach -t <session:window>` target) over the raw `%pane` id. For
 * a local Ghostty session we know the tab, show `tab N`. Local, unlocatable
 * sessions add nothing (the common case).
 */
function locatorBadge(s: ActiveSession): string {
  const p = s.provenance;
  const parts: string[] = [];
  if (p?.transport === 'ssh') parts.push(chalk.red('ssh'));
  if (p?.mux?.kind === 'tmux' && (s.tmuxTarget || p.mux.pane)) {
    parts.push(chalk.green(s.tmuxTarget ?? p.mux.pane!));
    // For a tmux-hosted session, say which app+tab is looking at it right now
    // (or that it's running detached). Only meaningful for tmux (the pane is the
    // durable handle; the viewer is transient).
    if (s.viewingIn) {
      const tab = s.viewingIn.tab != null ? ` tab ${s.viewingIn.tab}` : '';
      parts.push(chalk.gray(`viewing in ${s.viewingIn.app}${tab}`));
    } else {
      parts.push(chalk.gray('detached'));
    }
  } else if (p?.mux?.kind === 'screen') {
    parts.push(chalk.green('screen'));
  }
  if (s.ghosttyTab != null) parts.push(chalk.green(`tab ${s.ghosttyTab}`));
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
  const badges = (fork ? fork : '') + [signalBadges(s), locatorBadge(s)].filter(Boolean).join(' ');
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
/** Synthetic top-level group key for provider-sandboxed cloud tasks. */
const CLOUD_MACHINE_KEY = 'cloud';

function machineKeyFor(s: ActiveSession, localMachine: string): string {
  // Cloud tasks run in a provider sandbox, not on the machine they're attributed
  // to for reply routing (s.machine = the querier). Surface them as their own
  // top-level "cloud" group instead of nested under the local device.
  if (s.context === 'cloud') return CLOUD_MACHINE_KEY;
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
    // The synthetic "cloud" category sorts after all real machines.
    if (a === CLOUD_MACHINE_KEY) return 1;
    if (b === CLOUD_MACHINE_KEY) return -1;
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

/**
 * Order a merged listing so the local machine's sessions come first, then each
 * remote machine as a contiguous block (more sessions first, then name), with
 * every machine keeping its incoming order (timestamp) within the block. Also
 * dedupes: a session present both locally (a synced mirror copy) and via live
 * fan-out collapses to one, keyed by machine + session id. Rows are keyed by
 * `machine` (discover tags local rows with the local id; fan-out tags remote
 * rows with the peer id) falling back to `localMachine` when untagged. Pure —
 * `localMachine` is injected so the ordering is testable without os.hostname().
 */
export function mergeLocalFirst(sessions: SessionMeta[], localMachine: string): SessionMeta[] {
  const byMachine = new Map<string, SessionMeta[]>();
  const seen = new Set<string>();
  for (const s of sessions) {
    const machine = s.machine || localMachine;
    if (s.id) {
      const dedupeKey = `${machine}:${s.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }
    (byMachine.get(machine) ?? byMachine.set(machine, []).get(machine)!).push(s);
  }
  const keys = Array.from(byMachine.keys()).sort((a, b) => {
    if (a === localMachine) return -1;
    if (b === localMachine) return 1;
    const ac = byMachine.get(a)!.length, bc = byMachine.get(b)!.length;
    if (ac !== bc) return bc - ac;
    return a.localeCompare(b);
  });
  return keys.flatMap((k) => byMachine.get(k)!);
}

/**
 * Serialize a `SessionMeta[]` to the clean JSON shape the `--json` listing
 * emits: strip the internal-only scoring/provenance fields (`_matchedTerms`,
 * `_bm25Score`, `_remote`) that are search/fan-out bookkeeping, never part of
 * the public record, then pretty-print as a 2-space array with a trailing
 * newline. The single seam shared by the local `--json` path and the
 * `--json --host` remote fan-out so both emit byte-identical row shapes.
 */
export function serializeSessionsJson(sessions: SessionMeta[]): string {
  const serializable = sessions.map((s) => {
    const { _matchedTerms, _bm25Score, _remote, ...rest } = s;
    return rest;
  });
  return JSON.stringify(serializable, null, 2) + '\n';
}

/**
 * `agents sessions --json --host <h>` — fan the RECENT (non-active) listing out
 * to the named host(s) and emit ONE clean merged `SessionMeta[]` JSON array,
 * the same shape the local `--json` path emits. Reuses `gatherRemoteList` (the
 * exact SSH fan-out the interactive cross-machine listing already uses) and
 * serializes the merged, machine-tagged rows — instead of `runRemoteSessions`,
 * which streams each remote's raw stdout under a per-host banner and so can
 * never be JSON.parsed. A dead host contributes `[]` (with a stderr note from
 * the fan-out), so stdout is always a valid array and the exit stays 0.
 */
async function runRemoteSessionsJson(hosts: string[]): Promise<void> {
  // Forward the caller's own filters (query, --limit, --since, …) minus --host,
  // and guarantee --json so each peer answers with a parseable array. Force
  // whole-index scope: an explicit --host means "that box's index", not the
  // slice that happens to sit under the peer's SSH-login home dir.
  const forwarded = ensureWholeIndex(buildForwardedArgs(process.argv, new Set(hosts)));
  if (!forwarded.includes('--json')) forwarded.push('--json');
  const { sessions } = await gatherRemoteList(forwarded, hosts);
  process.stdout.write(serializeSessionsJson(sessions));
}

/**
 * `running N · idle N · waiting N · queued N` for a bucket of sessions (zero
 * buckets omitted). Same bucketing as the grand-total summary so per-group
 * counts reconcile with the `(total)` beside the header. Empty when nothing.
 */
function groupTally(sessions: ActiveSession[]): string {
  const running = sessions.filter(s => s.status === 'running').length;
  const idle = sessions.filter(s => s.status === 'idle').length;
  const waiting = sessions.filter(s => s.status === 'input_required').length;
  const queued = sessions.filter(s => s.status === 'queued').length;
  const parts: string[] = [];
  if (running) parts.push(`${running} running`);
  if (idle) parts.push(`${idle} idle`);
  if (waiting) parts.push(`${waiting} waiting`);
  if (queued) parts.push(`${queued} queued`);
  return parts.join(' · ');
}

/** Print one machine's workspace tree, indented under its machine header. */
function renderWorkspaceLayout(layout: ActiveSessionsLayout, base: string, machineKey?: string): void {
  let first = true;
  for (const ws of layout.workspaces) {
    if (!first) console.log();
    first = false;

    // Under the top-level "cloud" machine group the __cloud__ workspace header is
    // redundant ("▸ cloud" then "cloud") — render its rows flat under the machine
    // header instead. Row indent collapses by one level to match.
    const redundantCloud = ws.key === '__cloud__' && machineKey === CLOUD_MACHINE_KEY;
    const rowBase = redundantCloud ? base : base + '  ';
    if (!redundantCloud) {
      const header = ws.key === '__cloud__'
        ? chalk.magenta.bold('cloud')
        : ws.key === '__unknown__'
          ? chalk.gray.bold('unknown')
          : chalk.cyan.bold(shortCwd(ws.key));
      const wsSessions = [...ws.windows.flatMap(w => w.sessions), ...ws.flat];
      const tally = groupTally(wsSessions);
      console.log(`${base}${header} ${chalk.gray(`(${ws.total})`)}${tally ? chalk.gray(`  ${tally}`) : ''}`);
    }

    for (const win of ws.windows) {
      // Host is per-process, but every terminal in the same IDE window shares
      // an ancestor — take the first non-empty host as the window's label.
      const host = win.sessions.find((s) => s.host)?.host ?? 'terminal';
      const winHeader = `${chalk.gray(host)} ${chalk.gray('·')} ${chalk.gray(shortWindowLabel(win.windowId))} ${chalk.gray(`(${win.sessions.length})`)}`;
      console.log(rowBase + winHeader);
      for (const s of win.sessions) printActiveRow(s, rowBase + '  ');
    }

    for (const s of ws.flat) printActiveRow(s, rowBase);
  }
}

/** Machine header: `▸ <name> ← this machine` for the local box (cyan), matching
 * the `ag devices list` treatment; a plain `▸ <name>` for remotes. */
function printMachineHeader(mg: MachineGroup): void {
  // The synthetic "cloud" group isn't a device — tint it magenta (matching the
  // cloud row/label styling) so it reads as a category, not a machine.
  const isCloud = mg.machine === CLOUD_MACHINE_KEY;
  const marker = mg.isLocal ? chalk.cyan('▸ ') : isCloud ? chalk.magenta('▸ ') : chalk.gray('▸ ');
  const name = mg.isLocal ? chalk.bold.cyan(mg.machine) : isCloud ? chalk.bold.magenta(mg.machine) : chalk.bold(mg.machine);
  const here = mg.isLocal ? chalk.cyan('  ← this machine') : '';
  console.log(`${marker}${name} ${chalk.gray(`(${mg.total})`)}${here}`);
}

/**
 * Attach display-only jump locators onto LOCAL sessions: the Ghostty tab number
 * (one batched read-only osascript, only when a local ghostty session exists)
 * and the tmux `session:window.pane` target (one `list-panes -a` per socket).
 * Every step is best-effort and swallowed — a failure just leaves the raw pane
 * id / no tab number, and the rows render as before. Mutates the sessions.
 */
async function enrichLocalLocators(local: ActiveSession[]): Promise<void> {
  // Ghostty tab numbers.
  try {
    const ghostty = local.filter(s => s.host === 'ghostty' && s.provenance?.transport !== 'ssh');
    if (ghostty.length > 0) {
      const surfaces = await enumerateGhosttyTabs();
      for (const [sess, tab] of assignGhosttyTabs(ghostty, surfaces)) sess.ghosttyTab = tab;
    }
  } catch { /* non-fatal */ }

  // tmux attach targets + "viewing in <app> tab N", one batched query per socket.
  try {
    const tmux = local.filter(s => s.provenance?.mux?.kind === 'tmux' && s.provenance.mux.pane);
    if (tmux.length > 0) {
      // One Ghostty enumeration shared across every socket's viewing-in resolve
      // (a tmux client can be attached from a Ghostty tab).
      const surfaces = await enumerateGhosttyTabs();
      const sockets = new Set(tmux.map(s => s.provenance!.mux!.socket));
      for (const socket of sockets) {
        const paneMap = await mapPanesToTargets(socket);
        if (paneMap.size === 0) continue;
        const clients = await listClients(socket);
        for (const s of tmux) {
          if (s.provenance!.mux!.socket !== socket) continue;
          const target = paneMap.get(s.provenance!.mux!.pane!);
          if (target) s.tmuxTarget = target;
          s.viewingIn = await resolveViewingIn(s, clients, { paneToTarget: paneMap, ghosttySurfaces: surfaces });
        }
      }
    }
  } catch { /* non-fatal */ }
}

/** Normalize a `--host`/`--device` token (`alias`, `user@host`, `host.domain`)
 * to the machine id the fan-out and registry key off. */
function hostToken(h: string): string {
  return normalizeHost(h.split('@').pop() || h);
}

/**
 * Whether the local machine's sessions belong in an `--active` view. Local is
 * included by default; an explicit `--host`/`--device` list scopes the view to
 * exactly those machines, so local is dropped unless it is itself named (by
 * alias or `user@host`, matched on the normalized machine id). Exported for
 * unit testing without touching SSH or the live process table.
 */
export function shouldIncludeLocal(hosts: string[] | undefined, self: string): boolean {
  if (!hosts || hosts.length === 0) return true;
  return hosts.some(h => hostToken(h) === self);
}

/**
 * The peers to dial for an `--active` view. No `--host` → `undefined`, which
 * tells `gatherRemoteActive` to sweep the registered online devices. An
 * explicit list → exactly those, minus this machine (its sessions come from the
 * local seed, so dialing self would be a wasted SSH and a spurious "unreachable"
 * note). Returns `[]` when the only named host is self — the caller then skips
 * the remote fan-out entirely rather than letting `[]` trigger the sweep.
 * Exported for unit testing.
 */
export function remoteHostsToDial(hosts: string[] | undefined, self: string): string[] | undefined {
  if (!hosts || hosts.length === 0) return undefined;
  return hosts.filter(h => hostToken(h) !== self);
}

/**
 * Render the unified active-session view, grouped by machine. With no `--host`,
 * local sessions come from `getActiveSessions()` and (unless `--local`) the
 * registered online devices from `ag devices` are folded in over SSH. An
 * explicit `--host`/`--device` list SCOPES the view to exactly those machines —
 * the local machine is included only when it is itself named — so `--host` is a
 * filter, not an addition (matching the non-`--active` listing path). A tip is
 * shown when there are no other machines to include.
 */
async function renderActiveSessions(
  asJson: boolean,
  waitingOnly = false,
  opts: { local?: boolean; hosts?: string[] } = {},
): Promise<void> {
  const self = machineId();
  // An explicit --host/--device list scopes the view: seed local sessions only
  // when no hosts are named, or when this machine is one of the named targets.
  const local = shouldIncludeLocal(opts.hosts, self) ? await getActiveSessions() : [];
  for (const s of local) if (!s.machine) s.machine = self;

  let remoteDeviceCount = 0;
  let merged = local;
  if (!opts.local) {
    const remoteHosts = remoteHostsToDial(opts.hosts, self);
    // An explicit list naming only self leaves nothing remote to dial — skip the
    // fan-out rather than let an empty list fall through to the device sweep.
    if (!opts.hosts?.length || (remoteHosts && remoteHosts.length > 0)) {
      const remote = await gatherRemoteActive(remoteHosts);
      remoteDeviceCount = remote.deviceCount;
      merged = dedupeByMachineSession([...local, ...remote.sessions]);
    }
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

  // Enrich LOCAL sessions with jump locators (display-only, after the --json /
  // --waiting gates so scriptable output stays osascript-free). Remote sessions
  // keep their raw pane id — their tmux/Ghostty live on the other machine.
  await enrichLocalLocators(sessions.filter(s => !s.machine || s.machine === self));

  const grouped = groupSessionsByMachine(sessions, self);
  let firstMachine = true;
  for (const mg of grouped.machines) {
    if (!firstMachine) console.log();
    firstMachine = false;
    printMachineHeader(mg);
    renderWorkspaceLayout(mg.layout, '  ', mg.machine);
  }

  const parts = groupTally(sessions).split(' · ').filter(Boolean);
  // The synthetic "cloud" group is a category, not a machine — exclude it from the
  // machine count and note it separately so the tally stays truthful.
  const realMachines = grouped.machines.filter((m) => m.machine !== CLOUD_MACHINE_KEY).length;
  const hasCloud = grouped.machines.some((m) => m.machine === CLOUD_MACHINE_KEY);
  const machineWord = realMachines === 1 ? 'machine' : 'machines';
  const cloudNote = hasCloud ? ' + cloud' : '';
  console.log(chalk.gray(`\n${sessions.length} active (${parts.join(', ')}) across ${realMachines} ${machineWord}${cloudNote}.`));

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
  // Explicit --query is interchangeable with the positional; it's how you search
  // for text that collides with a subcommand name (e.g. `sessions --query go`).
  query = query ?? options.query;

  // Normalize convenience flags before any routing reads them: per-agent
  // shorthands fold into --agent, and --device is an alias for --host (both
  // resolve against the same device registry).
  applyAgentShorthands(options);
  if (options.device && options.device.length > 0) {
    options.host = [...(options.host ?? []), ...options.device];
  }

  // --roots: emit the local session-scan directories, per agent, as JSON. A pure
  // machine-readable query (no listing/render) — external watchers (the Factory
  // extension's fs.watch) read it to track the same dirs the CLI scans, instead
  // of hardcoding `~/.claude|.codex|.gemini`. Always local; ignores other flags.
  if (options.roots) {
    process.stdout.write(JSON.stringify(getSessionRoots(), null, 2) + '\n');
    return;
  }

  // --host WITHOUT --active. `--json` fans the recent listing out and emits ONE
  // clean merged SessionMeta[] array (same shape as the local --json path), for
  // scripts/extensions that JSON.parse a remote's history. Without --json it
  // keeps the legacy per-host stream (each remote's raw stdout under a
  // `── host ──` banner). With --active, the hosts are folded into the merged
  // machine-grouped view instead (handled below).
  if (options.host && options.host.length > 0 && !options.active) {
    if (options.json) {
      await runRemoteSessionsJson(options.host);
      return;
    }
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
  // The grouped project overview is the default for a bare interactive listing:
  // no query, no path drill-in, not explicitly --flat/--tree. It drops the silent
  // cwd-scope + 50-cap + 30-day window that hide most of a large index.
  const wantsOverview = isInteractive && !searchQuery && !pathFilter && !options.flat && !options.tree;
  const limit = wantsOverview
    ? OVERVIEW_POOL_LIMIT
    : parseInt(options.limit || (isInteractive ? String(PICKER_POOL_LIMIT) : '50'), 10);
  // Overview: recency order across the whole index, no default window; an explicit
  // --since still narrows. Non-overview keeps the prior interactive-30d default.
  const since = wantsOverview
    ? options.since
    : (options.since ?? (isInteractive && !options.all ? '30d' : undefined));
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
      // Default overview scopes to the current repo SUBTREE (prefix match), so a
      // monorepo shows its sub-projects grouped instead of collapsing to the one
      // exact-cwd project. `--all` clears the prefix and spans the whole index.
      cwdPrefix: pathFilter ?? (wantsOverview && !options.all ? process.cwd() : undefined),
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
      process.stdout.write(serializeSessionsJson(filtered));
      return;
    }

    // Cross-machine fan-out: unless --local (or we ARE a peer answering a
    // parent's sweep), fold in other online machines' sessions live over SSH so
    // the list spans the fleet without any sync — each remote row carries the
    // machine it came from, and the picker/table label + group by it. Only the
    // interactive picker and the printed table get this; --json and single-id
    // resolution above stay local (a peer answers for itself; scripts get a
    // deterministic local slice). Best-effort: a fan-out failure leaves the
    // local list intact rather than erroring the whole command.
    const forceLocal = options.local === true || process.env[NO_FANOUT_ENV] === '1';
    if (!forceLocal) {
      // Pass the hosts set so a variadic `--host a b` never leaks a host as a
      // query (defensive: the --host-without-active early return above already
      // means we only get here in auto-discovery mode, with no --host in argv).
      const forwarded = buildForwardedArgs(process.argv, new Set(options.host ?? []));
      if (!forwarded.includes('--json')) forwarded.push('--json');
      const fanSpinner = isInteractiveTerminal() ? ora('Reaching other machines...').start() : null;
      try {
        const { sessions: remoteSessions } = await gatherRemoteList(forwarded, options.host);
        if (remoteSessions.length > 0) {
          sessions = mergeLocalFirst([...sessions, ...remoteSessions], machineId());
        }
      } catch {
        // fan-out is an enrichment, never a hard dependency
      } finally {
        fanSpinner?.stop();
      }
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

    // The grouped project overview is the bare interactive default: a scannable
    // dashboard of the whole fleet grouped by project, newest-active first.
    // Interact/resume via `agents sessions <project>` or `agents sessions resume`.
    if (wantsOverview) {
      const liveIndex = await maybeLiveIndex(options);
      // Per-project row cap is fixed (--limit carries a default of 50 and drives
      // the fetch pool, not the display); `--all` expands every group instead.
      printSessionOverview(sessions, hiddenCount, liveIndex, { perProjectCap: OVERVIEW_ROWS_PER_PROJECT, expand: !!options.all });
      return;
    }

    // --tree / --flat are printed listings, not an interactive pick — render them
    // directly even in a TTY. A search query keeps the interactive picker.
    if (isInteractiveTerminal() && !options.tree && !options.flat) {
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

    // Non-interactive fallback (piped output) or --flat/--tree.
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
function flatSessionRow(session: SessionMeta, live?: ActiveSession, showTicket = false, cols: PickerColumns = {}): string {
  const agentColor = colorAgent(session.agent);
  const when = formatRelativeTime(session.lastActivity ?? session.timestamp);
  const project = session.project || '-';
  const tag = teamTag(session);
  const label = (session as any).label;
  const { glyph, preview } = liveGlyphAndPreview(live);
  // A running session's live preview says what the agent is doing now; a
  // resting one falls back to its opening topic.
  const doing = preview || (tag ? `${tag}${session.topic ?? ''}` : session.topic);
  const wt = session.worktreeSlug ? chalk.magenta(`wt:${session.worktreeSlug}`) : '';

  // The machine column only earns its width when the listing spans more than one
  // box (i.e. the cross-machine fan-out folded remotes in) — same rule and
  // pool-derived width as the picker.
  const machineColW = cols.machineWidth ?? PICKER_MACHINE_W;
  const machineCell = cols.showMachine
    ? chalk.gray(padToWidth(truncateToWidth((cols.machineLabel?.(session.machine ?? '') ?? session.machine ?? '') || '-', machineColW - 1), machineColW))
    : '';

  const TICKET_W = 10;
  const ticketCell = showTicket
    ? chalk.blue(padToWidth(truncateToWidth(ticketLabel(session) || '-', TICKET_W), TICKET_W + 1))
    : '';
  const glyphW = glyph ? 2 : 0;
  const machineW = cols.showMachine ? machineColW : 0;
  const ticketW = showTicket ? TICKET_W + 1 : 0;
  const wtW = wt ? stringWidth(wt) + 1 : 0;
  const topicW = Math.max(16, terminalWidth() - (10 + 9 + 8 + 16) - glyphW - machineW - ticketW - wtW - stringWidth(when) - 1);

  return (
    chalk.white(padToWidth(truncateToWidth(session.shortId, 9), 10)) +
    agentColor(padToWidth(truncateToWidth(session.agent, 8), 9)) +
    chalk.yellow(padToWidth(truncateToWidth(session.version || '-', 7), 8)) +
    machineCell +
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
  const when = formatRelativeTime(session.lastActivity ?? session.timestamp);
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

/**
 * Group key for the overview: prefer the indexed project name; else fold the cwd
 * to its repo — a worktree (`.../<repo>/.agents/worktrees/<slug>`) folds to the
 * repo, and a monorepo subdir falls back to its leaf dir basename. Pure.
 */
export function overviewProjectKey(s: Pick<SessionMeta, 'project' | 'cwd'>): string {
  if (s.project && s.project.trim()) return s.project.trim();
  const cwd = (s.cwd ?? '').replace(/\/+$/, '');
  if (!cwd) return '(no project)';
  const wt = cwd.match(/\/([^/]+)\/\.agents\/worktrees\//);
  if (wt) return wt[1];
  const parts = cwd.split('/');
  return parts[parts.length - 1] || cwd;
}

export interface OverviewGroup {
  key: string;
  total: number; // total sessions for this project in the fetched pool
  shown: SessionMeta[]; // the recent slice that fell within the display budget
  more: number; // total - shown.length
  maxTs: string; // most-recent timestamp in the group
}

/**
 * Turn a recency-descending pool into project groups: each group shows its
 * `perProjectCap` most-recent sessions (the rest become `· N more`), and groups
 * are ordered by their most-recent session so the newest-active project leads.
 * `perProjectCap = Infinity` expands every group. Pure — unit-tested.
 */
export function buildOverviewGroups(
  pool: SessionMeta[],
  perProjectCap: number,
): { groups: OverviewGroup[]; projectCount: number } {
  const byKey = new Map<string, SessionMeta[]>();
  for (const s of pool) {
    const k = overviewProjectKey(s);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(s);
  }
  const cap = Math.max(1, perProjectCap);
  const groups: OverviewGroup[] = [];
  for (const [key, rows] of byKey) {
    const shown = rows.slice(0, cap); // rows are recency-desc (pool was sorted)
    groups.push({ key, total: rows.length, shown, more: rows.length - shown.length, maxTs: rows[0].lastActivity ?? rows[0].timestamp });
  }
  groups.sort((a, b) => (a.maxTs < b.maxTs ? 1 : a.maxTs > b.maxTs ? -1 : a.key.localeCompare(b.key)));
  return { groups, projectCount: byKey.size };
}

/**
 * The grouped project overview — the bare interactive default. Shows the latest
 * sessions grouped under their project, newest-active project first, with a
 * `· N more` per project and a `+N more projects` when the list is capped.
 */
function printSessionOverview(
  pool: SessionMeta[],
  hiddenCount: number,
  liveIndex: Map<string, ActiveSession> | undefined,
  opts: { perProjectCap: number; expand: boolean },
): void {
  const { groups } = buildOverviewGroups(pool, opts.expand ? Infinity : opts.perProjectCap);
  const shownGroups = opts.expand ? groups : groups.slice(0, OVERVIEW_MAX_PROJECTS);
  const hiddenProjects = groups.length - shownGroups.length;

  const total = pool.length;
  const projWord = groups.length === 1 ? 'project' : 'projects';
  console.log(chalk.gray(`${total} session${total === 1 ? '' : 's'} · ${groups.length} ${projWord} · recent activity\n`));

  let first = true;
  for (const g of shownGroups) {
    if (!first) console.log();
    first = false;
    const { glyph } = liveGlyphAndPreview(liveIndex?.get(g.shown[0].id));
    const head =
      `${chalk.cyan('▸')} ${chalk.cyan.bold(g.key)}  ${chalk.gray(String(g.total))}` +
      `${glyph ? '  ' + glyph : ''} ${chalk.gray(formatRelativeTime(g.maxTs))}`;
    console.log(head);
    for (const s of g.shown) console.log(treeSessionRow(s, liveIndex?.get(s.id)));
    if (g.more > 0) console.log('  ' + chalk.gray(`· ${g.more} more`));
  }

  console.log();
  const parts = [chalk.gray('newest first (by last activity)')];
  if (hiddenProjects > 0) parts.push(chalk.gray(`+${hiddenProjects} more project${hiddenProjects === 1 ? '' : 's'}`));
  parts.push(chalk.gray('agents sessions --all spans every project on disk · <project> to drill in · --flat for the plain list'));
  console.log(parts.join(chalk.gray('  ·  ')));
  if (hiddenCount > 0) console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
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
  // it's a column of dashes that steals width from every topic. The machine
  // column (and its compact labels) is computed the same way the picker does it.
  const showTicket = sessions.some((s) => ticketLabel(s) !== '');
  const cols = pickerColumnsFor(sessions);
  for (const session of sessions) console.log(flatSessionRow(session, liveIndex?.get(session.id), showTicket, cols));

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
 * Render a resolved session to stdout — the non-follow view behind
 * `agents logs <sessionId>`. Defaults to the concise `summary` digest (same as
 * `agents sessions <id>`); pass `'markdown'` for the full transcript
 * (`agents logs <id> --full`). Reuses the shared `renderSession` renderer.
 */
export async function renderSessionLog(session: SessionMeta, mode: ViewMode = 'summary'): Promise<void> {
  await renderSession(session, mode, {});
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
  const parsedEvents = parseSession(session.filePath, session.agent);
  spinner.stop();

  let events = filterEvents(parsedEvents, filters);

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

  // json — normalized events plus the durable session signals from the state
  // engine (plan text, PR, worktree, ticket). Pre-1.20.51 emitted a bare event
  // array; consumers that JSON.parse this now read `output.events` for the
  // array. See issue #743 (plan surfaced) and CHANGELOG for the shape change.
  // `todos` (RUSH-1503) is computed from the UNFILTERED transcript so the
  // checklist reflects true session state regardless of any `--include` filter;
  // it lets the Factory panel read the CLI's checklist instead of re-parsing.
  const todos = inferSessionState(parsedEvents, { cwd: session.cwd }).todos;
  process.stdout.write(renderJson(events, todos ? { ...session, todos } : session));
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

/** Column-visibility flags for the picker row, computed once over the whole pool. */
export interface PickerColumns {
  /** Render the machine column (only when the pool spans more than one machine). */
  showMachine?: boolean;
  /** Map a full machine id to its compact display form (shared prefix stripped). */
  machineLabel?: (m: string) => string;
  /** Total width of the machine column, sized to the widest compacted hostname
   * in the pool (capped). Falls back to PICKER_MACHINE_W when absent. */
  machineWidth?: number;
  /** Render the ticket/PR column (only when at least one row carries a ref). */
  showTicket?: boolean;
  /**
   * Cells the picker prepends before each row: 2 for the single-select cursor
   * ('> '), 6 for the multi-select cursor + checkbox ('> [x] '). Reserved from
   * the topic width so rows never wrap. Defaults to 2.
   */
  gutter?: number;
}

/** Fallback machine-column width when a pool-derived width isn't supplied.
 * `pickerColumnsFor` normally computes `machineWidth` sized to the actual
 * hostnames, floored/capped by these bounds so common ids like `yosemite-s0`
 * (11) fit whole while a pathological hostname can't devour the topic column. */
const PICKER_MACHINE_W = 11;
const PICKER_MACHINE_MIN = 8;
const PICKER_MACHINE_MAX = 18;

/** Column width that shows every compacted hostname in `machines` whole (one
 * trailing space for separation), bounded by MIN/MAX. */
function machineColumnWidth(machines: string[], label: (m: string) => string): number {
  const widest = machines.reduce((w, m) => Math.max(w, stringWidth(label(m))), 0);
  return Math.min(PICKER_MACHINE_MAX, Math.max(PICKER_MACHINE_MIN, widest + 1));
}

/**
 * Compact display form for machine ids: strip the longest shared dash-delimited
 * prefix so "yosemite-s0"/"yosemite-s1" read as "s0"/"s1" while unrelated ids
 * ("zion", "mac-mini") stay whole. Stripping a *common* prefix can't collide,
 * and at least one segment is always kept.
 */
export function machineLabeler(machines: string[]): (m: string) => string {
  const uniq = [...new Set(machines.filter(Boolean))];
  if (uniq.length < 2) return (m) => m;
  const parts = uniq.map((m) => m.split('-'));
  const min = Math.min(...parts.map((p) => p.length));
  let shared = 0;
  while (shared < min - 1 && parts.every((p) => p[shared] === parts[0][shared])) shared++;
  if (shared === 0) return (m) => m;
  return (m) => {
    const p = m.split('-');
    return p.length > shared ? p.slice(shared).join('-') : m;
  };
}

/**
 * Column flags for a picker, computed once over the whole pool so every row
 * aligns: the machine column only earns its width when the listing spans more
 * than one box, the ticket column only when some row carries a PR/ticket ref.
 */
export function pickerColumnsFor(sessions: SessionMeta[]): PickerColumns {
  const machines = sessions.map((s) => s.machine).filter((m): m is string => !!m);
  const distinct = [...new Set(machines)];
  const machineLabel = machineLabeler(machines);
  return {
    showMachine: distinct.length > 1,
    machineLabel,
    machineWidth: machineColumnWidth(distinct, machineLabel),
    showTicket: sessions.some((s) => ticketLabel(s) !== ''),
  };
}

export function formatPickerLabel(s: SessionMeta, query: string, cols: PickerColumns = {}): string {
  const agentColor = colorAgent(s.agent);
  const when = formatRelativeTime(s.lastActivity ?? s.timestamp);
  const project = s.project || '-';
  const tag = teamTag(s);
  const label = (s as any).label;
  const topic = tag ? `${tag}${s.topic ?? ''}` : s.topic;
  const versionStr = s.version || '-';
  const wt = s.worktreeSlug ? chalk.magenta(`wt:${s.worktreeSlug}`) : '';

  const machineW = cols.machineWidth ?? PICKER_MACHINE_W;
  const machineCell = cols.showMachine
    ? chalk.gray(padRight(truncate((cols.machineLabel?.(s.machine ?? '') ?? s.machine ?? '') || '-', machineW - 1), machineW))
    : '';

  const TICKET_W = 10;
  const ticketCell = cols.showTicket
    ? chalk.blue(padRight(truncate(ticketLabel(s) || '-', TICKET_W), TICKET_W + 1))
    : '';

  // The picker prepends a gutter (cursor, plus a checkbox in multi-select mode);
  // reserve it, plus the conditional columns, so the topic shrinks to fit and
  // rows never wrap.
  const gutter = cols.gutter ?? 2;
  const machineColW = cols.showMachine ? machineW : 0;
  const ticketW = cols.showTicket ? TICKET_W + 1 : 0;
  const wtW = wt ? stringWidth(wt) + 1 : 0;
  const topicW = Math.max(
    16,
    terminalWidth() - gutter - (10 + 9 + 8 + 16) - machineColW - ticketW - wtW - stringWidth(when) - 1,
  );

  return (
    chalk.white(padRight(s.shortId, 10)) +
    agentColor(padRight(truncate(s.agent, 8), 9)) +
    chalk.yellow(padRight(truncate(versionStr, 7), 8)) +
    machineCell +
    chalk.cyan(padRight(truncate(project, 14), 16)) +
    renderTopicCell(label, topic, query, topicW, topicW) +
    ticketCell +
    (wt ? wt + ' ' : '') +
    chalk.gray(when)
  );
}

/** Hints rotated above the picker so the flags/features stay discoverable. */
const PICKER_TIPS: string[] = [
  'Tip: narrow with -a/--agent (e.g. -a codex), or --project <name> for another folder.',
  "Tip: --all searches every directory; -H/--host <machine> folds in another box's sessions.",
  'Tip: just type to fuzzy-search prompts and responses; press space to preview a session.',
  'Tip: --since 2d / --until <date> bound the time window; pass a session id to open it directly.',
];

/**
 * Pick a hint to show above the picker. Deterministic (keys off the pool size)
 * so it stays fixed across the picker's re-renders within a single run.
 */
export function formatPickerTip(sessions: SessionMeta[]): string {
  return chalk.gray(PICKER_TIPS[sessions.length % PICKER_TIPS.length]);
}

export async function pickSessionInteractive(
  sessions: SessionMeta[],
  message = 'Search sessions:',
  initialSearch?: string,
  hiddenCount = 0,
  enterHint?: string,
): Promise<PickedSession | null> {
  if (hiddenCount > 0) {
    console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
  }
  const cols = pickerColumnsFor(sessions);
  try {
    return await sessionPicker({
      message,
      subtitle: formatPickerTip(sessions),
      sessions,
      filter: (query: string) => {
        // No query: show the full pool (picker viewport still paginates via pageSize).
        // Typing: search the full pool.
        if (!query.trim()) return sessions;
        return filterSessionsByQuery(sessions, query);
      },
      labelFor: (s: SessionMeta, query: string) => formatPickerLabel(s, query, cols),
      pageSize: PICKER_RECENT_COUNT,
      initialSearch,
      enterHint,
    });
  } catch (err) {
    if (isPromptCancelled(err)) return null;
    throw err;
  }
}

/**
 * The machine a picked session lives on when its transcript is on that peer's
 * disk (folded in over the live fan-out), else undefined. Keys off `_remote`,
 * NOT `machine !== local`: a synced mirror is machine-tagged too, but its file
 * is a local mirror path, so it must be read/resumed locally like any other.
 */
function remoteMachineOf(session: SessionMeta): string | undefined {
  return session._remote ? session.machine : undefined;
}

/** True when the peer wasn't a dialable device; prints one clear line so a
 * remote pick never dead-ends silently. */
function warnNoPeerTarget(machine: string, session: SessionMeta): void {
  console.log(chalk.yellow(`Session ${session.shortId} lives on ${machine}, which isn't a reachable device right now.`));
  console.log(chalk.gray(`Register/wake it (ag devices), or run there: agents ssh ${machine}`));
}

async function handlePickedSession(picked: PickedSession): Promise<void> {
  // A session on another machine is read/resumed ON that machine over SSH — its
  // transcript and agent binary live there. Both actions execute on the peer
  // (not a local `--host` hop, which would discover locally and dead-end for a
  // session that exists only on the peer).
  const remote = remoteMachineOf(picked.session);
  if (remote) {
    if (picked.action === 'view') {
      const rc = await runOnPeer(['sessions', picked.session.shortId, '--markdown'], remote);
      if (rc === 'no-target') warnNoPeerTarget(remote, picked.session);
    } else {
      console.log(chalk.gray(`Resuming ${picked.session.shortId} on ${remote} over SSH...`));
      const rc = await runOnPeer(['sessions', 'resume', picked.session.shortId], remote, { tty: true });
      if (rc === 'no-target') warnNoPeerTarget(remote, picked.session);
    }
    return;
  }
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

  // Resolve the (possibly version-pinned) launcher up front. On Windows the
  // agent shim is a `.cmd`/`.ps1` and, under the shell needed to run it (see
  // spawnResumeCommand), a missing command exits non-zero rather than emitting
  // an ENOENT `error` event — so detect a removed version here instead of
  // relying on that event, keeping the /continue fallback working on every OS.
  if (!findExecutable(resume[0]) && session.version) {
    const fallback = buildFallbackCommand(session);
    if (fallback) {
      console.log(chalk.gray(
        `Version ${session.version} is not installed. Falling back to current version via /continue...`
      ));
      await spawnResumeCommand(fallback, cwd);
      return;
    }
  }

  await spawnResumeCommand(resume, cwd);
}

/**
 * Spawn a resume command as a foreground takeover (inherited stdio), resolving
 * when it exits. On Windows the agent launcher is a `.cmd`/PATHEXT shim that
 * `spawn` can't exec directly — a bare-name `shell:false` spawn throws
 * `EFTYPE`/`ENOENT` there — so we go through the shell via `needsWindowsShell`.
 * The spawn is guarded because such a failure can be thrown synchronously;
 * without the guard it would surface under an unrelated "Failed to discover
 * sessions" catch upstream instead of a truthful launch error.
 */
function spawnResumeCommand(cmd: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd[0], cmd.slice(1), {
        cwd,
        stdio: 'inherit',
        shell: needsWindowsShell(cmd[0]),
      });
    } catch (err: any) {
      console.error(chalk.red(`Failed to launch ${cmd[0]}: ${err.message}`));
      resolve();
      return;
    }
    child.on('error', (err: any) => {
      console.error(chalk.red(`Failed to launch ${cmd[0]}: ${err.message}`));
      if (err.code === 'ENOENT') {
        console.error(chalk.gray(`Make sure '${cmd[0]}' is on your PATH.`));
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
    .option('--query <text>', 'Search text — use when the term collides with a subcommand name (e.g. "go")')
    .description('Find, browse, and read agent conversation transcripts across Claude, Codex, Gemini, and OpenCode.')
    .option('-a, --agent <agent>', 'Filter by agent type and version (e.g., claude, codex@0.116.0)')
    .option('--claude', 'Shorthand for --agent claude')
    .option('--codex', 'Shorthand for --agent codex')
    .option('--kimi', 'Shorthand for --agent kimi')
    .option('--antigravity', 'Shorthand for --agent antigravity')
    .option('--grok', 'Shorthand for --agent grok')
    .option('--opencode', 'Shorthand for --agent opencode')
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
    .option('--roots', 'With --json: emit the on-disk directories scanned for session transcripts, per agent (for external watchers)')
    .option('--local', 'Only this machine — skip the cross-machine SSH fan-out (default listing and --active)')
    .option('--waiting', 'With --active: show only sessions waiting on your input (exits non-zero if any)')
    .option('--tree', 'Group the listing by directory; drops the id/version columns for readability')
    .option('--flat', 'Plain flat table (one row per session) instead of the grouped project overview')
    .option('--no-live', 'Do not enrich the listing with live status/preview for running sessions')
    .option('--cloud', 'Source sessions from Rush Cloud (captured runs) instead of local disk')
    .option('-H, --host <target...>', 'Run this query on remote machine(s) over SSH (host alias or user@host; repeatable)')
    .option('--device <target...>', 'Alias for --host (device alias from `agents devices`; repeatable)')
    .option('--browser', 'List browser-profile captures (screenshots, PDFs, recordings, downloads) instead of agent transcripts — alias of `agents browser sessions`');

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

      # The interactive list folds in other online machines automatically,
      # labelled by host with this machine first. Stay local with --local:
      agents sessions --local

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
      - The interactive listing folds in your other online machines automatically (live over SSH, no sync) — each row is labelled by host, this machine first. Use --local to skip the fan-out; --json and single-id lookups stay local.
      - --host runs the query on the remote's own index over SSH (host alias or user@host); repeat or pass several to fan out. SSH access is the only auth.
      - --include and --exclude are mutually exclusive.
      - --first and --last are mutually exclusive.
      - A filter flag (--include/--exclude/--first/--last) without --markdown/--json defaults to --markdown output.
      - --cloud sources from Rush Cloud captured runs instead of local disk.
      - Without --teams, team-spawned sessions are hidden by default.
    `,
  });

  sessionsCmd.action(async (query: string | undefined, options: SessionsOptions) => {
    if ((options as { browser?: boolean }).browser) {
      // Alias for `agents browser sessions`: a profile positional narrows to one profile.
      runBrowserSessions({ profile: query, json: options.json });
      return;
    }
    await sessionsAction(query, options);
  });

  registerSessionsTailCommand(sessionsCmd);
  registerSessionsSyncCommand(sessionsCmd);
  registerSessionsResumeCommand(sessionsCmd);
  registerGoCommand(sessionsCmd);
  registerFocusCommand(sessionsCmd);
  registerSessionsInjectCommand(sessionsCmd);
  registerSessionsExportCommand(sessionsCmd);
  registerSessionsImportCommand(sessionsCmd);
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


