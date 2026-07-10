import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BacklogCenter } from './BacklogCenter'
import type { FloorAgent, FloorTicket } from './floorModel'

// renderToStaticMarkup keeps this DOM-free and isolated (no happy-dom globals leak).

const tickets: FloorTicket[] = [
  { id: 'RUSH-1262', title: 'PKCE token exchange uses unpinned http client', project: 'rush', source: 'LN', pri: 'urgent', status: 'todo', desc: '', labels: ['security'], owner: 'Muqsit' },
  { id: '#418', title: 'Kanban feed views are stubs', project: 'swarmify', source: 'GH', pri: 'med', status: 'todo', desc: '', labels: [], owner: '' },
]
const noop = () => {}

function makeAgent(overrides: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'a1',
    host: 'this-mac',
    hostLabel: 'zion',
    project: 'rush',
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
    ticket: 'RUSH-1262',
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

function render(over?: Partial<Record<'LN' | 'GH', boolean>>, workers?: Record<string, FloorAgent[]>) {
  return renderToStaticMarkup(
    <BacklogCenter
      tickets={tickets}
      group="project"
      sort="priority"
      srcFilter={{ LN: true, GH: true, ...over }}
      projFilter={null}
      search=""
      selectedTicketId={null}
      workers={workers}
      onSelectTicket={noop}
      onOpenTask={noop}
    />,
  )
}

describe('BacklogCenter', () => {
  test('no longer renders its own toolbar (controls moved to the shared bar)', () => {
    const html = render()
    expect(html).not.toContain('bktoolbar')
    // The group/sort <select> controls are gone from this component entirely.
    expect(html).not.toContain('<select')
  })

  test('renders the ticket rows it is given', () => {
    const html = render()
    expect(html).toContain('trow2')
    expect(html).toContain('RUSH-1262')
    expect(html).toContain('#418')
  })

  test('applies the source filter (GH hidden when toggled off)', () => {
    const html = render({ GH: false })
    expect(html).toContain('RUSH-1262')
    expect(html).not.toContain('#418')
  })
})

describe('BacklogCenter in-flight chips', () => {
  test('a worked ticket gets the chip; an untouched one does not', () => {
    const html = render(undefined, { 'RUSH-1262': [makeAgent()] })
    expect(html.split('twork').length - 1).toBe(1)
    const worked = html.slice(html.indexOf('data-tid="RUSH-1262"'), html.indexOf('data-tid="#418"'))
    expect(worked).toContain('twork')
    expect(worked).toContain('CC')
    expect(worked).toContain('dot running')
  })

  test('multiple workers collapse to first abbr +N, tooltip carries the roster', () => {
    const html = render(undefined, {
      'RUSH-1262': [makeAgent(), makeAgent({ id: 'b', abbr: 'CX', name: 'pkce-review', phase: 'waiting' })],
    })
    expect(html).toContain('CC +1')
    expect(html).toContain('pkce-review')
  })

  test('no workers map renders no chips', () => {
    expect(render()).not.toContain('twork')
  })
})
