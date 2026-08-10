import { describe, test, expect } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { toolTarget, stepAgo, VerticalTimeline } from './Timeline'
import type { RecentEvent, RecentToolCall } from './floorModel'

const NOW = 1_700_000_000_000

describe('toolTarget — a compact target for a tool call', () => {
  test('a file path renders as its basename', () => {
    const call: RecentToolCall = { name: 'Edit', input: { file_path: '/Users/x/repo/src/core/tasks.ts' } }
    expect(toolTarget(call)).toBe('tasks.ts')
  })

  test('other path-shaped keys (target_file / path) also basename', () => {
    expect(toolTarget({ name: 'Read', input: { path: '/a/b/floor.css' } })).toBe('floor.css')
    expect(toolTarget({ name: 'Write', input: { target_file: '/a/b/c/Timeline.tsx' } })).toBe('Timeline.tsx')
  })

  test('a shell command renders as a short clause, truncated with an ellipsis', () => {
    const long = 'bun run build:settings && echo done && sleep 5 && curl localhost'
    const out = toolTarget({ name: 'Bash', input: { command: long } })
    expect(out.length).toBeLessThanOrEqual(43)
    expect(out.endsWith('…')).toBe(true)
    expect(toolTarget({ name: 'Bash', input: { command: 'bun run test' } })).toBe('bun run test')
  })

  test('no recognizable arg yields empty', () => {
    expect(toolTarget({ name: 'TodoWrite', input: { todos: [] } })).toBe('')
    expect(toolTarget({ name: 'X' })).toBe('')
    expect(toolTarget({ name: 'X', input: 'not-an-object' as unknown })).toBe('')
  })
})

describe('stepAgo — relative age of a tool step', () => {
  test('under 5s reads as "now"', () => {
    expect(stepAgo(new Date(NOW - 2000).toISOString(), NOW)).toBe('now')
  })
  test('seconds / minutes / hours scale', () => {
    expect(stepAgo(new Date(NOW - 40_000).toISOString(), NOW)).toBe('40s')
    expect(stepAgo(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('3m')
    expect(stepAgo(new Date(NOW - 2 * 3600_000).toISOString(), NOW)).toBe('2h')
  })
  test('a missing or unparseable timestamp yields empty', () => {
    expect(stepAgo(undefined, NOW)).toBe('')
    expect(stepAgo('not-a-date', NOW)).toBe('')
  })
  test('a future timestamp clamps to "now" (no negative ages)', () => {
    expect(stepAgo(new Date(NOW + 10_000).toISOString(), NOW)).toBe('now')
  })
})

describe('VerticalTimeline — rich progress events', () => {
  test('renders prose and reasoning rows between tool calls oldest-to-newest', () => {
    const recent: RecentEvent[] = [
      { kind: 'tool', call: { name: 'Edit', input: { file_path: '/repo/Timeline.tsx' }, timestamp: new Date(NOW - 10_000).toISOString() }, timestamp: new Date(NOW - 10_000).toISOString() },
      { kind: 'reasoning', text: 'The detail pane should show why the next file touch happens.', timestamp: new Date(NOW - 20_000).toISOString() },
      { kind: 'message', text: 'Reading the current timeline component before editing.', timestamp: new Date(NOW - 30_000).toISOString() },
      { kind: 'tool', call: { name: 'Read', input: { file_path: '/repo/TerminalDetail.tsx' }, timestamp: new Date(NOW - 40_000).toISOString() }, timestamp: new Date(NOW - 40_000).toISOString() },
    ]

    const html = renderToStaticMarkup(React.createElement(VerticalTimeline, { recent, nowMs: NOW }))
    expect(html.indexOf('Read')).toBeLessThan(html.indexOf('Reading the current timeline component before editing.'))
    expect(html.indexOf('Reading the current timeline component before editing.')).toBeLessThan(html.indexOf('The detail pane should show why the next file touch happens.'))
    expect(html.indexOf('The detail pane should show why the next file touch happens.')).toBeLessThan(html.indexOf('Edit'))
    expect(html).toContain('class="note message"')
    expect(html).toContain('class="note reasoning"')
  })
})
