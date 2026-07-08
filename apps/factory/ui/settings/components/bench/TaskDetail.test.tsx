import { describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// TaskDetail renders comment/description bodies through DOMPurify, whose default
// export binds to `window` at import time. Register happy-dom BEFORE requiring
// the component so DOMPurify.sanitize is a real function. The production surface
// is a VS Code webview, which has a window.
// Guard: another UI test file in the same process (e.g. utils/markdown.test.ts)
// may have already registered happy-dom globally — register() throws on a double
// register, which fails the whole suite. Only register when no DOM exists yet.
if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()

const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { TaskDetail } = require('./TaskDetail')
import type { FlatTask } from './TaskCard'

function makeTask(overrides: Partial<FlatTask> = {}): FlatTask {
  return {
    id: 'linear:iss_1',
    source: 'linear',
    title: 'Broken layout',
    description: 'Repro steps',
    status: 'in_progress',
    metadata: {
      identifier: 'RUSH-9',
      url: 'https://linear.app/acme/issue/RUSH-9',
      comments: [
        { body: 'This reproduces on Safari too', createdAt: '2026-07-01T00:00:00Z', author: 'Ada' },
      ],
      images: ['https://uploads.linear.app/shot.png'],
    },
    ...overrides,
  }
}

describe('TaskDetail comments + images', () => {
  test('renders a comment body and an <img> for each metadata image', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetail, {
        task: makeTask(),
        onDispatch: () => {},
        onDismiss: () => {},
        onOpenExternal: () => {},
      })
    )

    // Comment author + body render.
    expect(html).toContain('Ada')
    expect(html).toContain('This reproduces on Safari too')

    // Images section renders an <img> pointing at the metadata URL.
    expect(html).toContain('Images (1)')
    expect(html).toContain('<img')
    expect(html).toContain('src="https://uploads.linear.app/shot.png"')
  })

  test('omits the Images section when there are no images', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetail, {
        task: makeTask({
          metadata: { identifier: 'RUSH-9', url: 'https://linear.app/x', comments: [] },
        }),
        onDispatch: () => {},
        onDismiss: () => {},
        onOpenExternal: () => {},
      })
    )
    expect(html).not.toContain('Images (')
  })

  test('drops non-http(s) image URLs from render', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskDetail, {
        task: makeTask({
          metadata: { images: ['javascript:alert(1)', 'https://ok.example/a.png'] },
        }),
        onDispatch: () => {},
        onDismiss: () => {},
        onOpenExternal: () => {},
      })
    )
    expect(html).toContain('Images (1)')
    expect(html).not.toContain('javascript:alert(1)')
    expect(html).toContain('src="https://ok.example/a.png"')
  })
})
