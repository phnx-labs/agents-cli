import { describe, test, expect } from 'bun:test'
import type { UnifiedTask, ProjectRule } from '../../types'
import {
  derivePhase,
  deriveNeeds,
  deriveStalled,
  heartbeatLevel,
  latestTodos,
  todoProgress,
  parseStructuredQuestion,
  structuredQuestionFromToolCalls,
  groupAgents,
  sortAgents,
  clusterByQuestion,
  computeHostRows,
  orderManagedProjects,
  sessionKey,
  toFloorTicket,
  groupTickets,
  sortTickets,
  resolveProject,
  sessionTaskLine,
  todosWithFallback,
  PHASE_RANK,
  STALL_THRESHOLD_MS,
  type FloorAgent,
  type FloorPhase,
  type StructuredQuestion,
  type ManagedProject,
  type TodoItem,
} from './floorModel'

describe('resolveProject', () => {
  const RULES: ProjectRule[] = [
    { pattern: '**/agents/prix/api', project: 'Prix API' },
    { pattern: '**/agents/prix/app', project: 'Prix App' },
    { pattern: '/home/muqsit/src/monorepo', project: 'Monorepo Root' },
  ]

  test('user rules win first, and the first matching rule wins', () => {
    expect(resolveProject('/x/y/agents/prix/api', RULES)).toBe('Prix API')
    expect(resolveProject('/x/y/agents/prix/app', RULES)).toBe('Prix App')
  })

  test('a glob captures work inside the matched directory', () => {
    expect(resolveProject('/x/y/agents/prix/api/src/routes', RULES)).toBe('Prix API')
  })

  test('a path-prefix rule matches the dir and descendants but not a shared-prefix sibling', () => {
    expect(resolveProject('/home/muqsit/src/monorepo/packages/api', RULES)).toBe('Monorepo Root')
    expect(resolveProject('/home/muqsit/src/monorepo-two', RULES)).toBe('monorepo-two')
  })

  test('rules beat the git-repo-root default', () => {
    expect(resolveProject('/x/y/agents/prix/api', RULES, '/x/y/agents')).toBe('Prix API')
  })

  test('a monorepo subdir with no rule folds to its git repo root basename', () => {
    expect(resolveProject('/x/y/agents/prix/api', [], '/x/y/agents')).toBe('agents')
  })

  test('worktree folding beats the git-repo-root default', () => {
    expect(
      resolveProject(
        '/Users/m/src/o/swarmify/.agents/worktrees/floor-port',
        [],
        '/Users/m/src/o/swarmify/.agents/worktrees/floor-port',
      ),
    ).toBe('swarmify')
  })

  test('no rules, no repoRoot -> legacy last-segment', () => {
    expect(resolveProject('/x/y/prix-api')).toBe('prix-api')
    expect(resolveProject('')).toBe('')
  })
})

function makeAgent(overrides: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'a1',
    host: 'this-mac',
    project: 'swarmify',
    name: 'auth-refactor',
    abbr: 'CC',
    phase: 'running',
    verb: 'Editing',
    target: 'src/core/tasks.ts',
    tok: 0,
    since: '2s',
    lastActivityMs: 0,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: null,
    prUrl: null,
    ticket: null,
    branch: 'feat-auth',
    resp: '',
    messages: [],
    question: null,
    reply: { kind: 'terminal', host: 'this-mac', terminalId: 'CC-1' },
    todos: [],
    summary: '',
    recent: [],
    ...overrides,
  }
}

function makeTask(overrides: Partial<UnifiedTask> = {}): UnifiedTask {
  return {
    id: 'raw-id',
    source: 'linear',
    title: 'Some ticket',
    status: 'todo',
    metadata: {},
    ...overrides,
  }
}

describe('derivePhase — precedence waiting > failed > running > done > idle', () => {
  test('waitingForInput wins over a failed status', () => {
    expect(
      derivePhase({ status: 'failed', waitingForInput: true, active: true, prOpenUnreviewed: false }),
    ).toBe('waiting')
  })

  test('failed wins over a running status', () => {
    expect(
      derivePhase({ status: 'failed', waitingForInput: false, active: true, prOpenUnreviewed: false }),
    ).toBe('failed')
  })

  test('running requires the process to be active', () => {
    expect(
      derivePhase({ status: 'running', waitingForInput: false, active: true, prOpenUnreviewed: false }),
    ).toBe('running')
  })

  test('a stale running (process gone) settles to idle', () => {
    expect(
      derivePhase({ status: 'running', waitingForInput: false, active: false, prOpenUnreviewed: false }),
    ).toBe('idle')
  })

  test('completed maps to done', () => {
    expect(
      derivePhase({ status: 'completed', waitingForInput: false, active: false, prOpenUnreviewed: true }),
    ).toBe('done')
  })

  test('stopped and idle both settle to idle', () => {
    expect(
      derivePhase({ status: 'stopped', waitingForInput: false, active: false, prOpenUnreviewed: false }),
    ).toBe('idle')
    expect(
      derivePhase({ status: 'idle', waitingForInput: false, active: true, prOpenUnreviewed: false }),
    ).toBe('idle')
  })
})

describe('deriveNeeds', () => {
  test('waiting and failed always need attention', () => {
    expect(deriveNeeds('waiting', false)).toBe(true)
    expect(deriveNeeds('failed', false)).toBe(true)
  })

  test('done needs attention only when its PR is unreviewed', () => {
    expect(deriveNeeds('done', true)).toBe(true)
    expect(deriveNeeds('done', false)).toBe(false)
  })

  test('running and idle never need attention', () => {
    expect(deriveNeeds('running', true)).toBe(false)
    expect(deriveNeeds('idle', true)).toBe(false)
  })

  test('a stalled agent needs attention', () => {
    expect(deriveNeeds('stalled', false)).toBe(true)
  })

  test('self-promotion: an open PR climbs into needs-you once CI settles', () => {
    // Still running, but CI went green -> promote (the "ready to review" moment).
    expect(deriveNeeds('running', true, 'passed')).toBe(true)
    // Running with a red PR -> promote (needs a look).
    expect(deriveNeeds('running', true, 'failed')).toBe(true)
    // CI still running -> stay in the live lane, not needs-you.
    expect(deriveNeeds('running', true, 'running')).toBe(false)
    // Done + green -> needs review.
    expect(deriveNeeds('done', true, 'passed')).toBe(true)
    // Done + CI still running -> not yet.
    expect(deriveNeeds('done', true, 'running')).toBe(false)
  })

  test('unknown CI falls back to the prior done+PR rule', () => {
    expect(deriveNeeds('done', true, null)).toBe(true)
    expect(deriveNeeds('running', true, null)).toBe(false)
    expect(deriveNeeds('done', false, null)).toBe(false)
  })
})

describe('deriveStalled — a running agent gone quiet', () => {
  const now = 1_000_000_000_000

  test('running past the threshold is stalled; just under is not', () => {
    expect(deriveStalled(now - STALL_THRESHOLD_MS, 'running', now)).toBe(true)
    expect(deriveStalled(now - (STALL_THRESHOLD_MS - 1), 'running', now)).toBe(false)
  })

  test('an already-stalled agent that is still quiet stays stalled', () => {
    expect(deriveStalled(now - 5 * STALL_THRESHOLD_MS, 'stalled', now)).toBe(true)
  })

  test('waiting / failed / done / idle never become stalled', () => {
    const old = now - 10 * STALL_THRESHOLD_MS
    for (const phase of ['waiting', 'failed', 'done', 'idle'] as const) {
      expect(deriveStalled(old, phase, now)).toBe(false)
    }
  })

  test('unknown last-activity (0 or non-finite) never raises a false stall', () => {
    expect(deriveStalled(0, 'running', now)).toBe(false)
    expect(deriveStalled(Number.NaN, 'running', now)).toBe(false)
  })
})

describe('heartbeatLevel — live / stale / dead by silence age', () => {
  test('fresh is live, past 1x is stale (amber), past 2x is dead (red)', () => {
    expect(heartbeatLevel(0)).toBe('live')
    expect(heartbeatLevel(STALL_THRESHOLD_MS - 1)).toBe('live')
    expect(heartbeatLevel(STALL_THRESHOLD_MS)).toBe('stale')
    expect(heartbeatLevel(2 * STALL_THRESHOLD_MS - 1)).toBe('stale')
    expect(heartbeatLevel(2 * STALL_THRESHOLD_MS)).toBe('dead')
  })

  test('a non-finite age reads as live', () => {
    expect(heartbeatLevel(Number.NaN)).toBe('live')
  })
})

describe('parseStructuredQuestion — one kind per shape', () => {
  test('failed phase yields a retry, question mark or not', () => {
    const q = parseStructuredQuestion('bun test exited 1 — 2 tests fail. Stopping so you can look.', 'failed')
    expect(q).not.toBeNull()
    expect(q!.kind).toBe('retry')
    expect(q!.options).toEqual([])
    expect(q!.clusterKey).toBe('retry')
  })

  test('running chatter (no question) returns null', () => {
    expect(
      parseStructuredQuestion('Editing the incremental counter now; running the suite.', 'running'),
    ).toBeNull()
  })

  test('destructive keyword + question -> destructive with Confirm/Cancel', () => {
    const q = parseStructuredQuestion('This will DROP the legacy_tokens column on prod. Confirm?', 'waiting')
    expect(q!.kind).toBe('destructive')
    expect(q!.options).toEqual(['Confirm', 'Cancel'])
  })

  test('"X or Y?" -> choice with both alternatives extracted', () => {
    const q = parseStructuredQuestion('Token bucket per-user, or a sliding window?', 'waiting')
    expect(q!.kind).toBe('choice')
    expect(q!.options).toEqual(['Token bucket per-user', 'Sliding window'])
  })

  test('"X vs Y?" -> choice', () => {
    const q = parseStructuredQuestion('Postgres vs SQLite?', 'waiting')
    expect(q!.kind).toBe('choice')
    expect(q!.options).toEqual(['Postgres', 'SQLite'])
  })

  test('lettered options -> choice', () => {
    const q = parseStructuredQuestion('Which path: A) Rollback B) Fix forward?', 'waiting')
    expect(q!.kind).toBe('choice')
    expect(q!.options).toEqual(['Rollback', 'Fix forward'])
  })

  test('plain yes/no question -> confirm with Confirm/Hold', () => {
    const q = parseStructuredQuestion('Tests pass and the PR is green — merge it?', 'waiting')
    expect(q!.kind).toBe('confirm')
    expect(q!.options).toEqual(['Confirm', 'Hold'])
  })

  test('identical questions produce identical clusterKeys; different ones differ', () => {
    const a = parseStructuredQuestion('Token bucket per-user, or a sliding window?', 'waiting')!
    const b = parseStructuredQuestion('Token bucket per-user, or a sliding window?', 'waiting')!
    const c = parseStructuredQuestion('Tests pass and the PR is green — merge it?', 'waiting')!
    expect(a.clusterKey).toBe(b.clusterKey)
    expect(a.clusterKey).not.toBe(c.clusterKey)
    expect(a.clusterKey.length).toBeGreaterThan(0)
  })
})

describe('structuredQuestionFromToolCalls — lift the AskUserQuestion tool input', () => {
  const ask = (question: string, options: unknown) => ({
    name: 'AskUserQuestion',
    input: { questions: [{ question, header: 'H', options }] },
  })

  test('extracts question text + option labels from the tool call', () => {
    const q = structuredQuestionFromToolCalls([
      ask('Which store — Redux or Zustand?', [
        { label: 'Zustand', description: 'lighter' },
        { label: 'Redux', description: 'batteries' },
      ]),
    ])
    expect(q).not.toBeNull()
    expect(q!.kind).toBe('choice')
    expect(q!.text).toBe('Which store — Redux or Zustand?')
    expect(q!.options).toEqual(['Zustand', 'Redux'])
    expect(q!.clusterKey.length).toBeGreaterThan(0)
  })

  test('accepts plain-string options too', () => {
    const q = structuredQuestionFromToolCalls([ask('Merge now?', ['Merge', 'Hold'])])
    expect(q!.options).toEqual(['Merge', 'Hold'])
  })

  test('destructive keywords force the destructive kind', () => {
    const q = structuredQuestionFromToolCalls([ask('This will DELETE prod rows. Proceed?', [{ label: 'Yes' }])])
    expect(q!.kind).toBe('destructive')
  })

  test('picks the most recent AskUserQuestion (newest-first array)', () => {
    const q = structuredQuestionFromToolCalls([
      ask('Newest?', [{ label: 'A' }]),
      { name: 'Edit', input: { file_path: '/x.ts' } },
      ask('Older?', [{ label: 'B' }]),
    ])
    expect(q!.text).toBe('Newest?')
  })

  test('returns null when there is no AskUserQuestion call', () => {
    expect(structuredQuestionFromToolCalls([{ name: 'Edit', input: {} }])).toBeNull()
    expect(structuredQuestionFromToolCalls([])).toBeNull()
    expect(structuredQuestionFromToolCalls(undefined)).toBeNull()
  })

  test('returns null on a malformed call (no questions / empty text)', () => {
    expect(structuredQuestionFromToolCalls([{ name: 'AskUserQuestion', input: {} }])).toBeNull()
    expect(structuredQuestionFromToolCalls([ask('', [{ label: 'A' }])])).toBeNull()
  })
})

describe('groupAgents', () => {
  const agents = [
    makeAgent({ id: 'a', host: 'this-mac', project: 'swarmify', abbr: 'CC', phase: 'running' }),
    makeAgent({ id: 'b', host: 'yosemite-s0', project: 'prix-api', abbr: 'CX', phase: 'waiting' }),
    makeAgent({ id: 'c', host: 'this-mac', project: 'prix-api', abbr: 'CC', phase: 'running' }),
  ]

  test('groups by host, preserving first-seen key order', () => {
    const g = groupAgents(agents, 'host')
    expect([...g.keys()]).toEqual(['this-mac', 'yosemite-s0'])
    expect(g.get('this-mac')!.map((a) => a.id)).toEqual(['a', 'c'])
  })

  test('groups by project / status / agent dimensions', () => {
    expect([...groupAgents(agents, 'project').keys()]).toEqual(['swarmify', 'prix-api'])
    expect([...groupAgents(agents, 'status').keys()]).toEqual(['running', 'waiting'])
    expect([...groupAgents(agents, 'agent').keys()]).toEqual(['CC', 'CX'])
  })
})

describe('sortAgents', () => {
  test("'needs' orders by PHASE_RANK (waiting < failed < stalled < running < done < idle)", () => {
    const agents = [
      makeAgent({ id: 'idle', phase: 'idle' }),
      makeAgent({ id: 'done', phase: 'done' }),
      makeAgent({ id: 'running', phase: 'running' }),
      makeAgent({ id: 'stalled', phase: 'stalled' }),
      makeAgent({ id: 'failed', phase: 'failed' }),
      makeAgent({ id: 'waiting', phase: 'waiting' }),
    ]
    const ordered = sortAgents(agents, 'needs').map((a) => a.id)
    expect(ordered).toEqual(['waiting', 'failed', 'stalled', 'running', 'done', 'idle'])
    const ranks = sortAgents(agents, 'needs').map((a) => PHASE_RANK[a.phase])
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y))
  })

  test("'tok' orders by throughput descending", () => {
    const agents = [makeAgent({ id: 'lo', tok: 10 }), makeAgent({ id: 'hi', tok: 200 }), makeAgent({ id: 'mid', tok: 90 })]
    expect(sortAgents(agents, 'tok').map((a) => a.id)).toEqual(['hi', 'mid', 'lo'])
  })

  test("'recent' orders by elapsed time ascending (freshest first)", () => {
    const agents = [makeAgent({ id: 'h', since: '3h' }), makeAgent({ id: 's', since: '2s' }), makeAgent({ id: 'm', since: '14m' })]
    expect(sortAgents(agents, 'recent').map((a) => a.id)).toEqual(['s', 'm', 'h'])
  })

  test("'name' orders alphabetically and does not mutate input", () => {
    const agents = [makeAgent({ id: '1', name: 'zeta' }), makeAgent({ id: '2', name: 'alpha' })]
    expect(sortAgents(agents, 'name').map((a) => a.name)).toEqual(['alpha', 'zeta'])
    expect(agents.map((a) => a.name)).toEqual(['zeta', 'alpha'])
  })
})

describe('clusterByQuestion', () => {
  function waitingAgent(id: string, clusterKey: string | null): FloorAgent {
    const question: StructuredQuestion | null = clusterKey
      ? { kind: 'choice', text: 'q', options: ['A', 'B'], clusterKey }
      : null
    return makeAgent({ id, phase: 'waiting', question })
  }

  test('collapses agents sharing a clusterKey into one card, keeps singletons as [agent]', () => {
    const waiting = [
      waitingAgent('a', 'ratelimit'),
      waitingAgent('b', 'ratelimit'),
      waitingAgent('c', 'mergegreen'),
    ]
    const clusters = clusterByQuestion(waiting)
    expect(clusters.length).toBe(2)
    expect(clusters[0].map((a) => a.id)).toEqual(['a', 'b'])
    expect(clusters[1].map((a) => a.id)).toEqual(['c'])
  })

  test('agents without a parsed question never batch together', () => {
    const clusters = clusterByQuestion([waitingAgent('x', null), waitingAgent('y', null)])
    expect(clusters.length).toBe(2)
    expect(clusters.every((c) => c.length === 1)).toBe(true)
  })
})

describe('sessionKey — one canonical identity across origins', () => {
  const uuid = '4a78949e-1111-2222-3333-444455556666'

  test('same session via local tab + local sweep collapse to one key', () => {
    const fromTab = sessionKey({ origin: 'local', host: 'this-mac', cliSessionUuid: uuid, terminalId: 'CC-1705-1' })
    const fromSweep = sessionKey({ origin: 'local', host: 'this-mac', cliSessionUuid: uuid })
    expect(fromTab).toBe(uuid)
    expect(fromSweep).toBe(uuid)
    expect(fromTab).toBe(fromSweep)
  })

  test('provisional key re-keys once the UUID appears', () => {
    const provisional = sessionKey({ origin: 'local', terminalId: 'CC-1705-1' })
    const resolved = sessionKey({ origin: 'local', cliSessionUuid: uuid, terminalId: 'CC-1705-1' })
    expect(provisional).toBe('provisional:CC-1705-1')
    expect(resolved).toBe(uuid)
    expect(provisional).not.toBe(resolved)
  })

  test('provisional falls back through terminal -> cloud -> agent id', () => {
    expect(sessionKey({ origin: 'cloud', cloudTaskId: 'task-abc' })).toBe('provisional:task-abc')
    expect(sessionKey({ origin: 'local', agentId: 'agent-xyz' })).toBe('provisional:agent-xyz')
    expect(sessionKey({ origin: 'local' })).toBe('provisional:unknown')
  })

  test('remote keys namespaced by host do not collide across hosts', () => {
    const onHostA = sessionKey({ origin: 'remote', host: 'yosemite-s0', cliSessionUuid: uuid })
    const onHostB = sessionKey({ origin: 'remote', host: 'zion-m1', cliSessionUuid: uuid })
    expect(onHostA).toBe(`yosemite-s0:${uuid}`)
    expect(onHostB).toBe(`zion-m1:${uuid}`)
    expect(onHostA).not.toBe(onHostB)
  })

  test('remote falls back to the session file stem when the UUID is unknown', () => {
    expect(sessionKey({ origin: 'remote', host: 'zion-m1', sessionFileStem: 'rollout-2024' })).toBe('zion-m1:rollout-2024')
  })

  test('a genuinely remote UUID does not collide with the same session seen locally', () => {
    const local = sessionKey({ origin: 'local', host: 'this-mac', cliSessionUuid: uuid })
    const remote = sessionKey({ origin: 'remote', host: 'yosemite-s0', cliSessionUuid: uuid })
    expect(local).not.toBe(remote)
  })
})

describe('toFloorTicket — field mapping', () => {
  test('medium priority remaps to med', () => {
    expect(toFloorTicket(makeTask({ priority: 'medium' })).pri).toBe('med')
  })

  test('missing priority defaults to med; urgent/high/low pass through', () => {
    expect(toFloorTicket(makeTask({ priority: undefined })).pri).toBe('med')
    expect(toFloorTicket(makeTask({ priority: 'urgent' })).pri).toBe('urgent')
    expect(toFloorTicket(makeTask({ priority: 'high' })).pri).toBe('high')
    expect(toFloorTicket(makeTask({ priority: 'low' })).pri).toBe('low')
  })

  test('source remaps linear->LN, github->GH', () => {
    expect(toFloorTicket(makeTask({ source: 'linear' })).source).toBe('LN')
    expect(toFloorTicket(makeTask({ source: 'github' })).source).toBe('GH')
  })

  test('status remaps in_progress->in-progress, done->done, else todo', () => {
    expect(toFloorTicket(makeTask({ status: 'in_progress' })).status).toBe('in-progress')
    expect(toFloorTicket(makeTask({ status: 'done' })).status).toBe('done')
    expect(toFloorTicket(makeTask({ status: 'todo' })).status).toBe('todo')
  })

  test('id prefers metadata.identifier, falls back to id; project from repo; labels/desc defaulted', () => {
    const withId = toFloorTicket(
      makeTask({ id: 'raw', metadata: { identifier: 'RUSH-812', repo: 'prix-api', labels: ['bug'] }, description: 'd' }),
    )
    expect(withId.id).toBe('RUSH-812')
    expect(withId.project).toBe('prix-api')
    expect(withId.labels).toEqual(['bug'])
    expect(withId.desc).toBe('d')

    const bare = toFloorTicket(makeTask({ id: 'raw', metadata: {} }))
    expect(bare.id).toBe('raw')
    expect(bare.project).toBe('')
    expect(bare.labels).toEqual([])
    expect(bare.desc).toBe('')
  })

  test('owner maps from metadata.assignee, defaults to empty when unassigned', () => {
    expect(toFloorTicket(makeTask({ metadata: { assignee: 'Muqsit' } })).owner).toBe('Muqsit')
    expect(toFloorTicket(makeTask({ metadata: {} })).owner).toBe('')
  })
})

describe('groupTickets / sortTickets', () => {
  const tickets = [
    toFloorTicket(makeTask({ id: 'RUSH-2', source: 'linear', priority: 'low', metadata: { repo: 'web' } })),
    toFloorTicket(makeTask({ id: '#1', source: 'github', priority: 'urgent', metadata: { repo: 'swarmify' } })),
    toFloorTicket(makeTask({ id: 'RUSH-3', source: 'linear', priority: 'high', metadata: { repo: 'web' } })),
  ]

  test('sortTickets by priority uses PRI_RANK', () => {
    expect(sortTickets(tickets, 'priority').map((t) => t.pri)).toEqual(['urgent', 'high', 'low'])
  })

  test('sortTickets by id uses localeCompare', () => {
    expect(sortTickets(tickets, 'id').map((t) => t.id)).toEqual(['#1', 'RUSH-2', 'RUSH-3'])
  })

  test('groupTickets by source renders human labels', () => {
    expect([...groupTickets(tickets, 'source').keys()].sort()).toEqual(['GitHub', 'Linear'])
  })

  test('groupTickets by project buckets by repo', () => {
    const g = groupTickets(tickets, 'project')
    expect(g.get('web')!.map((t) => t.id)).toEqual(['RUSH-2', 'RUSH-3'])
    expect(g.get('swarmify')!.map((t) => t.id)).toEqual(['#1'])
  })

  test('groupTickets by owner buckets by assignee; unassigned collapses to Unassigned', () => {
    const owned = [
      toFloorTicket(makeTask({ id: 'RUSH-10', metadata: { assignee: 'Muqsit' } })),
      toFloorTicket(makeTask({ id: 'RUSH-11', metadata: { assignee: 'Bisma' } })),
      toFloorTicket(makeTask({ id: 'RUSH-12', metadata: { assignee: 'Muqsit' } })),
      toFloorTicket(makeTask({ id: 'RUSH-13', metadata: {} })),
    ]
    const g = groupTickets(owned, 'owner')
    expect(g.get('Muqsit')!.map((t) => t.id)).toEqual(['RUSH-10', 'RUSH-12'])
    expect(g.get('Bisma')!.map((t) => t.id)).toEqual(['RUSH-11'])
    expect(g.get('Unassigned')!.map((t) => t.id)).toEqual(['RUSH-13'])
  })
})

describe('computeHostRows', () => {
  const devices = [
    { name: 'zion', online: true, agents: 0 },
    { name: 'yosemite-s0', online: true, agents: 0 },
    { name: 'mac-mini', online: true, agents: 0 },
  ]

  test('folds the local machine into ONE row under its real name (the reported bug)', () => {
    // Local agents arrive from two paths, both labelled hostLabel='zion':
    //   - in-window (adaptUnified): host 'this-mac'
    //   - out-of-window / tmux (adaptRemote): host 'this-mac'
    // plus a genuinely-remote agent on yosemite-s0.
    const rows = computeHostRows(
      [
        makeAgent({ id: 'a', host: 'this-mac', hostLabel: 'zion' }),
        makeAgent({ id: 'b', host: 'this-mac', hostLabel: 'zion' }),
        makeAgent({ id: 'c', host: 'yosemite-s0' }),
      ],
      devices,
      [],
    )
    const names = rows.map((r) => r.name)
    // The machine shows exactly once, as 'zion' — never also as 'this-mac'.
    expect(names).toEqual(['mac-mini', 'yosemite-s0', 'zion'])
    expect(names).not.toContain('this-mac')
    const zion = rows.find((r) => r.name === 'zion')!
    expect(zion.count).toBe(2) // both local agents counted under the real name
    expect(zion.offline).toBe(false)
    expect(rows.find((r) => r.name === 'yosemite-s0')!.count).toBe(1)
    expect(rows.find((r) => r.name === 'mac-mini')!.count).toBe(0) // registry-only, 0 agents
  })

  test('never surfaces a raw this-mac phantom row; folds onto localHost when given', () => {
    // Before the fleet list resolves, hostLabel is undefined so the agent's host is
    // the synthetic 'this-mac'. That must NOT spawn a phantom 'this-mac' HOSTS row.
    const rowsNoLocal = computeHostRows([makeAgent({ id: 'a', host: 'this-mac' })], devices, [])
    expect(rowsNoLocal.map((r) => r.name)).not.toContain('this-mac')

    // Passing the local machine name gives it a row and folds the this-mac count into
    // it — even when the local machine is not in the device registry.
    const rows = computeHostRows([makeAgent({ id: 'a', host: 'this-mac' })], devices, [], [], 'yosemite-s1')
    const local = rows.find((r) => r.name === 'yosemite-s1')!
    expect(local.count).toBe(1)
    expect(local.offline).toBe(false)
    expect(rows.map((r) => r.name)).not.toContain('this-mac')
  })

  test('a session on an unregistered host creates NO phantom row (the reported bug)', () => {
    // ssh-config aliases / tailnet peers (mark, phoenix, pi) used to each spawn a HOST
    // row. Now an agent on an unregistered host is silently dropped from the roster —
    // only registered devices, pins, and the local machine make rows.
    const rows = computeHostRows(
      [
        makeAgent({ id: 'a', host: 'phoenix' }),
        makeAgent({ id: 'b', host: 'pi' }),
        makeAgent({ id: 'c', host: 'yosemite-s0' }),
      ],
      devices,
      [],
    )
    const names = rows.map((r) => r.name)
    expect(names).toEqual(['mac-mini', 'yosemite-s0', 'zion'])
    expect(names).not.toContain('phoenix')
    expect(names).not.toContain('pi')
    expect(rows.find((r) => r.name === 'yosemite-s0')!.count).toBe(1)
  })

  test('normalizes host case / FQDN onto the registry device row', () => {
    // A session reported as 'ZION' or a FQDN folds onto the 'zion' device row.
    const rows = computeHostRows(
      [
        makeAgent({ id: 'a', host: 'ZION' }),
        makeAgent({ id: 'b', host: 'mac-mini.tail1a85a1.ts.net' }),
      ],
      devices,
      [],
    )
    expect(rows.find((r) => r.name === 'zion')!.count).toBe(1)
    expect(rows.find((r) => r.name === 'mac-mini')!.count).toBe(1)
  })

  test('a host with agents whose device is offline lists, marked offline', () => {
    // Device-registry reachability is authoritative: an agent bucket on an offline
    // device still renders (from byHost) but shows offline, not its count.
    const rows = computeHostRows(
      [makeAgent({ id: 'a', host: 'win-mini' })],
      [{ name: 'win-mini', online: false, agents: 0 }],
      [],
    )
    expect(rows).toEqual([{ name: 'win-mini', count: 1, offline: true, pinned: false }])
  })

  test('pinned hosts render first in pin order, then the alphabetical remainder', () => {
    const rows = computeHostRows(
      [makeAgent({ id: 'a', host: 'yosemite-s0' })],
      devices,
      [],
      ['zion', 'mac-mini'], // user pinned zion then mac-mini
    )
    // pinned first in the user's order, unpinned (yosemite-s0) after, all sorted within groups
    expect(rows.map((r) => r.name)).toEqual(['zion', 'mac-mini', 'yosemite-s0'])
    expect(rows.filter((r) => r.pinned).map((r) => r.name)).toEqual(['zion', 'mac-mini'])
    expect(rows.find((r) => r.name === 'yosemite-s0')!.pinned).toBe(false)
  })

  test('a pinned host stays listed even with no agents and no online device', () => {
    // e.g. the local machine pinned by default while its registry entry is momentarily
    // absent — the pin keeps it visible so the user can still see/reorder it.
    const rows = computeHostRows([], [], [], ['zion'])
    expect(rows).toEqual([{ name: 'zion', count: 0, offline: false, pinned: true }])
  })
})

describe('latestTodos -- the checklist from the newest TodoWrite', () => {
  const tw = (todos: unknown) => ({ name: 'TodoWrite', input: { todos } })

  test('reads the NEWEST TodoWrite, superseding earlier ones', () => {
    // recentToolCalls is NEWEST-FIRST (session.summary.ts unshifts each call), so the
    // most recent TodoWrite (the 3-item list) sits ahead of the older one-item list.
    const calls = [
      { name: 'Bash', input: { command: 'bun test' } },
      tw([
        { content: 'read code', status: 'completed' },
        { content: 'write code', status: 'in_progress' },
        { content: 'open PR', status: 'pending' },
      ]),
      { name: 'Edit', input: { file: 'a.ts' } },
      tw([{ content: 'first plan', status: 'completed' }]),
    ]
    expect(latestTodos(calls)).toEqual([
      { content: 'read code', status: 'completed' },
      { content: 'write code', status: 'in_progress' },
      { content: 'open PR', status: 'pending' },
    ])
  })

  test('returns [] when there is no TodoWrite', () => {
    expect(latestTodos([{ name: 'Edit', input: {} }, { name: 'Bash', input: {} }])).toEqual([])
  })

  test('returns [] for undefined / empty input', () => {
    expect(latestTodos(undefined)).toEqual([])
    expect(latestTodos([])).toEqual([])
  })

  test('falls back to activeForm for content and defaults unknown status to pending', () => {
    expect(latestTodos([tw([
      { activeForm: 'Migrating token store', status: 'weird' },
      { content: '', status: 'completed' },        // dropped: no content
      { content: 'ok', status: 'in_progress' },
    ])])).toEqual([
      { content: 'Migrating token store', status: 'pending' },
      { content: 'ok', status: 'in_progress' },
    ])
  })

  test('tolerates malformed todos payload', () => {
    expect(latestTodos([tw('not-an-array')])).toEqual([])
    expect(latestTodos([{ name: 'TodoWrite', input: null }])).toEqual([])
  })

  test('todoProgress tallies completed vs total', () => {
    expect(todoProgress([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'in_progress' },
      { content: 'd', status: 'pending' },
    ])).toEqual({ done: 2, total: 4 })
    expect(todoProgress([])).toEqual({ done: 0, total: 0 })
  })
})

describe('orderManagedProjects', () => {
  const mk = (name: string, confidence: ManagedProject['confidence']): ManagedProject => ({
    id: name.toLowerCase(),
    name,
    path: `/repos/${name}`,
    confidence,
    source: 'manual',
  })

  test('confidence is the primary sort: high > medium > low', () => {
    const projects = [mk('low-one', 'low'), mk('high-one', 'high'), mk('med-one', 'medium')]
    expect(orderManagedProjects(projects, {}).map((p) => p.name)).toEqual([
      'high-one',
      'med-one',
      'low-one',
    ])
  })

  test('within one confidence tier, higher active-agent count wins', () => {
    const projects = [mk('quiet', 'high'), mk('busy', 'high'), mk('mid', 'high')]
    const counts = { busy: 5, mid: 2, quiet: 0 }
    expect(orderManagedProjects(projects, counts).map((p) => p.name)).toEqual([
      'busy',
      'mid',
      'quiet',
    ])
  })

  test('confidence outranks count: a high project with 0 agents beats a low project with many', () => {
    const projects = [mk('low-busy', 'low'), mk('high-idle', 'high')]
    const counts = { 'low-busy': 99, 'high-idle': 0 }
    expect(orderManagedProjects(projects, counts).map((p) => p.name)).toEqual([
      'high-idle',
      'low-busy',
    ])
  })

  test('name asc breaks a confidence+count tie', () => {
    const projects = [mk('zebra', 'medium'), mk('alpha', 'medium'), mk('mango', 'medium')]
    const counts = { zebra: 3, alpha: 3, mango: 3 }
    expect(orderManagedProjects(projects, counts).map((p) => p.name)).toEqual([
      'alpha',
      'mango',
      'zebra',
    ])
  })

  test('missing count entries are treated as 0 and it does not mutate the input', () => {
    const projects = [mk('a', 'high'), mk('b', 'high')]
    const frozen = [...projects]
    const ordered = orderManagedProjects(projects, { a: 1 })
    expect(ordered.map((p) => p.name)).toEqual(['a', 'b'])
    expect(projects).toEqual(frozen)
  })
})

describe('sessionTaskLine — prompt anchors the card ahead of the drifting last message', () => {
  test('prompt wins over summary and resp when present (the task, not the last message)', () => {
    const a = makeAgent({
      prompt: 'Add markdown to card bodies',
      summary: 'Editing FeedItem.tsx',
      resp: 'All 3 remaining hits are intentional',
      worktreeSlug: 'card-ux',
    })
    expect(sessionTaskLine(a)).toBe('Add markdown to card bodies')
  })

  test('falls back to summary -> resp -> worktreeSlug -> branch when there is no prompt', () => {
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: 'live preview' }))).toBe('live preview')
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: '', resp: 'last msg' }))).toBe('last msg')
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: '', resp: '', worktreeSlug: 'rush-1531' }))).toBe('rush-1531')
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: '', resp: '', worktreeSlug: '', branch: 'feat-x' }))).toBe('feat-x')
  })

  test('a blank/whitespace prompt is skipped so it does not blank the task line', () => {
    expect(sessionTaskLine(makeAgent({ prompt: '   ', summary: 'real work' }))).toBe('real work')
  })

  test('returns empty string when the agent carries no task signal at all', () => {
    expect(sessionTaskLine(makeAgent({ prompt: undefined, summary: '', resp: '', worktreeSlug: '', branch: '' }))).toBe('')
  })
})

describe('todosWithFallback — the checklist survives the recent-tool window cap', () => {
  const set = (n: number): TodoItem[] =>
    Array.from({ length: n }, (_, i) => ({ content: `t${i}`, status: 'pending' as const }))

  test('a fresh non-empty parse is used as-is', () => {
    const fresh = set(3)
    expect(todosWithFallback(fresh, set(1))).toBe(fresh)
  })

  test('an empty fresh parse falls back to the remembered set (checklist does not vanish)', () => {
    const remembered = set(2)
    expect(todosWithFallback([], remembered)).toBe(remembered)
  })

  test('empty fresh + no remembered set yields empty (no phantom checklist)', () => {
    expect(todosWithFallback([], undefined)).toEqual([])
    expect(todosWithFallback([], [])).toEqual([])
  })
})
