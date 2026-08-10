import { expect, test, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FloorSubtabs, openTaskTab, closeTaskTab, type FixedTab, type TaskTab } from './FloorSubtabs'

// Pure, DOM-free tests via renderToStaticMarkup — no happy-dom register, no global
// mutation, so nothing leaks into sibling test files (each import is self-contained).

describe('openTaskTab', () => {
  test('appends a new tab', () => {
    const out = openTaskTab([], { id: 'RUSH-1', title: 'A', source: 'LN' })
    expect(out.map((t) => t.id)).toEqual(['RUSH-1'])
  })

  test('de-dupes by id (re-opening focuses, does not duplicate)', () => {
    const base: TaskTab[] = [{ id: 'RUSH-1', title: 'A', source: 'LN' }]
    const out = openTaskTab(base, { id: 'RUSH-1', title: 'A (again)', source: 'LN' })
    expect(out).toBe(base) // identity preserved when nothing changes
    expect(out).toHaveLength(1)
  })

  test('preserves insertion order', () => {
    let tabs: TaskTab[] = []
    tabs = openTaskTab(tabs, { id: 'a', title: 'a', source: 'LN' })
    tabs = openTaskTab(tabs, { id: 'b', title: 'b', source: 'GH' })
    tabs = openTaskTab(tabs, { id: 'c', title: 'c', source: 'LN' })
    expect(tabs.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('closeTaskTab', () => {
  const three: TaskTab[] = [
    { id: 'a', title: 'a', source: 'LN' },
    { id: 'b', title: 'b', source: 'GH' },
    { id: 'c', title: 'c', source: 'LN' },
  ]

  test('closing a non-active tab keeps the active id', () => {
    const r = closeTaskTab(three, 'a', 'c')
    expect(r.tabs.map((t) => t.id)).toEqual(['a', 'b'])
    expect(r.activeId).toBe('a')
  })

  test('closing the active middle tab falls back to the left neighbor', () => {
    const r = closeTaskTab(three, 'b', 'b')
    expect(r.tabs.map((t) => t.id)).toEqual(['a', 'c'])
    expect(r.activeId).toBe('a')
  })

  test('closing the active leading tab falls back to the new first tab', () => {
    const r = closeTaskTab(three, 'a', 'a')
    expect(r.tabs.map((t) => t.id)).toEqual(['b', 'c'])
    expect(r.activeId).toBe('b')
  })

  test('closing the last remaining tab returns null active (hands center back)', () => {
    const r = closeTaskTab([{ id: 'a', title: 'a', source: 'LN' }], 'a', 'a')
    expect(r.tabs).toEqual([])
    expect(r.activeId).toBeNull()
  })

  test('closing an unknown id is a no-op', () => {
    const r = closeTaskTab(three, 'b', 'zzz')
    expect(r.tabs).toBe(three)
    expect(r.activeId).toBe('b')
  })
})

describe('FloorSubtabs render', () => {
  const fixed: FixedTab[] = [
    { center: 'agents', label: 'Agents', count: 8, needs: 3 },
    { center: 'backlog', label: 'Backlog', count: 12 },
    { center: 'projects', label: 'Projects', count: 4 },
    { center: 'host', label: 'Hosts', count: 5 },
  ]
  const noop = () => {}

  test('marks the active fixed center and shows count + needs badges', () => {
    const html = renderToStaticMarkup(
      <FloorSubtabs
        fixed={fixed}
        center="agents"
        taskTabs={[]}
        activeTaskTab={null}
        onSelectCenter={noop}
        onSelectTaskTab={noop}
        onCloseTaskTab={noop}
        onDispatch={noop}
      />,
    )
    // The agents tab is active (lime `on`); the count + needs badges render.
    expect(html).toContain('class="fsubtab on"')
    expect(html).toContain('fsubtab-needs')
    expect(html).toContain('>3<') // needs badge
    expect(html).toContain('>8<') // agents count
    expect(html).toContain('Dispatch')
  })

  test('a task tab active suppresses the fixed active state and renders a closeable tab', () => {
    const html = renderToStaticMarkup(
      <FloorSubtabs
        fixed={fixed}
        center="agents"
        taskTabs={[{ id: 'RUSH-1262', title: 'Token exchange', source: 'LN' }]}
        activeTaskTab="RUSH-1262"
        onSelectCenter={noop}
        onSelectTaskTab={noop}
        onCloseTaskTab={noop}
        onDispatch={noop}
      />,
    )
    // No fixed tab is `on` while a task tab owns the center.
    expect(html).not.toContain('class="fsubtab on"')
    expect(html).toContain('tasktab on')
    expect(html).toContain('tasktab-src')
    expect(html).toContain('tasktab-x')
    expect(html).toContain('Token exchange')
  })
})
