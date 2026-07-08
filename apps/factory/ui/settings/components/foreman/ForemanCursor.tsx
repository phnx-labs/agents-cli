import React, { useEffect, useRef, useState } from 'react'

// Phase 1 of the voice-drive-ui plan (docs/voice-drive-ui.md).
//
// ForemanCursor renders an absolute-positioned SVG that animates toward any
// element carrying a matching data-foreman-id attribute, optionally firing a
// click at the end of the move. The extension host drives this via
// foreman.uiCommand messages on the webview post-message channel; the webview
// renders the animation, then executes the target element's native click so
// the underlying handler runs exactly as if a human had clicked it.
//
// Abort: any foreman.abort message cancels any in-flight sequence. The mic
// stays hot during playback, so the user can cut the sequence short by
// saying "stop" / "cancel" / "wait" / "no" — the realtime transcript
// forwards those as abort signals.

type UiCommand =
  | { kind: 'move'; target: string }
  | { kind: 'click'; target: string }
  | { kind: 'highlight'; target: string; ms?: number }
  | { kind: 'reset' }

interface ForemanUiCommandMessage {
  type: 'foreman.uiCommand'
  command: UiCommand
}

interface ForemanAbortMessage {
  type: 'foreman.abort'
}

type IncomingMessage = ForemanUiCommandMessage | ForemanAbortMessage | { type: string }

interface CursorState {
  visible: boolean
  x: number
  y: number
  clicking: boolean
  targetId: string | null
}

const INITIAL: CursorState = { visible: false, x: 0, y: 0, clicking: false, targetId: null }

// Move duration scales with distance so long journeys don't feel instant and
// short hops don't feel sluggish. Clamped so the user always has time to
// say "stop" before a destructive click lands.
function moveDuration(dx: number, dy: number): number {
  const dist = Math.hypot(dx, dy)
  return Math.max(300, Math.min(900, 200 + dist * 0.8))
}

function resolveTarget(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-foreman-id="${CSS.escape(id)}"]`)
}

function centerOf(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

export function ForemanCursor() {
  const [state, setState] = useState<CursorState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const handler = (event: MessageEvent<IncomingMessage>) => {
      const m = event.data
      if (!m || typeof m !== 'object') return

      if (m.type === 'foreman.abort') {
        abortRef.current?.abort()
        setState(INITIAL)
        return
      }

      if (m.type !== 'foreman.uiCommand') return
      const cmd = (m as ForemanUiCommandMessage).command
      runCommand(cmd)
    }

    async function runCommand(cmd: UiCommand) {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac

      if (cmd.kind === 'reset') {
        setState(INITIAL)
        return
      }

      const el = resolveTarget(cmd.target)
      if (!el) {
        // eslint-disable-next-line no-console
        console.warn('[foreman] cursor target not found:', cmd.target)
        return
      }

      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      await sleep(120, ac.signal)

      const dest = centerOf(el)
      setState(prev => {
        const from = prev.visible ? prev : { ...prev, x: dest.x + 200, y: dest.y + 120 }
        return { visible: true, x: dest.x, y: dest.y, clicking: false, targetId: cmd.target }
      })

      // Wait for the CSS transition to finish before committing the click.
      await sleep(moveDuration(200, 120), ac.signal)

      if (cmd.kind === 'click') {
        setState(prev => ({ ...prev, clicking: true }))
        await sleep(180, ac.signal)
        el.click()
        setState(prev => ({ ...prev, clicking: false }))
      } else if (cmd.kind === 'highlight') {
        const ms = cmd.ms ?? 900
        el.classList.add('foreman-target-highlight')
        try {
          await sleep(ms, ac.signal)
        } finally {
          el.classList.remove('foreman-target-highlight')
        }
      }
    }

    window.addEventListener('message', handler)
    return () => {
      window.removeEventListener('message', handler)
      abortRef.current?.abort()
    }
  }, [])

  if (!state.visible) return null

  return (
    <div
      aria-hidden
      className={`foreman-cursor${state.clicking ? ' foreman-cursor-clicking' : ''}`}
      style={{
        transform: `translate3d(${state.x}px, ${state.y}px, 0) translate(-50%, -50%)`,
        transition: `transform ${moveDuration(0, 0)}ms cubic-bezier(0.4, 0, 0.2, 1)`,
      }}
    >
      <svg width="28" height="28" viewBox="0 0 28 28">
        <defs>
          <radialGradient id="foreman-cursor-grad" cx="50%" cy="45%" r="55%">
            <stop offset="0%" stopColor="var(--ds-accent, #4a90e2)" stopOpacity="0.95" />
            <stop offset="60%" stopColor="var(--ds-accent, #4a90e2)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--ds-accent, #4a90e2)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="14" cy="14" r="13" fill="url(#foreman-cursor-grad)" />
        <circle
          cx="14"
          cy="14"
          r="4"
          fill="var(--ds-accent, #4a90e2)"
        />
      </svg>
    </div>
  )
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
