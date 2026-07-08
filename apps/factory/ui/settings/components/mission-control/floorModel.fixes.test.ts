import { describe, test, expect } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import {
  toFloorTicket,
  groupTickets,
  groupAgents,
  sessionTaskLine,
  worktreeSlugOf,
  type FloorAgent,
} from './floorModel'
import type { UnifiedTask } from '../../types'

// Regression tests for the Factory Floor visibility fixes. Each asserts a
// user-visible outcome that was broken, so a future edit that reintroduces the bug
// fails here rather than silently in the UI.

function agent(over: Partial<FloorAgent>): FloorAgent {
  return {
    id: 'x', host: 'this-mac', hostLabel: undefined, project: '', name: 'a', abbr: 'CC',
    phase: 'running', verb: '', target: '', tok: 0, since: '', lastActivityMs: 0,
    files: 0, tools: 0, needs: false, pinned: false, pr: null, prUrl: null, ci: null,
    ticket: null, branch: '', worktreeSlug: '', worktreePath: '', resp: '', messages: [],
    question: null, reply: { kind: 'none', host: 'this-mac' }, todos: [], summary: '',
    recent: [], ...over,
  }
}

function task(meta: UnifiedTask['metadata'], over: Partial<UnifiedTask> = {}): UnifiedTask {
  return { id: 'T', source: 'linear', title: 't', status: 'todo', metadata: meta, ...over }
}

describe('issue 1 — real project, generic Unlabeled key', () => {
  test('toFloorTicket prefers the formal Linear project, then repo', () => {
    expect(toFloorTicket(task({ project: 'Rush App', repo: 'x/y' })).project).toBe('Rush App')
    expect(toFloorTicket(task({ repo: 'owner/repo' })).project).toBe('owner/repo')
    expect(toFloorTicket(task({})).project).toBe('')
  })

  test('groupTickets renders an empty project as "Unlabeled", never blank', () => {
    const tickets = [toFloorTicket(task({})), toFloorTicket(task({ project: 'Alpha' }))]
    const keys = [...groupTickets(tickets, 'project').keys()]
    expect(keys).toContain('Unlabeled')
    expect(keys).toContain('Alpha')
    expect(keys).not.toContain('')
  })

  test('groupAgents coalesces empty keys across axes', () => {
    const groups = groupAgents([agent({ project: '' }), agent({ project: 'Beta' })], 'project')
    expect([...groups.keys()]).toEqual(expect.arrayContaining(['Unlabeled', 'Beta']))
    // host groups by the DISPLAY label so this-mac folds onto the device name
    const byHost = groupAgents([agent({ host: 'this-mac', hostLabel: 'zion' })], 'host')
    expect([...byHost.keys()]).toContain('zion')
  })
})

describe('issue 2 — one task-line seam', () => {
  test('sessionTaskLine falls back summary -> resp -> worktreeSlug -> branch', () => {
    expect(sessionTaskLine(agent({ summary: 'S', resp: 'R', worktreeSlug: 'W' }))).toBe('S')
    expect(sessionTaskLine(agent({ resp: 'R', worktreeSlug: 'W' }))).toBe('R')
    expect(sessionTaskLine(agent({ worktreeSlug: 'headless-secrets-shadow', branch: 'b' }))).toBe('headless-secrets-shadow')
    expect(sessionTaskLine(agent({ branch: 'my/branch' }))).toBe('my/branch')
    expect(sessionTaskLine(agent({}))).toBe('')
  })

  test('worktreeSlugOf extracts the slug under .agents/worktrees/', () => {
    expect(worktreeSlugOf('/x/agents-cli/.agents/worktrees/headless-secrets-shadow/src/lib/secrets/linux.ts'))
      .toBe('headless-secrets-shadow')
    expect(worktreeSlugOf('/x/agents-cli/src/index.ts')).toBe('')
    expect(worktreeSlugOf(undefined)).toBe('')
  })
})

describe('wiring guard — infra must stay wired (issue 5 was dead code)', () => {
  // groupAgents + sessionTaskLine both existed unused once; assert their production
  // consumer still imports them so they can't silently become dead again.
  const pane = fs.readFileSync(path.join(__dirname, 'UnifiedAgentsPane.tsx'), 'utf8')
  test('UnifiedAgentsPane wires groupAgents (the Group-by control)', () => {
    expect(pane).toContain('groupAgents(')
  })
  test('UnifiedAgentsPane wires sessionTaskLine (the detail rail)', () => {
    expect(pane).toContain('sessionTaskLine(')
  })
})
