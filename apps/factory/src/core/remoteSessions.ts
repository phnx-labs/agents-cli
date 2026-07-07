// Cross-host session aggregation — pure types + normalize/group.
//
// This module has NO VS Code imports so it is unit-testable in isolation. The
// SSH fan-out + host discovery live in src/vscode/remoteSessions.vscode.ts;
// this file only turns the raw `agents sessions --active --json` payload into a
// normalized RemoteSession and groups records by host.
//
// A RemoteSession is the cross-host analog of a local agent, shaped so the
// webview can fold it into a FloorAgent (ui/settings/components/mission-control/
// floorModel.ts). Field names are mirrored, but the two types are NOT shared —
// data crosses the webview boundary via postMessage.

import {
  extractCurrentActivity,
  detectWaitingForInput,
  computeOutputTokensPerSec,
  formatActivity,
} from './session.activity';
import { resolveProject, normalizeHost, worktreeSlugOf } from '../shared/project';
import type { ProjectRule } from '../shared/project';

// Re-exported so existing host importers keep their `from '../core/remoteSessions'`
// path. The impls now live in src/shared/project so the webview (@shared) imports
// the SAME source instead of a hand-mirrored copy that silently drifts.
export { resolveProject, normalizeHost, worktreeSlugOf };
export type { ProjectRule } from '../shared/project';

/** Mirror of floorModel.FloorPhase (kept in sync by hand; not imported). */
export type RemotePhase = 'running' | 'idle' | 'waiting' | 'failed' | 'done';

/** Agent types whose session files session.activity.ts knows how to parse. */
type ParsableAgentType = 'claude' | 'codex' | 'gemini';

// normalizeHost now lives in src/shared/project.ts (imported + re-exported above).

/**
 * Decide which HOSTS bucket a session belongs to. A bare `agents sessions
 * --active --json` fans out over the whole fleet, so a single query answers for
 * many machines — each row carries its own `machine` id. Bucket by that id, NOT
 * by the host we happened to query (`fallbackHost`), or every remote session
 * collapses onto the querying machine. The local machine's own id maps to
 * `localLabel` ('this-mac') so the webview's `host === 'this-mac'` routing keeps
 * working. Rows with no machine (cloud) fall back to the querying host.
 */
export function resolveSessionHost(
  rawMachine: string | undefined,
  fallbackHost: string,
  localMachineId: string,
  localLabel: string,
): string {
  const norm = normalizeHost(rawMachine || '');
  if (!norm) return fallbackHost;
  return norm === localMachineId ? localLabel : norm;
}

/** A registered device as seen by the host reconciler (from `agents devices list`). */
export interface RegisteredDeviceInput {
  name: string;
  /** SSH target (the device's Tailscale dnsName). Falls back to `name` when absent. */
  address?: string;
  online?: boolean;
}

/** A host after reconciliation against the device registry. */
export interface ReconciledHost {
  /** Canonical device label (normalizeHost of the registry name). Grouping + sidebar key. */
  name: string;
  /** SSH target for the Tier-1 fetch; '' for the local machine (queried directly). */
  address: string;
  online: boolean;
  isLocal: boolean;
}

/**
 * Scope the swept host roster to the DEVICE REGISTRY + the local machine — never
 * ssh-config aliases or raw tailnet peers, which are not dev machines and used to
 * flood the sidebar with phantom hosts (mark, mark-aws, phoenix, pi, plus the same
 * mac listed as localhost / mac-mini / "Muqsit's Mac mini"). The local machine is
 * always present and online (queried directly, no ssh); a registry entry that IS the
 * local machine is folded into it via normalizeHost so the machine appears exactly
 * once under its canonical name. Pure so it is unit-tested against real `agents
 * devices` shapes.
 */
export function reconcileHosts(devices: RegisteredDeviceInput[], localHost: string): ReconciledHost[] {
  const localKey = normalizeHost(localHost);
  const byName = new Map<string, ReconciledHost>();
  if (localKey) byName.set(localKey, { name: localKey, address: '', online: true, isLocal: true });
  for (const d of devices) {
    const key = normalizeHost(d.name);
    if (!key || key === localKey) continue;
    byName.set(key, { name: key, address: (d.address || d.name || '').trim(), online: d.online === true, isLocal: false });
  }
  return [...byName.values()];
}

/**
 * The cross-host analog of a local agent. One record per active session on one
 * machine. `host` is the machine we queried ('this-mac' locally, an ssh/tailscale
 * name remotely) — never the raw `host` field of the CLI payload, which is the
 * terminal-emulator name (e.g. "ghostty").
 */
export interface RemoteSession {
  host: string;
  sessionId: string;
  agentType: string;
  cwd: string;
  project: string;
  phase: RemotePhase;
  activity: string;
  tokPerSec: number;
  waitingForInput: boolean;
  lastResponse: string;
  prUrl: string | null;
  ticket: string | null;
  branch: string;
  /** The `<slug>` under `.agents/worktrees/<slug>/` — the strong per-session
   *  disambiguator (two agents in sibling worktrees of one repo differ only here).
   *  '' when the session isn't in a worktree. */
  worktreeSlug: string;
  /** Absolute worktree path (== cwd for a worktree session), for the Reveal-worktree
   *  action. '' when not a worktree. */
  worktreePath: string;
  /** Elapsed ms since the session started, computed against the fetch clock so
   *  host clock skew does not distort it. */
  sinceMs: number;
  /** Host-reported wall-clock start (epoch ms). Carried verbatim so the UI can
   *  recompute freshness without trusting the remote clock for elapsed. */
  startedAtMs: number;
  /** Epoch ms of the most recent OBSERVED activity (the session file's last write).
   *  File-backed sessions get their mtime from the fan-out after enrichment; it is 0
   *  when there is no activity signal (a status-only remote/ssh session). NEVER
   *  backfilled from startedAtMs — start time is not activity. Drives staleness
   *  (isStaleSession) so an idle-for-days session stops being reported running /
   *  needs-you, WITHOUT hiding a remote agent that merely started long ago. */
  lastActivityMs: number;
  /** The session's task/prompt line from the CLI payload (`topic`/`label`). Shown
   *  on the card when Tier-1 has no enriched activity yet (remote hosts). */
  topic: string;
  /** Absolute session-file path, kept so the fan-out can enrich the deduped
   *  survivor without re-reading the raw record. */
  sessionFile: string;
  /** The CLI record's `context` ('terminal' | 'cloud' | 'teams' | ...). Lets the
   *  webview treat cloud rows differently from terminal-backed agents. */
  context: string;
  /** Cloud task id (`agents cloud message <id> <text>` is the reply channel for
   *  cloud rows). Empty for non-cloud sessions. */
  cloudTaskId: string;
  /** Cloud provider ('rush' | 'codex' | 'factory' | ...), informational. Empty otherwise. */
  cloudProvider: string;
  /** Team name for `teams`-context sessions (`agents factory answer <team> <text>`
   *  is their reply channel). Empty otherwise. */
  teamName: string;
  /** OS pid of the live process (terminal context), 0 when unknown. */
  pid: number;
  /** Transport the CLI reached this session over ('ssh' remote, 'local', or ''). */
  transport: string;
  /** Reply rail from `provenance.reply.rail`: 'tmux' means drive the pane below with
   *  `tmux send-keys`; '' means no programmatic channel (raw TTY) unless cloud/team. */
  replyRail: string;
  /** tmux pane target (e.g. '%65') for the tmux rail. Empty otherwise. */
  replyMuxTarget: string;
  /** tmux socket path for the tmux rail. Empty otherwise. */
  replyMuxSocket: string;
  /** The session's own tmux `%N` pane handle (from `provenance.mux.pane`), shown
   *  on the card for unique addressing. Falls back to the reply-rail pane when the
   *  CLI hasn't populated mux yet. Empty for non-tmux sessions. */
  tmuxPane: string;
  /** Where the session is currently being viewed, pre-formatted by the CLI (e.g.
   *  "Codium tab 3", "Ghostty tab 2", "detached"). '' when the CLI supplies none. */
  viewingIn: string;
}

/** One machine's worth of sessions plus its reachability + freshness stamp. */
export interface HostGroup {
  host: string;
  online: boolean;
  /** When this host's data was fetched (epoch ms) — freshness for the UI. */
  fetchedAt: number;
  sessions: RemoteSession[];
}

/** Live load bucket for a host. Mirrors dispatch.types.ts HostLoad (webview
 *  contract) — kept in sync by hand; the two are NOT shared across the boundary. */
export type HostLoad = 'idle' | 'free' | 'busy' | 'hot' | 'off';

/** Reachability + live load of a discovered host. `agents`/`load`/`uses` are the
 *  live-load fields the Dispatch panel reads; they ride the existing hostSessions
 *  message. During discovery (before the host is probed) they hold their pre-probe
 *  values (agents 0, load idle/off, uses 0); fetchHostSessions overwrites them with
 *  measured values before the payload leaves the extension host. */
export interface HostInfo {
  name: string;
  online: boolean;
  /** Active agent sessions on this host (HostGroup.sessions.length). */
  agents: number;
  /** Load bucket derived from CPU load + agent count; 'off' when offline. */
  load: HostLoad;
  /** Usage weight for the ranking tiebreak (active-session count). */
  uses: number;
}

/**
 * The subset of `agents sessions --active --json` records we consume. Every
 * field is optional because the payload shape varies by context (terminal /
 * teams / cloud). Unknown fields are ignored.
 */
export interface RawActiveSession {
  context?: string;
  kind?: string;
  pid?: number;
  sessionId?: string;
  cwd?: string;
  label?: string;
  topic?: string;
  sessionFile?: string;
  startedAtMs?: number;
  status?: string;
  teamName?: string;
  agentId?: string;
  cloudProvider?: string;
  cloudTaskId?: string;
  cloudStatus?: string;
  branch?: string;
  prUrl?: string;
  /** Where the session is being viewed right now, pre-formatted by the CLI's
   *  client resolver (e.g. "Codium tab 3", "Ghostty tab 2", "detached"). */
  viewingIn?: string;
  /** The CLI emits these NESTED objects on `sessions --active --json` (agents-cli
   *  ActiveSession: preview / pr / worktree / ticket). Earlier this shape declared
   *  none of them, so normalizeActiveSession silently dropped the worktree slug, the
   *  live preview (activity line), the structured ticket id, and the real branch —
   *  which is why remote/worktree cards showed only "Edit <file>" + a status word. */
  preview?: string;
  pr?: { url?: string; number?: number } | null;
  worktree?: { slug?: string; path?: string; branch?: string } | null;
  ticket?: string | { id?: string; url?: string } | null;
  /** Normalized device id the CLI attributes this session to (machineId() form,
   *  e.g. 'zion', 'yosemite-s0'). Present on every row of a fanned-out
   *  `sessions --active --json` — the load-bearing signal for which physical
   *  machine a session runs on. Absent for cloud rows (attributed to the querier). */
  machine?: string;
  /** How the CLI says a reply reaches this session. `reply` is null for raw TTYs
   *  (e.g. bare Ghostty) with no programmatic input channel; a tmux-backed session
   *  carries the socket + pane to drive via `tmux send-keys` (over ssh when remote).
   *  `mux` carries the session's OWN pane/socket (its authoritative %pane handle),
   *  distinct from the reply rail which may target a different pane. */
  provenance?: {
    transport?: string;
    reply?: { rail?: string; target?: string; socket?: string } | null;
    mux?: { pane?: string; socket?: string; session?: string } | null;
  } | null;
}

const TICKET_RE = /\b[A-Z][A-Z0-9]*-\d+\b/;

/**
 * Coerce an untyped JSON field to a string. The session JSON is not schema-validated,
 * so a field TypeScript believes is a string (ticket/branch/topic/label/prUrl) can
 * arrive as an object (e.g. a linked-ticket `{ id }`). Anything non-string becomes ''
 * here so it can never flow through to the webview and get rendered as a React child
 * (which throws "Objects are not valid as a React child"). Normalize at the boundary.
 */
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Map the CLI `status` string onto a FloorPhase.
 *   running            -> running
 *   input_required     -> waiting   (the cheap Tier-1 "needs you" signal)
 *   queued             -> running   (dispatched, work in the pipeline)
 *   failed / error     -> failed
 *   completed / done   -> done
 *   idle / stopped / _ -> idle
 */
export function mapStatusToPhase(status: string | undefined): RemotePhase {
  switch ((status || '').toLowerCase()) {
    case 'running':
    case 'queued':
    case 'in_progress':
      return 'running';
    case 'input_required':
    case 'waiting':
    case 'waiting_for_input':
      return 'waiting';
    case 'failed':
    case 'error':
      return 'failed';
    case 'completed':
    case 'done':
    case 'success':
      return 'done';
    case 'idle':
    case 'stopped':
    default:
      return 'idle';
  }
}

// projectGlobToRegExp / matchesProjectRule / pathBasename / resolveProject now
// live in src/shared/project.ts (imported + re-exported above) — one impl shared
// with the webview, no lockstep-mirrored copy.

/**
 * Derive a display project from a working directory with no user rules — the
 * legacy default: worktrees fold to their repo, otherwise the cwd basename.
 * Thin wrapper over resolveProject so the two never diverge.
 */
export function projectFromCwd(cwd: string): string {
  return resolveProject(cwd);
}

/** Pull the session UUID out of a session-file path (basename minus extension). */
function sessionIdFromFile(sessionFile: string | undefined): string {
  if (!sessionFile) return '';
  const base = sessionFile.split('/').pop() || '';
  return base.replace(/\.[^.]+$/, '');
}

/**
 * Turn one raw CLI record into a RemoteSession. `host` is the machine we queried;
 * `fetchedAt` is our local clock at fetch time (used for skew-free elapsed).
 */
export function normalizeActiveSession(
  raw: RawActiveSession,
  host: string,
  fetchedAt: number,
  projectRules: ProjectRule[] = []
): RemoteSession {
  const status = raw.status;
  const phase = mapStatusToPhase(status);
  const sessionId =
    raw.sessionId ||
    sessionIdFromFile(raw.sessionFile) ||
    raw.agentId ||
    raw.cloudTaskId ||
    '';
  const cwd = raw.cwd || '';
  const startedAtMs = typeof raw.startedAtMs === 'number' ? raw.startedAtMs : 0;
  // Ticket can arrive as a structured object ({ id }) OR a bare string; read the id
  // first, then fall back to scanning ticket/label/topic text for a RUSH-123 token.
  const rawTicket =
    raw.ticket && typeof raw.ticket === 'object' ? asStr(raw.ticket.id) : asStr(raw.ticket);
  const ticketText = `${rawTicket} ${asStr(raw.label)} ${asStr(raw.topic)}`;
  const ticketMatch = rawTicket || ticketText.match(TICKET_RE)?.[0] || null;
  // The live preview (latest agent turn/tool action) is the human "what is it doing"
  // line; it was previously never read, leaving remote cards blank.
  const preview = asStr(raw.preview);
  const worktreeSlug = asStr(raw.worktree?.slug) || worktreeSlugOf(cwd);

  return {
    host,
    sessionId,
    agentType: (raw.kind || '').toLowerCase(),
    cwd,
    project: resolveProject(cwd, projectRules),
    phase,
    activity: '',
    tokPerSec: 0,
    waitingForInput: phase === 'waiting',
    lastResponse: preview,
    // pr is a { url, number } object on the CLI payload; keep top-level prUrl as a
    // fallback for older shapes.
    prUrl: asStr(raw.prUrl) || asStr(raw.pr?.url) || null,
    ticket: ticketMatch,
    // The remote branch lives at worktree.branch; the top-level `branch` is usually
    // absent, which is why remote branch was always empty.
    branch: asStr(raw.branch) || asStr(raw.worktree?.branch),
    worktreeSlug,
    worktreePath: asStr(raw.worktree?.path) || (worktreeSlug ? cwd : ''),
    sinceMs: startedAtMs > 0 ? Math.max(0, fetchedAt - startedAtMs) : 0,
    startedAtMs,
    // 0 = no activity signal yet; the fan-out sets the real file mtime for file-backed
    // sessions. Deliberately NOT startedAtMs — start time is not activity.
    lastActivityMs: 0,
    topic: asStr(raw.topic) || asStr(raw.label),
    sessionFile: asStr(raw.sessionFile),
    context: asStr(raw.context),
    cloudTaskId: raw.cloudTaskId || '',
    cloudProvider: raw.cloudProvider || '',
    teamName: raw.teamName || '',
    pid: typeof raw.pid === 'number' ? raw.pid : 0,
    transport: raw.provenance?.transport || '',
    replyRail: raw.provenance?.reply?.rail || '',
    replyMuxTarget: raw.provenance?.reply?.target || '',
    replyMuxSocket: raw.provenance?.reply?.socket || '',
    // Prefer the session's own pane (provenance.mux.pane); fall back to the
    // reply-rail pane, which today already carries a %pane for tmux sessions.
    tmuxPane: raw.provenance?.mux?.pane || raw.provenance?.reply?.target || '',
    viewingIn: asStr(raw.viewingIn),
  };
}

/**
 * The FLAT `SessionMeta` shape emitted by `agents sessions --json` (recent, not
 * --active). Field names differ from the active payload (ticketId vs ticket,
 * gitBranch vs worktree.branch, lastActivity ISO vs startedAtMs), so recent sessions
 * get their own normalizer that lands on the SAME RemoteSession shape — one card path
 * for active AND recent. Unknown fields ignored.
 */
export interface RawRecentSession {
  id?: string;
  shortId?: string;
  agent?: string;
  timestamp?: string;
  lastActivity?: string;
  project?: string;
  cwd?: string;
  gitBranch?: string;
  worktreeSlug?: string;
  ticketId?: string;
  prUrl?: string;
  prNumber?: number;
  topic?: string;
  label?: string;
  machine?: string;
}

/** Map a recent (historical, non-active) SessionMeta onto RemoteSession. Recent =
 *  not live, so phase is always 'idle'; lastActivity drives the "…ago" stamp. */
export function normalizeRecentSession(
  raw: RawRecentSession,
  host: string,
  fetchedAt: number,
  projectRules: ProjectRule[] = []
): RemoteSession {
  const cwd = asStr(raw.cwd);
  const worktreeSlug = asStr(raw.worktreeSlug) || worktreeSlugOf(cwd);
  const lastActivityMs = raw.lastActivity ? Date.parse(raw.lastActivity) || 0 : 0;
  const startedAtMs = raw.timestamp ? Date.parse(raw.timestamp) || 0 : 0;
  return {
    host,
    sessionId: asStr(raw.id),
    agentType: asStr(raw.agent).toLowerCase(),
    cwd,
    project: asStr(raw.project) || resolveProject(cwd, projectRules),
    phase: 'idle',
    activity: '',
    tokPerSec: 0,
    waitingForInput: false,
    lastResponse: '',
    prUrl: asStr(raw.prUrl) || null,
    ticket: asStr(raw.ticketId) || null,
    branch: asStr(raw.gitBranch),
    worktreeSlug,
    worktreePath: worktreeSlug ? cwd : '',
    sinceMs: startedAtMs > 0 ? Math.max(0, fetchedAt - startedAtMs) : 0,
    startedAtMs,
    lastActivityMs,
    topic: asStr(raw.topic) || asStr(raw.label),
    sessionFile: '',
    context: 'recent',
    cloudTaskId: '',
    cloudProvider: '',
    teamName: '',
    pid: 0,
    transport: '',
    replyRail: '',
    replyMuxTarget: '',
    replyMuxSocket: '',
    // Recent sessions are historical/idle, not live — no tmux pane or "viewing in"
    // client to resolve, so both are empty (the required-string default).
    tmuxPane: '',
    viewingIn: '',
  };
}

/** Phase precedence for dedup — the most attention-worthy record wins. */
const DEDUPE_PHASE_RANK: Record<RemotePhase, number> = {
  waiting: 0,
  failed: 1,
  running: 2,
  done: 3,
  idle: 4,
};

/**
 * Collapse records that describe the SAME session into one.
 *
 * `agents sessions --active` reports one record per live *process*, but many
 * processes (login shell, node, the agent binary, extra tabs) attach to a single
 * session file — locally we've seen 9 pids resolve to one session. Left alone,
 * the header counts every process while the feed (keyed by session id) renders
 * only the distinct ids, so the count and the list diverge wildly. Dedup by
 * `sessionId` here so a "session" means a session, and keep the record whose phase
 * most needs the user (waiting > failed > running > done > idle) — e.g. one
 * waiting pane among eight running ones surfaces the whole session as waiting.
 * Records with an empty `sessionId` are passed through untouched (can't key them).
 */
export function dedupeSessions(sessions: RemoteSession[]): RemoteSession[] {
  const byId = new Map<string, RemoteSession>();
  const passthrough: RemoteSession[] = [];
  for (const s of sessions) {
    if (!s.sessionId) {
      passthrough.push(s);
      continue;
    }
    const existing = byId.get(s.sessionId);
    if (!existing || DEDUPE_PHASE_RANK[s.phase] < DEDUPE_PHASE_RANK[existing.phase]) {
      byId.set(s.sessionId, s);
    }
  }
  return [...byId.values(), ...passthrough];
}

/**
 * A session whose last OBSERVED ACTIVITY was this long ago is treated as dead and
 * dropped from the live roster so it can't be reported running or needs-you. Six
 * hours comfortably clears an idle-overnight agent while killing sessions abandoned
 * for days (e.g. an 11-day-old file-backed session last written to 11 days ago).
 */
export const STALE_SESSION_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * A session's last-activity epoch — the enriched session-file mtime (set by the
 * fan-out for file-backed sessions). This is a GENUINE activity signal: the *last
 * write*, not the session start. It is deliberately NOT backfilled from startedAtMs,
 * because start time says nothing about recent activity — a remote agent that started
 * days ago may be working right now. 0 means we have no activity signal (a status-only
 * remote/ssh session, or a session with no file), and such a session is never aged out.
 */
export function sessionLastActivityMs(s: RemoteSession): number {
  return s.lastActivityMs || 0;
}

/**
 * True when a session's last observed activity is older than `thresholdMs`. A session
 * with no activity signal at all (0) is NEVER forced stale — we can't age what we
 * can't see, and a false positive would hide a live agent that merely STARTED long
 * ago (the key distinction: start time is not activity).
 */
export function isStaleSession(
  s: RemoteSession,
  now: number,
  thresholdMs: number = STALE_SESSION_THRESHOLD_MS
): boolean {
  const last = sessionLastActivityMs(s);
  if (last <= 0) return false;
  return now - last >= thresholdMs;
}

/**
 * Drop stale sessions so counts, the feed, and needs-you all exclude long-dead
 * sessions. Pure; the fan-out applies it to the merged cross-host set.
 */
export function filterStaleSessions(
  sessions: RemoteSession[],
  now: number,
  thresholdMs: number = STALE_SESSION_THRESHOLD_MS
): RemoteSession[] {
  return sessions.filter((s) => !isStaleSession(s, now, thresholdMs));
}

/**
 * Parse a full `agents sessions --active --json` payload (string or array) into
 * RemoteSessions for one host. Malformed input yields an empty array rather than
 * throwing, so one bad host never sinks the whole fan-out.
 */
export function normalizeActiveSessions(
  payload: string | unknown[],
  host: string,
  fetchedAt: number,
  projectRules: ProjectRule[] = []
): RemoteSession[] {
  let arr: unknown[];
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      arr = Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  } else if (Array.isArray(payload)) {
    arr = payload;
  } else {
    return [];
  }
  return arr
    .filter((r): r is RawActiveSession => !!r && typeof r === 'object')
    .map((r) => normalizeActiveSession(r, host, fetchedAt, projectRules));
}

/**
 * Enrich a RemoteSession with activity / throughput / waiting derived from the
 * session file's JSONL content — the same derivation local agents use. Only the
 * local host can supply content cheaply (Tier-1); remote hosts stay status-only
 * until a Tier-2 rich fetch. Non-parsable agent types are returned unchanged.
 */
export function enrichWithSessionContent(
  session: RemoteSession,
  sessionContent: string,
  now: number
): RemoteSession {
  const agentType = session.agentType;
  if (agentType !== 'claude' && agentType !== 'codex' && agentType !== 'gemini') {
    return session;
  }
  const parsable = agentType as ParsableAgentType;
  const activity = extractCurrentActivity(sessionContent, parsable);
  const tokPerSec = computeOutputTokensPerSec(sessionContent, parsable, 60, now);
  const waiting = detectWaitingForInput(sessionContent, parsable);
  const nextPhase: RemotePhase =
    waiting && session.phase !== 'failed' && session.phase !== 'done'
      ? 'waiting'
      : session.phase;
  return {
    ...session,
    activity: activity ? formatActivity(activity) : session.activity,
    tokPerSec: Math.round(tokPerSec),
    waitingForInput: session.waitingForInput || waiting,
    phase: nextPhase,
  };
}

/**
 * Group normalized sessions by host into HostGroups. `hosts` supplies the full
 * roster + reachability so offline hosts still appear (with an empty session
 * list) instead of silently vanishing. `fetchedAt` stamps freshness.
 */
export function groupByHost(
  sessions: RemoteSession[],
  hosts: HostInfo[],
  fetchedAt: number
): HostGroup[] {
  const byHost = new Map<string, RemoteSession[]>();
  for (const s of sessions) {
    const list = byHost.get(s.host);
    if (list) list.push(s);
    else byHost.set(s.host, [s]);
  }
  const groups: HostGroup[] = [];
  const seen = new Set<string>();
  for (const h of hosts) {
    seen.add(h.name);
    groups.push({
      host: h.name,
      online: h.online,
      fetchedAt,
      sessions: byHost.get(h.name) || [],
    });
  }
  // Any host that produced sessions but was not in the roster (defensive).
  for (const [host, list] of byHost) {
    if (seen.has(host)) continue;
    groups.push({ host, online: true, fetchedAt, sessions: list });
  }
  return groups;
}
