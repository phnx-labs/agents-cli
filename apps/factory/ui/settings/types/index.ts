// Agent settings types
export interface BuiltInAgentSettings {
  login: boolean
  instances: number
  defaultModel?: string
}

export interface CustomAgentSettings {
  name: string
  command: string
  login: boolean
  instances: number
}

export interface CommandAlias {
  name: string
  agent: string
  flags: string
}

// Quick launch slot for keyboard shortcuts (Cmd+Shift+0..9)
export interface QuickLaunchSlot {
  agent: string
  version?: string
  mode?: 'plan' | 'edit'
  model?: string
  modelAlias?: string
  extraFlags?: string
  label?: string
}

export interface QuickLaunchConfig {
  slots?: Record<string, QuickLaunchSlot>
  slot1?: QuickLaunchSlot
  slot2?: QuickLaunchSlot
  slot3?: QuickLaunchSlot
}

export const QUICK_LAUNCH_SLOT_KEYS = ['0','1','2','3','4','5','6','7','8','9'] as const
export type QuickLaunchSlotKey = typeof QUICK_LAUNCH_SLOT_KEYS[number]

export function getQuickLaunchSlot(
  config: QuickLaunchConfig | undefined,
  key: QuickLaunchSlotKey,
): QuickLaunchSlot | undefined {
  if (!config) return undefined
  const direct = config.slots?.[key]
  if (direct) return direct
  if (key === '1') return config.slot1
  if (key === '2') return config.slot2
  if (key === '3') return config.slot3
  return undefined
}

export function setQuickLaunchSlotInConfig(
  config: QuickLaunchConfig | undefined,
  key: QuickLaunchSlotKey,
  slot: QuickLaunchSlot | undefined,
): QuickLaunchConfig {
  const next: QuickLaunchConfig = {
    ...(config || {}),
    slots: { ...(config?.slots || {}) },
  }
  delete next.slot1
  delete next.slot2
  delete next.slot3
  if (slot) {
    next.slots![key] = slot
  } else {
    delete next.slots![key]
  }
  return next
}

export type SwarmAgentType = 'claude' | 'codex' | 'gemini' | 'opencode'
export type PromptPackAgentType = 'claude' | 'codex' | 'gemini' | 'cursor'

// Skills types
export type SkillName =
  | 'plan'
  | 'splan'
  | 'debug'
  | 'sdebug'
  | 'sconfirm'
  | 'clean'
  | 'sclean'
  | 'test'
  | 'stest'
  | 'ship'
  | 'sship'
  | 'recap'
  | 'srecap'
  | 'simagine'

export interface SkillAgentStatus {
  installed: boolean
  cliAvailable: boolean
  builtIn: boolean
  supported: boolean
}

export interface SkillCommandStatus {
  name: SkillName
  description: string
  agents: Record<PromptPackAgentType, SkillAgentStatus>
}

export interface SkillsStatus {
  commands: SkillCommandStatus[]
}

// Watchdog playbook (user-editable house rules appended to the built-in
// watchdog prompt). Source file: ~/.agents/playbooks/watchdog.md.
export interface WatchdogPlaybookStatus {
  exists: boolean
  lines: number
  mtimeMs: number
}

// Prompt types
export interface PromptEntry {
  id: string
  title: string
  content: string
  isFavorite: boolean
  createdAt: number
  updatedAt: number
  accessedAt: number
}

// Task types. UnifiedTask / TaskMetadata / TaskComment / TaskSource are canonical
// in src/shared/tasks.ts and imported here via @shared — the SAME definition the
// extension host uses, so a field (e.g. Linear `project`) can never be present on
// one side of the postMessage boundary and missing on the other.
export type { TaskSource, UnifiedTask, TaskMetadata, TaskComment } from '@shared/tasks'

export interface TaskSourceSettings {
  linear: boolean
  github: boolean
  githubAssignedOnly: boolean
}

export interface CycleInfo {
  name: string
  startsAt: string
  endsAt: string
}

// Settings types
export interface EditorPreferences {
  markdownViewerEnabled: boolean
}

export interface DisplayPreferences {
  showFullAgentNames: boolean
  showLabelsInTitles: boolean
  autoLabelInTabTitles: boolean
  showSessionIdInTitles: boolean
  labelReplacesTitle: boolean
  showLabelOnlyOnFocus: boolean
}

export interface NotificationSettings {
  enabled: boolean
  style: 'native' | 'vscode'
  enabledAgents: string[]
}

// Ordered cwd->project mapping for Factory Floor grouping.
// Canonical in src/shared/project.ts (shared with the host via @shared) — imported
// for local use (AgentSettings.projectRules below) + re-exported for consumers.
import type { ProjectRule } from '@shared/project'
export type { ProjectRule }

export interface AgentSettings {
  builtIn: {
    claude: BuiltInAgentSettings
    codex: BuiltInAgentSettings
    gemini: BuiltInAgentSettings
    opencode: BuiltInAgentSettings
    cursor: BuiltInAgentSettings
    shell: BuiltInAgentSettings
    antigravity: BuiltInAgentSettings
    grok: BuiltInAgentSettings
    kimi: BuiltInAgentSettings
    droid: BuiltInAgentSettings
  }
  custom: CustomAgentSettings[]
  aliases: CommandAlias[]
  quickLaunch?: QuickLaunchConfig
  swarmEnabledAgents: SwarmAgentType[]
  prompts: PromptEntry[]
  editor: EditorPreferences
  display: DisplayPreferences
  notifications?: NotificationSettings
  showWelcomeScreen: boolean
  taskSources: TaskSourceSettings
  githubOwner?: string
  projectRules?: ProjectRule[]
}

// Running counts
export interface RunningCounts {
  claude: number
  codex: number
  gemini: number
  opencode: number
  cursor: number
  shell: number
  custom: Record<string, number>
}

// Agent status types
export interface AgentInstallStatus {
  installed: boolean
  cliAvailable: boolean
  mcpEnabled: boolean
  commandInstalled: boolean
}

export interface SwarmStatus {
  agentsCliAvailable: boolean
  agentsCliVersion: string | null
  mcpEnabled: boolean
  commandInstalled: boolean
  agents: {
    claude: AgentInstallStatus
    codex: AgentInstallStatus
    gemini: AgentInstallStatus
    opencode: AgentInstallStatus
  }
}

export type AgentRunStrategy = 'pinned' | 'available' | 'balanced'

export interface AgentInventoryVersion {
  version: string
  isDefault: boolean
  signedIn: boolean
  email: string | null
  plan: string | null
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null
  sessionUsedPercent: number
  lastActive: string | null
  path: string
}

export interface AgentInventory {
  agent: string
  strategy: AgentRunStrategy
  defaultVersion: string | null
  defaultAccount: string | null
  defaultPlan: string | null
  signedInCount: number
  healthyCount: number
  canRotate: boolean
  versions: AgentInventoryVersion[]
}

// A DotAgents resource repo (user / system / project / alias) as surfaced by
// `agents inspect <target> --json`, with capability counts per kind.
export interface AgentResourceRepo {
  repo: string
  root: string
  counts: {
    commands: number
    skills: number
    hooks: number
    mcp: number
    rules: number
    plugins: number
    workflows: number
    subagents: number
  }
  git?: {
    branch?: string
    ahead?: number
    behind?: number
    dirty?: number
  }
}

// Agent detail types (from swarm)
export interface AgentDetail {
  agent_id: string
  agent_type: string
  status: string
  duration: string | null
  started_at: string
  completed_at: string | null
  prompt: string
  cwd: string | null
  mode?: string
  files_created: string[]
  files_modified: string[]
  files_deleted: string[]
  bash_commands: string[]
  last_messages: string[]
  cloud_session_id?: string | null
  cloud_provider?: string | null
  pr_url?: string | null
  ci_status?: 'passed' | 'failed' | 'running' | null
  repo_owner?: string | null
  repo_name?: string | null
  cloud_summary?: string | null
  branch?: string | null
  linear_issue?: string | null
  attachments?: SessionAttachment[]
  // Factory metadata (Step 2: teams add --task-type flag).
  // When set, the UI shows a task-type badge and can group DAG waves.
  task_type?: 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs' | null
  name?: string | null
  after?: string[]
}

export type ApprovalStatus = 'pending' | 'approved' | 'running' | 'complete' | 'rejected'

export interface TaskSummary {
  task_name: string
  agent_count: number
  status_counts: { running: number; completed: number; failed: number; stopped: number }
  latest_activity: string
  agents: AgentDetail[]
  approval_status?: ApprovalStatus
  mix?: string
}

export interface SessionQuickSummary {
  filesEdited: number
  filesRead: number
  filesCreated: number
  filesDeleted: number
  toolCalls: number
  webSearches: number
  webFetches: number
  mcpCalls: number
}

export interface RecentToolCall {
  name: string
  input?: unknown
  output?: string
  isError?: boolean
  timestamp?: string
}

export interface SessionAttachment {
  path: string
  label: string
  mediaType: string
  sizeBytes?: number
  thumbnailUri?: string
}

// Terminal types
export interface TerminalDetail {
  id: string
  agentType: string
  label: string | null
  autoLabel: string | null
  createdAt: number
  index: number
  sessionId: string | null
  firstUserMessage?: string
  lastUserMessage?: string
  status?: 'running' | 'completed' | 'idle'
  messageCount?: number
  firstMessageTimestamp?: string
  lastActivityTimestamp?: string
  currentActivity?: string
  quickSummary?: SessionQuickSummary
  recentFiles?: string[]
  recentFileTimes?: Record<string, number>
  recentTools?: string[]
  recentToolCalls?: RecentToolCall[]
  attachments?: SessionAttachment[]
  lastFilePath?: string | null
  narrative?: string
  cwd?: string | null
  branch?: string | null
  recentFileStats?: Record<string, { added: number; removed: number }>
  waitingForInput?: boolean
  approvalStatus?: ApprovalStatus
  role?: string
  hint?: string
  isParent?: boolean
  parentId?: string | null
  parentLabel?: string | null
  children?: string[]
}

// Session types
export interface AgentSession {
  agentType: 'claude' | 'codex' | 'gemini'
  sessionId: string
  timestamp: string
  path: string
  preview?: string
}

// Context types
export type ContextAgentType = 'claude' | 'gemini' | 'codex' | 'agents' | 'cursor' | 'opencode' | 'unknown'

export interface ContextFile {
  path: string
  agent: ContextAgentType
  preview: string
  lines: number
  isSymlink: boolean
  symlinkTarget?: string
}

// UI types
export type TabId = 'floor' | 'bench' | 'panel'

export type ThemedIcon = { dark: string; light: string }

// VSCode API type
export interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

// Icon config type
export interface IconConfig {
  claude: string
  codex: ThemedIcon
  gemini: string
  opencode: string
  cursor: ThemedIcon
  agents: string
  shell: string
  github: string
  antigravity: string
  grok: ThemedIcon
  kimi: string
  droid: ThemedIcon
}

// Built-in agent config
export interface BuiltInAgentConfig {
  key: string
  name: string
  icon: string | ThemedIcon
}

// Prewarm pool types
export interface PrewarmPool {
  agentType: string
  available: number
  pending: number
}

// Workspace config types
export interface ContextMapping {
  source: string
  aliases: string[]
}

export interface WorkspaceConfig {
  context: ContextMapping[]
}
