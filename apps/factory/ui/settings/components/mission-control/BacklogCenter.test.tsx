import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BacklogCenter } from './BacklogCenter'
import type { FloorTicket } from './floorModel'

// renderToStaticMarkup keeps this DOM-free and isolated (no happy-dom globals leak).

const tickets: FloorTicket[] = [
  { id: 'RUSH-1262', title: 'PKCE token exchange uses unpinned http client', project: 'rush', source: 'LN', pri: 'urgent', status: 'todo', desc: '', labels: ['security'], owner: 'Muqsit' },
  { id: '#418', title: 'Kanban feed views are stubs', project: 'swarmify', source: 'GH', pri: 'med', status: 'todo', desc: '', labels: [], owner: '' },
]
const noop = () => {}

function render(over?: Partial<Record<'LN' | 'GH', boolean>>) {
  return renderToStaticMarkup(
    <BacklogCenter
      tickets={tickets}
      group="project"
      sort="priority"
      srcFilter={{ LN: true, GH: true, ...over }}
      projFilter={null}
      search=""
      selectedTicketId={null}
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
