import { abbrFor, type RemoteSessionLike } from './floorAdapter'
import type { AgentAbbr } from './floorModel'

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
