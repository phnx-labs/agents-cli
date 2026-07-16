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
  cleanWorktreeSlug,
  detectCreatedCommits,
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

describe('detectCreatedCommits', () => {
  test('extracts short commit shas from successful command output', () => {
    expect(detectCreatedCommits([
      { name: 'Bash', output: '[rush-1547-linear-artifacts 095e588093ca] RUSH-1547: surface ticket artifacts' },
      { name: 'Bash', output: '[rush-1547-linear-artifacts 095e588093ca] duplicate line' },
      { name: 'Bash', output: '[rush-1547-linear-artifacts 1111111] another change' },
    ])).toEqual(['095e588093ca', '1111111'])
  })

  test('ignores failed command output', () => {
    expect(detectCreatedCommits([
      { name: 'Bash', output: '[rush-1547-linear-artifacts deadbee] failed change', isError: true },
    ])).toEqual([])
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
    // no agent.last_messages, so resp is empty (the now-line, not the body, carries the
    // live activity); phase is waiting from the flag; needs is still true.
    expect(a.phase).toBe('waiting')
    expect(a.needs).toBe(true)
    expect(a.host).toBe('this-mac')
    expect(a.abbr).toBe('CC')
  })

  test('surfaces commit artifacts from recent terminal output', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        terminal: {
          id: 't1',
          recentToolCalls: [
            { name: 'Bash', output: '[rush-1547-linear-artifacts abc1234] RUSH-1547: wire ticket links' },
          ],
        },
        agent: null,
      }),
      { pinned: new Set(), workspaceRepo: 'agents-cli', nowMs: NOW },
    )
    expect(a.createdCommits).toEqual(['abc1234'])
  })

  test('a completed agent with a stale waiting flag lands in done, not needs-you (RUSH-1522)', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        status: 'completed',
        active: false,
        terminal: { id: 't1', waitingForInput: true },
        agent: null,
      }),
      { pinned: new Set(), workspaceRepo: 'swarmify', nowMs: NOW },
    )
    expect(a.phase).toBe('done')
    expect(a.needs).toBe(false) // no PR — nothing for the user to do
  })

  test('a stopped agent with a stale waiting flag settles to idle, not needs-you (RUSH-1522)', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        status: 'stopped',
        active: false,
        terminal: { id: 't1', waitingForInput: true },
        agent: null,
      }),
      { pinned: new Set(), workspaceRepo: 'swarmify', nowMs: NOW },
    )
    expect(a.phase).toBe('idle')
    expect(a.needs).toBe(false)
  })

  test('resp is empty (not the live-activity placeholder) when there is no last message', () => {
    // Regression: resp used to fall back to u.activity, so a placeholder now-line
    // ("Thinking...") rendered twice — once as the card body, once as the verb nowline.
    const a = toFloorAgentFromUnified(
      baseUnified({ activity: 'Thinking...', status: 'idle', active: false, agent: null }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.resp).toBe('')
    // The activity still reaches the card via the verb/target now-line, not the body.
    expect(a.verb).toBe('Thinking...')
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

  test('maps the ORIGINAL task (terminal firstUserMessage) into prompt, distinct from the last message', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        activity: 'Editing FeedItem.tsx',
        terminal: { id: 't1', firstUserMessage: 'Surface the original prompt on cards' },
        agent: { last_messages: ['Done — wired renderMarkdown into the resp line'] },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.prompt).toBe('Surface the original prompt on cards')
    // resp is the LAST message, not the prompt — the two are independent.
    expect(a.resp).toBe('Done — wired renderMarkdown into the resp line')
  })

  test('a headless run maps its dispatch prompt into prompt', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        terminal: null,
        agent: { prompt: 'Fix the rate limiter', last_messages: [] },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.prompt).toBe('Fix the rate limiter')
  })

  test('carries the full last_messages window into messages (Activity feed), not just the last one', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        agent: { last_messages: ['first', '', '  ', 'second', 'third'] },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    // blank entries are dropped; order preserved; resp is still the last non-blank one.
    expect(a.messages).toEqual(['first', 'second', 'third'])
    expect(a.resp).toBe('third')
  })

  test('renders a clean worktree slug from a real worktree cwd (never a raw path)', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        terminal: { id: 't1', cwd: '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1531' },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.worktreeSlug).toBe('rush-1531')
    expect(a.worktreeSlug).not.toContain('/')
    expect(a.worktreeSlug).not.toContain('WT=')
  })

  test('detects plan artifacts from output and recent worktree files', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        files: ['ref-cycle-18.md'],
        agent: { last_messages: ['Rendered ref-plan.html'] },
        terminal: {
          id: 't1',
          cwd: '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525',
          recentToolCalls: [{ name: 'Bash', output: 'open .agents/artifacts/ref-review.md' }],
        },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.plans?.map((p) => p.path)).toEqual([
      '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525/ref-plan.html',
      '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525/ref-cycle-18.md',
      '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525/.agents/artifacts/ref-review.md',
    ])
  })

  test('ignores plan-like paths that are only mentioned by the user task', () => {
    const a = toFloorAgentFromUnified(
      baseUnified({
        activity: 'Review ref-task.html',
        terminal: {
          id: 't1',
          cwd: '/Users/x/src/github.com/o/agents-cli/.agents/worktrees/rush-1525',
          firstUserMessage: 'Please render ref-plan.html',
          lastUserMessage: 'Open ref-review.md when done',
          currentActivity: 'Thinking about ref-current.html',
        },
        agent: { prompt: 'Build a plan named ref-prompt.md', last_messages: [] },
      }),
      { pinned: new Set(), workspaceRepo: null, nowMs: NOW },
    )
    expect(a.plans).toEqual([])
  })
})

describe('cleanWorktreeSlug — kills the WT=<path> leak', () => {
  test('a real worktree path yields the trailing slug', () => {
    expect(cleanWorktreeSlug('/Users/x/repo/.agents/worktrees/rush-1531')).toBe('rush-1531')
  })
  test('strips a WT= prefix and any surviving path down to the slug', () => {
    expect(cleanWorktreeSlug('WT=/Users/x/repo/.agents/worktrees/card-ux')).toBe('card-ux')
  })
  test('a non-worktree cwd resolves to empty (no chip)', () => {
    expect(cleanWorktreeSlug('/Users/x/src/repo')).toBe('')
    expect(cleanWorktreeSlug('')).toBe('')
    expect(cleanWorktreeSlug(null)).toBe('')
    expect(cleanWorktreeSlug(undefined)).toBe('')
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
      createdTickets: ['RUSH-901'],
      spawnedTeam: 'rate-limiter',
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
    expect(a.createdTickets).toEqual(['RUSH-901'])
    expect(a.spawnedTeam).toBe('rate-limiter')
    expect(a.question?.kind).toBe('confirm')
    // remote carries only session-start; heartbeat anchors to it until backend adds a stamp.
    expect(a.lastActivityMs).toBe(NOW - 42_000)
    // a genuinely-remote host is already its real name — no display override.
    expect(a.hostLabel).toBeUndefined()
  })

  test('detects remote plan artifacts from output and attachment refs', () => {
    const r: RemoteSessionLike = {
      host: 'yosemite-s0',
      sessionId: 'plan123',
      agentType: 'codex',
      cwd: '/home/u/src/agents-cli/.agents/worktrees/rush-1525',
      project: 'agents-cli',
      phase: 'running',
      activity: 'Writing plan',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: 'Plan rendered at ref-plan.html',
      output: 'See ref-cycle.md',
      attachments: ['capture (/tmp/ref-screenshot.html)'],
      prUrl: null,
      ticket: 'RUSH-1525',
      branch: 'rush-1525',
      sinceMs: 1000,
      startedAtMs: NOW - 1000,
      topic: 'Preview plan files',
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
    expect(a.plans?.map((p) => p.path)).toEqual([
      '/home/u/src/agents-cli/.agents/worktrees/rush-1525/ref-plan.html',
      '/home/u/src/agents-cli/.agents/worktrees/rush-1525/ref-cycle.md',
      '/tmp/ref-screenshot.html',
    ])
  })

  test('carries structured remote attachments onto the Floor card', () => {
    const r: RemoteSessionLike = {
      host: 'yosemite-s0',
      sessionId: 'shot123',
      agentType: 'codex',
      cwd: '/home/u/src/agents-cli',
      project: 'agents-cli',
      phase: 'running',
      activity: 'Reading screenshot',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      output: '',
      attachments: [{
        path: '/home/u/.agents/.history/attachments/factory-floor.png',
        label: 'factory-floor.png',
        mediaType: 'image/png',
        sizeBytes: 12345,
        thumbnailUri: 'vscode-resource://factory-floor.png',
      }],
      prUrl: null,
      ticket: 'RUSH-1524',
      branch: 'rush-1524',
      sinceMs: 1000,
      startedAtMs: NOW - 1000,
      topic: 'Preview session attachments',
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
    expect(a.attachments).toEqual([{
      path: '/home/u/.agents/.history/attachments/factory-floor.png',
      label: 'factory-floor.png',
      mediaType: 'image/png',
      sizeBytes: 12345,
      thumbnailUri: 'vscode-resource://factory-floor.png',
    }])
  })

  test('ignores remote plan-like paths that are only labels or task topics', () => {
    const r: RemoteSessionLike = {
      host: 'yosemite-s0',
      sessionId: 'plan456',
      agentType: 'codex',
      cwd: '/home/u/src/agents-cli/.agents/worktrees/rush-1525',
      project: 'agents-cli',
      phase: 'running',
      activity: 'Reviewing ref-activity.html',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      output: '',
      attachments: [],
      prUrl: null,
      ticket: 'RUSH-1525',
      branch: 'rush-1525',
      sinceMs: 1000,
      startedAtMs: NOW - 1000,
      topic: 'Create ref-plan.html',
      label: 'ref-topic.md',
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
    expect(a.plans).toEqual([])
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

  test('a cloud task gets its own "Cloud" category instead of folding under the dispatching machine', () => {
    // The CLI attributes a cloud task to the querier ('zion') for reply routing, but
    // it runs in a provider sandbox — the feed must NOT show it under the local host.
    const r: RemoteSessionLike = {
      host: 'zion',
      sessionId: 'task_e',
      agentType: 'codex',
      cwd: '',
      project: '',
      phase: 'waiting',
      activity: '',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: '',
      sinceMs: 0,
      startedAtMs: NOW,
      topic: 'Read README.md',
      context: 'cloud',
      cloudTaskId: 'task_e',
      cloudProvider: 'codex',
      teamName: '',
      pid: 0,
      transport: '',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set(), 'zion')
    // Groups under "Cloud", never the local machine — grouping keys off hostLabel ?? host.
    expect(a.hostLabel).toBe('Cloud')
    // Reply routing still targets the real querier host, unaffected by the display label.
    expect(a.reply.host).toBe('zion')
  })

  test('uses a remote manual label as the card name before topic or ids', () => {
    const r: RemoteSessionLike = {
      host: 'yosemite-s0',
      sessionId: '019e30a2-raw-session-id',
      agentType: 'codex',
      cwd: '/home/u/src/app',
      project: 'app',
      phase: 'running',
      activity: 'Editing src/app.ts',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: 'feature-branch',
      sinceMs: 1_000,
      startedAtMs: NOW - 1_000,
      label: 'factory floor labels',
      topic: 'Fix Factory header labels',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 1,
      transport: 'ssh',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.name).toBe('factory floor labels')
    expect(a.name).not.toContain('019e30a2')
  })

  test('falls back to topic, never a raw session id slice, when label is absent', () => {
    const r: RemoteSessionLike = {
      host: 'zion',
      sessionId: '019e30a2-dead-beef',
      agentType: 'claude',
      cwd: '',
      project: '',
      phase: 'running',
      activity: '',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: '',
      sinceMs: 1_000,
      startedAtMs: NOW - 1_000,
      topic: 'Audit cloud UUID headers',
      context: 'cloud',
      cloudTaskId: 'task_123',
      cloudProvider: 'codex',
      teamName: '',
      pid: 0,
      transport: '',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.name).toBe('Audit cloud UUID headers')
    expect(a.name).not.toContain('019e30a2')
  })

  test('uses a generic agent label instead of a uuid when no human fields exist', () => {
    const r: RemoteSessionLike = {
      host: 'zion',
      sessionId: '019e30a2-dead-beef',
      agentType: 'claude',
      cwd: '',
      project: '',
      phase: 'running',
      activity: '',
      tokPerSec: 0,
      waitingForInput: false,
      lastResponse: '',
      prUrl: null,
      ticket: null,
      branch: '',
      sinceMs: 1_000,
      startedAtMs: NOW - 1_000,
      topic: '',
      context: 'terminal',
      cloudTaskId: '',
      cloudProvider: '',
      teamName: '',
      pid: 0,
      transport: '',
      replyRail: '',
      replyMuxTarget: '',
      replyMuxSocket: '',
    }
    const a = toFloorAgentFromRemote(r, new Set())
    expect(a.name).toBe('Claude session')
    expect(a.name).not.toContain('019e30a2')
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

describe('toFloorAgentFromRemote — plan progress (RUSH-1380)', () => {
  const remote = (over: Partial<RemoteSessionLike>): RemoteSessionLike => ({
    host: 'yosemite-s0',
    sessionId: 's1',
    agentType: 'claude',
    cwd: '/home/u/src/web',
    project: 'web',
    phase: 'running',
    activity: '',
    tokPerSec: 0,
    waitingForInput: false,
    lastResponse: '',
    prUrl: null,
    ticket: null,
    branch: '',
    sinceMs: 1_000,
    startedAtMs: NOW - 1_000,
    topic: '',
    context: 'headless',
    ...over,
  } as RemoteSessionLike)

  test('maps the CLI todos onto the FloorAgent checklist', () => {
    const a = toFloorAgentFromRemote(remote({
      activity: 'Bash: bun test',
      todos: [
        { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
        { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
      ],
    }), new Set())
    expect(a.todos).toEqual([
      { content: 'Read the code', status: 'completed' },
      { content: 'Ship it', status: 'in_progress' },
    ])
    // A live tool action is present, so it stays the now-line verb (not overridden).
    expect(a.verb).toBe('Bash:')
  })

  test('with no live activity, surfaces the in-progress step as the now-line', () => {
    const a = toFloorAgentFromRemote(remote({
      activity: '',
      todos: [
        { content: 'Done', status: 'completed' },
        { content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' },
      ],
    }), new Set())
    expect(a.verb).toBe('Plan')
    expect(a.target).toBe('Shipping it')
  })

  test('no todos ⇒ empty checklist, no verb override', () => {
    const a = toFloorAgentFromRemote(remote({ activity: '' }), new Set())
    expect(a.todos).toEqual([])
    expect(a.verb).toBe('')
  })
})
