import { describe, test, expect } from 'bun:test'
import {
  buildRecap,
  recapDayLabel,
  recapCost,
  processUserPrompt,
  detectUserPromptKind,
  cleanSessionPrompt,
  sessionRowView,
  quoteAgentLine,
  prLabel,
  harnessLabel,
  type RecapForkEdge,
} from './recapModel'
import type { RemoteSessionLike } from './floorAdapter'
import type { FloorAgent } from './floorModel'

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

describe('cleanSessionPrompt', () => {
  test('strips wrapper tags so path noise and command-message never show', () => {
    expect(cleanSessionPrompt('<command-message>Fix the bug</command-message>')).toBe('Fix the bug')
    expect(cleanSessionPrompt('<context>some info</context>\nDo something')).toBe('some info\nDo something')
  })
})

describe('processUserPrompt — four kinds', () => {
  test('image: screenshot chip, path dropped, caption kept', () => {
    const raw = '/Users/muqsit/Screenshots/CleanShot 2026-08-23 at 12.03.45.png The landscape mode looks cramped — can we give the hero more room?'
    expect(detectUserPromptKind(raw)).toBe('image')
    const p = processUserPrompt(raw)
    expect(p.kind).toBe('image')
    expect(p.chip).toBe('screenshot')
    expect(p.text).toBe('The landscape mode looks cramped — can we give the hero more room?')
    expect(p.text).not.toContain('/Users')
    expect(p.text).not.toContain('CleanShot')
    expect(p.text).not.toContain('.png')
  })

  test('image from attachment, no path in text', () => {
    const p = processUserPrompt('Look at this', 'image', [{ path: '/tmp/shot.png', mediaType: 'image/png' }])
    expect(p.chip).toBe('screenshot')
    expect(p.text).toBe('Look at this')
    expect(p.text).not.toContain('/tmp')
  })

  test('command: first command only as $ chip, remainder as caption', () => {
    const raw = '<bash-input>crabbox status</bash-input>\nHelping understand the currency I set up for the agency — does it use Crabbox?'
    expect(detectUserPromptKind(raw)).toBe('command')
    const p = processUserPrompt(raw)
    expect(p.kind).toBe('command')
    expect(p.chip).toBe('crabbox status')
    expect(p.text).toContain('Helping understand the currency')
    expect(p.text).not.toContain('<bash-input>')
  })

  test('skill: Base directory collapses to /continue', () => {
    const raw = 'Base directory for this skill: /home/muqsit/.agents/skills/continue\npick up the agents view cache work'
    expect(detectUserPromptKind(raw)).toBe('skill')
    const p = processUserPrompt(raw)
    expect(p.kind).toBe('skill')
    expect(p.chip).toBe('/continue')
    expect(p.text).toBe('pick up the agents view cache work')
    expect(p.text).not.toContain('/home/')
    expect(p.text).not.toContain('Base directory')
  })

  test('plain text is shown as-is after wrapper strip', () => {
    const p = processUserPrompt('<command-message>Ship the recap row</command-message>')
    expect(p.kind).toBe('text')
    expect(p.chip).toBeNull()
    expect(p.text).toBe('Ship the recap row')
  })
})

function floor(over: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'a1',
    host: 'yosemite-s1',
    hostLabel: 'yosemite-s1',
    project: 'svatlas',
    name: 'session',
    abbr: 'CC',
    phase: 'running',
    verb: '',
    target: '',
    tok: 0,
    since: '2d',
    lastActivityMs: NOW,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: '#418',
    prUrl: 'https://github.com/x/y/pull/418',
    ci: 'running',
    ticket: null,
    branch: '',
    worktreeSlug: '',
    worktreePath: '',
    resp: 'Widened the hero to a 2-col grid and pushed the CTA down.',
    prompt: '/Users/muqsit/Screenshots/CleanShot 2026-08-23.png The landscape mode looks cramped — can we give the hero more room?',
    topic: 'Redesigning the SVAtlas landscape hero section',
    messages: [],
    question: null,
    reply: { kind: 'none', host: 'yosemite-s1' },
    todos: [],
    summary: '',
    recent: [],
    ...over,
  }
}

describe('sessionRowView adapter seam', () => {
  test('binds FloorAgent fields until CLI watch JSON lands', () => {
    const row = sessionRowView(floor())
    expect(row.title).toBe('Redesigning the SVAtlas landscape hero section')
    expect(row.recapSource).toBe('agent recap')
    expect(row.you.kind).toBe('image')
    expect(row.you.chip).toBe('screenshot')
    expect(row.you.text).not.toContain('/Users')
    expect(row.harnessTag).toBe('Claude ›')
    expect(row.lastLine).toContain('Widened the hero')
    expect(row.repo).toBe('svatlas')
    expect(row.pr).toEqual({ label: 'PR #418', ci: 'running' })
    expect(row.host).toBe('yosemite-s1')
    expect(row.live).toBe('run')
  })

  test('prefers CLI overlay fields when present (adapter seam)', () => {
    const row = sessionRowView(floor({ prompt: 'ignored' }), {
      title: 'Explaining the Crabbox CI currency model',
      recapSource: 'last line',
      userPromptClean: '$ crabbox status Helping understand the currency',
      userPromptKind: 'command',
      lastAgentLine: 'Yes — every run mints a per-repo credit',
      lastAssistantMessage: 'Yes — every CI run mints a per-repo credit against the shared microVM pool.',
    })
    expect(row.title).toBe('Explaining the Crabbox CI currency model')
    expect(row.recapSource).toBe('last line')
    expect(row.you.kind).toBe('command')
    expect(row.lastLine).toBe(quoteAgentLine('Yes — every run mints a per-repo credit'))
    expect(row.lastFull).toContain('shared microVM pool')
  })

  test('prLabel and harnessLabel', () => {
    expect(prLabel('#2922')).toBe('PR #2922')
    expect(prLabel('PR #2922')).toBe('PR #2922')
    expect(harnessLabel('CX')).toBe('Codex ›')
  })
})
