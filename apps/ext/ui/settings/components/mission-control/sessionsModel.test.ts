import { describe, test, expect } from 'bun:test'
import type { FloorAgent } from './floorModel'
import { needsReconnect, sessionBand } from './floorModel'
import { scopeSessions, sortSessions, groupSessions, sessionChipCounts, type SessionScope } from './sessionsModel'

function mk(over: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: over.id ?? 'a1',
    host: 'this-mac',
    hostLabel: 'zion',
    project: 'agents-cli',
    name: 'a-session',
    abbr: 'CC',
    phase: 'running',
    verb: '',
    target: '',
    tok: 0,
    since: '2s',
    lastActivityMs: 0,
    startedAtMs: 0,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: null,
    prUrl: null,
    ticket: null,
    branch: '',
    worktreeSlug: '',
    worktreePath: '',
    resp: '',
    prompt: '',
    topic: '',
    sessionId: over.id ?? 'a1',
    messages: [],
    question: null,
    reply: { kind: 'terminal', host: 'this-mac', terminalId: 'CC-1' },
    todos: [],
    summary: '',
    recent: [],
    ...over,
  } as FloorAgent
}

const EMPTY: SessionScope = { filter: 'all', project: null, host: null, search: '' }

describe('needsReconnect / sessionBand', () => {
  test('orphaned, crashed, abandoned all need reconnecting', () => {
    for (const s of ['orphaned', 'crashed', 'abandoned', 'ORPHANED']) {
      expect(needsReconnect(mk({ liveStatus: s }))).toBe(true)
      expect(sessionBand(mk({ liveStatus: s, phase: 'idle' }))).toBe('reconnect')
    }
  })
  test('a plain idle/running session is NOT reconnect', () => {
    expect(needsReconnect(mk({ liveStatus: 'idle' }))).toBe(false)
    expect(needsReconnect(mk({ liveStatus: '' }))).toBe(false)
    expect(needsReconnect(mk({ liveStatus: undefined }))).toBe(false)
    expect(sessionBand(mk({ phase: 'running' }))).toBe('active')
    expect(sessionBand(mk({ phase: 'done' }))).toBe('done')
  })
  test('reconnect wins even over a done phase (a crashed session is resumable, not finished)', () => {
    expect(sessionBand(mk({ liveStatus: 'crashed', phase: 'done' }))).toBe('reconnect')
  })
  test('attention band = live but not progressing (idle / stalled / waiting / failed)', () => {
    for (const phase of ['idle', 'stalled', 'waiting', 'failed'] as const) {
      expect(sessionBand(mk({ phase }))).toBe('attention')
    }
    // a running session IS progressing, so it stays in the active band, not attention
    expect(sessionBand(mk({ phase: 'running' }))).toBe('active')
  })
})

describe('scopeSessions — filter chips', () => {
  const list = [
    mk({ id: 'run', phase: 'running', liveStatus: 'running' }),
    mk({ id: 'orph', phase: 'idle', liveStatus: 'orphaned' }),
    mk({ id: 'idle', phase: 'idle', liveStatus: 'idle' }),
    mk({ id: 'done', phase: 'done', liveStatus: 'idle' }),
    mk({ id: 'star', phase: 'running', liveStatus: 'running', pinned: true }),
  ]
  test('orphaned keeps only reconnect rows', () => {
    expect(scopeSessions(list, { ...EMPTY, filter: 'orphaned' }).map((a) => a.id)).toEqual(['orph'])
  })
  test('active drops reconnect and done', () => {
    expect(scopeSessions(list, { ...EMPTY, filter: 'active' }).map((a) => a.id).sort()).toEqual(['idle', 'run', 'star'])
  })
  test('starred keeps only pinned', () => {
    expect(scopeSessions(list, { ...EMPTY, filter: 'starred' }).map((a) => a.id)).toEqual(['star'])
  })
  test('all keeps everything', () => {
    expect(scopeSessions(list, EMPTY)).toHaveLength(5)
  })
})

describe('scopeSessions — project / host / search', () => {
  const list = [
    mk({ id: 'a', project: 'agents-cli', hostLabel: 'zion', topic: 'refactor secrets broker' }),
    mk({ id: 'b', project: 'rush', hostLabel: 'mac-mini', topic: 'blog post' }),
  ]
  test('project filter', () => {
    expect(scopeSessions(list, { ...EMPTY, project: 'rush' }).map((a) => a.id)).toEqual(['b'])
  })
  test('host filter uses hostLabel', () => {
    expect(scopeSessions(list, { ...EMPTY, host: 'zion' }).map((a) => a.id)).toEqual(['a'])
  })
  test('search matches topic', () => {
    expect(scopeSessions(list, { ...EMPTY, search: 'secrets' }).map((a) => a.id)).toEqual(['a'])
  })
})

describe('sortSessions — recency vs creation are distinct', () => {
  // s1 started long ago but was active recently; s2 started recently but is now quiet.
  const s1 = mk({ id: 's1', startedAtMs: 1_000, lastActivityMs: 9_000 })
  const s2 = mk({ id: 's2', startedAtMs: 8_000, lastActivityMs: 2_000 })
  test('recent orders by lastActivityMs (s1 first)', () => {
    expect(sortSessions([s2, s1], 'recent', true).map((a) => a.id)).toEqual(['s1', 's2'])
  })
  test('started orders by startedAtMs (s2 first) — a different order than recent', () => {
    expect(sortSessions([s1, s2], 'started', true).map((a) => a.id)).toEqual(['s2', 's1'])
  })
  // Root AGENTS.md "Purpose": rank by PROGRESS, not liveness. Idle-but-unfinished is
  // the highest-abandonment-risk state, so it surfaces ABOVE running, never below it,
  // and `done` is a distinct terminal state at the bottom (RUSH-2838).
  test('status never buries idle below running, and done is terminal', () => {
    const rows = [
      mk({ id: 'done', phase: 'done' }),
      mk({ id: 'run', phase: 'running' }),
      mk({ id: 'idle', phase: 'idle' }),
      mk({ id: 'orph', liveStatus: 'orphaned', phase: 'idle' }),
    ]
    expect(sortSessions(rows, 'status', true).map((a) => a.id)).toEqual(['orph', 'idle', 'run', 'done'])
  })
  test('status puts every stopped phase above running, most acute first', () => {
    const rows = [
      mk({ id: 'done', phase: 'done' }),
      mk({ id: 'run', phase: 'running' }),
      mk({ id: 'idle', phase: 'idle' }),
      mk({ id: 'stalled', phase: 'stalled' }),
      mk({ id: 'failed', phase: 'failed' }),
      mk({ id: 'waiting', phase: 'waiting' }),
      mk({ id: 'orph', liveStatus: 'orphaned', phase: 'idle' }),
    ]
    expect(sortSessions(rows, 'status', true).map((a) => a.id))
      .toEqual(['orph', 'waiting', 'failed', 'stalled', 'idle', 'run', 'done'])
  })
  test('the status sort agrees with the band grouping it sits next to', () => {
    // `Sort: Status` and the default `Group: state` are two views of one ranking, so a
    // row cannot lead under one and trail under the other. Both are driven off
    // PHASE_RANK / BAND_ORDER; this pins them together.
    const rows = [
      mk({ id: 'run', phase: 'running' }),
      mk({ id: 'idle', phase: 'idle' }),
      mk({ id: 'orph', liveStatus: 'orphaned', phase: 'idle' }),
      mk({ id: 'done', phase: 'done' }),
    ]
    const bySort = sortSessions(rows, 'status', true).map((a) => sessionBand(a))
    const byBand = groupSessions(rows, 'state', 'status', true).map((s) => s.band)
    expect(bySort).toEqual(['reconnect', 'attention', 'active', 'done'])
    expect(byBand).toEqual(['reconnect', 'attention', 'active', 'done'])
  })
  test('name sorts A→Z when desc (the shared default direction)', () => {
    const rows = [mk({ id: 'z', topic: 'zebra' }), mk({ id: 'a', topic: 'apple' })]
    expect(sortSessions(rows, 'name', true).map((a) => a.id)).toEqual(['a', 'z'])
  })
})

describe('groupSessions — starred pinned to a single top section', () => {
  const list = [
    mk({ id: 'star', pinned: true, phase: 'running' }),
    mk({ id: 'orph', liveStatus: 'orphaned', phase: 'idle' }),
    mk({ id: 'run', phase: 'running' }),
  ]
  test('state group: Starred first, then Needs reconnecting, then Running — no duplication', () => {
    const secs = groupSessions(list, 'state', 'recent', true)
    expect(secs.map((s) => s.label)).toEqual(['Starred', 'Needs reconnecting', 'Running'])
    // The starred row appears ONLY in Starred, never again in Running.
    const allIds = secs.flatMap((s) => s.agents.map((a) => a.id))
    expect(allIds.filter((id) => id === 'star')).toHaveLength(1)
    expect(secs.find((s) => s.label === 'Running')!.agents.map((a) => a.id)).toEqual(['run'])
  })
  test('filter=starred: no separate Starred band (the whole list is starred)', () => {
    const onlyStar = [mk({ id: 's1', pinned: true }), mk({ id: 's2', pinned: true })]
    const secs = groupSessions(onlyStar, 'state', 'recent', true, /* filterIsStarred */ true)
    expect(secs.some((s) => s.kind === 'starred')).toBe(false)
  })
  test('all-pinned on a non-starred filter STILL renders the Starred band (keyed off filter, not pin ratio)', () => {
    const onlyStar = [mk({ id: 's1', pinned: true, phase: 'running' }), mk({ id: 's2', pinned: true, phase: 'idle' })]
    const secs = groupSessions(onlyStar, 'state', 'recent', true, /* filterIsStarred */ false)
    expect(secs[0]!.kind).toBe('starred')
    expect(secs[0]!.agents.map((a) => a.id).sort()).toEqual(['s1', 's2'])
  })
})

describe('groupSessions — attention band ranks progress-stopped work above running', () => {
  test('idle/stalled sessions surface in "Needs attention" ABOVE the running band', () => {
    const list = [
      mk({ id: 'run', phase: 'running', lastActivityMs: 9_000 }),
      mk({ id: 'idle', phase: 'idle', lastActivityMs: 5_000 }),
      mk({ id: 'stall', phase: 'stalled', lastActivityMs: 1_000 }),
    ]
    const secs = groupSessions(list, 'state', 'recent', true)
    expect(secs.map((s) => s.label)).toEqual(['Needs attention', 'Running'])
    // Within attention, MOST-stuck (oldest activity) first — stall(1s) before idle(5s).
    expect(secs.find((s) => s.label === 'Needs attention')!.agents.map((a) => a.id)).toEqual(['stall', 'idle'])
    expect(secs.find((s) => s.label === 'Running')!.agents.map((a) => a.id)).toEqual(['run'])
  })
  test('attention leads most-stuck-first even under a recency sort that would reverse it', () => {
    // Under 'recent' desc the most-recent (idle2 @ 8s) would sort first; the band's
    // staleness override must instead put the most-stuck (idle1 @ 2s) at the top.
    const list = [
      mk({ id: 'idle1', phase: 'idle', lastActivityMs: 2_000 }),
      mk({ id: 'idle2', phase: 'idle', lastActivityMs: 8_000 }),
    ]
    const secs = groupSessions(list, 'state', 'recent', true)
    expect(secs.find((s) => s.label === 'Needs attention')!.agents.map((a) => a.id)).toEqual(['idle1', 'idle2'])
  })
})

describe('groupSessions — project grouping surfaces lost work first', () => {
  const list = [
    mk({ id: 'r1', project: 'rush', phase: 'running' }),
    mk({ id: 'r2', project: 'rush', phase: 'idle' }),
    mk({ id: 'a1', project: 'agents-cli', liveStatus: 'orphaned', phase: 'idle' }),
  ]
  test('a project with an orphaned session sorts above a larger all-active project', () => {
    const secs = groupSessions(list, 'project', 'recent', true)
    expect(secs.map((s) => s.label)).toEqual(['agents-cli', 'rush'])
  })
})

describe('sessionChipCounts', () => {
  test('counts all / active / orphaned / starred', () => {
    const list = [
      mk({ phase: 'running' }),
      mk({ phase: 'idle' }),
      mk({ liveStatus: 'orphaned', phase: 'idle' }),
      mk({ phase: 'done' }),
      mk({ pinned: true, phase: 'running' }),
    ]
    expect(sessionChipCounts(list)).toEqual({ all: 5, active: 3, orphaned: 1, starred: 1 })
  })
})
