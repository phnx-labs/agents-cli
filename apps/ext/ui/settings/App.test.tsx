import { afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')

type PostedMessage = { type?: string }
type IntervalEntry = { delay?: number; handler: () => void }

const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const originalDateNow = Date.now
const originalMatchMedia = window.matchMedia

function installHost(posts: PostedMessage[]) {
  ;(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: PostedMessage) => posts.push(message),
    getState: () => undefined,
    setState: () => {},
  })
}

function installIcons() {
  ;(window as unknown as { __ICONS__: unknown }).__ICONS__ = {
    claude: 'claude.svg',
    codex: { dark: 'codex-dark.svg', light: 'codex-light.svg' },
    gemini: 'gemini.svg',
    opencode: 'opencode.svg',
    cursor: { dark: 'cursor-dark.svg', light: 'cursor-light.svg' },
    agents: 'agents.svg',
    shell: 'shell.svg',
    github: 'github.svg',
    antigravity: 'antigravity.svg',
    grok: { dark: 'grok-dark.svg', light: 'grok-light.svg' },
    kimi: 'kimi.svg',
    droid: { dark: 'droid-dark.svg', light: 'droid-light.svg' },
  }
}

function installBrowserShims(intervals: IntervalEntry[]) {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as typeof window.matchMedia

  globalThis.setInterval = ((handler: TimerHandler, delay?: number) => {
    const entry = {
      delay,
      handler: () => {
        if (typeof handler === 'function') handler()
      },
    }
    intervals.push(entry)
    return intervals.length as unknown as ReturnType<typeof setInterval>
  }) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval
}

afterEach(() => {
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
  Date.now = originalDateNow
  window.matchMedia = originalMatchMedia
  document.body.innerHTML = ''
  delete (globalThis as unknown as { acquireVsCodeApi?: unknown }).acquireVsCodeApi
})

describe('App unified task refresh', () => {
  test('refreshes backlog tasks while the Floor tab stays open', async () => {
    const posts: PostedMessage[] = []
    const intervals: IntervalEntry[] = []
    let now = 1_000
    Date.now = () => now
    installHost(posts)
    installIcons()
    installBrowserShims(intervals)

    const { default: App } = await import('./App')
    const rootElement = document.createElement('div')
    document.body.appendChild(rootElement)
    const root = createRoot(rootElement)

    await act(async () => {
      root.render(React.createElement(App))
    })

    expect(posts.filter((message) => message.type === 'fetchUnifiedTasks')).toHaveLength(1)

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'tasksData', tasks: [] } }))
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'unifiedTasksData', tasks: [] } }))
    })

    now += 30_001
    await act(async () => {
      for (const interval of intervals.filter((entry) => entry.delay === 30_000)) interval.handler()
    })

    expect(posts.filter((message) => message.type === 'fetchUnifiedTasks')).toHaveLength(2)

    await act(async () => {
      root.unmount()
    })
  })
})
