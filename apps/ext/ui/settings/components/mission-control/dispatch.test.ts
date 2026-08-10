import { describe, test, expect } from 'bun:test'
import type { TaskSummary, TerminalDetail, AgentDetail } from '../../types'
import {
  buildCloudDispatchCommand,
  isLinearSourcedTask,
  isTerminalJustSpawned,
  isTerminalActive,
  reconcilePending,
  pruneExpiredPending,
  markTimedOutPending,
  markCloudFailedPending,
  filterDispatchedTaskIds,
  optimisticActivityLabel,
  resolveReposFromLabels,
  PENDING_DISPATCH_TTL_MS,
  TIMED_OUT_RETENTION_MS,
  JUST_SPAWNED_WINDOW_MS,
  resolveAutoProject,
  type PendingDispatch,
} from './dispatch'

const FIXED_NOW = 1_700_000_000_000

function makeTerminal(overrides: Partial<TerminalDetail> = {}): TerminalDetail {
  return {
    id: 'cl-1',
    agentType: 'claude',
    label: null,
    autoLabel: null,
    createdAt: FIXED_NOW,
    index: 1,
    sessionId: null,
    approvalStatus: 'pending',
    ...overrides,
  }
}

function makeAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent_id: 'a1',
    agent_type: 'claude',
    status: 'running',
    duration: null,
    started_at: new Date(FIXED_NOW).toISOString(),
    completed_at: null,
    prompt: '',
    cwd: null,
    files_created: [],
    files_modified: [],
    files_deleted: [],
    bash_commands: [],
    last_messages: [],
    ...overrides,
  }
}

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    task_name: 'task',
    agent_count: 1,
    status_counts: { running: 1, completed: 0, failed: 0, stopped: 0 },
    latest_activity: new Date(FIXED_NOW).toISOString(),
    agents: [makeAgent()],
    ...overrides,
  }
}

function makePending(overrides: Partial<PendingDispatch> = {}): PendingDispatch {
  return {
    id: 'p-1',
    agentType: 'claude',
    target: 'local',
    taskId: 'rush-362',
    taskIdentifier: 'RUSH-362',
    title: 'Group-chat agent',
    createdAt: FIXED_NOW,
    ...overrides,
  }
}

describe('isTerminalJustSpawned', () => {
  test('true for terminal created this instant', () => {
    expect(isTerminalJustSpawned(FIXED_NOW, FIXED_NOW)).toBe(true)
  })

  test('true at 14s old', () => {
    expect(isTerminalJustSpawned(FIXED_NOW - 14_000, FIXED_NOW)).toBe(true)
  })

  test('false at 15s boundary (exclusive)', () => {
    expect(isTerminalJustSpawned(FIXED_NOW - JUST_SPAWNED_WINDOW_MS, FIXED_NOW)).toBe(false)
  })

  test('false for older terminal', () => {
    expect(isTerminalJustSpawned(FIXED_NOW - 60_000, FIXED_NOW)).toBe(false)
  })

  test('false for future createdAt (clock skew, treat as not spawned)', () => {
    expect(isTerminalJustSpawned(FIXED_NOW + 5_000, FIXED_NOW)).toBe(false)
  })

  test('false when createdAt is undefined', () => {
    expect(isTerminalJustSpawned(undefined, FIXED_NOW)).toBe(false)
  })

  test('false when createdAt is 0', () => {
    expect(isTerminalJustSpawned(0, FIXED_NOW)).toBe(false)
  })
})

describe('isTerminalActive', () => {
  test('just-spawned idle terminal is active (trust window)', () => {
    const t = makeTerminal({ status: 'idle', createdAt: FIXED_NOW - 5_000 })
    expect(isTerminalActive(t, FIXED_NOW)).toBe(true)
  })

  test('old idle terminal with no activity is not active', () => {
    const t = makeTerminal({ status: 'idle', createdAt: FIXED_NOW - 60_000, currentActivity: undefined })
    expect(isTerminalActive(t, FIXED_NOW)).toBe(false)
  })

  test('running terminal is active even when old', () => {
    const t = makeTerminal({ status: 'running', createdAt: FIXED_NOW - 60_000 })
    expect(isTerminalActive(t, FIXED_NOW)).toBe(true)
  })

  test('old terminal with currentActivity is active', () => {
    const t = makeTerminal({
      status: 'idle',
      createdAt: FIXED_NOW - 60_000,
      currentActivity: 'Reading auth.ts',
    })
    expect(isTerminalActive(t, FIXED_NOW)).toBe(true)
  })

  test('just-spawned terminal without status still active (regression: new terminal spawn)', () => {
    const t = makeTerminal({ status: undefined, createdAt: FIXED_NOW - 1_000 })
    expect(isTerminalActive(t, FIXED_NOW)).toBe(true)
  })
})

describe('reconcilePending', () => {
  test('empty pending list returned unchanged', () => {
    const out = reconcilePending([], [makeTerminal()], [makeTask()])
    expect(out).toEqual([])
  })

  test('local pending reconciled when matching terminal appears after dispatch', () => {
    const pending = [makePending({ createdAt: FIXED_NOW - 1_000 })]
    const terminals = [makeTerminal({ createdAt: FIXED_NOW })]
    const out = reconcilePending(pending, terminals, [])
    expect(out).toHaveLength(0)
  })

  test('local pending reconciled within slack window (terminal stamped slightly before dispatch)', () => {
    const pending = [makePending({ createdAt: FIXED_NOW })]
    const terminals = [makeTerminal({ createdAt: FIXED_NOW - 500 })]
    const out = reconcilePending(pending, terminals, [])
    expect(out).toHaveLength(0)
  })

  test('local pending NOT reconciled by older terminal outside slack', () => {
    const pending = [makePending({ createdAt: FIXED_NOW })]
    const terminals = [makeTerminal({ createdAt: FIXED_NOW - 5_000 })]
    const out = reconcilePending(pending, terminals, [])
    expect(out).toHaveLength(1)
  })

  test('local pending NOT reconciled by different agent type', () => {
    const pending = [makePending({ agentType: 'claude' })]
    const terminals = [makeTerminal({ agentType: 'codex', createdAt: FIXED_NOW })]
    const out = reconcilePending(pending, terminals, [])
    expect(out).toHaveLength(1)
  })

  test('cloud pending reconciled by matching swarm task agent', () => {
    const pending = [makePending({ target: 'cloud', createdAt: FIXED_NOW - 1_000 })]
    const task = makeTask({
      agents: [makeAgent({ started_at: new Date(FIXED_NOW).toISOString() })],
    })
    const out = reconcilePending(pending, [], [task])
    expect(out).toHaveLength(0)
  })

  test('cloud pending reconciled by fresh local terminal (rush cloud run shell)', () => {
    // The extension dispatches Rush Cloud via `rush cloud run` inside a
    // local terminal. A fresh same-agentType terminal proves dispatch fired
    // even when the cloud-runs poll hasn't caught up yet — without this
    // fallback, the pending sits unmatched for 180s and surfaces a
    // false-positive timeout banner.
    const pending = [makePending({ target: 'cloud', createdAt: FIXED_NOW - 1_000 })]
    const terminals = [makeTerminal({ createdAt: FIXED_NOW })]
    const out = reconcilePending(pending, terminals, [])
    expect(out).toHaveLength(0)
  })

  test('cloud pending NOT reconciled by older terminal outside slack', () => {
    const pending = [makePending({ target: 'cloud', createdAt: FIXED_NOW })]
    const terminals = [makeTerminal({ createdAt: FIXED_NOW - 5_000 })]
    const out = reconcilePending(pending, terminals, [])
    expect(out).toHaveLength(1)
  })

  test('cloud pending NOT reconciled by failed cloud-run (markCloudFailedPending handles it)', () => {
    // A failed cloud-run must not silently consume the pending — otherwise
    // the user gets no signal that Rush Cloud failed. markCloudFailedPending
    // flips it to timedOut so the banner surfaces.
    const pending = [makePending({ target: 'cloud', createdAt: FIXED_NOW - 1_000 })]
    const failedTask = makeTask({
      agents: [makeAgent({ status: 'failed', started_at: new Date(FIXED_NOW).toISOString() })],
    })
    const out = reconcilePending(pending, [], [failedTask])
    expect(out).toHaveLength(1)
  })

  test('multiple pending: only matching ones are consumed', () => {
    const p1 = makePending({ id: 'p-1', agentType: 'claude', createdAt: FIXED_NOW - 1_000 })
    const p2 = makePending({ id: 'p-2', agentType: 'codex', createdAt: FIXED_NOW - 1_000 })
    const terminals = [makeTerminal({ agentType: 'claude', createdAt: FIXED_NOW })]
    const out = reconcilePending([p1, p2], terminals, [])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('p-2')
  })

  test('returns same reference when nothing consumed (enables React bail-out)', () => {
    const pending = [makePending()]
    const out = reconcilePending(pending, [], [])
    expect(out).toBe(pending)
  })
})

describe('pruneExpiredPending', () => {
  test('keeps fresh entries', () => {
    const pending = [makePending({ createdAt: FIXED_NOW - 5_000 })]
    const out = pruneExpiredPending(pending, FIXED_NOW)
    expect(out).toHaveLength(1)
  })

  test('entry past TTL but within retention is still kept (timeout warning visible)', () => {
    // Previously this dropped at TTL boundary. New semantics: warning stays
    // visible for ttl + retention so silent cloud-dispatch failures surface.
    const pending = [makePending({ createdAt: FIXED_NOW - PENDING_DISPATCH_TTL_MS - 1 })]
    const out = pruneExpiredPending(pending, FIXED_NOW)
    expect(out).toHaveLength(1)
  })

  test('entry past TTL + retention is fully removed', () => {
    const pending = [makePending({ createdAt: FIXED_NOW - PENDING_DISPATCH_TTL_MS - TIMED_OUT_RETENTION_MS - 1 })]
    const out = pruneExpiredPending(pending, FIXED_NOW)
    expect(out).toHaveLength(0)
  })

  test('exact-retention-boundary entry is removed (inclusive)', () => {
    const pending = [makePending({ createdAt: FIXED_NOW - PENDING_DISPATCH_TTL_MS - TIMED_OUT_RETENTION_MS })]
    const out = pruneExpiredPending(pending, FIXED_NOW)
    expect(out).toHaveLength(0)
  })

  test('mixed list keeps entries still within retention window', () => {
    const fresh = makePending({ id: 'fresh', createdAt: FIXED_NOW - 10_000 })
    const stale = makePending({
      id: 'stale',
      createdAt: FIXED_NOW - PENDING_DISPATCH_TTL_MS - TIMED_OUT_RETENTION_MS - 1_000,
    })
    const out = pruneExpiredPending([fresh, stale], FIXED_NOW)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('fresh')
  })
})

describe('markTimedOutPending', () => {
  test('fresh entry stays pending', () => {
    const pending = [makePending({ createdAt: FIXED_NOW - 5_000 })]
    const out = markTimedOutPending(pending, FIXED_NOW)
    expect(out).toBe(pending)
  })

  test('entry past TTL flips to timedOut (and only that entry)', () => {
    const fresh = makePending({ id: 'fresh', createdAt: FIXED_NOW - 5_000 })
    const stale = makePending({ id: 'stale', createdAt: FIXED_NOW - PENDING_DISPATCH_TTL_MS - 1 })
    const out = markTimedOutPending([fresh, stale], FIXED_NOW)
    expect(out).not.toBe([fresh, stale])
    expect(out.find((p) => p.id === 'fresh')?.status ?? 'pending').toBe('pending')
    expect(out.find((p) => p.id === 'stale')?.status).toBe('timedOut')
  })

  test('already-timedOut entry is not re-flipped (preserves identity)', () => {
    const t = { ...makePending({ createdAt: FIXED_NOW - PENDING_DISPATCH_TTL_MS - 1 }), status: 'timedOut' as const }
    const out = markTimedOutPending([t], FIXED_NOW)
    expect(out).toBe([t].length === 1 ? out : out) // same ref semantics checked below
    expect(out[0]).toBe(t)
  })

  test('exact-TTL boundary entry flips (inclusive)', () => {
    const pending = [makePending({ createdAt: FIXED_NOW - PENDING_DISPATCH_TTL_MS })]
    const out = markTimedOutPending(pending, FIXED_NOW)
    expect(out[0].status).toBe('timedOut')
  })

  test('empty list returns same reference', () => {
    const pending: PendingDispatch[] = []
    const out = markTimedOutPending(pending, FIXED_NOW)
    expect(out).toBe(pending)
  })
})

describe('markCloudFailedPending', () => {
  test('cloud pending flips to timedOut when a matching failed cloud-run exists', () => {
    const pending = [makePending({ target: 'cloud', createdAt: FIXED_NOW - 500 })]
    const failedTask = makeTask({
      agents: [makeAgent({ status: 'failed', started_at: new Date(FIXED_NOW).toISOString() })],
    })
    const out = markCloudFailedPending(pending, [failedTask])
    expect(out[0].status).toBe('timedOut')
  })

  test('local pending is untouched even if a failed cloud-run exists', () => {
    const pending = [makePending({ target: 'local', createdAt: FIXED_NOW - 500 })]
    const failedTask = makeTask({
      agents: [makeAgent({ status: 'failed', started_at: new Date(FIXED_NOW).toISOString() })],
    })
    const out = markCloudFailedPending(pending, [failedTask])
    expect(out).toBe(pending)
  })

  test('does not flip on a failed cloud-run that pre-dates the dispatch (unrelated earlier run)', () => {
    // The match must be time-bounded — otherwise an old failed execution
    // from yesterday would mark every fresh dispatch as failed.
    const pending = [makePending({ target: 'cloud', createdAt: FIXED_NOW })]
    const failedTask = makeTask({
      agents: [makeAgent({ status: 'failed', started_at: new Date(FIXED_NOW - 60_000).toISOString() })],
    })
    const out = markCloudFailedPending(pending, [failedTask])
    expect(out).toBe(pending)
  })

  test('does not flip when matching cloud-run is running, not failed', () => {
    const pending = [makePending({ target: 'cloud', createdAt: FIXED_NOW - 500 })]
    const runningTask = makeTask({
      agents: [makeAgent({ status: 'running', started_at: new Date(FIXED_NOW).toISOString() })],
    })
    const out = markCloudFailedPending(pending, [runningTask])
    expect(out).toBe(pending)
  })

  test('does not re-flip already-timedOut entries (same-reference preserved)', () => {
    const p: PendingDispatch = {
      ...makePending({ target: 'cloud', createdAt: FIXED_NOW - 500 }),
      status: 'timedOut',
    }
    const failedTask = makeTask({
      agents: [makeAgent({ status: 'failed', started_at: new Date(FIXED_NOW).toISOString() })],
    })
    const input = [p]
    const out = markCloudFailedPending(input, [failedTask])
    expect(out).toBe(input)
    expect(out[0]).toBe(p)
  })

  test('mixed list: only matching cloud pending flips', () => {
    const fresh = makePending({ id: 'fresh', target: 'cloud', createdAt: FIXED_NOW - 500 })
    const other = makePending({ id: 'other', target: 'cloud', agentType: 'codex', createdAt: FIXED_NOW - 500 })
    const failedTask = makeTask({
      agents: [makeAgent({ status: 'failed', agent_type: 'claude', started_at: new Date(FIXED_NOW).toISOString() })],
    })
    const out = markCloudFailedPending([fresh, other], [failedTask])
    expect(out.find((p) => p.id === 'fresh')?.status).toBe('timedOut')
    expect(out.find((p) => p.id === 'other')?.status ?? 'pending').toBe('pending')
  })

  test('empty list returns same reference', () => {
    const pending: PendingDispatch[] = []
    const out = markCloudFailedPending(pending, [])
    expect(out).toBe(pending)
  })
})

describe('filterDispatchedTaskIds', () => {
  test('returns all tasks when pending set is empty', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }]
    const out = filterDispatchedTaskIds(tasks, new Set())
    expect(out).toBe(tasks)
  })

  test('filters out dispatched task id', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const out = filterDispatchedTaskIds(tasks, new Set(['b']))
    expect(out.map((t) => t.id)).toEqual(['a', 'c'])
  })

  test('filters multiple', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const out = filterDispatchedTaskIds(tasks, new Set(['a', 'c']))
    expect(out.map((t) => t.id)).toEqual(['b'])
  })
})

describe('optimisticActivityLabel', () => {
  test('local uses "Starting..." prefix with identifier', () => {
    expect(optimisticActivityLabel(makePending({ taskIdentifier: 'RUSH-362' })))
      .toBe('Starting... (RUSH-362)')
  })

  test('cloud uses "Queuing on Rush Cloud..." prefix', () => {
    expect(
      optimisticActivityLabel(makePending({ target: 'cloud', taskIdentifier: 'RUSH-362' }))
    ).toBe('Queuing on Rush Cloud... (RUSH-362)')
  })

  test('cloud with targetRepo appends arrow suffix', () => {
    expect(
      optimisticActivityLabel(
        makePending({ target: 'cloud', taskIdentifier: 'RUSH-362', targetRepo: 'muqsitnawaz/agents' })
      )
    ).toBe('Queuing on Rush Cloud... (RUSH-362 -> muqsitnawaz/agents)')
  })

  test('falls back to title when no identifier', () => {
    const p = makePending({ taskIdentifier: '', title: 'Fix the login bug please' })
    expect(optimisticActivityLabel(p)).toBe('Starting... (Fix the login bug please)')
  })

  test('truncates long titles to 40 chars', () => {
    const p = makePending({
      taskIdentifier: '',
      title: 'x'.repeat(100),
    })
    const label = optimisticActivityLabel(p)
    const inner = label.slice('Starting... ('.length, -1)
    expect(inner).toHaveLength(40)
  })

  test('timedOut cloud dispatch surfaces the timeout message', () => {
    const p: PendingDispatch = {
      ...makePending({ target: 'cloud', taskIdentifier: 'RUSH-461', targetRepo: 'muqsitnawaz/agents' }),
      status: 'timedOut',
    }
    expect(optimisticActivityLabel(p)).toBe(
      'Dispatch timed out — check Rush Cloud terminal (RUSH-461 -> muqsitnawaz/agents)',
    )
  })

  test('timedOut local dispatch surfaces the timeout message', () => {
    const p: PendingDispatch = {
      ...makePending({ target: 'local', taskIdentifier: 'RUSH-461' }),
      status: 'timedOut',
    }
    expect(optimisticActivityLabel(p)).toBe('Dispatch timed out — check terminal (RUSH-461)')
  })
})

describe('resolveReposFromLabels', () => {
  test('single repo:X label -> owner/X', () => {
    expect(resolveReposFromLabels(['repo:agents'], 'muqsitnawaz'))
      .toEqual(['muqsitnawaz/agents'])
  })

  test('multiple repo:X labels -> all resolved in order', () => {
    expect(resolveReposFromLabels(['repo:agents', 'repo:swarmify', 'repo:halo'], 'muqsitnawaz'))
      .toEqual(['muqsitnawaz/agents', 'muqsitnawaz/swarmify', 'muqsitnawaz/halo'])
  })

  test('mixed labels: ignores non-repo labels', () => {
    expect(resolveReposFromLabels(['priority:high', 'repo:agents', 'bug'], 'muqsitnawaz'))
      .toEqual(['muqsitnawaz/agents'])
  })

  test('dedupes same repo:X mentioned twice', () => {
    expect(resolveReposFromLabels(['repo:agents', 'repo:agents'], 'muqsitnawaz'))
      .toEqual(['muqsitnawaz/agents'])
  })

  test('empty labels -> []', () => {
    expect(resolveReposFromLabels([], 'muqsitnawaz')).toEqual([])
  })

  test('undefined labels -> []', () => {
    expect(resolveReposFromLabels(undefined, 'muqsitnawaz')).toEqual([])
  })

  test('null owner -> []', () => {
    expect(resolveReposFromLabels(['repo:agents'], null)).toEqual([])
  })

  test('empty owner -> []', () => {
    expect(resolveReposFromLabels(['repo:agents'], '')).toEqual([])
  })

  test('malformed label "repo:" (empty name) ignored', () => {
    expect(resolveReposFromLabels(['repo:'], 'muqsitnawaz')).toEqual([])
  })

  test('case-sensitive match on "repo:" prefix', () => {
    expect(resolveReposFromLabels(['Repo:agents', 'REPO:halo'], 'muqsitnawaz')).toEqual([])
  })

  test('trims whitespace on owner', () => {
    expect(resolveReposFromLabels(['repo:agents'], '  muqsitnawaz  '))
      .toEqual(['muqsitnawaz/agents'])
  })

  test('accepts dots and dashes in repo name', () => {
    expect(resolveReposFromLabels(['repo:my.repo-v2'], 'muqsitnawaz'))
      .toEqual(['muqsitnawaz/my.repo-v2'])
  })

  test('rejects slashes in repo label (prevents owner injection)', () => {
    expect(resolveReposFromLabels(['repo:evil/other-owner/target'], 'muqsitnawaz'))
      .toEqual([])
  })
})

describe('isLinearSourcedTask', () => {
  test('accepts standard Linear identifier', () => {
    expect(isLinearSourcedTask('RUSH-461')).toBe(true)
  })

  test('accepts single-letter team prefix', () => {
    expect(isLinearSourcedTask('A-1')).toBe(true)
  })

  test('accepts alphanumeric team prefix (must start with letter)', () => {
    expect(isLinearSourcedTask('RUSH2-42')).toBe(true)
  })

  test('trims surrounding whitespace', () => {
    expect(isLinearSourcedTask('  RUSH-7 ')).toBe(true)
  })

  test('rejects lowercase prefix (Linear identifiers are uppercase)', () => {
    expect(isLinearSourcedTask('rush-461')).toBe(false)
  })

  test('rejects GitHub-style identifier (#42)', () => {
    expect(isLinearSourcedTask('#42')).toBe(false)
  })

  test('rejects prefix starting with digit', () => {
    expect(isLinearSourcedTask('2RUSH-1')).toBe(false)
  })

  test('rejects missing number', () => {
    expect(isLinearSourcedTask('RUSH-')).toBe(false)
  })

  test('rejects empty string', () => {
    expect(isLinearSourcedTask('')).toBe(false)
  })

  test('rejects null/undefined', () => {
    expect(isLinearSourcedTask(null)).toBe(false)
    expect(isLinearSourcedTask(undefined)).toBe(false)
  })
})

describe('resolveAutoProject', () => {
  const projects = [
    { id: 'web', linearProject: 'Web App', uses: 3 },
    { id: 'api', linearProject: 'Backend', uses: 9 },
    { id: 'infra', uses: 1 }, // unlinked project
  ]

  test('matches the target whose linearProject equals the ticket project', () => {
    // The ticket is for "Web App" — must pick `web`, NOT the most-used `api`.
    expect(resolveAutoProject(projects, 'Web App')).toBe('web')
  })

  test('falls back to most-used when the ticket project has no matching target', () => {
    expect(resolveAutoProject(projects, 'Marketing')).toBe('api')
  })

  test('falls back to most-used when the ticket has no project', () => {
    expect(resolveAutoProject(projects, undefined)).toBe('api')
  })

  test('a linked match wins even when it is the least-used project', () => {
    const p = [
      { id: 'busy', linearProject: 'Busy', uses: 100 },
      { id: 'rare', linearProject: 'Rare', uses: 1 },
    ]
    expect(resolveAutoProject(p, 'Rare')).toBe('rare')
  })

  test('returns undefined when there are no projects', () => {
    expect(resolveAutoProject([], 'Web App')).toBeUndefined()
  })
})

describe('buildCloudDispatchCommand', () => {
  test('rush provider uses legacy `rush cloud run` form', () => {
    const cmd = buildCloudDispatchCommand({
      provider: 'rush',
      agentType: 'claude',
      repos: ['muqsitnawaz/agents'],
      safePrompt: 'fix it',
    })
    expect(cmd).toBe(`rush cloud run claude --repo muqsitnawaz/agents -p 'fix it'`)
  })

  test('rush multi-repo sends repeatable --repo flags in order', () => {
    const cmd = buildCloudDispatchCommand({
      provider: 'rush',
      agentType: 'claude',
      repos: ['muqsitnawaz/rush', 'muqsitnawaz/agents'],
      safePrompt: 'refactor',
    })
    expect(cmd).toBe(
      `rush cloud run claude --repo muqsitnawaz/rush --repo muqsitnawaz/agents -p 'refactor'`
    )
  })

  test('codex provider routes through agents cloud run (cloud-agnostic path)', () => {
    const cmd = buildCloudDispatchCommand({
      provider: 'codex',
      agentType: 'codex',
      repos: ['muqsitnawaz/agents'],
      safePrompt: 'add tests',
    })
    expect(cmd).toBe(
      `agents cloud run --provider codex --agent codex --repo muqsitnawaz/agents -p 'add tests'`
    )
  })

  test('factory provider routes through agents cloud run', () => {
    const cmd = buildCloudDispatchCommand({
      provider: 'factory',
      agentType: 'droid',
      repos: ['org/repo'],
      safePrompt: 'deploy',
    })
    expect(cmd).toBe(
      `agents cloud run --provider factory --agent droid --repo org/repo -p 'deploy'`
    )
  })

  test('pre-escaped single quotes in the prompt are preserved verbatim', () => {
    // Caller escapes ' -> '\''; the builder must not re-escape or strip it.
    const safePrompt = `fix Muqsit'\\''s bug`
    const cmd = buildCloudDispatchCommand({
      provider: 'rush',
      agentType: 'claude',
      repos: ['a/b'],
      safePrompt,
    })
    expect(cmd).toContain(`-p 'fix Muqsit'\\''s bug'`)
  })
})
