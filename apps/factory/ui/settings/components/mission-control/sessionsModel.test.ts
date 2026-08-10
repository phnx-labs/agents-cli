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
  test('status orders reconnect ahead of running ahead of idle', () => {
    const rows = [
      mk({ id: 'idle', phase: 'idle' }),
      mk({ id: 'orph', liveStatus: 'orphaned', phase: 'idle' }),
      mk({ id: 'run', phase: 'running' }),
    ]
    expect(sortSessions(rows, 'status', true).map((a) => a.id)).toEqual(['orph', 'run', 'idle'])
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
  test('state group: Starred first, then Needs reconnecting, then Active — no duplication', () => {
    const secs = groupSessions(list, 'state', 'recent', true)
    expect(secs.map((s) => s.label)).toEqual(['Starred', 'Needs reconnecting', 'Active'])
    // The starred row appears ONLY in Starred, never again in Active.
    const allIds = secs.flatMap((s) => s.agents.map((a) => a.id))
    expect(allIds.filter((id) => id === 'star')).toHaveLength(1)
    expect(secs.find((s) => s.label === 'Active')!.agents.map((a) => a.id)).toEqual(['run'])
  })
  test('filter=starred: no separate Starred band (the whole list is starred)', () => {
    const onlyStar = [mk({ id: 's1', pinned: true }), mk({ id: 's2', pinned: true })]
    const secs = groupSessions(onlyStar, 'state', 'recent', true)
    expect(secs.some((s) => s.kind === 'starred')).toBe(false)
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
