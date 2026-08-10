import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  FloorSidebar,
  FLOOR_SIDEBAR_MAX_WIDTH,
  FLOOR_SIDEBAR_MIN_WIDTH,
} from './FloorSidebar'

const noop = () => {}

describe('FloorSidebar resizing', () => {
  test('renders an accessible resize separator with the persisted width', () => {
    const html = renderToStaticMarkup(
      <FloorSidebar
        agents={[]}
        tickets={[]}
        projFilter={null}
        hostPins={[]}
        projects={[]}
        sidebarWidth={260}
        onSidebarWidthChange={noop}
        onScope={noop}
      />,
    )

    expect(html).toContain('sidebar-resize')
    expect(html).toContain('role="separator"')
    expect(html).toContain('aria-label="Resize sidebar"')
    expect(html).toContain(`aria-valuemin="${FLOOR_SIDEBAR_MIN_WIDTH}"`)
    expect(html).toContain(`aria-valuemax="${FLOOR_SIDEBAR_MAX_WIDTH}"`)
    expect(html).toContain('aria-valuenow="260"')
  })
})
