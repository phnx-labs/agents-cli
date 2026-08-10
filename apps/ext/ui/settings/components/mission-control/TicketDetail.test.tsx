import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TicketInFlight, dispatchCta } from './TicketDetail'
import type { FloorAgent } from './floorModel'

// Pure, DOM-free tests via renderToStaticMarkup. The full TicketDetail render goes
// through renderTodoDescription -> DOMPurify, which needs a browser DOM this runner
// deliberately doesn't register — so the in-flight block and the dispatch-guard copy
// are exported and tested directly.

function makeAgent(overrides: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'a1',
    host: 'this-mac',
    hostLabel: 'zion',
    project: 'swarmify',
    name: 'pkce-pinning',
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
    ci: null,
    ticket: 'RUSH-812',
    branch: 'feat-auth',
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

describe('dispatchCta', () => {
  test('no workers: plain label, no caution, no note', () => {
    expect(dispatchCta('RUSH-812', [])).toEqual({ label: 'Dispatch onto RUSH-812', caution: false, note: null })
  })

  test('workers present: anyway label, caution on, note names the first worker', () => {
    const cta = dispatchCta('RUSH-812', [makeAgent(), makeAgent({ id: 'b', abbr: 'CX' })])
    expect(cta.label).toBe('Dispatch anyway onto RUSH-812')
    expect(cta.caution).toBe(true)
    expect(cta.note).toBe('CC is already on this ticket — dispatching adds a second agent.')
  })
})

describe('TicketInFlight', () => {
  test('renders nothing with no workers', () => {
    expect(renderToStaticMarkup(<TicketInFlight workers={[]} />)).toBe('')
  })

  test('one row per worker with phase dot, host, and PR chip', () => {
    const workers = [
      makeAgent({ id: 'a', pr: '#142' }),
      makeAgent({ id: 'b', abbr: 'CX', name: 'pkce-review', phase: 'waiting' }),
    ]
    const html = renderToStaticMarkup(<TicketInFlight workers={workers} onSelectAgent={() => {}} />)
    expect(html).toContain('In flight')
    expect(html.split('dflight-row').length - 1).toBe(2)
    expect(html).toContain('pkce-pinning')
    expect(html).toContain('zion')
    expect(html).toContain('#142')
    expect(html).toContain('dot waiting')
  })
})
