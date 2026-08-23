import { abbrFor, type RemoteSessionLike } from './floorAdapter'
import type { AgentAbbr, CiStatus, FloorAgent } from './floorModel'
import type { TerminalDetail } from '../../types'

// Pure model for the Recap ledger — "what happened while I was away". Turns the
// fleet-wide recent-session sweep (fetchRecapSessions) into day-grouped entries
// with per-day rollups. No React, no fetching; unit-tested next to this file.

/** One fork edge as the extension recorded it (src/core/forkLineage.ts). */
export interface RecapForkEdge {
  sourceSessionId: string
  sourceHost: string
  forkSessionId: string | null
  forkHost: string
  agentKey: string
  forkedAt: number
}

export interface RecapEntry {
  id: string
  abbr: AgentAbbr
  /** Task line: label/topic, else worktree slug, else branch, else a generic agent title. */
  title: string
  project: string
  host: string
  branch: string
  startedAtMs: number
  lastActivityMs: number
  durationMs: number
  costUsd: number
  tokenCount: number
  prUrl: string | null
  ticket: string | null
  /** This row is a fork: where it came from, and where it ran. */
  fork: { sourceId: string; sourceHost: string; forkHost: string } | null
  /**
   * The parent's own ledger row, when it landed in the same day group — the row
   * renders the two side by side and the parent's standalone row is dropped.
   * Null when the parent is on another day (or out of the sweep); the fork still
   * carries its `fork` marker, so the lineage never silently disappears.
   */
  forkedFrom: RecapEntry | null
}

export interface RecapDay {
  /** 'Today' / 'Yesterday' / 'Jul 8' — derived from lastActivity in local time. */
  label: string
  entries: RecapEntry[]
  /** Rollup across the day's entries — counted BEFORE pairing, so a fork pair
   *  still reports the two sessions and two costs it actually is. */
  sessions: number
  costUsd: number
  prs: number
}

/** 'Today' / 'Yesterday' / short local date for any older day. */
export function recapDayLabel(ms: number, nowMs: number): string {
  const day = new Date(ms)
  const now = new Date(nowMs)
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(day)) / 86_400_000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "$5.60" / "$0.42" — always two decimals; '' when unknown (0). */
export function recapCost(usd: number): string {
  if (!usd || !Number.isFinite(usd)) return ''
  return `$${usd.toFixed(2)}`
}

function recapTitle(s: RemoteSessionLike): string {
  return s.label || s.topic || s.worktreeSlug || s.branch || (s.agentType ? `${s.agentType} session` : 'Session')
}

/**
 * Build the day-grouped ledger from the recap sweep. `liveIds` (session ids of
 * agents currently on the live feed) are excluded — the ledger is what FINISHED,
 * the feed is what's running. Dedup by session id (the same session can surface
 * from two sweeps), newest activity first, grouped by local calendar day.
 *
 * `forkEdges` (recorded by `Agents: Fork …` at launch) reunite a fork with the
 * session it came from: a fork's row carries the lineage, and when the parent
 * finished on the same day the two render as ONE side-by-side row. Day rollups
 * are counted before that pairing, so the numbers still describe both sessions.
 */
export function buildRecap(
  sessions: RemoteSessionLike[],
  liveIds: Set<string>,
  nowMs: number,
  forkEdges: RecapForkEdge[] = [],
): RecapDay[] {
  const forkByFork = new Map<string, RecapForkEdge>()
  for (const e of forkEdges) {
    if (e.forkSessionId && !forkByFork.has(e.forkSessionId)) forkByFork.set(e.forkSessionId, e)
  }

  const seen = new Set<string>()
  const entries: RecapEntry[] = []
  for (const s of sessions) {
    if (!s.sessionId || liveIds.has(s.sessionId) || seen.has(s.sessionId)) continue
    seen.add(s.sessionId)
    const at = s.lastActivityMs || s.startedAtMs
    if (!at) continue
    const edge = forkByFork.get(s.sessionId)
    entries.push({
      id: s.sessionId,
      abbr: abbrFor(s.agentType),
      title: recapTitle(s),
      project: s.project,
      host: s.host,
      branch: s.branch,
      startedAtMs: s.startedAtMs,
      lastActivityMs: at,
      durationMs: s.durationMs ?? 0,
      costUsd: s.costUsd ?? 0,
      tokenCount: s.tokenCount ?? 0,
      prUrl: s.prUrl,
      ticket: s.ticket,
      fork: edge
        ? { sourceId: edge.sourceSessionId, sourceHost: edge.sourceHost, forkHost: edge.forkHost }
        : null,
      forkedFrom: null,
    })
  }
  entries.sort((a, b) => b.lastActivityMs - a.lastActivityMs)

  const days: RecapDay[] = []
  for (const e of entries) {
    const label = recapDayLabel(e.lastActivityMs, nowMs)
    let day = days[days.length - 1]
    if (!day || day.label !== label) {
      day = { label, entries: [], sessions: 0, costUsd: 0, prs: 0 }
      days.push(day)
    }
    day.entries.push(e)
    day.sessions += 1
    day.costUsd += e.costUsd
    if (e.prUrl) day.prs += 1
  }
  for (const day of days) pairForksWithin(day)
  return days
}

/**
 * Fold each fork in a day onto its parent's row. The parent is only absorbed
 * when it finished on the SAME day — a pair spanning two days would have to
 * delete yesterday's row to render, and the ledger must not rewrite a past day.
 * A parent that isn't here stays unpaired; the fork keeps its lineage marker.
 */
function pairForksWithin(day: RecapDay): void {
  const byId = new Map(day.entries.map((e) => [e.id, e]))
  const absorbed = new Set<string>()
  for (const e of day.entries) {
    if (!e.fork) continue
    const parent = byId.get(e.fork.sourceId)
    // A parent that is itself somebody's fork keeps its own row: chaining two
    // pairs into one would hide the middle session.
    if (!parent || parent === e || absorbed.has(parent.id) || parent.fork) continue
    e.forkedFrom = parent
    absorbed.add(parent.id)
  }
  if (absorbed.size > 0) day.entries = day.entries.filter((e) => !absorbed.has(e.id))
}

// =============================================================================
// ADAPTER SEAM — Fleet session row
//
// Prefer CLI session/watch JSON fields when present:
//   title, recapSource, userPromptClean, userPromptKind, lastAgentLine
// Until those land on origin/main, bind against TerminalDetail
// (narrative, lastAssistantMessage, firstUserMessage, branch, cwd, status)
// and FloorAgent (topic, prompt, resp, messages, project, pr, ci, branch, host).
// Wire the final field names here — not in SessionsPane.
// =============================================================================

export type RecapSource = 'agent recap' | 'last line' | 'renamed'
export type UserPromptKind = 'text' | 'image' | 'command' | 'skill'
export type RecapSourceClass = 'agent' | 'last' | 'rename'
export type SessionLive = 'run' | 'idle' | 'done' | 'orphan'

export type RecapSourceWire =
  | RecapSource
  | 'agent'
  | 'last'
  | 'rename'
  | 'renamed'
  | 'last line'
  | 'agent recap'

/** CLI-watch / TerminalDetail overlay the row consumes. Extra keys are ignored. */
export interface SessionRecapFields {
  title?: string | null
  recapSource?: RecapSourceWire | null
  userPromptClean?: string | null
  userPromptKind?: UserPromptKind | null
  lastAgentLine?: string | null
  lastAgentMessage?: string | null
  lastAssistantMessage?: string | null
  firstUserMessage?: string | null
  narrative?: string | null
  cwd?: string | null
  branch?: string | null
  status?: string | null
}

export interface ProcessedUserPrompt {
  kind: UserPromptKind
  /** Caption after chips; filesystem paths stripped. */
  text: string
  /**
   * Chip label: `screenshot` (image), the first command (command), `/skill`
   * (skill). Null for plain text.
   */
  chip: string | null
}

export interface SessionRowView {
  title: string
  recapSource: RecapSource
  recapSourceClass: RecapSourceClass
  you: ProcessedUserPrompt
  harnessTag: string
  lastLine: string
  lastFull: string
  repo: string
  pr: { label: string; ci: CiStatus } | null
  branch: string
  host: string
  age: string
  live: SessionLive
}

const HARNESS_BY_ABBR: Record<AgentAbbr, string> = {
  CC: 'Claude',
  CX: 'Codex',
  GX: 'Gemini',
  CR: 'Cursor',
  AG: 'Agents',
  GK: 'Grok',
  KM: 'Kimi',
  DR: 'Droid',
  OC: 'OpenCode',
  SH: 'Shell',
}

const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|heic|tiff?)(?:\b|$)/i
const IMAGE_PATH_RE =
  /(?:~|\/|[A-Za-z]:\\)[^\n]*?\.(?:png|jpe?g|gif|webp|avif|bmp|heic|tiff?)/i
const ABS_PATH_RE = /(?:\/(?:Users|home|tmp|var|private|Screenshots)[^\s'"`\])]+|[A-Za-z]:\\[^\s'"`\])]+)/g
const SKILL_BASE_RE = /Base directory for this skill:\s*(\S+)/i
const COMMAND_NAME_RE = /<command-name>\s*([^<]*?)\s*<\/command-name>/i
const BASH_INPUT_RE = /<bash-input>\s*([\s\S]*?)\s*<\/bash-input>/i
const FENCE_CMD_RE = /```(?:bash|sh|zsh|shell)?\s*\n([^\n]+)/i
const LEADING_CMD_RE = /^\s*(?:\$|❯)\s+(\S.*)$/m
const TEAM_PROMPT_SUFFIX_MARKER = "When you're done, provide a brief summary of:"
const HEADLESS_PLAN_MODE_PREFIX = 'You are running in HEADLESS PLAN MODE.'
const NOISE_LINE_PATTERNS = [
  /^(cwd|shell|current_date|timezone|os|platform|arch|home|user)\b\s*:/i,
  /^\/[\w/.-]+$/,
  /^(bash|zsh|fish|sh|dash)$/i,
  /^\d{4}-\d{2}-\d{2}$/,
  /^Caveat:/i,
]

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
}

function basenameOf(path: string): string {
  const segs = path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean)
  const wt = segs.indexOf('worktrees')
  if (wt > 1 && segs[wt - 1] === '.agents') return segs[wt - 2] ?? segs[segs.length - 1] ?? ''
  return segs[segs.length - 1] ?? ''
}

function stripTeamWrappers(raw: string): string {
  let text = raw
  if (text.trimStart().startsWith(HEADLESS_PLAN_MODE_PREFIX)) {
    const blankLine = text.indexOf('\n\n')
    if (blankLine === -1) return ''
    text = text.slice(blankLine + 2)
  }
  const suffixIdx = text.indexOf(TEAM_PROMPT_SUFFIX_MARKER)
  if (suffixIdx !== -1) text = text.slice(0, suffixIdx)
  return text.trim()
}

/** Strip framework wrappers so the row never shows `<command-message>` / path noise. */
export function cleanSessionPrompt(raw: string): string {
  let text = stripTeamWrappers(raw).replace(/\r/g, '').trim()
  if (!text) return ''
  text = text.replace(/<\/?[a-z_][a-z0-9_-]*>/gi, '')
  const meaningful = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line)))
  return meaningful.join('\n').trim()
}

export function harnessLabel(abbr: AgentAbbr): string {
  return `${HARNESS_BY_ABBR[abbr] ?? 'Agent'} ›`
}

export function normalizeRecapSource(raw: RecapSourceWire | null | undefined): RecapSource | null {
  if (!raw) return null
  if (raw === 'agent' || raw === 'agent recap') return 'agent recap'
  if (raw === 'last' || raw === 'last line') return 'last line'
  if (raw === 'rename' || raw === 'renamed') return 'renamed'
  return null
}

export function recapSourceClass(src: RecapSource): RecapSourceClass {
  if (src === 'agent recap') return 'agent'
  if (src === 'last line') return 'last'
  return 'rename'
}

function skillNameFromPath(path: string): string {
  const segs = path.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean)
  const skillsAt = segs.lastIndexOf('skills')
  const name = skillsAt >= 0 ? segs[skillsAt + 1] : segs[segs.length - 1]
  if (!name) return '/skill'
  return name.startsWith('/') ? name : `/${name}`
}

function extractSkillName(raw: string): string | null {
  const base = raw.match(SKILL_BASE_RE)
  if (base?.[1]) return skillNameFromPath(base[1])
  const cmd = raw.match(COMMAND_NAME_RE)
  const name = cmd?.[1]?.trim()
  if (name) return name.startsWith('/') ? name : `/${name}`
  return null
}

function firstCommandTokens(cmd: string): string {
  const rest = cmd.trim().replace(/^\$\s+/, '')
  const m = rest.match(/^([A-Za-z0-9._:/-]+(?:\s+[A-Za-z0-9._:/-]+){0,4})(?:\s+[A-Z]|$)/)
  return (m?.[1] ?? rest.split(/\s+/).slice(0, 3).join(' ')).trim()
}

function extractCommand(raw: string): string | null {
  const bash = raw.match(BASH_INPUT_RE)
  if (bash?.[1]) return firstCommandTokens(firstLine(bash[1]))
  const fence = raw.match(FENCE_CMD_RE)
  if (fence?.[1]) return firstCommandTokens(fence[1])
  const lead = raw.match(LEADING_CMD_RE)
  if (lead?.[1]) return firstCommandTokens(lead[1])
  return null
}

function truncateCmd(cmd: string, max = 40): string {
  const t = cmd.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

function stripPaths(text: string): string {
  return text
    .replace(new RegExp(IMAGE_PATH_RE.source, 'gi'), ' ')
    .replace(ABS_PATH_RE, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function hasImageAttachment(
  attachments?: Array<{ path?: string; mediaType?: string; label?: string }>,
): boolean {
  return (attachments ?? []).some((a) => {
    const media = a.mediaType ?? ''
    if (media.startsWith('image/')) return true
    return IMAGE_EXT_RE.test(a.path ?? '') || IMAGE_EXT_RE.test(a.label ?? '')
  })
}

export function detectUserPromptKind(
  raw: string,
  attachments?: Array<{ path?: string; mediaType?: string; label?: string }>,
): UserPromptKind {
  if (hasImageAttachment(attachments) || IMAGE_PATH_RE.test(raw)) return 'image'
  if (SKILL_BASE_RE.test(raw) || COMMAND_NAME_RE.test(raw)) return 'skill'
  if (BASH_INPUT_RE.test(raw) || FENCE_CMD_RE.test(raw) || LEADING_CMD_RE.test(raw)) return 'command'
  return 'text'
}

export function processUserPrompt(
  raw: string,
  kindHint?: UserPromptKind | null,
  attachments?: Array<{ path?: string; mediaType?: string; label?: string }>,
): ProcessedUserPrompt {
  const kind = kindHint ?? detectUserPromptKind(raw, attachments)
  if (kind === 'image') {
    return { kind: 'image', chip: 'screenshot', text: stripPaths(cleanSessionPrompt(raw)) }
  }
  if (kind === 'command') {
    const cmd = extractCommand(raw) ?? firstCommandTokens(firstLine(cleanSessionPrompt(raw)))
    let rest = raw
    if (BASH_INPUT_RE.test(raw)) rest = raw.replace(BASH_INPUT_RE, '\n')
    rest = rest.replace(FENCE_CMD_RE, '\n')
    if (cmd) rest = rest.replace(cmd, '')
    rest = rest.replace(/^\s*[\$❯]\s*/gm, '')
    return { kind: 'command', chip: truncateCmd(cmd.replace(/^\$\s+/, '')), text: stripPaths(cleanSessionPrompt(rest)) }
  }
  if (kind === 'skill') {
    const chip = extractSkillName(raw) ?? '/skill'
    let rest = raw.replace(SKILL_BASE_RE, '\n')
    rest = rest.replace(/<command-(?:name|message|args|contents)>[\s\S]*?<\/command-(?:name|message|args|contents)>/gi, '\n')
    return { kind: 'skill', chip, text: stripPaths(cleanSessionPrompt(rest)) }
  }
  return { kind: 'text', chip: null, text: stripPaths(cleanSessionPrompt(raw)) }
}

export function quoteAgentLine(line: string): string {
  const t = line.trim()
  if (!t) return ''
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('\u201c') && t.endsWith('\u201d'))) return t
  return `"${t}"`
}

export function prLabel(pr: string | null | undefined): string | null {
  if (!pr) return null
  const n = pr.replace(/^\s*PR\s*/i, '').replace(/^#/, '').trim()
  if (!n) return null
  return `PR #${n}`
}

function inferRecapSource(fields: SessionRecapFields, title: string, promptText: string): RecapSource {
  const wired = normalizeRecapSource(fields.recapSource)
  if (wired) return wired
  const promptFirst = firstLine(promptText)
  if (title && promptFirst && title !== promptFirst) {
    return title.length > 28 ? 'agent recap' : 'renamed'
  }
  return 'last line'
}

function liveOf(agent: FloorAgent, status?: string | null): SessionLive {
  // Right-edge live dot is progress (working / idle / done). Reconnect is the
  // LEFT pdot + group band — matching the approved mockup, where a reconnecting
  // row can still be green/amber/grey.
  const st = (status ?? agent.phase).toLowerCase()
  if (st === 'running' || st === 'stalled') return 'run'
  if (st === 'done' || st === 'completed' || st === 'stopped') return 'done'
  if (st === 'idle' || st === 'waiting') return 'idle'
  const ls = (agent.liveStatus ?? '').toLowerCase()
  if (ls === 'orphaned' || ls === 'crashed' || ls === 'abandoned') return 'orphan'
  return 'idle'
}

/**
 * ADAPTER SEAM entry: build the row view-model from a FloorAgent plus optional
 * TerminalDetail / CLI-watch overlay. Callers must not re-derive prompt chips.
 */
export function sessionRowView(
  agent: FloorAgent,
  terminal?: TerminalDetail | SessionRecapFields | null,
): SessionRowView {
  const overlay = {
    ...(agent as FloorAgent & SessionRecapFields),
    ...(terminal ?? {}),
  } as SessionRecapFields & FloorAgent

  const rawPrompt = firstNonEmpty(
    overlay.userPromptClean,
    overlay.firstUserMessage,
    agent.prompt,
    agent.topic,
  )
  const you = processUserPrompt(rawPrompt, overlay.userPromptKind, agent.attachments)
  const lastFull = firstNonEmpty(
    overlay.lastAgentMessage,
    overlay.lastAssistantMessage,
    overlay.narrative,
    agent.resp,
    agent.messages[agent.messages.length - 1],
    agent.summary,
    overlay.lastAgentLine,
  )
  const lastLine = quoteAgentLine(firstNonEmpty(overlay.lastAgentLine, firstLine(lastFull)))
  const title = firstNonEmpty(overlay.title, agent.topic, agent.name, 'Session')
  const recapSource = inferRecapSource(overlay, title, you.text || rawPrompt)
  const repo = firstNonEmpty(agent.project, overlay.cwd ? basenameOf(overlay.cwd) : '')
  const pr = prLabel(agent.pr)

  return {
    title,
    recapSource,
    recapSourceClass: recapSourceClass(recapSource),
    you,
    harnessTag: harnessLabel(agent.abbr),
    lastLine,
    lastFull,
    repo,
    pr: pr ? { label: pr, ci: agent.ci ?? null } : null,
    branch: firstNonEmpty(overlay.branch, agent.branch),
    host: firstNonEmpty(agent.hostLabel, agent.host === 'this-mac' ? '' : agent.host),
    age: agent.since,
    live: liveOf(agent, overlay.status),
  }
}
