import { describe, test, expect } from 'bun:test'
import { buildPrBoard, collectPrUrls, type PrStatusLike } from './prBoardModel'
import type { FloorAgent } from './floorModel'

function makeAgent(overrides: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'a1',
    host: 'this-mac',
    hostLabel: 'zion',
    project: 'agents-cli',
    name: 'rail-flyouts',
    abbr: 'CC',
    phase: 'done',
    verb: '',
    target: '',
    tok: 0,
    since: '2s',
    lastActivityMs: 0,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: '#900',
    prUrl: 'https://github.com/x/y/pull/900',
    ci: null,
    ticket: null,
    branch: 'feat',
    worktreeSlug: '',
    worktreePath: '',
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

function status(over: Partial<PrStatusLike>): PrStatusLike {
  return {
    url: 'https://github.com/x/y/pull/900',
    number: 900,
    title: 'feat: thing',
    state: 'open',
    isDraft: false,
    ci: 'passed',
    review: 'approved',
    mergeable: 'mergeable',
    readyToMerge: true,
    ...over,
  }
}

describe('collectPrUrls', () => {
  test('unique URLs, agents without a PR skipped', () => {
    const urls = collectPrUrls([
      makeAgent(),
      makeAgent({ id: 'b', prUrl: 'https://github.com/x/y/pull/901' }),
      makeAgent({ id: 'c' }), // same URL as a1
      makeAgent({ id: 'd', pr: null, prUrl: null }),
    ])
    expect(urls).toEqual(['https://github.com/x/y/pull/900', 'https://github.com/x/y/pull/901'])
  })
})

describe('buildPrBoard', () => {
  test('orders for action: ready, red/conflicting, changes-requested, running, rest, settled', () => {
    const rows = buildPrBoard(
      [
        status({ url: 'u-running', number: 1, readyToMerge: false, ci: 'running', review: null }),
        status({ url: 'u-merged', number: 2, state: 'merged', readyToMerge: false }),
        status({ url: 'u-ready', number: 3 }),
        status({ url: 'u-changes', number: 4, readyToMerge: false, review: 'changes_requested' }),
        status({ url: 'u-red', number: 5, readyToMerge: false, ci: 'failed' }),
        status({ url: 'u-waiting', number: 6, readyToMerge: false, review: 'review_required', ci: 'passed' }),
      ],
      [],
    )
    expect(rows.map((r) => r.url)).toEqual(['u-ready', 'u-red', 'u-changes', 'u-running', 'u-waiting', 'u-merged'])
  })

  test('joins the owning agent by URL', () => {
    const owner = makeAgent()
    const rows = buildPrBoard([status({}), status({ url: 'u-orphan', number: 7 })], [owner])
    expect(rows.find((r) => r.number === 900)?.owner?.id).toBe('a1')
    expect(rows.find((r) => r.number === 7)?.owner).toBe(null)
  })
})
