import { afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (typeof (globalThis as { document?: unknown }).document === 'undefined') GlobalRegistrator.register()
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { act } = require('react')
const { createRoot } = require('react-dom/client')
const { THROUGHPUT_TICK_MS } = require('./floorRefresh')
const { ThroughputCounter } = require('./UnifiedAgentsPane')

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ThroughputCounter', () => {
  test('uses a 1-second data tick (not 140ms) and exposes data-tick-ms', async () => {
    expect(THROUGHPUT_TICK_MS).toBe(1_000)

    const intervals: number[] = []
    const realSetInterval = globalThis.setInterval
    // @ts-expect-error test stub
    globalThis.setInterval = (fn: TimerHandler, ms?: number) => {
      if (typeof ms === 'number') intervals.push(ms)
      return realSetInterval(fn as () => void, ms)
    }

    const rootElement = document.createElement('div')
    document.body.appendChild(rootElement)
    const root = createRoot(rootElement)

    try {
      await act(async () => {
        root.render(React.createElement(ThroughputCounter, { tokensPerSec: 120 }))
      })
      const el = rootElement.querySelector('.sw-throughput') as HTMLElement
      expect(el).toBeTruthy()
      expect(el.getAttribute('data-tick-ms')).toBe('1000')
      expect(intervals).toContain(1_000)
      expect(intervals).not.toContain(140)
    } finally {
      globalThis.setInterval = realSetInterval
      await act(async () => {
        root.unmount()
      })
    }
  })

  test('zeros bars when tokensPerSec is 0 (no interval)', async () => {
    const intervals: number[] = []
    const realSetInterval = globalThis.setInterval
    // @ts-expect-error test stub
    globalThis.setInterval = (fn: TimerHandler, ms?: number) => {
      if (typeof ms === 'number') intervals.push(ms)
      return realSetInterval(fn as () => void, ms)
    }

    const rootElement = document.createElement('div')
    document.body.appendChild(rootElement)
    const root = createRoot(rootElement)

    try {
      await act(async () => {
        root.render(React.createElement(ThroughputCounter, { tokensPerSec: 0 }))
      })
      expect(rootElement.querySelector('.sw-throughput-value')?.textContent).toBe('0')
      // No animation interval when idle.
      expect(intervals).not.toContain(1_000)
      expect(intervals).not.toContain(140)
    } finally {
      globalThis.setInterval = realSetInterval
      await act(async () => {
        root.unmount()
      })
    }
  })
})
