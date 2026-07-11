import { describe, test, expect } from 'bun:test'
import { buildRecap, recapDayLabel, recapCost } from './recapModel'
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
