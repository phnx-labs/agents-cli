// HostBridge — the single seam that lets the same React surface run in the VS
// Code webview AND in a standalone Electron window.
//
// The webview talks to its backend over a message channel. Today that backend is
// the VS Code extension host, reached via the injected acquireVsCodeApi(). To run
// the identical UI in Electron, only the OUTBOUND path needs abstracting: an
// Electron preload exposes window.swarmHost.post() and re-emits host->renderer
// messages as ordinary window 'message' events — the same channel the webview
// already listens on. So inbound stays untouched (every existing
// window.addEventListener('message', ...) keeps working under both hosts) and
// only the post() side is routed through the bridge.

import type { VsCodeApi } from '../types'

export interface HostBridge {
  post(message: unknown): void
  onMessage(handler: (message: unknown) => void): () => void
}

declare function acquireVsCodeApi(): VsCodeApi

interface SwarmHost {
  post(message: unknown): void
}

export type HostKind = 'electron' | 'vscode' | 'none'

// Pure host-selection decision, split out so it can be unit-tested without a DOM.
// Electron wins when its preload bridge is present; otherwise fall back to the
// VS Code webview API; 'none' means neither is available (a bug / bare browser).
export function selectHostKind(hasSwarmHost: boolean, hasAcquireVsCodeApi: boolean): HostKind {
  if (hasSwarmHost) return 'electron'
  if (hasAcquireVsCodeApi) return 'vscode'
  return 'none'
}

function windowMessageSubscription(handler: (message: unknown) => void): () => void {
  const listener = (e: MessageEvent) => handler(e.data)
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

let bridge: HostBridge | null = null

export function resolveBridge(): HostBridge {
  if (bridge) return bridge

  const swarmHost = (window as unknown as { swarmHost?: SwarmHost }).swarmHost
  const hasAcquire = typeof acquireVsCodeApi !== 'undefined'
  const kind = selectHostKind(!!swarmHost && typeof swarmHost.post === 'function', hasAcquire)

  if (kind === 'electron' && swarmHost) {
    bridge = { post: (m) => swarmHost.post(m), onMessage: windowMessageSubscription }
    return bridge
  }
  if (kind === 'vscode') {
    const api = acquireVsCodeApi()
    bridge = { post: (m) => api.postMessage(m), onMessage: windowMessageSubscription }
    return bridge
  }
  throw new Error('HostBridge: no host detected (neither Electron swarmHost nor VS Code acquireVsCodeApi)')
}
