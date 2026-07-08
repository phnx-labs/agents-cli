import { expect, test } from 'bun:test'
import type React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// renderTodoDescription sanitizes via DOMPurify, which binds `window` at import
// time. The real app runs in a VS Code webview / Electron host, so register a DOM
// BEFORE importing markdown.ts — then the full marked -> DOMPurify pipeline runs
// exactly as it does in production.
GlobalRegistrator.register()
const { renderTodoDescription, escapeHtml } = await import('./markdown')

// renderTodoDescription returns a <div> whose sanitized HTML is carried on
// dangerouslySetInnerHTML.__html — assert on that string directly so the test
// needs no DOM.
function html(desc: string, clamp = false): string {
  const el = renderTodoDescription(desc, clamp) as React.ReactElement<{
    dangerouslySetInnerHTML: { __html: string }
  }>
  return el.props.dangerouslySetInnerHTML.__html
}

test('renders a heading as <h2>', () => {
  const out = html('## Summary')
  expect(out).toContain('<h2')
  expect(out).toContain('Summary')
  expect(out).not.toContain('## Summary')
})

test('renders a fenced code block as <pre><code>', () => {
  const out = html('```\nconst x = 1\n```')
  expect(out).toContain('<pre')
  expect(out).toContain('<code')
  expect(out).toContain('const x = 1')
  // fence markers must not survive as literal text
  expect(out).not.toContain('```')
})

test('renders bold as <strong>', () => {
  const out = html('this is **bold** text')
  expect(out).toContain('<strong>bold</strong>')
  expect(out).not.toContain('**bold**')
})

test('renders a bullet list as <ul><li>', () => {
  const out = html('- one\n- two\n- three')
  expect(out).toContain('<li>')
  expect(out).toContain('one')
  expect(out).toContain('two')
  expect(out).toContain('three')
})

test('clamp flag toggles the todo-md-clamp class', () => {
  const clamped = renderTodoDescription('hi', true) as React.ReactElement<{ className: string }>
  const unclamped = renderTodoDescription('hi', false) as React.ReactElement<{ className: string }>
  expect(clamped.props.className).toContain('todo-md-clamp')
  expect(unclamped.props.className).not.toContain('todo-md-clamp')
})

test('escapeHtml escapes angle brackets and ampersands', () => {
  expect(escapeHtml('<a> & "b"')).toBe('&lt;a&gt; &amp; &quot;b&quot;')
})
