// SHELL adapter: real UnifiedAgent / RemoteSession / UnifiedTask -> Floor view-model.
//
// The view-model TYPES are owned by floorModel.ts (the shared webview contract) and
// the pure derivations (derivePhase / deriveNeeds / parseStructuredQuestion /
// toFloorTicket) live there too — this file only translates the real data shapes into
// the inputs those functions expect. No logic is reimplemented here.
//
// UnifiedAgent is declared locally in UnifiedAgentsPane.tsx and not exported; we accept
// a structural subset (UnifiedAgentLike) so TypeScript's structural typing lets the real
// object flow in without a circular import. RemoteSession lives in src/core (the
// extension-host build root) and cannot be imported from ui/ — its payload is mirrored
// here as RemoteSessionLike, matching the fields settings.vscode.ts sends over postMessage.

import {
  derivePhase,
  deriveNeeds,
  parseStructuredQuestion,
  toFloorTicket,
  latestTodos,
  resolveProject,
  worktreeSlugOf,
  type FloorAgent,
  type FloorTicket,
  type AgentAbbr,
  type ReplyTarget,
  type CiStatus,
} from './floorModel'
import type { UnifiedTask, RecentToolCall, ProjectRule } from '../../types'

// ---------- structural inputs ----------

/** Structural subset of UnifiedAgentsPane's local UnifiedAgent that the adapter reads. */
export interface UnifiedAgentLike {
  id: string
  agentType: string
  displayName: string
  activity: string
  active: boolean
  timestamp: string
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'idle'
  files: string[]
  toolCalls: number
  prUrl?: string | null
  ci?: CiStatus | null
  linearIssue?: string | null
  terminal?: {
    id?: string
    cwd?: string | null
    branch?: string | null
    waitingForInput?: boolean
    lastUserMessage?: string
    currentActivity?: string
    narrative?: string
    recentToolCalls?: RecentToolCall[]
  } | null
  agent?: {
    cwd?: string | null
    branch?: string | null
    repo_name?: string | null
    status?: string
    last_messages?: string[]
  } | null
}

/** Mirror of src/core/remoteSessions.ts RemoteSession, as it crosses postMessage. */
export interface RemoteSessionLike {
  host: string
  sessionId: string
  agentType: string
  cwd: string
  project: string
  phase: 'running' | 'idle' | 'waiting' | 'failed' | 'done'
  activity: string
  tokPerSec: number
  waitingForInput: boolean
  lastResponse: string
  prUrl: string | null
  ci?: CiStatus | null
  ticket: string | null
  branch: string
  /** `<slug>` under `.agents/worktrees/<slug>/` — disambiguates sibling worktree
   *  sessions and gives the card a task label when topic/preview are empty. */
  worktreeSlug?: string
  /** Absolute worktree path, for the Reveal-worktree action. */
  worktreePath?: string
  sinceMs: number
  startedAtMs: number
  topic: string
  context: string
  cloudTaskId: string
  cloudProvider: string
  teamName: string
  pid: number
  transport: string
  replyRail: string
  replyMuxTarget: string
  replyMuxSocket: string
  tmuxPane: string
  viewingIn?: string
}

// ---------- primitive helpers ----------

const ABBR_BY_TYPE: Record<string, AgentAbbr> = {
  claude: 'CC',
  codex: 'CX',
  gemini: 'GX',
  cursor: 'CR',
  opencode: 'OC',
  amp: 'AG',
  agents: 'AG',
  grok: 'GK',
  kimi: 'GK',
}

/** agentType string -> terminal-tab prefix. Unknown types fall back to Shell. */
export function abbrFor(agentType: string): AgentAbbr {
  return ABBR_BY_TYPE[(agentType || '').toLowerCase()] ?? 'SH'
}

/**
 * Split a one-line activity string into the bold verb + trailing target the feed
 * renders (prototype actHtml: "▸ <b>${verb}</b> ${target}"). "$ cmd" reads as
 * Running cmd; otherwise the first word is the verb and the remainder the target.
 */
export function splitActivity(activity: string): { verb: string; target: string } {
  const t = (activity || '').trim()
  if (!t) return { verb: '', target: '' }
  if (t.startsWith('$')) return { verb: 'Running', target: t.replace(/^\$\s*/, '') }
  const sp = t.indexOf(' ')
  if (sp === -1) return { verb: t, target: '' }
  return { verb: t.slice(0, sp), target: t.slice(sp + 1) }
}

/**
 * Project scope for an agent. Delegates to resolveProject: user rules win first,
 * then a worktree path folds back to its repo, then the CLI repo name (the git repo
 * root basename), then the cwd's last segment. Empty cwd falls back to the label.
 */
export function deriveProject(
  cwd: string | null | undefined,
  repoName: string | null | undefined,
  fallback: string,
  rules: ProjectRule[] = [],
): string {
  // No cwd to match rules against -> the CLI repo name (or the label) is all we have.
  if (!cwd) return repoName || fallback
  return resolveProject(cwd, rules, repoName || undefined) || fallback
}

/** Human elapsed label ("2s" / "14m" / "3h" / "1d") from an epoch-ms delta. */
export function sinceFromMs(ms: number): string {
  if (!isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Human elapsed label from an ISO timestamp, measured against now. */
export function sinceFromIso(iso: string, nowMs: number): string {
  const started = new Date(iso).getTime()
  if (!isFinite(started)) return ''
  return sinceFromMs(nowMs - started)
}

/** Epoch ms of an ISO timestamp, or 0 when it can't be parsed (heartbeat treats 0 as unknown). */
export function isoToMs(iso: string): number {
  const ms = new Date(iso).getTime()
  return isFinite(ms) ? ms : 0
}

/** "#142" from a GitHub PR url, or null when it isn't a recognizable PR link. */
export function floorPrLabel(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/\/pull\/(\d+)/)
  if (m) return `#${m[1]}`
  const n = url.match(/#(\d+)\s*$/)
  return n ? `#${n[1]}` : null
}

/**
 * Reply channel for a cross-host / non-tab session, derived from its context.
 * Cloud rows answer via `agents cloud message`; teams via `agents factory answer`;
 * a raw terminal on another machine or another local process has no injectable
 * channel, so it resolves to 'none' with a reason the UI shows inline. `host`
 * rides through so the host handler can ssh cloud/team commands to the owner.
 */
export function deriveReplyTargetFromRemote(r: RemoteSessionLike): ReplyTarget {
  const ctx = (r.context || '').toLowerCase()
  if (r.cloudTaskId || ctx === 'cloud') {
    if (!r.cloudTaskId) return { kind: 'none', host: r.host, reason: 'Cloud task id unknown' }
    // Cloud accounts are host-scoped: a local fetch reports this-mac's tasks, a --host
    // fetch reports that host's. Keep the owner so the host handler ssh-wraps when remote.
    return { kind: 'cloud', host: r.host, cloudTaskId: r.cloudTaskId, cloudProvider: r.cloudProvider }
  }
  if (r.teamName || ctx === 'teams' || ctx === 'team') {
    if (!r.teamName) return { kind: 'none', host: r.host, reason: 'Team name unknown' }
    return { kind: 'team', host: r.host, teamName: r.teamName }
  }
  // tmux-backed session (headless or interactive, local or remote): the CLI's
  // provenance.reply hands us the socket + pane, so we drive it with `tmux send-keys`
  // (over ssh when the host isn't this machine). This is the channel for a headless
  // agent on another box — as long as it runs inside tmux.
  if (r.replyRail === 'tmux' && r.replyMuxTarget && r.replyMuxSocket) {
    return { kind: 'tmux', host: r.host, muxSocket: r.replyMuxSocket, muxTarget: r.replyMuxTarget }
  }
  // Raw non-tmux TTY (bare Ghostty, a shell we don't own): the CLI reports reply=null
  // — there is no programmatic way to inject keystrokes. Honest 'none' beats a silent
  // no-op; the user opens the terminal to answer.
  return {
    kind: 'none',
    host: r.host,
    reason: r.host === 'this-mac' ? 'Open the terminal to reply' : `Runs on ${r.host} — open it there to reply`,
  }
}

// ---------- adapters ----------

/**
 * Map a local UnifiedAgent to a FloorAgent. waiting comes from the terminal's
 * waitingForInput flag or a headless agent's input_required status; an open PR marks a
 * done agent unreviewed (needs-you). Phase + needs are derived by floorModel, not here.
 */
export function toFloorAgentFromUnified(
  u: UnifiedAgentLike,
  opts: { pinned: Set<string>; workspaceRepo?: string | null; nowMs: number; localHostName?: string; projectRules?: ProjectRule[] },
): FloorAgent {
  const waitingForInput = u.terminal?.waitingForInput === true || u.agent?.status === 'input_required'
  const prOpenUnreviewed = !!u.prUrl
  const ci = u.ci ?? null
  const phase = derivePhase({
    status: u.status,
    waitingForInput,
    active: u.active,
    prOpenUnreviewed,
  })
  const needs = deriveNeeds(phase, prOpenUnreviewed, ci)
  const lastMsgs = u.agent?.last_messages
  const resp = (lastMsgs && lastMsgs.length ? lastMsgs[lastMsgs.length - 1] : '') || u.activity || ''
  const { verb, target } = splitActivity(u.activity)
  const project = deriveProject(u.terminal?.cwd ?? u.agent?.cwd, u.agent?.repo_name, opts.workspaceRepo || '—', opts.projectRules ?? [])
  // Local unified agents ARE this window's terminal tabs, so sendText into the live
  // terminal is the exact reply channel; fall back to 'none' for a tab-less headless row.
  const reply: ReplyTarget = u.terminal?.id
    ? { kind: 'terminal', host: 'this-mac', terminalId: u.terminal.id }
    : { kind: 'none', host: 'this-mac', reason: 'No live terminal to reply into' }

  return {
    id: u.id,
    host: 'this-mac',
    // In-window tab agents are always terminal-attached.
    context: 'terminal',
    // Display the machine's real device name (e.g. 'zion') instead of the
    // internal 'this-mac' routing key. Undefined until the fleet list resolves.
    hostLabel: opts.localHostName || undefined,
    project,
    name: u.displayName,
    abbr: abbrFor(u.agentType),
    phase,
    verb,
    target,
    tok: 0, // per-agent local tok/s isn't measured; the top bar shows the aggregate poll.
    since: sinceFromIso(u.timestamp, opts.nowMs),
    // u.timestamp is the session's last-activity stamp, so the heartbeat is exact locally.
    lastActivityMs: isoToMs(u.timestamp),
    files: u.files.length,
    tools: u.toolCalls,
    needs,
    pinned: opts.pinned.has(u.id),
    pr: floorPrLabel(u.prUrl),
    prUrl: u.prUrl ?? null,
    ci,
    ticket: u.linearIssue ?? null,
    branch: u.terminal?.branch ?? u.agent?.branch ?? '',
    worktreeSlug: worktreeSlugOf(u.terminal?.cwd ?? u.agent?.cwd),
    worktreePath: worktreeSlugOf(u.terminal?.cwd ?? u.agent?.cwd) ? (u.terminal?.cwd ?? u.agent?.cwd ?? '') : '',
    resp,
    question: parseStructuredQuestion(resp, phase),
    reply,
    todos: latestTodos(u.terminal?.recentToolCalls),
    // The rolling summary line + recent tool calls already flow over the wire on the
    // terminal. Prefer the agent's own prose (narrative); fall back to the now-line
    // (currentActivity) when it hasn't spoken between tool calls yet.
    summary: u.terminal?.narrative || u.terminal?.currentActivity || '',
    recent: u.terminal?.recentToolCalls ?? [],
  }
}

/**
 * Map a cross-host RemoteSession to a FloorAgent. The backend already normalized the
 * phase + activity + throughput, so we trust those and only re-derive needs + the
 * structured question (both pure). Host stays the remote machine name.
 */
export function toFloorAgentFromRemote(r: RemoteSessionLike, pinned: Set<string>, localHostName?: string, projectRules: ProjectRule[] = []): FloorAgent {
  const phase = r.phase
  const prOpenUnreviewed = !!r.prUrl
  const ci = r.ci ?? null
  const needs = deriveNeeds(phase, prOpenUnreviewed, ci)
  const { verb, target } = splitActivity(r.activity)
  const id = `remote-${r.host}-${r.sessionId}`
  const name = r.branch || r.ticket || r.sessionId.slice(0, 8)
  // Remote (Tier-1) sessions have no enriched last-response yet — fall back to the
  // session's task line (topic) so the card shows what it's working on, not blank.
  const resp = r.lastResponse || r.topic || ''
  // Cloud tasks run in a provider sandbox, not on the dispatching machine — the CLI
  // attributes them to the querier ('zion') for reply routing, but they should NOT
  // fold under that local host in the feed. Give them their own "Cloud" category.
  const isCloud = (r.context || '').toLowerCase() === 'cloud' || !!r.cloudTaskId

  return {
    id,
    host: r.host,
    // Carry the CLI context ('headless' | 'terminal' | 'cloud' | 'teams') so the
    // feed can badge a background (headless) run distinctly from a terminal one.
    context: r.context,
    sessionId: r.sessionId,
    pid: r.pid,
    // This machine's own sessions reported by the machine-wide fetch carry the
    // synthetic 'this-mac'; give them the real device name so they fold into the
    // same HOSTS row as in-window local agents instead of a second bucket.
    hostLabel: isCloud ? 'Cloud' : (r.host === 'this-mac' ? localHostName || undefined : undefined),
    project: deriveProject(r.cwd, r.project, r.project || '—', projectRules),
    name,
    abbr: abbrFor(r.agentType),
    phase,
    verb,
    target,
    tok: r.tokPerSec,
    since: sinceFromMs(r.sinceMs),
    // Remote sessions only carry a wall-clock START (startedAtMs); there is no distinct
    // last-activity epoch yet, so the heartbeat anchors to start until backend-data adds
    // one. 0 (unknown) disables the heartbeat rather than raising a false stall.
    lastActivityMs: r.startedAtMs > 0 ? r.startedAtMs : 0,
    files: 0,
    tools: 0,
    needs,
    pinned: pinned.has(id),
    pr: floorPrLabel(r.prUrl),
    prUrl: r.prUrl ?? null,
    ci,
    ticket: r.ticket,
    branch: r.branch,
    worktreeSlug: r.worktreeSlug ?? worktreeSlugOf(r.cwd),
    worktreePath: r.worktreePath ?? (worktreeSlugOf(r.cwd) ? r.cwd : ''),
    resp,
    question: parseStructuredQuestion(resp, phase),
    reply: deriveReplyTargetFromRemote(r),
    // Remote (Tier-1) sessions are status-only; no tool calls to parse todos from yet.
    todos: [],
    // Remote = summary only: the sweep carries the session's task line (topic) / last
    // response but no tool calls yet, so recent stays empty until Tier-2 enrichment.
    summary: r.topic || r.lastResponse || '',
    recent: [],
    // tmux %pane handle + where it's being viewed, surfaced on the card.
    pane: r.tmuxPane || undefined,
    viewingIn: r.viewingIn || undefined,
  }
}

/** Map local UnifiedAgents (watchdog rows should be filtered out by the caller). */
export function adaptUnified(
  agents: UnifiedAgentLike[],
  opts: { pinned: Set<string>; workspaceRepo?: string | null; nowMs: number; localHostName?: string; projectRules?: ProjectRule[] },
): FloorAgent[] {
  return agents.map((a) => toFloorAgentFromUnified(a, opts))
}

/** Map genuinely-remote sessions (caller drops host === 'this-mac' to avoid double count). */
export function adaptRemote(sessions: RemoteSessionLike[], pinned: Set<string>, localHostName?: string, projectRules: ProjectRule[] = []): FloorAgent[] {
  return sessions.map((s) => toFloorAgentFromRemote(s, pinned, localHostName, projectRules))
}

/** UnifiedTask[] -> FloorTicket[] (delegates to floorModel.toFloorTicket). */
export function adaptTickets(tasks: UnifiedTask[]): FloorTicket[] {
  return tasks.map(toFloorTicket)
}
