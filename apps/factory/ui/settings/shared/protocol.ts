// Floor work-stream protocol — the typed contract between the React surface and
// whichever host backs it (VS Code extension today, Electron main next). This is
// the FLOOR subset of the full webview message set: exactly what a standalone
// work-stream app must satisfy. Terminal-tab management, the custom editor, and
// install flows stay VS-Code-only and are intentionally excluded here.
//
// Types only — no runtime. Both hosts import this to stay honest about the shape
// of every floor message; new floor features add a variant here first.

// Managed-projects contract lives in floorModel (the webview view-model); type-only
// import so protocol stays runtime-free and the host mirrors these shapes field-for-field.
import type { ManagedProject, LinearProjectLite } from '../components/mission-control/floorModel'

// ---- inbound: renderer -> host ------------------------------------------------

export type FloorInbound =
  | { type: 'ready' }
  | { type: 'subscribeFloor' }
  | { type: 'unsubscribeFloor' }
  | { type: 'fetchTasks'; limit?: number }
  | { type: 'fetchAllTerminals' }
  | { type: 'fetchUnifiedTasks' }
  | { type: 'detectTaskSources' }
  | { type: 'getFloorThroughput' }
  /**
   * Fleet host sessions. `force: true` runs one bare `agents sessions --active
   * --json`. Omit force (or false) to receive last-good immediately without a
   * fleet CLI call once a snapshot exists. The manual freshness chip passes
   * force:true; the panel-visible one-shot seed omits it.
   */
  | { type: 'fetchHostSessions'; force?: boolean }
  /** Local sessions only. `force` bypasses the 60s local-only backstop. */
  | { type: 'fetchLocalSessions'; force?: boolean }
  | { type: 'fetchHostSessionDetail'; host: string; sessionId: string }
  | { type: 'fetchDispatchData' }
  | { type: 'dismissTask'; taskId: string }
  // Focus a session: open/attach a real terminal on it (`agents sessions focus <id>`).
  | { type: 'focusSession'; sessionId: string; host?: string }
  // Stop a background (headless) run by killing its pid.
  | { type: 'stopSession'; sessionId: string; pid?: number }
  // Managed projects (curated sidebar list + Projects pane).
  | { type: 'fetchManagedProjects' }
  | { type: 'saveManagedProject'; project: ManagedProject } // id present & already exists -> edit; else add
  | { type: 'deleteManagedProject'; id: string }
  | { type: 'pickProjectFolder' } // host opens a native folder picker
  | { type: 'fetchLinearProjects' }

export type FloorInboundType = FloorInbound['type']

// ---- outbound: host -> renderer ----------------------------------------------

export type FloorOutbound =
  | { type: 'panelVisibility'; visible: boolean }
  | { type: 'tasksData'; tasks: unknown[] }
  | { type: 'allTerminalsData'; terminals: unknown[] }
  | { type: 'unifiedTasksData'; tasks: unknown[]; cycleInfo: unknown | null }
  | { type: 'taskSourcesData'; sources: { linear: boolean; github: boolean } }
  | { type: 'floorThroughputData'; tokensPerSec: number }
  | { type: 'cloudSummaryUpdate'; executionId: string; summary: string; status: string }
  | {
      type: 'hostSessions'
      hosts: unknown
      sessions: unknown
      groups: unknown
      fetchedAt: unknown
      /** Per-host last successful fetch epoch ms (optional freshness). */
      hostFreshness?: Record<string, number>
      /** True when served from last-good without a fresh fleet CLI call. */
      fromCache?: boolean
    }
  | {
      type: 'localSessions'
      sessions: unknown
      fetchedAt: unknown
      fromCache?: boolean
    }
  | { type: 'hostSessionDetail'; host: string; sessionId: string; markdown?: string; error?: string }
  | { type: 'dispatchData'; agents: unknown[]; hosts: unknown[]; targets: unknown[] }
  | { type: 'updateRunningCounts'; counts: unknown }
  // Managed projects (curated sidebar list + Projects pane).
  | { type: 'managedProjectsData'; projects?: ManagedProject[]; error?: string }
  | { type: 'linearProjectsData'; projects: LinearProjectLite[] }
  | { type: 'projectFolderPicked'; path: string; repoSlug?: string; name: string; suggestedLinear?: LinearProjectLite }

export type FloorOutboundType = FloorOutbound['type']
