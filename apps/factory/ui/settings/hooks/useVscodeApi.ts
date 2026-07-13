import type { VsCodeApi, IconConfig } from '../types'
import { resolveBridge } from '../host/bridge'

// Create singleton instance
let vscodeInstance: VsCodeApi | null = null

/**
 * Get the host API instance (singleton).
 *
 * Named for history; it now routes through the HostBridge, so the same call
 * works under both the VS Code webview and the standalone Electron host. State
 * getters are no-ops — nothing in the webview persists through the VS Code state
 * API (all durable state lives host-side and is re-sent on the ready handshake).
 */
export function getVsCodeApi(): VsCodeApi {
  if (!vscodeInstance) {
    const bridge = resolveBridge()
    vscodeInstance = {
      postMessage: (message: unknown) => bridge.post(message),
      getState: () => undefined,
      setState: () => {},
    }
  }
  return vscodeInstance
}

/**
 * Get icons from window global
 */
export function getIcons(): IconConfig {
  return (window as unknown as { __ICONS__: IconConfig }).__ICONS__
}

/**
 * Post a message to the VS Code extension
 */
export function postMessage(message: unknown): void {
  getVsCodeApi().postMessage(message)
}

// Common message types for type-safe messaging
export type VsCodeMessageType =
  | 'ready'
  | 'saveSettings'
  | 'spawnAgent'
  | 'fetchTasks'
  | 'fetchTasksBySession'
  | 'fetchUnifiedTasks'
  | 'detectTaskSources'
  | 'fetchSessions'
  | 'fetchContextFiles'
  | 'fetchAgentTerminals'
  | 'checkInstalledAgents'
  | 'fetchAgentModels'
  | 'getDefaultAgent'
  | 'getSecondaryAgent'
  | 'setDefaultAgent'
  | 'setSecondaryAgent'
  | 'getPrewarmStatus'
  | 'togglePrewarm'
  | 'getWorkspaceConfig'
  | 'openContextFile'
  | 'openTerminalFile'
  | 'openPlanPreview'
  | 'openSession'
  | 'spawnAgentForTask'
  | 'installSwarmAgent'
  | 'installCommandPack'
  | 'quickSpawn'
  | 'subscribeFloor'
  | 'unsubscribeFloor'
  | 'fetchAgentResources'
