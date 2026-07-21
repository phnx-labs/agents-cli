import { afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')

afterEach(() => {
  document.body.innerHTML = ''
})

async function render(element: React.ReactElement) {
  const rootElement = document.createElement('div')
  document.body.appendChild(rootElement)
  const root = createRoot(rootElement)
  await act(async () => {
    root.render(element)
  })
  return root
}

describe('ResourceViewer MIME rendering', () => {
  test('pretty-prints JSON text resources', async () => {
    const { ResourceViewer } = await import('./ResourceViewer')
    const root = await render(React.createElement(ResourceViewer, {
      selected: { serverName: 'demo', uri: 'demo://config', name: 'config', mimeType: 'application/json' },
      contents: [{ uri: 'demo://config', text: '{"ok":true}', mimeType: 'application/json' }],
      loading: false,
      error: null,
    }))

    expect(document.body.textContent).toContain('"ok": true')
    root.unmount()
  })

  test('renders image blobs as data URLs', async () => {
    const { ResourceViewer } = await import('./ResourceViewer')
    const root = await render(React.createElement(ResourceViewer, {
      selected: { serverName: 'demo', uri: 'demo://image', name: 'image', mimeType: 'image/png' },
      contents: [{ uri: 'demo://image', blob: 'iVBORw0KGgo=', mimeType: 'image/png' }],
      loading: false,
      error: null,
    }))

    const img = document.querySelector('img') as HTMLImageElement | null
    expect(img?.src).toBe('data:image/png;base64,iVBORw0KGgo=')
    root.unmount()
  })

  test('summarizes non-image blobs as binary byte counts', async () => {
    const { ResourceViewer } = await import('./ResourceViewer')
    const root = await render(React.createElement(ResourceViewer, {
      selected: { serverName: 'demo', uri: 'demo://archive', name: 'archive', mimeType: 'application/octet-stream' },
      contents: [{ uri: 'demo://archive', blob: 'AQIDBA==', mimeType: 'application/octet-stream' }],
      loading: false,
      error: null,
    }))

    expect(document.body.textContent).toContain('Binary 4 bytes')
    root.unmount()
  })
})
