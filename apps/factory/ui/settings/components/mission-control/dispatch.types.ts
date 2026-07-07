// Consolidated Dispatch panel — shared webview contract.
//
// Authored up front so the parallel workstreams build against a stable seam:
//   - dispatch-ui fills DispatchPanel + sub-components against these types.
//   - floor-ui uses the plan/failure types.
//   - integrator wires the panel + the postMessage shapes below into
//     UnifiedAgentsPane.tsx.
//   - backend-* implement the extension-host side of the SAME message shapes.
//
// Design source of truth (vendored in this branch):
//   extension/docs/prototypes/dispatch.html  (the interactive spec — match it 1:1)
//   extension/docs/prototypes/DESIGN.md       ("Dispatch panel" section)
// Field names mirror the prototype's `S` state object so the port is a translation.

export type DispatchMode = 'plan' | 'auto' | 'edit'
export type WatchdogPolicy = 'off' | 'keep' | 'handsoff'
export type HostKind = 'local' | 'remote' | 'cloud'
export type HostLoad = 'idle' | 'free' | 'busy' | 'hot' | 'off'

/** An installed agent (from `agents view --json` via agentInventory). Only agents
 *  with an installed version appear; `signedIn` gates whether it can run. */
export interface InstalledAgent {
  id: string          // 'claude' | 'codex' | 'kimi' | 'opencode' | 'antigravity' | 'grok' | 'droid'
  name: string        // 'Claude'
  color: string       // brand color for the pill dot
  signedIn: boolean
  version: string
  isDefault: boolean
}

/** A place to run, unified across local machine / remote SSH / cloud, with LIVE load. */
export interface DispatchHost {
  id: string          // 'this-mac' | remote hostname | 'rush' | 'codex'
  label: string
  kind: HostKind
  online: boolean
  agents: number      // agents currently running on this host (session-index count)
  load: HostLoad      // derived from CPU + agent count; 'off' when offline
  uses: number        // lifetime usage (ranking tiebreak)
  costHint?: string   // cloud only, e.g. "~$0.40/run"
}

/** A local project (working dir) or a cloud repo, ranked by session-index usage. */
export interface DispatchTarget {
  id: string          // project slug or "owner/repo"
  label: string
  path?: string       // local dir (absolute-ish); omitted for cloud repos
  uses: number
  confidence?: 'high' | 'medium' | 'low'
  linearProject?: string   // linked Linear project NAME — drives the pill + auto-select match
}

export interface DispatchAttachment {
  type: 'image' | 'file'
  name: string
  /** opaque ref the backend resolves (clipboard temp path, dropped file path). */
  ref?: string
}

export interface NotifyPrefs {
  events: { stall: boolean; question: boolean; plan: boolean; finish: boolean; fail: boolean }
  channel: 'imessage' | 'slack' | 'desktop'
  dnd: boolean
}

/** The single payload the DispatchPanel emits — replaces the scattered dispatchTask args. */
export interface DispatchRequest {
  prompt: string
  ticketIds: string[]            // attached ticket identifiers (may be empty)
  attachments: DispatchAttachment[]
  agent: string                  // InstalledAgent.id
  runOn: string                  // DispatchHost.id (cloud id implies cloud)
  project?: string               // local dir id — REQUIRED for local hosts (never $HOME)
  repo?: string                  // cloud repo id — for cloud hosts
  branch?: string
  mode: DispatchMode
  watchdog: WatchdogPolicy
  notify: NotifyPrefs
  batch: 'all' | 'per'           // when ticketIds.length > 1: one agent for all, or one per ticket
}

// ---- plan-review / failure (Floor after-dispatch) ----

export interface PlanStep { n: number; text: string }
export interface PendingPlan {
  sessionId: string
  agentId: string           // FloorAgent id
  steps: PlanStep[]
}

// ---------------------------------------------------------------------------
// postMessage CONTRACT (both webview and extension host implement these exactly)
//
//   webview -> ext:
//     { type: 'fetchDispatchData' }
//     { type: 'dispatch', request: DispatchRequest }       // the unified dispatch
//     { type: 'approvePlan', sessionId, edited?: PlanStep[] }
//     { type: 'sendBackPlan', sessionId, note: string }
//     { type: 'reassignAgent', sessionId, toAgent: string }
//     { type: 'nudgeAgent', sessionId }
//
//   ext -> webview:
//     { type: 'dispatchData', agents: InstalledAgent[], hosts: DispatchHost[], targets: DispatchTarget[] }
//     { type: 'planReady', plan: PendingPlan }
//     (host load rides on the EXISTING 'hostSessions' message — backend-data widens
//      its `hosts` entries with agents/load/uses; see remoteSessions HostInfo.)
// ---------------------------------------------------------------------------
