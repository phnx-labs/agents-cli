// FeedItem renders agent prose through renderMarkdown -> DOMPurify, which needs a
// real DOM. Most tests here are deliberately DOM-free (renderToStaticMarkup), but
// that is exactly why FeedItem had no working coverage: every render threw
// "DOMPurify.sanitize is not a function". Registering happy-dom exercises the real
// sanitizer rather than stubbing it out.
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Guarded exactly as App.test.tsx:4 does: registering twice throws, and whether
// another file in the run got there first depends on file order.
if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()

import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FloorAgent } from './floorModel'

// Imported dynamically, AFTER the line above runs. A static import would be
// hoisted above the registration, and dompurify binds to `window` at module
// evaluation time — which is precisely why registering it alone did not work.
const { FeedItem } = await import('./FeedItem')

const noop = () => {}

function agent(over: Partial<FloorAgent> = {}): FloorAgent {
  return {
    id: 'a1',
    host: 'this-mac',
    project: 'agents-cli',
    name: 'heartbeat-lastactivity',
    abbr: 'CC',
    phase: 'running',
    verb: '',
    target: '',
    tok: 40,
    since: '15s',
    lastActivityMs: 0,
    files: 0,
    tools: 0,
    needs: false,
    pinned: false,
    pr: null,
    prUrl: null,
    ci: null,
    ticket: '',
    branch: '',
    worktreeSlug: '',
    worktreePath: '',
    resp: '',
    messages: [],
    question: null,
    reply: { kind: 'none', host: 'this-mac' },
    todos: [],
    summary: '',
    recent: [],
    sessionId: 'sess-abc',
    ...over,
  }
}

function render(a: FloorAgent, plain: boolean): string {
  return renderToStaticMarkup(
    <FeedItem
      agent={a}
      selected={false}
      plain={plain}
      onSelect={noop}
      onOption={noop}
      onFreeText={noop}
      onAttach={noop}
      onOpenPlan={noop}
      onOpenTerminal={noop}
    />,
  )
}

// A compact row's title is the agent's NAME, so without a preview line the row
// says what the agent is called and nothing about what it is doing. These pin
// that every compact row carries exactly one such line.
describe('compact (plain) row preview line', () => {
  test('an agent that has said nothing still shows its prompt as the preview', () => {
    const html = render(agent({ prompt: 'Trace where remote sessions lose their last-activity stamp' }), true)
    expect(html).toContain('class="summary')
    expect(html).toContain('Trace where remote sessions lose their last-activity stamp')
  })

  test('falls back down the chain to the summary when there is no prompt', () => {
    const html = render(agent({ summary: 'Mapping the two half-wired dispatch paths' }), true)
    expect(html).toContain('class="summary')
    expect(html).toContain('Mapping the two half-wired dispatch paths')
  })

  test('falls back to the worktree slug when the agent has no narrative at all', () => {
    // The contextless-card case: a waiting session with nothing to say still has
    // to be distinguishable from every other waiting session.
    const html = render(agent({ worktreeSlug: 'agents/heartbeat' }), true)
    expect(html).toContain('class="summary')
    expect(html).toContain('agents/heartbeat')
  })

  test('does NOT add a second preview line when the agent already has a response', () => {
    // The response block IS the row's one line. Rendering the prompt underneath
    // it makes the row a line taller for signal the operator already has.
    const html = render(
      agent({ resp: 'Merged the three surfaces into one BacklogCenter.', prompt: 'Collapse the ticket surfaces' }),
      true,
    )
    expect(html).toContain('Merged the three surfaces into one BacklogCenter.')
    // Assert on the preview ELEMENT, not the prompt text: the prompt also appears
    // in the row's title tooltip, so a bare text match would pass either way.
    expect(html).not.toContain('class="summary')
  })

  test('the full (non-compact) card is unaffected — it still shows both', () => {
    const html = render(
      agent({ resp: 'Merged the three surfaces into one BacklogCenter.', prompt: 'Collapse the ticket surfaces' }),
      false,
    )
    expect(html).toContain('Merged the three surfaces into one BacklogCenter.')
    expect(html).toContain('Collapse the ticket surfaces')
  })

  test('a single-line prompt does not render twice: title AND task block', () => {
    // The title IS firstLine(prompt), so a TASK block under it restated the same
    // string and cost the card ~120px. Compare LINE COUNT, not text: firstLine()
    // strips markdown, so `prompt !== firstLine(prompt)` is true for ANY
    // single-line prompt containing markup — the cards that read worst.
    const html = render(agent({ prompt: 'Make **discovery** natural' }), false)
    expect(html).not.toContain('class="task')
  })

  test('a multi-line prompt still gets its task block — it carries more than the title', () => {
    const html = render(agent({ prompt: 'Make discovery natural\n\nKeep the legacy keyword path behind a flag.' }), false)
    expect(html).toContain('class="task')
    expect(html).toContain('Keep the legacy keyword path behind a flag.')
  })
})

// A "needs you" row whose reply cannot be delivered used to look identical to one
// that worked: replyToAgent set an inline error, but the feed never passed it to
// StructuredReply, so the click produced no visible change at all.
describe('reply delivery failure is visible on the feed row', () => {
  const asking = (over = {}) => agent({
    phase: 'waiting',
    needs: true,
    question: { kind: 'choice', text: 'Drop the old table?', options: ['Drop it', 'Keep it'], clusterKey: 'k' },
    reply: { kind: 'none', host: 'yosemite-s1', reason: 'Runs on yosemite-s1 — open it there to reply' },
    ...over,
  })

  test('renders the delivery error when one is supplied', () => {
    const html = render({ ...asking(), } as FloorAgent, false)
    expect(html).toContain('Drop it')  // the options render
    const withErr = renderToStaticMarkup(
      <FeedItem
        agent={asking() as FloorAgent}
        selected={false}
        plain={false}
        error="Runs on yosemite-s1 — open it there to reply"
        onSelect={noop} onOption={noop} onFreeText={noop} onAttach={noop}
        onOpenPlan={noop} onOpenTerminal={noop}
      />,
    )
    expect(withErr).toContain('Runs on yosemite-s1')
  })

  test('the same row without an error shows no error text', () => {
    const html = render(asking() as FloorAgent, false)
    expect(html).not.toContain('open it there to reply')
  })

  test('a compact asking row does not also render a prose preview line', () => {
    // The question IS the row's line; a summary above it makes two prose blocks.
    const html = render(asking({ prompt: 'Migrate the policy_v1 RLS rules' }) as FloorAgent, true)
    expect(html).not.toContain('class="summary')
  })
})
