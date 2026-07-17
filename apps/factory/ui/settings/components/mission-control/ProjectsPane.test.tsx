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

describe('ProjectsPane edit interaction', () => {
  test('clicking Edit highlights the row, focuses the folder input, and scrolls the form into view', async () => {
    const projects = [
      { id: 'a', name: 'Alpha', path: '/alpha', confidence: 'high' as const, source: 'manual' as const },
      { id: 'b', name: 'Beta', path: '/beta', confidence: 'high' as const, source: 'manual' as const },
    ]

    const rootElement = document.createElement('div')
    document.body.appendChild(rootElement)
    const root = createRoot(rootElement)

    await act(async () => {
      root.render(
        React.createElement(ProjectsPane, {
          projects,
          linearProjects: [],
          pickedFolder: null,
          onSave: () => {},
          onDelete: () => {},
          onPickFolder: () => {},
          onClose: () => {},
        }),
      )
    })

    const editButtons = Array.from(rootElement.querySelectorAll('button')).filter(
      (b) => b.textContent === 'Edit',
    )
    expect(editButtons).toHaveLength(2)

    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    const scrolledElements: Element[] = []
    HTMLElement.prototype.scrollIntoView = function (this: Element) {
      scrolledElements.push(this)
    }

    try {
      await act(async () => {
        editButtons[1].click()
      })

      const highlightedRows = Array.from(rootElement.querySelectorAll('.dispatch-panel.editing'))
      expect(highlightedRows).toHaveLength(1)
      expect(highlightedRows[0].querySelector('span')?.textContent).toBe('Beta')

      const folderInput = rootElement.querySelector(
        'input[placeholder="/absolute/path/to/repo"]',
      ) as HTMLInputElement
      expect(document.activeElement).toBe(folderInput)

      const formContainer = folderInput.closest('.dispatch-panel')?.parentElement
      expect(scrolledElements).toContain(formContainer)
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView
      await act(async () => {
        root.unmount()
      })
    }
  })
})
