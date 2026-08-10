import { afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { ProjectsPane, safeProjectId } = require('./ProjectsPane')

afterEach(() => {
  document.body.innerHTML = ''
})

describe('safeProjectId', () => {
  test('replaces slash in owner/repo so CLI ids stay path-safe', () => {
    expect(safeProjectId('phnx-labs/agents-cli')).toBe('phnx-labs-agents-cli')
    expect(safeProjectId('Owner/Repo Name')).toBe('owner-repo-name')
    expect(safeProjectId('  agents cli  ')).toBe('agents-cli')
    expect(safeProjectId('///')).toBe('project')
  })
})

describe('ProjectsPane save', () => {
  test('new project id sanitizes repoSlug with slash', async () => {
    const saved: Array<Record<string, unknown>> = []
    const rootElement = document.createElement('div')
    document.body.appendChild(rootElement)
    const root = createRoot(rootElement)

    await act(async () => {
      root.render(
        React.createElement(ProjectsPane, {
          projects: [],
          linearProjects: [],
          pickedFolder: {
            path: '/Users/muqsit/src/github.com/phnx-labs/agents-cli',
            repoSlug: 'phnx-labs/agents-cli',
            name: 'agents-cli',
          },
          onSave: (p: Record<string, unknown>) => { saved.push(p) },
          onDelete: () => {},
          onPickFolder: () => {},
          onClose: () => {},
        }),
      )
    })

    const addBtn = Array.from(rootElement.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add project',
    ) as HTMLButtonElement
    expect(addBtn).toBeTruthy()
    await act(async () => {
      addBtn.click()
    })

    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe('phnx-labs-agents-cli')
    expect(saved[0].repoSlug).toBe('phnx-labs/agents-cli')
    expect(String(saved[0].id)).not.toContain('/')

    await act(async () => {
      root.unmount()
    })
  })

  test('edit preserves autoDispatch and maxAgents from the base project', async () => {
    const saved: Array<Record<string, unknown>> = []
    const projects = [
      {
        id: 'agents-cli',
        name: 'agents-cli',
        path: '/repo/agents-cli',
        repoSlug: 'phnx-labs/agents-cli',
        dirs: [{ slug: 'phnx-labs/agents-cli', path: '/repo/agents-cli' }],
        confidence: 'high' as const,
        source: 'manual' as const,
        autoDispatch: true,
        maxAgents: 4,
      },
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
          onSave: (p: Record<string, unknown>) => { saved.push(p) },
          onDelete: () => {},
          onPickFolder: () => {},
          onClose: () => {},
        }),
      )
    })

    const editBtn = Array.from(rootElement.querySelectorAll('button')).find(
      (b) => b.textContent === 'Edit',
    ) as HTMLButtonElement
    await act(async () => {
      editBtn.click()
    })

    const nameInput = Array.from(rootElement.querySelectorAll('input')).find(
      (i) => (i as HTMLInputElement).placeholder === 'project name',
    ) as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(nameInput, 'agents-cli-renamed')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      nameInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const saveBtn = Array.from(rootElement.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save changes',
    ) as HTMLButtonElement
    await act(async () => {
      saveBtn.click()
    })

    expect(saved).toHaveLength(1)
    expect(saved[0].id).toBe('agents-cli')
    expect(saved[0].name).toBe('agents-cli-renamed')
    expect(saved[0].autoDispatch).toBe(true)
    expect(saved[0].maxAgents).toBe(4)

    await act(async () => {
      root.unmount()
    })
  })
})
