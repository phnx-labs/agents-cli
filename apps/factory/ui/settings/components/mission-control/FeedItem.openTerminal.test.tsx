import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FeedItem } from './FeedItem'
import type { FloorAgent } from './floorModel'

const noop = () => {}

function agent(over: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'a1',
    host: 'this-mac',
    project: 'agents-cli',
    name: 'fix-auth',
    abbr: 'CC',
    phase: 'waiting',
    verb: 'Waiting',
    target: '',
    tok: 0,
    since: '1m',
    lastActivityMs: 0,
    files: 0,
    tools: 0,
    needs: true,
    pinned: false,
    pr: null,
    prUrl: null,
    ci: null,
    ticket: 'RUSH-1',
    branch: '',
    worktreeSlug: '',
    worktreePath: '',
    resp: 'Which approach?',
    messages: [],
    question: { kind: 'choice', text: 'Which approach?', options: ['A'], clusterKey: 'k' },
    reply: { kind: 'none', host: 'this-mac' },
    todos: [],
    summary: '',
    recent: [],
    sessionId: 'sess-abc',
    ...over,
  }
}

describe('FeedItem open/resume terminal action (RUSH-1520)', () => {
  test('renders Terminal button when onOpenTerminal + sessionId are set', () => {
    const html = renderToStaticMarkup(
      <FeedItem
        agent={agent()}
        selected={false}
        plain={false}
        onSelect={noop}
        onOption={noop}
        onFreeText={noop}
        onAttach={noop}
        onOpenPlan={noop}
        onOpenTerminal={noop}
      />,
    )
    expect(html).toContain('open-term')
    expect(html).toContain('Open / resume session in a terminal')
    expect(html).toContain('Terminal')
  })

  test('omits Terminal button when no open handler', () => {
    const html = renderToStaticMarkup(
      <FeedItem
        agent={agent()}
        selected={false}
        plain={false}
        onSelect={noop}
        onOption={noop}
        onFreeText={noop}
        onAttach={noop}
        onOpenPlan={noop}
      />,
    )
    expect(html).not.toContain('open-term')
  })

  test('shows Terminal for a local terminal reply channel without sessionId', () => {
    const html = renderToStaticMarkup(
      <FeedItem
        agent={agent({ sessionId: undefined, reply: { kind: 'terminal', host: 'this-mac', terminalId: 't1' } })}
        selected={false}
        plain={false}
        onSelect={noop}
        onOption={noop}
        onFreeText={noop}
        onAttach={noop}
        onOpenPlan={noop}
        onOpenTerminal={noop}
      />,
    )
    expect(html).toContain('open-term')
  })
})
