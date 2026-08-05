import { afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { ProjectsPane } = require('./ProjectsPane')

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ProjectsPane CLI-managed surface', () => {
  test('labels projects as CLI-managed and shows command errors inline', async () => {
    const rootElement = document.createElement('div')
    document.body.appendChild(rootElement)
    const root = createRoot(rootElement)

    await act(async () => {
      root.render(
        React.createElement(ProjectsPane, {
          projects: [],
          linearProjects: [],
          pickedFolder: null,
          commandError: 'agents projects list failed: not logged in',
          onSave: () => {},
          onDelete: () => {},
          onPickFolder: () => {},
          onClose: () => {},
        }),
      )
    })

    expect(rootElement.textContent).toContain('CLI-managed')
    const err = rootElement.querySelector('[data-testid="project-command-error"]')
    expect(err?.textContent).toContain('agents projects list failed')
    // No toast surface — error is inline only.
    expect(rootElement.querySelector('[data-testid="toast"]')).toBeNull()

    await act(async () => {
      root.unmount()
    })
  })
})
