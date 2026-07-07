import { describe, test, expect } from 'bun:test'
import {
  abbrFor,
  splitActivity,
  deriveProject,
  sinceFromMs,
  isoToMs,
  floorPrLabel,
  toFloorAgentFromUnified,
  toFloorAgentFromRemote,
  adaptTickets,
  type UnifiedAgentLike,
  type RemoteSessionLike,
} from './floorAdapter'
import type { UnifiedTask } from '../../types'

const NOW = 1_700_000_000_000

describe('abbrFor', () => {
  test('maps known agent types to their tab prefix', () => {
    expect(abbrFor('claude')).toBe('CC')
    expect(abbrFor('Codex')).toBe('CX')
    expect(abbrFor('gemini')).toBe('GX')
    expect(abbrFor('cursor')).toBe('CR')
    expect(abbrFor('opencode')).toBe('OC')
  })
  test('unknown types fall back to Shell', () => {
    expect(abbrFor('mystery')).toBe('SH')
    expect(abbrFor('')).toBe('SH')
  })
})

describe('splitActivity', () => {
  test('a shell command reads as Running <cmd>', () => {
    expect(splitActivity('$ bun test core/')).toEqual({ verb: 'Running', target: 'bun test core/' })
  })
  test('first word is the verb, the rest the target', () => {
    expect(splitActivity('Editing src/core/tasks.ts')).toEqual({ verb: 'Editing', target: 'src/core/tasks.ts' })
  })
  test('a lone word is all verb, no target', () => {
    expect(splitActivity('idle')).toEqual({ verb: 'idle', target: '' })
  })
  test('empty stays empty', () => {
    expect(splitActivity('')).toEqual({ verb: '', target: '' })
  })
})

describe('deriveProject', () => {
  test('a repo name always wins', () => {
    expect(deriveProject('/anything/here', 'swarmify', 'fallback')).toBe('swarmify')
  })
  test('folds a worktree path back to its repo', () => {
    expect(deriveProject('/Users/x/src/github.com/o/swarmify/.agents/worktrees/floor-port', null, 'fb')).toBe('swarmify')
  })
  test('plain cwd uses the last path segment', () => {
    expect(deriveProject('/Users/x/src/github.com/o/prix-api', null, 'fb')).toBe('prix-api')
  })
  test('no cwd and no repo uses the fallback', () => {
    expect(deriveProject(null, null, 'fb')).toBe('fb')
  })
})

describe('sinceFromMs', () => {
  test('renders human units and rejects negatives', () => {
    expect(sinceFromMs(5_000)).toBe('5s')
    expect(sinceFromMs(90_000)).toBe('1m')
    expect(sinceFromMs(3 * 3600_000)).toBe('3h')
    expect(sinceFromMs(2 * 86_400_000)).toBe('2d')
    expect(sinceFromMs(-1)).toBe('')
  })
})

describe('isoToMs', () => {
  test('parses an ISO stamp to epoch ms', () => {
    expect(isoToMs(new Date(NOW).toISOString())).toBe(NOW)
  })
  test('unparseable input reads as 0 (unknown)', () => {
    expect(isoToMs('not-a-date')).toBe(0)
    expect(isoToMs('')).toBe(0)
  })
})

describe('floorPrLabel', () => {
  test('extracts the PR number from a github url', () => {
    expect(floorPrLabel('https://github.com/o/r/pull/142')).toBe('#142')
  })
  test('accepts a bare #number', () => {
    expect(floorPrLabel('#412')).toBe('#412')
  })
  test('null in, null out', () => {
    expect(floorPrLabel(null)).toBeNull()
    expect(floorPrLabel(undefined)).toBeNull()
  })
})

function baseUnified(over: Partial<UnifiedAgentLike>): UnifiedAgentLike {
  return {
    id: 'term-1',
    agentType: 'claude',
    displayName: 'auth-refactor',
    activity: 'Editing src/auth.ts',
    active: true,
    timestamp: new Date(NOW - 5000).toISOString(),
    status: 'running',
    files: ['a.ts', 'b.ts'],
    toolCalls: 7,
    ...over,
  }
}

describe('toFloorAgentFromUnified', () => {
  test('a terminal awaiting input becomes a waiting, needs-you agent with a parsed question', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        activity: 'idle',
        status: 'idle',
        active: false,
        terminal: { id: 't1', waitingForInput: true },
        agent: null,
        // last response is a real choice question
      }),
      { pinned: new Set(), workspaceRepo: 'swarmify', nowMs: NOW },
    )
    // no agent.last_messages, so resp falls back to activity 'idle' -> not a question,
    // but phase is waiting from the flag; needs is still true.
    expect(a.phase).toBe('waiting')
    expect(a.needs).toBe(true)
    expect(a.host).toBe('this-mac')
    expect(a.abbr).toBe('CC')
  })

  test('local agent keeps host this-mac (routing) but takes hostLabel from localHostName (display)', () => {
    const withName = toFloorAgentFromUnified(
      baseUnified({}),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW, localHostName: 'zion' },
    )
    // host stays the routing key so reply/nudge/reassign still target the local machine.
    expect(withName.host).toBe('this-mac')
    // hostLabel is the real device name every Floor surface renders.
    expect(withName.hostLabel).toBe('zion')

    // Before the fleet list resolves (no localHostName), hostLabel is undefined and
    // callers fall back to host.
    const noName = toFloorAgentFromUnified(baseUnified({}), { pinned: new Set(), workspaceRepo: null, nowMs: NOW })
    expect(noName.host).toBe('this-mac')
    expect(noName.hostLabel).toBeUndefined()
  })

  test('a failed agent needs you and gets a retry question', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({ status: 'failed', active: false, activity: 'build broke' }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.phase).toBe('failed')
    expect(a.needs).toBe(true)
    expect(a.question?.kind).toBe('retry')
  })

  test('a running agent does not need you', () => {
    const a = toFloorAgentFromUnified(baseUnified({}), { pinned: new Set(), workspaceRepo: null, nowMs: NOW })
    expect(a.phase).toBe('running')
    expect(a.needs).toBe(false)
    expect(a.files).toBe(2)
    expect(a.tools).toBe(7)
    // u.timestamp is the last-activity stamp -> exact heartbeat anchor locally.
    expect(a.lastActivityMs).toBe(NOW - 5000)
  })

  test('a completed agent with an open PR is done + unreviewed (needs you)', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({ status: 'completed', active: false, prUrl: 'https://github.com/o/r/pull/9' }),
      { pinned: new Set(['term-1']), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.phase).toBe('done')
    expect(a.needs).toBe(true)
    expect(a.pr).toBe('#9')
    expect(a.pinned).toBe(true)
  })

  test('a headless agent parses its last message into a structured choice question', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        id: 'agent-x',
        activity: 'working',
        status: 'idle',
        active: false,
        terminal: null,
        agent: {
          status: 'input_required',
          repo_name: 'prix-api',
          branch: 'feat-rl',
          last_messages: ['Token bucket per-user, or a sliding window?'],
        },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.phase).toBe('waiting')
    expect(a.project).toBe('prix-api')
    expect(a.branch).toBe('feat-rl')
    expect(a.question?.kind).toBe('choice')
    expect(a.question?.options.length).toBeGreaterThanOrEqual(2)
  })
})

describe('toFloorAgentFromRemote', () => {
  test('carries the remote host and normalized fields through', () => {
    const r: RemoteSessionLike = {
      host: 'yosemite-s0',
      sessionId: 'abcd1234efgh',
      agentType: 'codex',
      cwd: '/home/u/src/prix-api',
      project: 'prix-api',
      phase: 'waiting',
      activity: 'Running cargo build',
      tokPerSec: 88,
      waitingForInput: true,
      lastResponse: 'Merge the green PR?',
      prUrl: 'https://github.com/o/r/pull/50',
      ticket: 'RUSH-812',
      branch: 'feat-x',
      sinceMs: 42_000,
      startedAtMs: NOW - 42_000,
      topic: 'Wire the rate limiter',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 4321,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.host).toBe('yosemite-s0')
    expect(a.id).toBe('remote-yosemite-s0-abcd1234efgh')
    expect(a.abbr).toBe('CX')
    expect(a.tok).toBe(88)
    expect(a.since).toBe('42s')
    expect(a.needs).toBe(true)
    expect(a.pr).toBe('#50')
    expect(a.ticket).toBe('RUSH-812')
    expect(a.question?.kind).toBe('confirm')
    // remote carries only session-start; heartbeat anchors to it until backend adds a stamp.
    expect(a.lastActivityMs).toBe(NOW - 42_000)
    // a genuinely-remote host is already its real name — no display override.
    expect(a.hostLabel).toBeUndefined()
  })

  test('carries context/sessionId/pid so a headless run gets the bg badge + Focus/Stop', () => {
    const r: RemoteSessionLike = {
      host: 'this-mac',
      sessionId: 'headless99abcd',
      agentType: 'claude',
      cwd: '/home/u/src/app',
      project: 'app',
      phase: 'running',
      activity: 'Editing src/auth.ts',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: '',
      sinceMs: 9_000,
      startedAtMs: NOW - 9_000,
      topic: 'auth refactor',
      context: 'headless',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 40912,
      transport: '',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set(), 'zion')
    // context drives the bg badge; sessionId/pid drive Focus/Stop.
    expect(a.context).toBe('headless')
    expect(a.sessionId).toBe('headless99abcd')
    expect(a.pid).toBe(40912)
    // 'this-mac' folds to the real device name so the run groups under 'zion'.
    expect(a.hostLabel).toBe('zion')
  })

  test("this machine's out-of-window sessions (host 'this-mac') take the real name as hostLabel so they fold, not duplicate", () => {
    const base: RemoteSessionLike = {
      host: 'this-mac',
      sessionId: 'localsess1',
      agentType: 'claude',
      cwd: '/home/u/src/web',
      project: 'web',
      phase: 'running',
      activity: 'Editing App.tsx',
      tokPerSec: 10,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: 'feat-z',
      sinceMs: 1_000,
      startedAtMs: NOW - 1_000,
      topic: '',
      context: 'terminal',
    }
    const a = toFloorAgentFromRemote(base, new Set(), 'zion')
    // host stays the routing key; only the display name resolves to the real device.
    expect(a.host).toBe('this-mac')
    expect(a.hostLabel).toBe('zion')
  })

  test('a remote session with an unknown start (0) disables the heartbeat rather than false-stalling', () => {
    const r: RemoteSessionLike = {
      host: 'zion',
      sessionId: 'deadbeef',
      agentType: 'claude',
      cwd: '/home/u/src/web',
      project: 'web',
      phase: 'running',
      activity: 'Editing App.tsx',
      tokPerSec: 40,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: 'feat-y',
      sinceMs: 0,
      startedAtMs: 0,
      topic: 'Dark mode',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 0,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    expect(toFloorAgentFromRemote(r, new Set()).lastActivityMs).toBe(0)
  })
})

describe('deriveReplyTargetFromRemote', () => {
  const base: RemoteSessionLike = {
    host: 'this-mac', sessionId: 's1', agentType: 'claude', cwd: '/x', project: 'x',
    phase: 'waiting', activity: '', tokPerSec: 0, waitingForInput: true, lastResponse: '',
    prUrl: null, ticket: null, branch: '', sinceMs: 0, startedAtMs: 0, topic: '',
    context: '', cloudTaskId: '', cloudProvider: '', teamName: '', pid: 0,
    transport: '', replyRail: '', replyMuxTarget: '', replyMuxSocket: '',
  }

  test('a tmux-backed remote session routes to the tmux rail (ssh + send-keys)', () => {
    const r = toFloorAgentFromRemote({
      ...base, host: 'yosemite-s0', context: 'terminal', transport: 'ssh',
      replyRail: 'tmux', replyMuxTarget: '%65', replyMuxSocket: '/tmp/tmux-1000/default',
    }, new Set())
    expect(r.reply.kind).toBe('tmux')
    expect(r.reply.host).toBe('yosemite-s0')
    expect(r.reply.muxTarget).toBe('%65')
    expect(r.reply.muxSocket).toBe('/tmp/tmux-1000/default')
  })

  test('a tmux rail missing its pane/socket degrades to none, not a dead send', () => {
    const r = toFloorAgentFromRemote({ ...base, context: 'terminal', replyRail: 'tmux', replyMuxTarget: '', replyMuxSocket: '' }, new Set())
    expect(r.reply.kind).toBe('none')
  })

  test('cloud row routes to `agents cloud message` on its owning host', () => {
    const r = toFloorAgentFromRemote({ ...base, host: 'this-mac', context: 'cloud', cloudTaskId: 'vclfel94', cloudProvider: 'rush' }, new Set())
    expect(r.reply.kind).toBe('cloud')
    expect(r.reply.cloudTaskId).toBe('vclfel94')
    expect(r.reply.host).toBe('this-mac')
  })

  test('a remote cloud row keeps its host so the handler can ssh to it', () => {
    const r = toFloorAgentFromRemote({ ...base, host: 'yosemite-s0', context: 'cloud', cloudTaskId: 't7' }, new Set())
    expect(r.reply.kind).toBe('cloud')
    expect(r.reply.host).toBe('yosemite-s0')
  })

  test('teams row routes to `agents factory answer` with the team name', () => {
    const r = toFloorAgentFromRemote({ ...base, context: 'teams', teamName: 'auth-team' }, new Set())
    expect(r.reply.kind).toBe('team')
    expect(r.reply.teamName).toBe('auth-team')
  })

  test('a raw terminal session has no injectable channel (none + reason)', () => {
    const local = toFloorAgentFromRemote({ ...base, host: 'this-mac', context: 'terminal' }, new Set())
    expect(local.reply.kind).toBe('none')
    expect(local.reply.reason).toBeTruthy()
    const remote = toFloorAgentFromRemote({ ...base, host: 'zion', context: 'terminal' }, new Set())
    expect(remote.reply.kind).toBe('none')
    expect(remote.reply.reason).toContain('zion')
  })

  test('a cloud row missing its task id degrades to none rather than a dead send', () => {
    const r = toFloorAgentFromRemote({ ...base, context: 'cloud', cloudTaskId: '' }, new Set())
    expect(r.reply.kind).toBe('none')
  })
})

describe('adaptTickets', () => {
  test('maps UnifiedTask fields onto FloorTicket', () => {
    const tasks: UnifiedTask[] = [
      {
        id: 'lin-1',
        source: 'linear',
        title: 'Fix the thing',
        description: 'details',
        status: 'in_progress',
        priority: 'high',
        metadata: { identifier: 'RUSH-1', repo: 'swarmify', labels: ['bug'] },
      },
    ]
    const [t] = adaptTickets(tasks)
    expect(t.id).toBe('RUSH-1')
    expect(t.source).toBe('LN')
    expect(t.pri).toBe('high')
    expect(t.status).toBe('in-progress')
    expect(t.project).toBe('swarmify')
    expect(t.labels).toEqual(['bug'])
  })
})
