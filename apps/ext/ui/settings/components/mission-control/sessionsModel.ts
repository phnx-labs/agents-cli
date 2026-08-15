// Pure filter/sort/group model for the Sessions surface. No React, no DOM — every
// function here is unit-tested (sessionsModel.test.ts). The surface's whole value is
// recovering detached work fast, so the load-bearing rules are: starred sessions are
// always reachable at the top, and sessions that need reconnecting (orphaned / crashed
// / abandoned — alive or resumable, but detached) surface ahead of everything else.

import {
  needsReconnect,
  sessionBand,
  type FloorAgent,
  type SessionBand,
  type SessionFilter,
  type SessionGroup,
  type SessionSort,
} from './floorModel'

/** One rendered section of the Sessions list: a header + its rows. */
export interface SessionSection {
  /** Stable key for React + scroll retention. */
  key: string
  /** Header text. */
  label: string
  /** What kind of grouping produced this section (drives header styling). */
  kind: 'starred' | 'band' | 'project' | 'host'
  /** The state band, when kind === 'band'. */
  band?: SessionBand
  /** Rows in display order (already sorted). */
  agents: FloorAgent[]
}

export interface SessionScope {
  filter: SessionFilter
  /** Exact project name, or null for all. */
  project: string | null
  /** hostLabel ?? host, or null for all. */
  host: string | null
  /** Free-text query over topic / project / host / branch / id. */
  search: string
}

const hostOf = (a: FloorAgent): string => a.hostLabel ?? a.host

/** True when a session is in one of the live "active" states (not reconnect, not done). */
function isActive(a: FloorAgent): boolean {
  return !needsReconnect(a) && a.phase !== 'done'
}

/**
 * Apply the status chip + project + host + search filters. Pure; order-independent.
 * 'starred' keeps only pinned rows; 'orphaned' keeps only needs-reconnect rows;
 * 'active' drops reconnect + done; 'all' keeps everything.
 */
export function scopeSessions(all: FloorAgent[], scope: SessionScope): FloorAgent[] {
  const q = scope.search.trim().toLowerCase()
  return all.filter((a) => {
    if (scope.filter === 'starred' && !a.pinned) return false
    if (scope.filter === 'orphaned' && !needsReconnect(a)) return false
    if (scope.filter === 'active' && !isActive(a)) return false
    if (scope.project && a.project !== scope.project) return false
    if (scope.host && hostOf(a) !== scope.host) return false
    if (q) {
      const hay = `${a.name} ${a.topic ?? ''} ${a.prompt ?? ''} ${a.project} ${hostOf(a)} ${a.branch} ${a.worktreeSlug} ${a.sessionId ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

// Lower rank sorts first under 'status'. reconnect is the acute case, then the
// live states by urgency, then done.
const STATUS_RANK: Record<string, number> = {
  reconnect: 0,
  waiting: 1,
  running: 2,
  stalled: 2,
  idle: 3,
  failed: 4,
  done: 5,
}

function statusRank(a: FloorAgent): number {
  if (needsReconnect(a)) return STATUS_RANK.reconnect!
  return STATUS_RANK[a.phase] ?? 3
}

/**
 * Sort a list by the chosen key. `desc` reverses the natural direction (natural =
 * most-recent / newest / most-urgent / most-tokens first, and A→Z for name). Stable
 * within equal keys via a sessionId tiebreak so rows don't jitter between renders.
 */
export function sortSessions(list: FloorAgent[], sort: SessionSort, desc: boolean): FloorAgent[] {
  const dir = desc ? 1 : -1
  const arr = [...list]
  arr.sort((a, b) => {
    let cmp = 0
    switch (sort) {
      case 'recent':
        cmp = (b.lastActivityMs || 0) - (a.lastActivityMs || 0)
        break
      case 'started':
        cmp = (b.startedAtMs || 0) - (a.startedAtMs || 0)
        break
      case 'status':
        // Ascending rank (reconnect=0 first). At the shared default dir (desc:true
        // -> +1) this reads "most urgent first".
        cmp = statusRank(a) - statusRank(b)
        break
      case 'tok':
        cmp = (b.tok || 0) - (a.tok || 0)
        break
      case 'name': {
        // A→Z at the shared default dir (desc:true -> +1).
        const an = (a.topic || a.name || '').toLowerCase()
        const bn = (b.topic || b.name || '').toLowerCase()
        cmp = an.localeCompare(bn)
        break
      }
    }
    if (cmp === 0) cmp = (a.sessionId || a.id).localeCompare(b.sessionId || b.id)
    return cmp * dir
  })
  return arr
}

const BAND_LABEL: Record<SessionBand, string> = {
  reconnect: 'Needs reconnecting',
  attention: 'Needs attention',
  active: 'Running',
  done: 'Recently finished',
}
// Ranked by progress (root AGENTS.md "Purpose"): detached work first, then live work
// that has STOPPED progressing (attention), then healthy running work, then done —
// so idle-but-unfinished sessions surface above running, never buried below it.
const BAND_ORDER: SessionBand[] = ['reconnect', 'attention', 'active', 'done']

/**
 * Group a scoped list into ordered sections. Starred sessions are lifted into a
 * single "Starred" section at the very top (so they are always one glance away),
 * and are NOT repeated below — EXCEPT when the filter is already 'starred', where
 * the whole list is starred and a separate band would be noise. Everything else is
 * grouped by `group`, and every section is sorted by (`sort`,`desc`).
 */
export function groupSessions(
  scoped: FloorAgent[],
  group: SessionGroup,
  sort: SessionSort,
  desc: boolean,
  /** True when the active status filter is already 'starred' — then the whole list
   *  is starred, so a separate top "Starred" section would be pure noise. Keyed off
   *  the actual filter, NOT "every visible row happens to be pinned" (which would
   *  also drop the section for a user whose only sessions are all starred on the
   *  'all' filter — the exact case the top section exists for). */
  filterIsStarred = false,
): SessionSection[] {
  const sections: SessionSection[] = []

  const starred = filterIsStarred ? [] : scoped.filter((a) => a.pinned)
  const rest = filterIsStarred ? scoped : scoped.filter((a) => !a.pinned)

  if (starred.length) {
    sections.push({ key: 'starred', label: 'Starred', kind: 'starred', agents: sortSessions(starred, sort, desc) })
  }

  if (group === 'flat') {
    if (rest.length) sections.push({ key: 'all', label: 'All sessions', kind: 'band', agents: sortSessions(rest, sort, desc) })
    return sections
  }

  if (group === 'state') {
    for (const band of BAND_ORDER) {
      const inBand = rest.filter((a) => sessionBand(a) === band)
      if (inBand.length) {
        // The attention band exists to surface work that has STOPPED progressing, so
        // it always leads with the MOST-stuck session (oldest activity) — the highest
        // abandonment risk — independent of the list-wide sort. Other bands honor the
        // chosen (`sort`,`desc`).
        const agents = band === 'attention'
          ? [...inBand].sort((a, b) => {
              const d = (a.lastActivityMs || 0) - (b.lastActivityMs || 0)
              return d !== 0 ? d : (a.sessionId || a.id).localeCompare(b.sessionId || b.id)
            })
          : sortSessions(inBand, sort, desc)
        sections.push({ key: `band:${band}`, label: BAND_LABEL[band], kind: 'band', band, agents })
      }
    }
    return sections
  }

  // group === 'project' | 'host': bucket by key, order buckets by "needs
  // reconnecting first, then most rows", so the projects/machines with lost work
  // rise to the top.
  const keyOf = group === 'project' ? (a: FloorAgent) => a.project : hostOf
  const buckets = new Map<string, FloorAgent[]>()
  for (const a of rest) {
    const k = keyOf(a) || '(none)'
    const b = buckets.get(k)
    if (b) b.push(a)
    else buckets.set(k, [a])
  }
  const ordered = [...buckets.entries()].sort((a, b) => {
    const ra = a[1].some(needsReconnect) ? 0 : 1
    const rb = b[1].some(needsReconnect) ? 0 : 1
    if (ra !== rb) return ra - rb
    if (b[1].length !== a[1].length) return b[1].length - a[1].length
    return a[0].localeCompare(b[0])
  })
  for (const [k, rows] of ordered) {
    sections.push({
      key: `${group}:${k}`,
      label: k,
      kind: group === 'project' ? 'project' : 'host',
      agents: sortSessions(rows, sort, desc),
    })
  }
  return sections
}

/** Counts for the filter chips — computed once over the full (unscoped-by-chip) list. */
export function sessionChipCounts(all: FloorAgent[]): Record<SessionFilter, number> {
  let active = 0
  let orphaned = 0
  let starred = 0
  for (const a of all) {
    if (a.pinned) starred++
    if (needsReconnect(a)) orphaned++
    else if (a.phase !== 'done') active++
  }
  return { all: all.length, active, orphaned, starred }
}
