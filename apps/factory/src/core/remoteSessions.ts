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

import { resolveProject, normalizeHost, worktreeSlugOf } from '../shared/project';
import type { ProjectRule } from '../shared/project';

// Re-exported so existing host importers keep their `from '../core/remoteSessions'`
// path. The impls now live in src/shared/project so the webview (@shared) imports
// the SAME source instead of a hand-mirrored copy that silently drifts.
export { resolveProject, normalizeHost, worktreeSlugOf };
export type { ProjectRule } from '../shared/project';

/**
 * Build the command that opens/attaches a session living on a REMOTE device.
 * We `ssh -t` into the peer and let its own `agents sessions focus <id> --local`
 * resolve the session in-place — attach its live tmux pane, or resume it in the
 * ssh TTY when it's headless. `--local` is correct because the caller already
 * knows the session is on `host`, so a cross-host sweep from the peer is wasted
 * work. The local (this-mac) path does NOT use this — it spawns
 * `agents sessions focus` detached so it opens a native terminal tab.
 */
export function buildRemoteFocusCommand(sessionId: string, host: string): string {
  const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const remote = `agents sessions focus ${shq(sessionId)} --local`;
  return `ssh -t ${shq(host)} ${shq(remote)}`;
}

/** Mirror of floorModel.FloorPhase (kept in sync by hand; not imported). */
export type RemotePhase = 'running' | 'idle' | 'waiting' | 'failed' | 'done';

/** Why an agent handed control back — mirrors the CLI AwaitingReason. */
export type RemoteAwaitReason = 'question' | 'plan_review' | 'permission';

/** One discrete choice the agent offered (mirror of the CLI QuestionOption). */
export interface RemoteQuestionOption {
  label: string;
  description: string;
  /** Selection keystroke for a TUI prompt ('1' … or 'esc'); '' for a free-text choice. */
  key: string;
}

/**
 * The structured decision an agent is waiting on, carried verbatim from the CLI
 * state engine (`agents sessions --active --json` → ActiveSession.question). This
 * is the load-bearing "what does it want from me" signal the NEEDS-YOU card renders
 * — the UI no longer has to regex it back out of a truncated preview line.
 */
export interface RemoteQuestion {
  text: string;
  reason: RemoteAwaitReason;
  options: RemoteQuestionOption[];
}

export interface RemoteAttachment {
  path: string;
  label: string;
  mediaType: string;
  sizeBytes?: number;
  thumbnailUri?: string;
}

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
/** One live checklist item from the CLI's TodoProgress (RUSH-1380). */
export interface RemoteTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present-continuous label for the active step (drives the live verb). */
  activeForm?: string;
}

export interface RemoteSession {
  host: string;
  sessionId: string;
  agentType: string;
  cwd: string;
  project: string;
  phase: RemotePhase;
  /** Live now-line for the card (the CLI's `preview` while the agent is working). */
  activity: string;
  /** Output-token throughput from the CLI payload (`ActiveSession.tokPerSec`), rounded. */
  tokPerSec: number;
  waitingForInput: boolean;
  /** Per-session rate/usage limit from the CLI transcript (RUSH-1523). */
  rateLimited: boolean;
  /** Why the agent handed control back ('question' | 'plan_review' | 'permission'),
   *  from the CLI payload. '' when the session isn't waiting. */
  awaitingReason: string;
  lastResponse: string;
  /** The structured decision the agent is waiting on (question/plan/permission +
   *  options), from the CLI state engine. null when the CLI supplied none — the UI
   *  then falls back to parsing lastResponse for options. */
  question: RemoteQuestion | null;
  /** Last few assistant turns (most-recent last), one line each — panel context. [] when none. */
  tail: string[];
  /** Live plan checklist from the CLI's most recent `TodoWrite` (RUSH-1380). Lets the
   *  Factory Floor show an N/M pill + checklist for remote / device-dispatched agents
   *  that have no local tool-call stream. Absent when the session wrote no todo list. */
  todos?: RemoteTodoItem[];
  /** Raw CLI output text, when the active-session payload carries it. */
  output: string;
  /** Attachment refs/names from the CLI payload, normalized for thumbnail + preview. */
  attachments: RemoteAttachment[];
  prUrl: string | null;
  ticket: string | null;
  /** Tracker refs this session CREATED (Linear create_issue / gh issue create). */
  createdTickets: string[];
  /** Team name this session SPAWNED via `agents teams create/add`; '' when none. */
  spawnedTeam: string;
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
  /** User-set session label from the CLI payload. Kept separate from topic so UI
   *  card headers can prefer explicit names over inferred task lines. */
  label: string;
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
  /** Outcome fields, populated only for RECENT (historical) sessions — the flat
   *  `agents sessions --json` payload carries them; the --active payload does not.
   *  0 when unknown. These drive the Recap ledger (duration/cost per session). */
  durationMs?: number;
  costUsd?: number;
  tokenCount?: number;
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
  /** Inferred live activity from the CLI state engine: 'working' | 'waiting_input'
   *  | 'idle'. The single source for the "is it doing something right now" signal —
   *  the extension no longer re-derives it from the transcript tail (issue #741). */
  activity?: string;
  /** Output-token throughput (tokens/sec, rolling 60s window) computed by the CLI.
   *  Absent when no transcript is resolvable or the agent reports no usage. */
  tokPerSec?: number;
  /** Why the agent is waiting, when activity is waiting_input. */
  awaitingReason?: string | null;
  /** Structured decision the agent is waiting on (CLI ActiveSession.question). Present
   *  only for waiting_input sessions; the options are the real choices (AskUserQuestion
   *  options, or canonical Approve/Deny for plan/permission). */
  question?: { text?: string; reason?: string; options?: Array<{ label?: string; description?: string; key?: string } | null> } | null;
  /** Last few assistant turns (most-recent last), from the CLI state engine. */
  tail?: string[];
  /** Live plan progress (CLI ActiveSession.todos, RUSH-1380): the latest TodoWrite
   *  checklist + a done/total tally + the current step. Present only when the session
   *  has written a todo list. */
  todos?: {
    items?: Array<{ content?: string; status?: string; activeForm?: string } | null>;
    done?: number;
    total?: number;
    activeForm?: string;
  } | null;
  output?: string;
  attachments?: unknown[];
  pr?: { url?: string; number?: number } | null;
  worktree?: { slug?: string; path?: string; branch?: string } | null;
  ticket?: string | { id?: string; url?: string } | null;
  /** Tracker refs the session CREATED + team it SPAWNED, from the CLI session scan. */
  createdTickets?: string[];
  spawnedTeam?: string;
  /** Per-session rate/usage limit from the CLI (RUSH-1523). */
  rateLimited?: boolean;
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
 * Normalize the CLI's `ActiveSession.todos` items into the flat checklist the UI
 * renders (RUSH-1380). Drops contentless items; coerces an unknown status to
 * 'pending'. Returns [] when the payload carries no usable list.
 */
function normalizeTodos(raw: RawActiveSession['todos']): RemoteTodoItem[] {
  const items = raw?.items;
  if (!Array.isArray(items)) return [];
  const out: RemoteTodoItem[] = [];
  for (const it of items) {
    if (!it) continue;
    const content = asStr(it.content);
    if (!content) continue;
    const status: RemoteTodoItem['status'] =
      it.status === 'completed' || it.status === 'in_progress' ? it.status : 'pending';
    const activeForm = asStr(it.activeForm);
    out.push(activeForm ? { content, status, activeForm } : { content, status });
  }
  return out;
}

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

/** Coerce a CLI-emitted numeric field (number, or numeric string) to a number; 0 otherwise. */
function asNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * Normalize the CLI's `question` object across the postMessage boundary. Returns
 * null when there is no usable question (no text), so the webview falls back to
 * parsing `lastResponse`. `reason` is clamped to the known set; options with no
 * label are dropped.
 */
export function normalizeQuestion(raw: RawActiveSession['question']): RemoteQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const text = asStr(raw.text);
  if (!text) return null;
  const reason: RemoteAwaitReason =
    raw.reason === 'plan_review' || raw.reason === 'permission' ? raw.reason : 'question';
  const options: RemoteQuestionOption[] = Array.isArray(raw.options)
    ? raw.options
        .filter((o): o is { label?: string; description?: string; key?: string } => !!o && typeof o === 'object')
        .map((o) => ({ label: asStr(o.label), description: asStr(o.description), key: asStr(o.key) }))
        .filter((o) => o.label)
    : [];
  return { text, reason, options };
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

function normalizeAttachment(raw: unknown): RemoteAttachment | null {
  if (typeof raw === 'string') {
    const path = raw.trim();
    return path ? { path, label: basename(path), mediaType: 'application/octet-stream' } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    path?: unknown;
    ref?: unknown;
    label?: unknown;
    name?: unknown;
    mediaType?: unknown;
    media_type?: unknown;
    sizeBytes?: unknown;
    size?: unknown;
    thumbnailUri?: unknown;
  };
  const path = asStr(obj.path) || asStr(obj.ref);
  if (!path) return null;
  const sizeBytes =
    typeof obj.sizeBytes === 'number' ? obj.sizeBytes :
    typeof obj.size === 'number' ? obj.size :
    undefined;
  return {
    path,
    label: asStr(obj.label) || asStr(obj.name) || basename(path),
    mediaType: asStr(obj.mediaType) || asStr(obj.media_type) || 'application/octet-stream',
    sizeBytes,
    thumbnailUri: asStr(obj.thumbnailUri) || undefined,
  };
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
  const todos = normalizeTodos(raw.todos);

  return {
    host,
    sessionId,
    agentType: (raw.kind || '').toLowerCase(),
    cwd,
    project: resolveProject(cwd, projectRules),
    phase,
    // The now-line is live only while the CLI says the agent is working; an idle
    // or waiting session must not keep showing its last tool action as current.
    activity: raw.activity === 'working' ? preview : '',
    tokPerSec: Math.round(asNum(raw.tokPerSec)),
    waitingForInput: phase === 'waiting',
    rateLimited: raw.rateLimited === true,
    awaitingReason: asStr(raw.awaitingReason),
    lastResponse: preview,
    question: normalizeQuestion(raw.question),
    tail: Array.isArray(raw.tail) ? raw.tail.map((t) => asStr(t)).filter(Boolean) : [],
    todos: todos.length ? todos : undefined,
    output: asStr(raw.output),
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments.map(normalizeAttachment).filter((a): a is RemoteAttachment => Boolean(a))
      : [],
    // pr is a { url, number } object on the CLI payload; keep top-level prUrl as a
    // fallback for older shapes.
    prUrl: asStr(raw.prUrl) || asStr(raw.pr?.url) || null,
    ticket: ticketMatch,
    createdTickets: Array.isArray(raw.createdTickets) ? raw.createdTickets.map((t: unknown) => String(t)) : [],
    spawnedTeam: asStr(raw.spawnedTeam),
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
    label: asStr(raw.label),
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
  createdTickets?: string[];
  spawnedTeam?: string;
  prUrl?: string;
  prNumber?: number;
  topic?: string;
  label?: string;
  machine?: string;
  // Outcome metrics the CLI computes per session (may arrive as numeric strings).
  durationMs?: number | string;
  costUsd?: number | string;
  tokenCount?: number | string;
  messageCount?: number | string;
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
    rateLimited: false,
    awaitingReason: '',
    lastResponse: '',
    // Recent (historical) sessions are idle — no live decision to surface.
    question: null,
    tail: [],
    output: '',
    attachments: [],
    prUrl: asStr(raw.prUrl) || null,
    ticket: asStr(raw.ticketId) || null,
    createdTickets: Array.isArray(raw.createdTickets) ? raw.createdTickets.map((t: unknown) => String(t)) : [],
    spawnedTeam: asStr(raw.spawnedTeam),
    branch: asStr(raw.gitBranch),
    worktreeSlug,
    worktreePath: worktreeSlug ? cwd : '',
    sinceMs: startedAtMs > 0 ? Math.max(0, fetchedAt - startedAtMs) : 0,
    startedAtMs,
    lastActivityMs,
    topic: asStr(raw.topic) || asStr(raw.label),
    label: asStr(raw.label),
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
    // Outcome metrics for the Recap ledger. The CLI emits these on the flat
    // SessionMeta payload; coerce defensively (numeric strings observed in the wild).
    durationMs: asNum(raw.durationMs),
    costUsd: asNum(raw.costUsd),
    tokenCount: asNum(raw.tokenCount),
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
