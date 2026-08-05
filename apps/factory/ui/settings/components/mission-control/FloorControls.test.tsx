import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FloorControls, floorControlsMode } from './FloorControls'

// renderToStaticMarkup keeps these tests DOM-free and isolated (no happy-dom globals).

describe('floorControlsMode', () => {
  test('agents center -> agents control set', () => {
    expect(floorControlsMode('agents')).toBe('agents')
  })
  test('backlog center -> backlog control set', () => {
    expect(floorControlsMode('backlog')).toBe('backlog')
  })
  test('projects/host centers -> no bar', () => {
    expect(floorControlsMode('projects')).toBeNull()
    expect(floorControlsMode('host')).toBeNull()
  })
})

const noop = () => {}
const common = {
  sidebarOpen: true,
  onToggleSidebar: noop,
  rightOpen: true,
  onToggleRight: noop,
  plain: false,
  onTogglePlain: noop,
  sort: 'needs' as const,
  onSort: noop,
  ticketGroup: 'project' as const,
  onTicketGroup: noop,
  ticketSubgroup: 'owner' as const,
  onTicketSubgroup: noop,
  ticketSort: 'priority' as const,
  onTicketSort: noop,
  srcFilter: { LN: true, GH: true },
  onToggleSrc: noop,
}

describe('FloorControls contextual bar', () => {
  test('agents mode renders Sort + needs flag, NOT Group/Subgroup (those live on feed header)', () => {
    const html = renderToStaticMarkup(<FloorControls mode="agents" needsCount={3} {...common} />)
    // The agents Sort pill exposes the FloorSort options...
    expect(html).toContain('Needs you first')
    // Group/Subgroup were duplicated with SavedViews — removed from this bar.
    expect(html).not.toContain('Group:')
    expect(html).not.toContain('Subgroup:')
    // ...the ⚑ needs flag pill shows when needsCount > 0...
    expect(html).toContain('fpill-flag')
    // ...and the backlog LN/GH source chips are absent.
    expect(html).not.toContain('class="chip ')
  })

  test('backlog mode renders the LN/GH source chips + ticket Sort, NOT the feed sort', () => {
    const html = renderToStaticMarkup(<FloorControls mode="backlog" {...common} />)
    expect(html).toContain('class="chip on"') // LN + GH both active
    expect(html).toContain('>LN<')
    expect(html).toContain('>GH<')
    expect(html).toContain('Subgroup:')
    expect(html).toContain('Owner')
    // Backlog sort options are Priority/ID — the feed's 'Needs you first' must not appear.
    expect(html).not.toContain('Needs you first')
  })

  test('no Dispatch button — it lives on the sub-tab strip now', () => {
    const html = renderToStaticMarkup(<FloorControls mode="agents" needsCount={0} {...common} />)
    expect(html).not.toContain('Dispatch')
  })
})
