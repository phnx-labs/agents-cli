import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SavedViews, FEED_GROUP_OPTS, FEED_STATUS_OPTS } from './SavedViewsBar'

const noop = () => {}

describe('SavedViews feed header bar (RUSH-1526)', () => {
  test('without feedFilters, only Save view (no group/status chips)', () => {
    const html = renderToStaticMarkup(
      <SavedViews views={[]} activeName={null} onApply={noop} onSave={noop} onDelete={noop} />,
    )
    expect(html).toContain('Save view')
    expect(html).toContain('feed-header-bar')
    expect(html).not.toContain('Group:')
    expect(html).not.toContain('Needs you')
  })

  test('with feedFilters, group-by and status filters render next to Save view', () => {
    const html = renderToStaticMarkup(
      <SavedViews
        views={[]}
        activeName={null}
        onApply={noop}
        onSave={noop}
        onDelete={noop}
        feedFilters={{
          group: 'outcome',
          onGroup: noop,
          status: ['needs'],
          onToggleStatus: noop,
          abbrs: [],
          availableAbbrs: ['CC', 'CX'],
          onToggleAbbr: noop,
        }}
      />,
    )
    expect(html).toContain('Save view')
    expect(html).toContain('Group:')
    expect(html).toContain('Outcome')
    expect(html).toContain('Needs you')
    expect(html).toContain('Running')
    expect(html).toContain('feed-header-status on') // needs active
    expect(html).toContain('>CC<')
    expect(html).toContain('>CX<')
    // Group options are present in the select
    for (const o of FEED_GROUP_OPTS) {
      expect(html).toContain(`>${o.label}<`)
    }
    for (const o of FEED_STATUS_OPTS) {
      expect(html).toContain(o.label)
    }
  })

  test('active agent chips mark .on when selected', () => {
    const html = renderToStaticMarkup(
      <SavedViews
        views={[]}
        activeName={null}
        onApply={noop}
        onSave={noop}
        onDelete={noop}
        feedFilters={{
          group: 'project',
          onGroup: noop,
          status: [],
          onToggleStatus: noop,
          abbrs: ['CC'],
          availableAbbrs: ['CC', 'CX'],
          onToggleAbbr: noop,
        }}
      />,
    )
    expect(html).toContain('feed-header-agent on')
  })
})
