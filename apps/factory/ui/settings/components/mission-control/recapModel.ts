import { abbrFor, type RemoteSessionLike } from './floorAdapter'
import type { AgentAbbr } from './floorModel'

// Pure model for the Recap ledger — "what happened while I was away". Turns the
// fleet-wide recent-session sweep (fetchRecapSessions) into day-grouped entries
// with per-day rollups. No React, no fetching; unit-tested next to this file.

export interface RecapEntry {
  id: string
  abbr: AgentAbbr
  /** Task line: topic, else worktree slug, else branch, else the session id. */
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
}

export interface RecapDay {
  /** 'Today' / 'Yesterday' / 'Jul 8' — derived from lastActivity in local time. */
  label: string
  entries: RecapEntry[]
  /** Rollup across the day's entries. */
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

/**
 * Build the day-grouped ledger from the recap sweep. `liveIds` (session ids of
 * agents currently on the live feed) are excluded — the ledger is what FINISHED,
 * the feed is what's running. Dedup by session id (the same session can surface
 * from two sweeps), newest activity first, grouped by local calendar day.
 */
export function buildRecap(sessions: RemoteSessionLike[], liveIds: Set<string>, nowMs: number): RecapDay[] {
  const seen = new Set<string>()
  const entries: RecapEntry[] = []
  for (const s of sessions) {
    if (!s.sessionId || liveIds.has(s.sessionId) || seen.has(s.sessionId)) continue
    seen.add(s.sessionId)
    const at = s.lastActivityMs || s.startedAtMs
    if (!at) continue
    entries.push({
      id: s.sessionId,
      abbr: abbrFor(s.agentType),
      title: s.topic || s.worktreeSlug || s.branch || s.sessionId.slice(0, 8),
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
  return days
}
