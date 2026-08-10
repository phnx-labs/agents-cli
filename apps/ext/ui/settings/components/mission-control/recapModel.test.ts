import { describe, test, expect } from 'bun:test'
import { buildRecap, recapDayLabel, recapCost, type RecapForkEdge } from './recapModel'
import type { RemoteSessionLike } from './floorAdapter'

const NOW = Date.parse('2026-07-10T18:00:00') // local-time anchor for day labels

function session(over: Partial<RemoteSessionLike>): RemoteSessionLike {
  return {
    host: 'zion',
    sessionId: 's1',
    agentType: 'claude',
    cwd: '/repo',
    project: 'agents-cli',
    phase: 'idle',
    activity: '',
    tokPerSec: 0,
    waitingForInput: false,
    lastResponse: '',
    prUrl: null,
    ticket: null,
    branch: 'main',
    sinceMs: 0,
    startedAtMs: NOW - 3_600_000,
    lastActivityMs: NOW - 1_800_000,
    topic: 'Ship the recap',
    context: 'recent',
    cloudTaskId: '',
    cloudProvider: '',
    teamName: '',
    pid: 0,
    transport: '',
    replyRail: '',
    replyMuxTarget: '',
    replyMuxSocket: '',
    tmuxPane: '',
    durationMs: 1_800_000,
    costUsd: 2.5,
    tokenCount: 100_000,
    ...over,
  }
}

describe('recapDayLabel', () => {
  test('today / yesterday / short date', () => {
    expect(recapDayLabel(NOW - 60_000, NOW)).toBe('Today')
    expect(recapDayLabel(NOW - 86_400_000, NOW)).toBe('Yesterday')
    const older = recapDayLabel(NOW - 3 * 86_400_000, NOW)
    expect(older).not.toBe('Today')
    expect(older).not.toBe('Yesterday')
    expect(older.length).toBeGreaterThan(2)
  })
})

describe('recapCost', () => {
  test('two decimals; empty when unknown', () => {
    expect(recapCost(5.6019)).toBe('$5.60')
    expect(recapCost(0)).toBe('')
    expect(recapCost(Number.NaN)).toBe('')
  })
})

describe('buildRecap', () => {
  test('groups by day newest-first with per-day rollups', () => {
    const days = buildRecap(
      [
        session({ sessionId: 'a', costUsd: 2.5, prUrl: 'https://github.com/x/y/pull/1' }),
        session({ sessionId: 'b', lastActivityMs: NOW - 3_600_000, costUsd: 1.5, prUrl: null }),
        session({ sessionId: 'c', lastActivityMs: NOW - 86_400_000, costUsd: 4 }),
      ],
      new Set(),
      NOW,
    )
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday'])
    expect(days[0]!.entries.map((e) => e.id)).toEqual(['a', 'b']) // newest first
    expect(days[0]!.sessions).toBe(2)
    expect(days[0]!.costUsd).toBeCloseTo(4)
    expect(days[0]!.prs).toBe(1)
    expect(days[1]!.sessions).toBe(1)
  })

  test('excludes live sessions and dedups by id', () => {
    const days = buildRecap(
      [session({ sessionId: 'live' }), session({ sessionId: 'x' }), session({ sessionId: 'x' })],
      new Set(['live']),
      NOW,
    )
    expect(days).toHaveLength(1)
    expect(days[0]!.entries.map((e) => e.id)).toEqual(['x'])
  })

  test('drops sessions with no activity signal; falls back title chain', () => {
    const days = buildRecap(
      [
        session({ sessionId: 'no-time', lastActivityMs: 0, startedAtMs: 0 }),
        session({ sessionId: 'no-topic', topic: '', worktreeSlug: 'fix-rail', branch: 'feat' }),
      ],
      new Set(),
      NOW,
    )
    expect(days).toHaveLength(1)
    expect(days[0]!.entries).toHaveLength(1)
    expect(days[0]!.entries[0]!.title).toBe('fix-rail')
    expect(days[0]!.entries[0]!.abbr).toBe('CC')
  })
})

describe('buildRecap fork lineage', () => {
  function edge(over: Partial<RecapForkEdge> = {}): RecapForkEdge {
    return {
      sourceSessionId: 'parent',
      sourceHost: 'zion',
      forkSessionId: 'fork',
      forkHost: 'yosemite-m0',
      agentKey: 'claude',
      forkedAt: NOW - 900_000,
      ...over,
    }
  }

  test('pairs a fork with its parent and drops the parent row', () => {
    const days = buildRecap(
      [
        session({ sessionId: 'fork', host: 'yosemite-m0', lastActivityMs: NOW - 600_000 }),
        session({ sessionId: 'parent', host: 'zion', lastActivityMs: NOW - 1_800_000 }),
      ],
      new Set(),
      NOW,
      [edge()],
    )
    expect(days[0]!.entries.map((e) => e.id)).toEqual(['fork'])
    const forked = days[0]!.entries[0]!
    expect(forked.fork).toEqual({ sourceId: 'parent', sourceHost: 'zion', forkHost: 'yosemite-m0' })
    expect(forked.forkedFrom?.id).toBe('parent')
    expect(forked.forkedFrom?.host).toBe('zion')
  })

  test('the day rollup still counts both sessions in a pair', () => {
    const days = buildRecap(
      [
        session({ sessionId: 'fork', costUsd: 1, prUrl: 'https://x/pr/2' }),
        session({ sessionId: 'parent', costUsd: 3, prUrl: 'https://x/pr/1' }),
      ],
      new Set(),
      NOW,
      [edge()],
    )
    expect(days[0]!.entries).toHaveLength(1)
    expect(days[0]!.sessions).toBe(2)
    expect(days[0]!.costUsd).toBeCloseTo(4)
    expect(days[0]!.prs).toBe(2)
  })

  test('keeps a cross-day parent on its own day and still marks the fork', () => {
    const days = buildRecap(
      [
        session({ sessionId: 'fork', host: 'mac-mini', lastActivityMs: NOW - 600_000 }),
        session({ sessionId: 'parent', lastActivityMs: NOW - 30 * 3_600_000 }),
      ],
      new Set(),
      NOW,
      [edge({ forkHost: 'mac-mini' })],
    )
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday'])
    expect(days[0]!.entries[0]!.forkedFrom).toBeNull()
    expect(days[0]!.entries[0]!.fork?.sourceHost).toBe('zion')
    expect(days[1]!.entries.map((e) => e.id)).toEqual(['parent'])
  })

  test('a parent that is itself a fork keeps its own row', () => {
    const days = buildRecap(
      [
        session({ sessionId: 'c', lastActivityMs: NOW - 600_000 }),
        session({ sessionId: 'b', lastActivityMs: NOW - 900_000 }),
        session({ sessionId: 'a', lastActivityMs: NOW - 1_200_000 }),
      ],
      new Set(),
      NOW,
      [edge({ sourceSessionId: 'b', forkSessionId: 'c' }), edge({ sourceSessionId: 'a', forkSessionId: 'b' })],
    )
    // b is a's fork, so it is not absorbed into c's pair — hiding it would
    // erase a session from the ledger.
    expect(days[0]!.entries.map((e) => e.id)).toEqual(['c', 'b'])
    expect(days[0]!.entries[0]!.forkedFrom).toBeNull()
    expect(days[0]!.entries[1]!.forkedFrom?.id).toBe('a')
  })

  test('an edge whose fork never reported an id pairs nothing', () => {
    const days = buildRecap(
      [session({ sessionId: 'parent' })],
      new Set(),
      NOW,
      [edge({ forkSessionId: null })],
    )
    expect(days[0]!.entries.map((e) => e.id)).toEqual(['parent'])
    expect(days[0]!.entries[0]!.fork).toBeNull()
  })
})
