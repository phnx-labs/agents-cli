// Factory Floor — shared webview view-model + pure logic contract.
//
// Lives in ui/ (NOT src/core) because the webview bundle is isolated from the
// extension host: no ui/ file may import from src/*. Data crosses the boundary
// via postMessage; types are mirrored on each side.
//
// This file is the SEAM between the webview workstreams. Types below are authored
// up front so COMPONENTS and SHELL build against a stable contract; LOGIC fills
// the function bodies and adds floorModel.test.ts. No two agents edit this file
// except LOGIC (owner after this scaffold).
//
// Design source of truth: ~/Downloads/factory-floor-prototype/factory-floor.html
// (+ DESIGN.md). Field names mirror the prototype's AGENTS / TICKETS mock objects
// so the port is a 1:1 translation, not a redesign.

import type { UnifiedTask, RecentToolCall } from '../../types'

export type { RecentToolCall }

// ---------- project resolution ----------
//
// resolveProject + worktreeSlugOf are canonical in src/shared/project.ts, imported
// via @shared — the SAME impl the extension host uses, so a session's project can no
// longer resolve differently on each side of the postMessage boundary. Re-exported
// so existing importers (e.g. floorAdapter) keep their `from './floorModel'` path.
import { resolveProject, worktreeSlugOf } from '@shared/project'
import type { ProjectRule } from '@shared/project'
export { resolveProject, worktreeSlugOf }
export type { ProjectRule }

// ---------- agent view-model ----------

/**
 * Single field everything keys off. Precedence when deriving from raw signals:
 *   waiting > failed > running > done(unreviewed) > done(settled) > idle
 * (waiting outranks failed: a waiting agent is reversible by the user right now.)
 * Prototype: factory-floor.html:330,363-364.
 *
 * 'stalled' is a running agent that has gone quiet past STALL_THRESHOLD_MS — the
 * process may be wedged, so it surfaces in Needs-You. Derived live from a heartbeat
 * (deriveStalled), not reported by the CLI.
 */
export type FloorPhase = 'running' | 'idle' | 'waiting' | 'failed' | 'done' | 'stalled'

/** Terminal-tab prefix per agent CLI (ui utils is the reference map). */
export type AgentAbbr = 'CC' | 'CX' | 'GX' | 'CR' | 'AG' | 'GK' | 'OC' | 'SH'

export type StructuredQuestionKind = 'choice' | 'confirm' | 'destructive' | 'retry'

/**
 * Parsed from an agent's last response. Drives the structured-reply buttons
 * (option chips vs Confirm/Cancel vs Retry) instead of a bare free-text box.
 * Prototype: QCLUSTERS + structuredReply(), factory-floor.html:369-379,591-597.
 */
export interface StructuredQuestion {
  kind: StructuredQuestionKind
  /** The question text shown above the option buttons. */
  text: string
  /** Multiple-choice options; first is the recommended/primary. Empty for retry. */
  options: string[]
  /** Stable key so identical questions across agents cluster for batch triage. */
  clusterKey: string
  /**
   * Why the agent handed control back, when known from the CLI state engine
   * (question / plan_review / permission). Absent for text-heuristic questions.
   * Drives the "why blocked" chip on the decision panel.
   */
  reason?: 'question' | 'plan_review' | 'permission'
  /**
   * Per-option selection keystroke for an interactive TUI prompt, parallel to
   * `options`: a digit ('1'…) for AskUserQuestion/plan, or 'esc' to cancel/deny.
   * '' for a free-text choice. Absent entirely for text-parsed questions (which take
   * a free-text reply). The reply layer sends the keystroke instead of the label when
   * present, so a select-list prompt is actually driven, not fed a label it ignores.
   */
  optionKeys?: string[]
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** One item of an agent's task checklist, parsed from its latest TodoWrite call. */
export interface TodoItem {
  content: string
  status: TodoStatus
}

/**
 * How a user reply reaches THIS agent. Built by the adapter from the agent's
 * source so the host handler ('replyToAgent') can dispatch without re-deriving:
 *   terminal -> the live vscode terminal (sendText); local tabs only.
 *   tmux     -> `tmux -S <muxSocket> send-keys -t <muxTarget>`, over ssh when the
 *               session is on another host. This is how a headless/interactive agent
 *               running inside tmux (local or remote) receives a reply; the CLI hands
 *               us the socket + pane in `provenance.reply`.
 *   cloud    -> `agents cloud message <cloudTaskId> <text>`.
 *   team     -> `agents factory answer <teamName> <text>`.
 *   none     -> no reachable channel (raw non-tmux TTY, e.g. bare Ghostty); `reason`
 *               is shown inline instead of a dead send.
 * `host` is 'this-mac' for local delivery or a remote name the handler prefixes with
 * ssh (tmux/cloud/team commands run on the machine that owns the session).
 */
export type ReplyKind = 'terminal' | 'tmux' | 'cloud' | 'team' | 'none'

export interface ReplyTarget {
  kind: ReplyKind
  host: string
  terminalId?: string
  sessionId?: string
  muxSocket?: string
  muxTarget?: string
  cloudTaskId?: string
  cloudProvider?: string
  teamName?: string
  reason?: string
}

/**
 * The at-a-glance unit rendered in every Floor surface. Built by SHELL's adapter
 * from the real UnifiedAgent (+ cross-host session data). Mirrors prototype
 * AGENTS: factory-floor.html:336-347.
 */
// CI state of an agent's open PR. Mirrors src/core/prChecks.ts (kept as a plain
// string union so UI and extension code need not share an import across roots).
export type CiStatus = 'passed' | 'failed' | 'running' | null

export interface FloorAgent {
  id: string
  host: string          // 'this-mac' for local; remote hostname otherwise. ROUTING key — reply/nudge/reassign target it.
  hostLabel?: string    // DISPLAY name for host: the local machine's real device name (e.g. 'zion') so it isn't shown as 'this-mac'. Falls back to host.
  context?: string      // CLI session context ('terminal' | 'headless' | 'cloud' | 'teams'); drives the bg badge for background runs.
  sessionId?: string    // CLI session id — Focus targets it (`agents sessions focus <id>`).
  pid?: number          // process id (headless/background runs) — Stop kills it.
  project: string       // repo or cwd basename (worktrees folded to their repo)
  name: string          // displayName / branch-derived label
  abbr: AgentAbbr       // agentType -> CC/CX/GX/...
  phase: FloorPhase
  verb: string          // current activity verb, e.g. "Editing"
  target: string        // activity object, e.g. "src/core/tasks.ts"
  tok: number           // output tok/s; 0 when not streaming
  since: string          // human elapsed, e.g. "2s", "14m", "3h"
  lastActivityMs: number // epoch ms of last observed activity; drives the live heartbeat. 0 when unknown.
  files: number
  tools: number
  needs: boolean         // waiting || failed || (done && unreviewed)
  pinned: boolean        // user-pinned (persisted in globalState)
  pr: string | null      // "#142" when a PR is open
  prUrl: string | null   // full PR URL (https://github.com/…/pull/N) — the real external link to open
  ci: CiStatus           // CI state of the open PR; null when no PR / unknown
  ticket: string | null  // "RUSH-812" when linked (injected/worked-on ticket from prompt or branch)
  createdTickets?: string[] // tracker refs this session CREATED (Linear create_issue / gh issue create); [] / undefined when none
  spawnedTeam?: string   // team name this session SPAWNED via `agents teams create/add`; undefined when none
  branch: string
  worktreeSlug: string   // "<slug>" under .agents/worktrees/; '' when not a worktree. Disambiguates sibling sessions + labels the card when topic/preview are empty.
  worktreePath: string   // absolute worktree path, for the Reveal-worktree action; '' when not a worktree
  resp: string           // last response text (Anthropic Agent-view style)
  prompt?: string        // the ORIGINAL task (first user message / dispatch prompt / topic); anchors the card, distinct from the last message
  messages: string[]     // the last few assistant messages (from the CLI's last_messages window); [] when none. Drives the detail-pane Activity feed.
  question: StructuredQuestion | null
  reply: ReplyTarget     // how a user reply reaches this agent (host dispatches on kind)
  todos: TodoItem[]      // task checklist from the latest TodoWrite; empty when none
  summary: string        // the "what is it doing" line (CLI-provided); '' when unknown
  recent: RecentToolCall[] // rolling window of this session's recent tool calls; [] when none
  pane?: string          // tmux `%N` pane handle for unique addressing; undefined for non-tmux
  viewingIn?: string     // "Codium tab 3" / "Ghostty tab 2" / "detached"; undefined when unknown
}

// ---------- HOSTS sidebar rows ----------

/** One row in the HOSTS sidebar: a machine, its active-agent count, reachability. */
export interface HostRow {
  name: string
  count: number
  offline: boolean
  pinned: boolean
}

/** Canonicalize a host name to its device label. Mirror of core normalizeHost so a
 *  session's host ('mac-mini', 'ZION', a FQDN) folds onto the registry device it
 *  belongs to. Kept local — ui/ cannot import from src/*. */
function normalizeHostKey(raw: string): string {
  return (raw || '')
    .split('.')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Build the HOSTS rows, SCOPED to the machines that actually exist: the registered
 * device fleet + the local machine + any pinned host. A HOST row is NEVER created
 * from an arbitrary session's host — an agent reported on an unregistered host (an
 * ssh-config alias, a tailnet peer) is still counted into a matching device row but
 * can no longer spawn a phantom row of its own (the reported-bug hosts: mark,
 * mark-aws, phoenix, pi, and the same mac triplicated as localhost / mac-mini /
 * "Muqsit's Mac mini").
 *
 * Each agent folds into its DISPLAY host (`hostLabel ?? host`), normalized to the
 * device label, so the local machine's 'this-mac' bucket collapses onto its real
 * name and appears exactly once. Online devices show even with 0 agents. Device
 * reachability is authoritative when a fleet entry exists; `offlineHosts` only
 * decides a host that has no device entry (a pin).
 *
 * `localHost` is the local machine's canonical name; it always gets a row even when
 * it isn't in the registry (the machine you're on must always be visible).
 *
 * `pins` is the user's ordered list of pinned host names. Pinned hosts render FIRST,
 * in `pins` order (drag-reorderable), then the rest auto-sorted. A pinned host stays
 * visible even with 0 agents / offline, since the user asked for it.
 */
export function computeHostRows(
  agents: FloorAgent[],
  devices: { name: string; online: boolean; agents: number }[],
  offlineHosts: string[],
  pins: string[] = [],
  localHost?: string,
): HostRow[] {
  // Agent counts keyed by normalized device label so 'this-mac'/hostLabel, a FQDN,
  // and case variants all land on the same registry row.
  const byHost: Record<string, number> = {}
  for (const a of agents) {
    const raw = a.hostLabel ?? a.host
    // The synthetic local routing key folds onto the local machine before its real
    // device name has been threaded in as hostLabel (the pre-fold transient).
    const key = raw === 'this-mac' && localHost ? normalizeHostKey(localHost) : normalizeHostKey(raw)
    if (!key) continue
    byHost[key] = (byHost[key] || 0) + 1
  }
  const offline = new Set(offlineHosts)
  const pinIndex = new Map(pins.map((n, i) => [n, i]))
  const deviceByName = new Map(devices.map((d) => [d.name, d]))
  // The row set is the REGISTERED FLEET + local machine + pins — not session hosts.
  const names = new Set<string>()
  for (const d of devices) names.add(d.name)
  if (localHost) names.add(localHost)
  for (const p of pins) names.add(p)
  const rows = [...names].sort().map((name) => {
    const dev = deviceByName.get(name)
    const offlineRow = dev ? !dev.online : offline.has(name)
    const count = byHost[normalizeHostKey(name)] ?? dev?.agents ?? 0
    return { name, count, offline: offlineRow, pinned: pinIndex.has(name) }
  })
  // Pinned first (in the user's drag order), then the alphabetical remainder.
  const pinned = rows
    .filter((r) => r.pinned)
    .sort((a, b) => pinIndex.get(a.name)! - pinIndex.get(b.name)!)
  const rest = rows.filter((r) => !r.pinned)
  return [...pinned, ...rest]
}

// ---------- managed projects (curated sidebar list + Projects pane) ----------
//
// The floor's PROJECTS list is a CURATED set of repos the user cares about — not
// whatever happens to be running right now. Persisted host-side; the webview only
// renders + edits via postMessage. This type is mirrored field-for-field by the
// host (the two builds can't share an import), so keep the shapes in lockstep.

export interface ManagedProject {
  id: string                       // stable local id
  name: string                     // label in sidebar + dispatch
  path: string                     // absolute local folder
  repoSlug?: string                // "owner/repo"
  linearProjectId?: string
  linearProjectName?: string       // for the Linear pill
  autoDispatch?: boolean           // opt-in: factory auto-picks delegated Todo tickets (default off)
  maxAgents?: number               // cap on concurrent auto-dispatched agents for this project
  confidence: 'high' | 'medium' | 'low'
  source: 'detected' | 'manual'
}

/** A Linear project reduced to what the picker needs. */
export interface LinearProjectLite {
  id: string
  name: string
}

/** confidence high>medium>low for the count-independent primary sort. */
const CONFIDENCE_RANK: Record<ManagedProject['confidence'], number> = {
  high: 0,
  medium: 1,
  low: 2,
}

/**
 * Order the curated projects for the sidebar's top-3. Precedence:
 *   1. confidence: high > medium > low
 *   2. active-agent count desc (from `agentCountByName`, keyed by project name)
 *   3. name asc (locale) as the final stable tie-break
 * Pure so both the sidebar and its unit test agree. Does not mutate the input.
 */
export function orderManagedProjects(
  projects: ManagedProject[],
  agentCountByName: Record<string, number>,
): ManagedProject[] {
  return [...projects].sort((a, b) => {
    const conf = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]
    if (conf !== 0) return conf
    const countDiff = (agentCountByName[b.name] ?? 0) - (agentCountByName[a.name] ?? 0)
    if (countDiff !== 0) return countDiff
    return a.name.localeCompare(b.name)
  })
}

// ---------- ticket view-model (Backlog) ----------

export type TicketSource = 'LN' | 'GH'
export type TicketPriority = 'urgent' | 'high' | 'med' | 'low'
export type TicketStatus = 'todo' | 'in-progress' | 'blocked' | 'done'

/** Mirrors prototype TICKETS (factory-floor.html:382-395); built from UnifiedTask. */
export interface FloorTicket {
  id: string           // metadata.identifier ("RUSH-812" / "#412") || id
  title: string
  project: string
  source: TicketSource
  pri: TicketPriority
  status: TicketStatus
  desc: string
  labels: string[]
  owner: string        // metadata.assignee (human or agent) || '' when unassigned
}

// ---------- controls state ----------

export type CenterMode = 'agents' | 'backlog' | 'host' | 'projects' | 'recap' | 'prs'

// Host detail pane payloads. Mirror of extension/src/core/hostInventory.ts —
// the webview can't import from src/*, so the shape is redeclared here and
// crosses the boundary as JSON via the `hostInventory` message.
export interface HostResourceSummary {
  skills: number
  plugins: number
  mcp: number
  commands: number
  workflows: number
  memory: number
  hooks: number
  drift: number
}
export interface HostAgentVersion {
  version: string
  isDefault: boolean
  signedIn: boolean
  email: string | null
  plan: string | null
  sessionPercent: number | null
  weekPercent: number | null
  lastActive: string | null
  resources: HostResourceSummary | null
}
export interface HostAgentInfo {
  agent: string
  versions: HostAgentVersion[]
}
export interface HostMeta {
  name: string
  enrolled: boolean
  source: string | null
  target: string | null
  user: string | null
  os: string | null
  caps: string[]
  addedAt: string | null
  status: string | null
}
export interface HostInventory {
  host: string
  reachable: boolean
  error: string | null
  meta: HostMeta | null
  agents: HostAgentInfo[]
  fetchedAt: number
}
export type FloorGroupBy = 'host' | 'project' | 'status' | 'agent'
export type FloorSort = 'needs' | 'recent' | 'tok' | 'name'
export type TicketGroupBy = 'project' | 'priority' | 'source' | 'status' | 'owner'
export type TicketSort = 'priority' | 'id'

// ---------- stable rank constants (data — final, not stubs) ----------

/** Needs-you first ordering. Prototype: factory-floor.html:364.
 *  'stalled' sits just below failed: a wedged agent needs you, but a hard failure or an
 *  explicit question outranks it. */
export const PHASE_RANK: Record<FloorPhase, number> = {
  waiting: 0,
  failed: 1,
  stalled: 2,
  running: 3,
  done: 4,
  idle: 5,
}

/** A running agent silent this long is treated as stalled (amber). 2x -> dead (red). */
export const STALL_THRESHOLD_MS = 90_000

/** Prototype: factory-floor.html:396. */
export const PRI_RANK: Record<TicketPriority, number> = {
  urgent: 0,
  high: 1,
  med: 2,
  low: 3,
}

// ---------- canonical session identity ----------

/**
 * Where a session was observed. 'this-mac' sightings (a local tab OR the local sweep)
 * are 'local'; only a genuinely different host is 'remote'. Cloud tasks are 'cloud'.
 */
export type SessionOrigin = 'local' | 'remote' | 'cloud'

/**
 * Raw identity signals for one observed session. Shaped to fit what the adapter has:
 * local terminals carry a lazily-populated CLI UUID + a terminal id; the remote sweep
 * carries a host + a session id (UUID or file stem); cloud carries an opaque task id.
 */
export interface SessionKeyInput {
  origin: SessionOrigin
  host?: string | null
  /** The CLI session UUID — collision-free within an agent type, but populated lazily. */
  cliSessionUuid?: string | null
  /** Remote fallback: the session file's stem, used when the UUID is not yet known. */
  sessionFileStem?: string | null
  /** Provisional (pre-UUID) identity sources, in precedence order. */
  terminalId?: string | null
  cloudTaskId?: string | null
  agentId?: string | null
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * The one "what is this session doing" line, used by BOTH the card and the detail
 * rail so no surface re-derives it or renders blank. Fallback chain: the ORIGINAL
 * task (prompt / first user message — the durable anchor), then the CLI summary /
 * live preview, then the last response, then the worktree slug or branch (a task
 * label when there's no narrative — e.g. "headless-secrets-shadow"). Returns '' when
 * the agent carries no task signal at all; callers that need an absolute fallback add
 * `|| a.name` (the card already shows the name separately, so it omits that).
 *
 * prompt is preferred first so a card anchors to what the agent was ASKED to do, not
 * whatever it last said — the last message drifts as work progresses, the task doesn't.
 */
export function sessionTaskLine(a: FloorAgent): string {
  return firstNonEmpty(a.prompt, a.summary, a.resp, a.worktreeSlug, a.branch) ?? ''
}

/**
 * Persist-last-non-empty for a session's todo checklist. The tool-call window that
 * `latestTodos` parses is capped (session.summary.ts keeps only the last 24 calls),
 * so once >24 tool calls follow the last TodoWrite the checklist silently vanishes.
 * Callers thread through the last KNOWN non-empty set (remembered per session id) and
 * fall back to it when the fresh parse is empty — so a still-running agent keeps
 * showing its progress instead of dropping to a blank card. Pure so it's unit-tested.
 */
export function todosWithFallback(fresh: TodoItem[], remembered: TodoItem[] | undefined): TodoItem[] {
  if (fresh.length > 0) return fresh
  return remembered && remembered.length > 0 ? remembered : []
}

/**
 * One canonical identity per session, stable across the origins that report it. Mirrors
 * 02-floor-event-stream.md Decision 1:
 *   remote -> `${host}:${cliSessionUuid ?? sessionFileStem}`
 *   else   -> cliSessionUuid ?? `provisional:${terminalId | cloudTaskId | agentId}`
 * Prefer the CLI UUID (so a session seen as both a local tab and the local sweep collapses
 * to one key); namespace remote by host so the same UUID on two hosts does not collide;
 * fall back to a provisional key while the UUID is unknown and re-key once it arrives.
 */
export function sessionKey(input: SessionKeyInput): string {
  const uuid = firstNonEmpty(input.cliSessionUuid)
  const provisionalId = firstNonEmpty(input.terminalId, input.cloudTaskId, input.agentId) ?? 'unknown'
  if (input.origin === 'remote') {
    const host = firstNonEmpty(input.host) ?? 'unknown-host'
    const id = uuid ?? firstNonEmpty(input.sessionFileStem) ?? provisionalId
    return `${host}:${id}`
  }
  if (uuid) return uuid
  return `provisional:${provisionalId}`
}

// ---------- pure logic (LOGIC fills bodies; signatures are the contract) ----------

/** Raw signals -> FloorPhase, applying the precedence documented on FloorPhase. */
export function derivePhase(input: {
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'idle'
  waitingForInput: boolean
  active: boolean
  prOpenUnreviewed: boolean
}): FloorPhase {
  // Precedence: waiting > failed > running > done > idle.
  if (input.waitingForInput) return 'waiting'
  if (input.status === 'failed') return 'failed'
  // A stale 'running' whose process is no longer alive is really idle.
  if (input.status === 'running') return input.active ? 'running' : 'idle'
  if (input.status === 'completed') return 'done'
  // 'stopped' and 'idle' both settle to idle.
  return 'idle'
}

/**
 * waiting || failed || stalled || (open PR that needs a human decision).
 *
 * Self-promotion: an agent with an open, unreviewed PR climbs into Needs You the
 * moment CI settles — passed (ready to merge) or failed (needs a look) — even if
 * the agent process is still running. While CI is still running it stays in the
 * live lane. When CI status is unknown (gh unavailable, or a PR with no checks),
 * fall back to the prior rule: a completed agent with an open PR needs review.
 */
export function deriveNeeds(phase: FloorPhase, prOpenUnreviewed: boolean, ci: CiStatus = null): boolean {
  if (phase === 'waiting' || phase === 'failed' || phase === 'stalled') return true
  if (!prOpenUnreviewed) return false
  if (ci === 'passed' || ci === 'failed') return true
  if (ci === 'running') return false
  return phase === 'done'
}

/**
 * Is a running agent stalled? True when it has been silent past STALL_THRESHOLD_MS.
 * Only a running (or already-stalled) agent can stall — a waiting/failed/done/idle
 * agent is already categorized, and an idle agent is quiet on purpose. lastActivityMs
 * of 0 (unknown) never stalls, so a missing heartbeat can't raise a false alarm.
 * Pure so both the adapter (promote phase at poll time) and the live card agree.
 */
export function deriveStalled(lastActivityMs: number, phase: FloorPhase, now: number): boolean {
  if (phase !== 'running' && phase !== 'stalled') return false
  if (!Number.isFinite(lastActivityMs) || lastActivityMs <= 0) return false
  return now - lastActivityMs >= STALL_THRESHOLD_MS
}

/** Heartbeat severity from a silence age: live < threshold <= stale (amber) < 2x <= dead (red). */
export type HeartbeatLevel = 'live' | 'stale' | 'dead'
export function heartbeatLevel(ageMs: number): HeartbeatLevel {
  if (!Number.isFinite(ageMs) || ageMs < STALL_THRESHOLD_MS) return 'live'
  if (ageMs >= 2 * STALL_THRESHOLD_MS) return 'dead'
  return 'stale'
}

/** Minimal shape of a parsed tool call the checklist reads (name + raw input). */
export interface ToolCallLike {
  name: string
  input?: unknown
}

/**
 * The agent's current task checklist: the todos of its MOST RECENT TodoWrite call.
 * A later TodoWrite fully supersedes earlier ones (the agent rewrites the whole
 * list each time), so we take the newest, not a merge. `recentToolCalls` is stored
 * NEWEST-FIRST (session.summary.ts unshifts each call), so we scan from index 0 and
 * return the FIRST TodoWrite. Returns [] when there is no TodoWrite or the input is
 * malformed. (Caveat: recentToolCalls is capped at 24, so a checklist drops off once
 * >24 tool calls follow the last TodoWrite.) Pure so it's unit-tested.
 */
export function latestTodos(toolCalls: ReadonlyArray<ToolCallLike> | undefined): TodoItem[] {
  if (!toolCalls || toolCalls.length === 0) return []
  for (let i = 0; i < toolCalls.length; i++) {
    if (toolCalls[i]?.name !== 'TodoWrite') continue
    const input = toolCalls[i]?.input
    const raw = input && typeof input === 'object' ? (input as Record<string, unknown>).todos : undefined
    if (!Array.isArray(raw)) return []
    const todos: TodoItem[] = []
    for (const t of raw) {
      if (!t || typeof t !== 'object') continue
      const rec = t as Record<string, unknown>
      const content =
        typeof rec.content === 'string' ? rec.content :
        typeof rec.activeForm === 'string' ? rec.activeForm : ''
      if (!content) continue
      const status: TodoStatus =
        rec.status === 'completed' || rec.status === 'in_progress' ? rec.status : 'pending'
      todos.push({ content, status })
    }
    return todos
  }
  return []
}

/** completed / total tally for a checklist (total 0 when empty). */
export function todoProgress(todos: ReadonlyArray<TodoItem>): { done: number; total: number } {
  return { done: todos.filter((t) => t.status === 'completed').length, total: todos.length }
}

/**
 * Detect a structured question in an agent's last response. Returns null when the
 * text is not a question. Shapes: choice ("A or B?" / "X vs Y"), confirm
 * ("merge it?"), destructive (DROP/DELETE/prod keywords), retry (phase==='failed').
 * clusterKey groups identical questions across agents for batch triage.
 */
export function parseStructuredQuestion(resp: string, phase: FloorPhase): StructuredQuestion | null {
  const text = resp.trim()
  // A failed agent always needs a retry decision, question mark or not.
  if (phase === 'failed') {
    return { kind: 'retry', text, options: [], clusterKey: 'retry' }
  }
  // Everything else must actually be a question.
  if (!text.includes('?')) return null
  // Destructive keywords take safety precedence over choice/confirm shaping.
  if (/\b(DROP|DELETE|destructive|prod(uction)?|overwrite|force)\b/.test(text)) {
    return { kind: 'destructive', text, options: ['Confirm', 'Cancel'], clusterKey: slugifyQuestion(text) }
  }
  // Explicit alternatives -> a multiple-choice reply.
  const options = extractChoiceOptions(text)
  if (options.length >= 2) {
    return { kind: 'choice', text, options, clusterKey: slugifyQuestion(text) }
  }
  // Any other question is a yes/no confirmation.
  return { kind: 'confirm', text, options: ['Confirm', 'Hold'], clusterKey: slugifyQuestion(text) }
}

/**
 * Lift a structured question out of the agent's recent TOOL CALLS. When an agent
 * calls the AskUserQuestion tool, the question text + options live in the tool
 * INPUT — not in any assistant prose — so parseStructuredQuestion(resp) never sees
 * them and the card renders a bare "needs you" with no options. This reads the most
 * recent AskUserQuestion call and lifts its first question into the reply model.
 * `toolCalls` is newest-first (session.summary.ts unshifts each call), so the first
 * match is the live question. Returns null when there's no such call or it's malformed.
 * Pure so it's unit-tested. Takes precedence over the text heuristic in the adapter.
 */
export function structuredQuestionFromToolCalls(
  toolCalls: ReadonlyArray<ToolCallLike> | undefined,
): StructuredQuestion | null {
  if (!toolCalls || toolCalls.length === 0) return null
  for (const call of toolCalls) {
    if (call?.name !== 'AskUserQuestion') continue
    const input = call.input
    const questions = input && typeof input === 'object' ? (input as Record<string, unknown>).questions : undefined
    if (!Array.isArray(questions) || questions.length === 0) return null
    const first = questions[0]
    if (!first || typeof first !== 'object') return null
    const rec = first as Record<string, unknown>
    const text = typeof rec.question === 'string' ? rec.question.trim() : ''
    if (!text) return null
    const options: string[] = []
    for (const o of Array.isArray(rec.options) ? rec.options : []) {
      if (typeof o === 'string' && o.trim()) { options.push(o.trim()); continue }
      const label = o && typeof o === 'object' ? (o as Record<string, unknown>).label : undefined
      if (typeof label === 'string' && label.trim()) options.push(label.trim())
    }
    const destructive = /\b(DROP|DELETE|destructive|prod(uction)?|overwrite|force)\b/.test(text)
    return {
      kind: destructive ? 'destructive' : 'choice',
      text,
      options,
      clusterKey: slugifyQuestion(text),
    }
  }
  return null
}

/** The CLI's authoritative decision object (ActiveSession.question), as it crosses postMessage. */
export interface RemoteQuestionInput {
  text: string
  reason: 'question' | 'plan_review' | 'permission'
  options: Array<{ label: string; description?: string; key?: string }>
}

/**
 * Build a StructuredQuestion from the CLI's authoritative decision object. This
 * takes precedence over the text/tool-call heuristics because the CLI extracted it
 * at the SOURCE — the AskUserQuestion tool input, or the plan/permission dialog — so
 * the options + their select keys are exact, not regexed back out of prose. `kind`
 * drives chip styling (permission → destructive, so Deny reads as the safe default).
 *
 * Returns null for a bare prose question (reason 'question' with no options): the
 * text heuristic (parseStructuredQuestion) derives choices / Confirm-Hold better, so
 * we defer to it rather than render a chip-less confirm.
 */
export function structuredQuestionFromRemote(q: RemoteQuestionInput | null | undefined): StructuredQuestion | null {
  if (!q || !q.text?.trim()) return null
  const text = q.text.trim()
  const options = q.options.map((o) => o.label).filter(Boolean)
  if (q.reason === 'question' && options.length === 0) return null
  const optionKeys = q.options.map((o) => (o.key ?? '').trim())
  const kind: StructuredQuestionKind =
    q.reason === 'permission' ? 'destructive' : options.length >= 2 ? 'choice' : 'confirm'
  return {
    kind,
    text,
    options,
    clusterKey: slugifyQuestion(text),
    reason: q.reason,
    optionKeys: optionKeys.some(Boolean) ? optionKeys : undefined,
  }
}

/** Normalized slug of the question intent so identical questions across agents collide. */
function slugifyQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]+/g, ' ') // strip punctuation and numbers
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
}

/** Pull the choice labels out of "A) .. B) ..", "1. .. 2. ..", "X vs Y", or "X or Y". */
function extractChoiceOptions(text: string): string[] {
  const numbered = [...text.matchAll(/\d+[.)]\s*([^?\d][^?]*?)(?=\s*\d+[.)]|\?|$)/g)].map((m) => m[1])
  if (numbered.length >= 2) return numbered.map(cleanOption).filter(Boolean)

  const lettered = [...text.matchAll(/[A-Za-z][)]\s*([^?]*?)(?=\s*[A-Za-z][)]|\?|$)/g)].map((m) => m[1])
  if (lettered.length >= 2) return lettered.map(cleanOption).filter(Boolean)

  const core = questionCore(text)
  if (/\bvs\.?\b|\bversus\b/i.test(core)) {
    const parts = core.split(/\s+vs\.?\s+|\s+versus\s+/i)
    if (parts.length >= 2) return parts.map(cleanOption).filter(Boolean)
  }
  if (/\bor\b/i.test(core)) {
    const parts = stripLeadIn(core).split(/,?\s+or\s+/i)
    if (parts.length >= 2) return parts.map(cleanOption).filter(Boolean)
  }
  return []
}

/** Everything up to the first question mark, trimmed. */
function questionCore(text: string): string {
  const q = text.indexOf('?')
  return (q === -1 ? text : text.slice(0, q)).trim()
}

/** Drop a leading "context:" preamble so the choice clause stands alone. */
function stripLeadIn(text: string): string {
  const i = text.lastIndexOf(':')
  return (i === -1 ? text : text.slice(i + 1)).trim()
}

/** Tidy a raw option fragment into a button label. */
function cleanOption(raw: string): string {
  const s = raw
    .replace(/^[\s,.;:]+/, '')
    .replace(/[\s,.;:?]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^(a|an|the)\s+/i, '')
    .trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** Group agents by the chosen dimension. Prototype groupKey: factory-floor.html:412. */
export function groupAgents(agents: FloorAgent[], by: FloorGroupBy): Map<string, FloorAgent[]> {
  // Coalesce empty keys to a human label (same rule as groupTickets) so a Floor
  // group header is never blank. Host groups by its DISPLAY label so 'this-mac'
  // collapses onto the real device name, matching the HOSTS sidebar.
  const accessor: Record<FloorGroupBy, (a: FloorAgent) => string> = {
    host: (a) => (a.hostLabel ?? a.host) || 'Unknown host',
    project: (a) => a.project || 'Unlabeled',
    status: (a) => a.phase,
    agent: (a) => a.abbr,
  }
  const get = accessor[by]
  const groups = new Map<string, FloorAgent[]>()
  for (const a of agents) {
    const key = get(a)
    const bucket = groups.get(key)
    if (bucket) bucket.push(a)
    else groups.set(key, [a])
  }
  return groups
}

/** Sort within a group. 'needs' uses PHASE_RANK. Prototype: agentsCenter():624-630. */
export function sortAgents(agents: FloorAgent[], by: FloorSort): FloorAgent[] {
  const arr = [...agents]
  switch (by) {
    case 'needs':
      return arr.sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase])
    case 'recent':
      return arr.sort((a, b) => sinceSeconds(a.since) - sinceSeconds(b.since))
    case 'tok':
      return arr.sort((a, b) => b.tok - a.tok)
    case 'name':
      return arr.sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** Parse a human elapsed label ("2s", "14m", "3h", "1d") to seconds for recency sort. */
function sinceSeconds(since: string): number {
  const m = /^(\d+)\s*([smhd])/.exec(since.trim())
  if (!m) return Number.MAX_SAFE_INTEGER
  const unit: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
  return Number(m[1]) * unit[m[2]]
}

/**
 * Cluster waiting agents by StructuredQuestion.clusterKey so N agents asking the
 * same thing collapse into one batch-triage card. Prototype: byQ in agentsCenter()
 * (factory-floor.html:629) + clusterCard() (598-607). Singletons return as [agent].
 */
export function clusterByQuestion(waiting: FloorAgent[]): FloorAgent[][] {
  const byKey = new Map<string, FloorAgent[]>()
  for (const a of waiting) {
    // Agents without a parsed question can never batch with another; key by id.
    const key = a.question ? a.question.clusterKey : a.id
    const bucket = byKey.get(key)
    if (bucket) bucket.push(a)
    else byKey.set(key, [a])
  }
  return [...byKey.values()]
}

/** UnifiedTask -> FloorTicket. status: todo|in_progress|done -> todo|in-progress|done;
 *  priority: 'medium' -> 'med'; source: 'linear'->'LN','github'->'GH'. */
export function toFloorTicket(task: UnifiedTask): FloorTicket {
  return {
    id: task.metadata.identifier ?? task.id,
    title: task.title,
    // The formal project as defined in the source: Linear's `project` (from
    // linear-cli), else the repo scope for GitHub-sourced tickets. Empty when the
    // source declares neither — grouping renders that as 'Unlabeled' (never blank).
    project: task.metadata.project ?? task.metadata.repo ?? '',
    source: task.source === 'linear' ? 'LN' : 'GH',
    pri: toTicketPriority(task.priority),
    status: toTicketStatus(task.status),
    desc: task.description ?? '',
    labels: task.metadata.labels ?? [],
    owner: task.metadata.assignee ?? '',
  }
}

function toTicketPriority(p: UnifiedTask['priority']): TicketPriority {
  switch (p) {
    case 'urgent':
      return 'urgent'
    case 'high':
      return 'high'
    case 'medium':
      return 'med'
    case 'low':
      return 'low'
    default:
      return 'med'
  }
}

function toTicketStatus(s: UnifiedTask['status']): TicketStatus {
  switch (s) {
    case 'in_progress':
      return 'in-progress'
    case 'done':
      return 'done'
    default:
      return 'todo'
  }
}

export function groupTickets(tickets: FloorTicket[], by: TicketGroupBy): Map<string, FloorTicket[]> {
  // Every accessor coalesces an empty key to a human label so a group header is
  // never blank (the "· 76" bug) — one generic rule across all axes.
  const accessor: Record<TicketGroupBy, (t: FloorTicket) => string> = {
    project: (t) => t.project || 'Unlabeled',
    priority: (t) => t.pri,
    source: (t) => (t.source === 'LN' ? 'Linear' : 'GitHub'),
    status: (t) => t.status.replace('-', ' '),
    owner: (t) => t.owner || 'Unassigned',
  }
  const get = accessor[by]
  const groups = new Map<string, FloorTicket[]>()
  for (const t of tickets) {
    const key = get(t)
    const bucket = groups.get(key)
    if (bucket) bucket.push(t)
    else groups.set(key, [t])
  }
  return groups
}

/**
 * Agents grouped by the ticket they carry ("RUSH-812" / "#412" — the same
 * identifier space as FloorTicket.id). The backlog joins on this to show who is
 * already working a ticket; all phases are kept (a done agent with an open PR is
 * still the ticket's worker) so the UI can style by phase.
 */
export function ticketWorkers(agents: FloorAgent[]): Record<string, FloorAgent[]> {
  const by: Record<string, FloorAgent[]> = {}
  for (const a of agents) {
    if (!a.ticket) continue
    ;(by[a.ticket] ??= []).push(a)
  }
  return by
}

/** Per-project activity rollup — what the rail flyout and Projects pane summarize. */
export interface ProjectRollup {
  /** Agents currently on the project. */
  run: number
  /** Of those, agents waiting on the user. */
  wait: number
  /** Open (non-done) backlog tickets for the project. */
  backlog: number
  /** Distinct open-PR URLs carried by the project's agents. */
  prs: number
  /** Most recent agent activity (epoch ms); 0 when unknown/idle. */
  lastActivityMs: number
}

/**
 * Derive every project's rollup from the live feed + backlog in one pass. Keyed by
 * project name (the same key ManagedProject.name / FloorTicket.project use), so a
 * consumer can look up curated and discovered projects alike.
 */
export function projectRollups(agents: FloorAgent[], tickets: FloorTicket[]): Record<string, ProjectRollup> {
  const by: Record<string, ProjectRollup> = {}
  const prSets = new Map<string, Set<string>>()
  const get = (name: string): ProjectRollup => (by[name] ??= { run: 0, wait: 0, backlog: 0, prs: 0, lastActivityMs: 0 })
  for (const a of agents) {
    const r = get(a.project)
    r.run += 1
    if (a.needs) r.wait += 1
    if (a.lastActivityMs > r.lastActivityMs) r.lastActivityMs = a.lastActivityMs
    if (a.prUrl) {
      const set = prSets.get(a.project) ?? new Set<string>()
      set.add(a.prUrl)
      prSets.set(a.project, set)
    }
  }
  for (const t of tickets) {
    if (t.status !== 'done') get(t.project).backlog += 1
  }
  for (const [name, set] of prSets) get(name).prs = set.size
  return by
}

export function sortTickets(tickets: FloorTicket[], by: TicketSort): FloorTicket[] {
  const arr = [...tickets]
  if (by === 'priority') return arr.sort((a, b) => PRI_RANK[a.pri] - PRI_RANK[b.pri])
  return arr.sort((a, b) => a.id.localeCompare(b.id))
}
