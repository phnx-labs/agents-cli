import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskSummary, TerminalDetail as TerminalInfo, AgentDetail, UnifiedTask, RecentToolCall, ProjectRule } from '../../types'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './icons'
import { relTime, taskNameToTitle, swarmOverallStatus, shortDuration } from './types'
import { postMessage, usePanelVisibility } from '../../hooks'
import { ExtLink } from '../common'
import { renderTodoDescription, renderMarkdown } from '../../utils/markdown'
import { CMD_PALETTE_EVENTS } from './CommandPalette'
import { CloudActivityFeed } from './CloudActivityFeed'
import { VerticalTimeline } from './Timeline'
import { TerminalExpandedDetail } from './TerminalDetail'
import { useNow } from './useNow'
import {
  isTerminalActive,
  isTerminalJustSpawned,
  reconcilePending,
  pruneExpiredPending,
  markTimedOutPending,
  markCloudFailedPending,
  filterDispatchedTaskIds,
  optimisticActivityLabel,
  PENDING_DISPATCH_TTL_MS,
  type PendingDispatch,
} from './dispatch'
import { FloorControls, floorControlsMode, type StatusChip } from './FloorControls'
import { FloorSidebar } from './FloorSidebar'
import { FloorRail } from './FloorRail'
import { FloorSubtabs, openTaskTab, closeTaskTab, type FixedTab, type TaskTab } from './FloorSubtabs'
import { BacklogCenter } from './BacklogCenter'
import { PrBoardPane } from './PrBoardPane'
import { buildPrBoard, collectPrUrls, type PrStatusLike } from './prBoardModel'
import { RecapPane } from './RecapPane'
import { buildRecap } from './recapModel'
import { TaskDetail } from '../bench/TaskDetail'
import type { FlatTask } from '../bench/TaskCard'
import { TicketDetail } from './TicketDetail'
import { HostDetail } from './HostDetail'
import { ProjectsPane } from './ProjectsPane'
import { FeedItem, FollowUpBox } from './FeedItem'
import { NeedsYouClusters } from './NeedsYouClusters'
import { AgentDecision } from './AgentDecision'
import {
  clusterByQuestion,
  sortAgents,
  groupAgents,
  sessionTaskLine,
  ticketWorkers,
  projectRollups,
  type FloorAgent,
  type FloorTicket,
  type CenterMode,
  type HostInventory,
  type FloorGroupBy,
  type FloorSort,
  type TicketGroupBy,
  type TicketSort,
  type TicketSource,
  type AgentAbbr,
  type CiStatus,
  type ManagedProject,
  type LinearProjectLite,
  linearIssueLabel,
  linearIssueUrl,
} from './floorModel'
import { SavedViews } from './SavedViewsBar'
import { loadSavedViews, persistSavedViews, upsertView, removeView, viewMatches, type SavedView } from './savedViews'
import { adaptUnified, adaptRemote, adaptTickets, sinceFromMs, type RemoteSessionLike } from './floorAdapter'
import type { PlanFile } from '../../utils/planDetector'
import {
  DispatchPanel,
  type DispatchDevice,
  type DispatchDeviceRepo,
  type DispatchDeviceSync,
  type DeviceDispatchRequest,
  type DraftResult,
  type DraftTicketPayload,
} from './DispatchPanel'
import { PlanReview } from './PlanReview'
import { FailureCard } from './FailureCard'
import { ticketKey } from './dispatchInput'
import type {
  InstalledAgent, DispatchHost, DispatchTarget, DispatchRequest, PendingPlan, PlanStep,
} from './dispatch.types'

// ---------- Floor shell persisted prefs ----------

const FLOOR_PREFS_KEY = 'swarmify.floorPrefs.v1'

// Two-tier refresh of cross-host sessions. Local (this-mac, no SSH) is cheap → fast;
// the remote SSH fan-out is expensive → slow. Both are visibility-gated. Local tab
// agents already stream via the extension's fs.watch push, so these only drive the
// remote + cross-window rows that the one-shot mount fetch used to leave frozen.
const LOCAL_POLL_MS = 3_000
const REMOTE_POLL_MS = 45_000

interface FloorPrefs {
  plain: boolean
  sidebar: boolean
  // Collapsed icon rail (true, the default) vs the full text sidebar.
  rail: boolean
  right: boolean
  pinned: string[]
  // Ordered pinned host names for the HOSTS sidebar. null = never customized
  // (the local machine is pinned by default); [] = user explicitly unpinned all.
  hostPins: string[] | null
}

function defaultFloorPrefs(): FloorPrefs {
  return { plain: false, sidebar: true, rail: true, right: true, pinned: [], hostPins: null }
}

function loadFloorPrefs(): FloorPrefs {
  try {
    const raw = localStorage.getItem(FLOOR_PREFS_KEY)
    if (!raw) return defaultFloorPrefs()
    return { ...defaultFloorPrefs(), ...JSON.parse(raw) }
  } catch {
    return defaultFloorPrefs()
  }
}

function saveFloorPrefs(p: FloorPrefs): void {
  try { localStorage.setItem(FLOOR_PREFS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

const NEW_AGENT_MENU: Array<{ agent: string; name: string; abbr: string; keys: string[] }> = [
  { agent: 'claude', name: 'Claude', abbr: 'CC', keys: ['Cmd', 'Shift', 'A'] },
  { agent: 'codex', name: 'Codex', abbr: 'CX', keys: ['Cmd', 'Shift', 'B'] },
  { agent: 'gemini', name: 'Gemini', abbr: 'GX', keys: ['Cmd', 'Shift', 'X'] },
  { agent: 'opencode', name: 'OpenCode', abbr: 'OC', keys: ['Cmd', 'Shift', 'M'] },
  { agent: 'cursor', name: 'Cursor', abbr: 'CR', keys: ['Cmd', 'Shift', 'U'] },
]

type FilterTab = 'all' | 'terminal' | 'cloud' | 'team'

type FactoryTaskType = 'plan' | 'implement' | 'test' | 'review' | 'bugfix' | 'docs'

function compactHumanLabel(text: string | null | undefined): string {
  const line = (text || '').split('\n').map((l) => l.trim()).find(Boolean) || ''
  return line.replace(/^#+\s+/, '').replace(/^[-*+]\s+/, '').replace(/[*_`]/g, '').slice(0, 72).trim()
}

export interface WatchdogEventUI {
  ts: number
  kind: 'tick' | 'decision' | 'nudge' | 'rotate' | 'error'
  terminalId?: string
  agentType?: string
  message: string
  reason?: string
  tailLines?: string[]
  stalledForMs?: number
  lastUserMessage?: string
  lastAssistantMessage?: string
  nudgeText?: string
}

interface UnifiedAgent {
  kind: 'terminal' | 'headless' | 'cloud' | 'team' | 'watchdog'
  id: string
  agentType: string
  displayName: string
  sessionId?: string
  activity: string
  active: boolean
  duration: string
  timestamp: string
  prUrl?: string | null
  ci?: CiStatus | null
  cloudProvider?: string | null
  terminal?: TerminalInfo
  swarm?: TaskSummary
  agent?: AgentDetail
  teamAgents?: AgentDetail[]
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'idle'
  files: string[]
  toolCalls: number
  linearIssue?: string | null
  mode?: string
  // Factory metadata surfaced as badges in the UI
  taskType?: FactoryTaskType | null
  teammateName?: string | null
  /** For team rows, a roll-up count of task-types across members. */
  taskTypeCounts?: Partial<Record<FactoryTaskType, number>>
  // Watchdog-specific
  watchdogEvents?: WatchdogEventUI[]
}

function buildUnifiedList(terminals: TerminalInfo[], tasks: TaskSummary[]): UnifiedAgent[] {
  const items: UnifiedAgent[] = []

  const now = Date.now()
  for (const t of terminals) {
    const justSpawned = isTerminalJustSpawned(t.createdAt, now)
    const isActive = isTerminalActive(t, now)
    const files: string[] = []
    if (t.recentFiles) files.push(...t.recentFiles.slice(0, 5))
    // Prefer a human label (manual > auto) so a card reads "terminal-race-fix" rather
    // than "claude-596c4c07"; the full session id stays available on hover.
    const humanLabel = compactHumanLabel(t.label) || compactHumanLabel(t.autoLabel) || compactHumanLabel(t.firstUserMessage)
    items.push({
      kind: 'terminal',
      id: `term-${t.id}`,
      agentType: t.agentType,
      sessionId: t.sessionId ?? undefined,
      displayName: humanLabel || `${t.agentType} session`,
      activity: t.currentActivity || t.label || (justSpawned ? 'Starting...' : t.status === 'idle' ? 'idle' : t.role ?? 'terminal'),
      active: isActive,
      duration: t.firstMessageTimestamp ? relTime(t.firstMessageTimestamp) : '',
      timestamp: t.lastActivityTimestamp || new Date(t.createdAt).toISOString(),
      terminal: t,
      status: isActive ? 'running' : 'idle',
      files,
      toolCalls: t.quickSummary?.toolCalls ?? 0,
      mode: t.role || 'auto',
    })
  }

  for (const task of tasks) {
    const isTeam = task.agents.length > 1
    const isActive = task.status_counts.running > 0

    if (isTeam) {
      const status = swarmOverallStatus(task)
      const pr = task.agents.map((a) => a.pr_url).find(Boolean)
      const dur = task.agents.map((a) => a.duration).find(Boolean)
      const allFiles = task.agents.flatMap((a) => [...(a.files_created || []), ...(a.files_modified || [])]).slice(0, 6)
      const totalTools = task.agents.reduce((s, a) => s + (a.bash_commands?.length || 0), 0)
      const linear = task.agents.map((a) => a.linear_issue).find(Boolean)
      const taskTypeCounts: Partial<Record<FactoryTaskType, number>> = {}
      for (const a of task.agents) {
        const tt = a.task_type as FactoryTaskType | null | undefined
        if (tt) taskTypeCounts[tt] = (taskTypeCounts[tt] ?? 0) + 1
      }
      items.push({
        kind: 'team',
        id: `team-${task.task_name}`,
        agentType: task.agents[0]?.agent_type ?? 'claude',
        displayName: taskNameToTitle(task.task_name),
        activity: `${task.agent_count} agents`,
        active: isActive,
        duration: dur || '',
        timestamp: task.latest_activity,
        prUrl: pr,
        ci: task.agents.map((a) => a.ci_status).find((c) => c != null) ?? null,
        swarm: task,
        teamAgents: task.agents,
        status: status === 'merged' ? 'completed' : status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'idle',
        files: allFiles,
        toolCalls: totalTools,
        linearIssue: linear,
        taskTypeCounts,
      })
    } else if (task.agents.length === 1) {
      const a = task.agents[0]
      const isCloud = a.mode === 'cloud' || !!a.cloud_provider
      const lastCmd = a.bash_commands?.[a.bash_commands.length - 1]
      const lastFile = a.files_modified?.[a.files_modified.length - 1]
      const lastMsg = a.last_messages?.[a.last_messages.length - 1]
      const promptFirstLine = a.prompt?.split('\n')[0]?.slice(0, 120) || ''
      const activity = isCloud
        ? (promptFirstLine || 'cloud run')
        : (lastCmd ? `$ ${lastCmd}` : lastFile ? `Editing ${lastFile}` : lastMsg ? lastMsg.slice(0, 120) : promptFirstLine || 'working...')
      const allFiles = [...(a.files_created || []), ...(a.files_modified || [])].slice(0, 6)
      items.push({
        kind: isCloud ? 'cloud' : 'headless',
        id: `agent-${a.agent_id}`,
        agentType: a.agent_type,
        displayName: a.name?.trim() || promptFirstLine || taskNameToTitle(task.task_name),
        activity,
        active: a.status === 'running',
        duration: a.duration || '',
        timestamp: a.started_at,
        prUrl: a.pr_url,
        ci: a.ci_status ?? null,
        cloudProvider: a.cloud_provider,
        agent: a,
        swarm: task,
        status: a.status as UnifiedAgent['status'],
        files: allFiles,
        toolCalls: a.bash_commands?.length || 0,
        linearIssue: a.linear_issue,
        mode: a.mode,
        taskType: (a.task_type as FactoryTaskType | null | undefined) ?? null,
        teammateName: a.name ?? null,
      })
    }
  }

  items.sort((a, b) => {
    if (a.active && !b.active) return -1
    if (!a.active && b.active) return 1
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  })

  return items
}

function kindBadge(kind: UnifiedAgent['kind']): string {
  switch (kind) {
    case 'terminal': return 'terminal'
    case 'headless': return 'headless'
    case 'cloud': return 'cloud'
    case 'team': return 'team'
    case 'watchdog': return 'watchdog'
  }
}

function statusLabel(status: UnifiedAgent['status']): string {
  return status
}

// Throughput counter -- live pulsing sparkline for LLM output tok/s
export function ThroughputCounter({ tokensPerSec }: { tokensPerSec: number }) {
  const BAR_COUNT = 24
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0))
  const [displayValue, setDisplayValue] = useState(tokensPerSec)

  useEffect(() => {
    if (tokensPerSec <= 0) {
      setBars(Array(BAR_COUNT).fill(0))
      setDisplayValue(0)
      return
    }

    const nextBar = () => {
      const variance = 0.5 + Math.random() * 1.0
      return Math.max(2, Math.min(22, (tokensPerSec * variance) / 70))
    }

    const tick = () => {
      setBars(prev => {
        const next = prev.slice(1)
        next.push(nextBar())
        return next
      })
      setDisplayValue(prev => {
        const target = tokensPerSec * (0.88 + Math.random() * 0.24)
        return Math.round(prev * 0.55 + target * 0.45)
      })
    }

    tick()
    const id = setInterval(tick, 140)
    return () => clearInterval(id)
  }, [tokensPerSec])

  return (
    <div className="sw-throughput" title="LLM output tokens per second (estimated)">
      <div className="sw-throughput-sparkline">
        {bars.map((h, i) => (
          <div key={i} className="sw-spark-bar" style={{ height: h }} />
        ))}
      </div>
      <div className="sw-throughput-value">{displayValue}</div>
      <div className="sw-throughput-unit">
        <span className="sw-throughput-label">tok/s</span>
        <span className="sw-throughput-sub">throughput</span>
      </div>
    </div>
  )
}

// Short PR label from a GitHub URL: https://github.com/org/repo/pull/123 → org/repo#123
function shortPrLabel(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i)
  if (m) return `${m[1]}/${m[2]}#${m[3]}`
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}`
  } catch {
    return url
  }
}

type StatPopoverKey = 'shipped' | 'open' | 'running' | 'nextup' | 'files'

function statPopoverTitle(key: StatPopoverKey): string {
  switch (key) {
    case 'shipped': return 'Shipped today'
    case 'open': return 'Open PRs'
    case 'running': return 'Running agents'
    case 'nextup': return 'Next up'
    case 'files': return 'Files today'
  }
}

function statPopoverEmptyLabel(key: StatPopoverKey): string {
  switch (key) {
    case 'shipped': return 'No PRs shipped yet'
    case 'open': return 'No open PRs'
    case 'running': return 'No running agents'
    case 'nextup': return 'Queue is empty'
    case 'files': return 'No files touched today'
  }
}

interface BuildRowsCtx {
  activeItems: UnifiedAgent[]
  queueTasks: UnifiedTask[]
  filesToday: string[]
  shippedPRs: Array<{ key: string; title: string; url: string; agentType: string; timestamp: string }>
  openPRs: Array<{ key: string; title: string; url: string; agentType: string; timestamp: string }>
  onOpenExternal: (url: string) => void
  onFocusTerminal: (terminalId: string) => void
  onOpenFile: (path: string) => void
}

function buildStatPopoverRows(key: StatPopoverKey, ctx: BuildRowsCtx): StatPopoverRow[] {
  switch (key) {
    case 'shipped':
    case 'open': {
      const prs = key === 'shipped' ? ctx.shippedPRs : ctx.openPRs
      return prs.map((pr) => ({
        key: pr.key,
        icon: <AgentAvatar id={pr.agentType} size={16} />,
        title: pr.title,
        subtitle: shortPrLabel(pr.url),
        onClick: () => ctx.onOpenExternal(pr.url),
      }))
    }
    case 'running': {
      return ctx.activeItems.map((item) => {
        const terminalId = item.kind === 'terminal' ? item.terminal?.id : undefined
        const action = terminalId
          ? () => ctx.onFocusTerminal(terminalId)
          : item.prUrl
            ? () => ctx.onOpenExternal(item.prUrl as string)
            : undefined
        return {
          key: item.id,
          icon: <AgentAvatar id={item.agentType} size={16} />,
          title: item.displayName,
          subtitle: item.activity.slice(0, 48),
          onClick: action,
          disabled: !action,
        }
      })
    }
    case 'nextup': {
      return ctx.queueTasks.map((task) => ({
        key: task.id,
        title: task.title,
        subtitle: task.metadata.identifier || undefined,
        onClick: task.metadata.url ? () => ctx.onOpenExternal(task.metadata.url as string) : undefined,
        disabled: !task.metadata.url,
      }))
    }
    case 'files': {
      return ctx.filesToday.map((path) => {
        const base = path.split('/').pop() || path
        const dir = path.slice(0, path.length - base.length).replace(/\/$/, '')
        return {
          key: path,
          title: base,
          subtitle: dir || undefined,
          onClick: () => ctx.onOpenFile(path),
        }
      })
    }
  }
}

interface StatPopoverRow {
  key: string
  icon?: React.ReactNode
  title: string
  subtitle?: string
  disabled?: boolean
  onClick?: () => void
}

function StatPopover({
  title,
  rows,
  emptyLabel,
}: {
  title: string
  rows: StatPopoverRow[]
  emptyLabel: string
}) {
  return (
    <div className="sw-floor-pr-popover" role="menu">
      <div className="sw-floor-pr-popover-head">{title}</div>
      {rows.length === 0 ? (
        <div className="sw-floor-pr-popover-empty">{emptyLabel}</div>
      ) : (
        <div className="sw-floor-pr-popover-list">
          {rows.map((row) => (
            <button
              key={row.key}
              type="button"
              className="sw-floor-pr-popover-row"
              onClick={row.onClick}
              disabled={row.disabled || !row.onClick}
            >
              {row.icon}
              <span className="sw-floor-pr-popover-title">{row.title}</span>
              {row.subtitle && <span className="sw-floor-pr-popover-num">{row.subtitle}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface UnifiedAgentsPaneProps {
  terminals: TerminalInfo[]
  tasks: TaskSummary[]
  tasksLoading: boolean
  unifiedTasks: UnifiedTask[]
  unifiedTasksLoading: boolean
  onDispatch: () => void
  onNavigate?: (tab: 'floor' | 'bench' | 'panel') => void
  onOpenInBench?: (taskId: string) => void
  openDispatchTrigger?: number
  quickSpawnTrigger?: number
  openDetailTaskId?: string | null
  onDetailTaskConsumed?: () => void
  onThroughputChange?: (tokensPerSec: number) => void
  /** The single live-feed filter, lifted to App so the TopBar search drives it. */
  search: string
  onSearch: (q: string) => void
  githubRepo?: string | null
  watchdogEnabled?: boolean
  watchdogEvents?: WatchdogEventUI[]
  projectRules?: ProjectRule[]
}

// Preserve object identity for unchanged agents across renders so memoized
// AgentCards don't all re-render when one agent's data changes. An item's
// signature is a full JSON serialization, so identity is reused ONLY when every
// rendered field is byte-identical — stale data is impossible.
function useStableList(items: UnifiedAgent[]): UnifiedAgent[] {
  const prevRef = useRef<Map<string, { sig: string; item: UnifiedAgent }>>(new Map())
  return useMemo(() => {
    const next = new Map<string, { sig: string; item: UnifiedAgent }>()
    const out = items.map((item) => {
      const sig = JSON.stringify(item)
      const prev = prevRef.current.get(item.id)
      const stable = prev && prev.sig === sig ? prev.item : item
      next.set(item.id, { sig, item: stable })
      return stable
    })
    prevRef.current = next
    return out
  }, [items])
}

// Wrap a FeedItem so double-clicking the card opens it as a closeable task tab.
// display:contents keeps the parent grid layout intact — the span box vanishes and the
// card stays the real grid child — while still catching the dblclick that bubbles up.
function FeedRow({ onOpenTask, ...props }: React.ComponentProps<typeof FeedItem> & { onOpenTask: (a: FloorAgent) => void }) {
  return (
    <span style={{ display: 'contents' }} onDoubleClick={() => onOpenTask(props.agent)}>
      <FeedItem {...props} />
    </span>
  )
}

export function UnifiedAgentsPane({ terminals, tasks, tasksLoading, unifiedTasks, unifiedTasksLoading, onDispatch, onNavigate, onOpenInBench, openDispatchTrigger, quickSpawnTrigger, openDetailTaskId, onDetailTaskConsumed, onThroughputChange, search: floorSearch, onSearch: setFloorSearch, githubRepo, watchdogEnabled = false, watchdogEvents = [], projectRules = [] }: UnifiedAgentsPaneProps) {
  const panelVisible = usePanelVisibility()
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [statPopover, setStatPopover] = useState<'shipped' | 'open' | 'running' | 'nextup' | 'files' | null>(null)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [dispatchPrefill, setDispatchPrefill] = useState('')
  const [dispatchPrefillTicketId, setDispatchPrefillTicketId] = useState<string | undefined>(undefined)
  // Draft-prompt round-trip result (host 'draftPromptResult'); nonce forces the
  // DispatchPanel effect to fire even on a repeated ok/error. A monotonic counter
  // (not Date.now) so two results in the same ms can't collide to an equal nonce.
  const [draftResult, setDraftResult] = useState<DraftResult | null>(null)
  const draftNonce = useRef(0)
  // Consolidated dispatch data feeding the single DispatchPanel (from `dispatchData`).
  const [dispatchAgents, setDispatchAgents] = useState<InstalledAgent[]>([])
  const [dispatchHosts, setDispatchHosts] = useState<DispatchHost[]>([])
  const [dispatchTargets, setDispatchTargets] = useState<DispatchTarget[]>([])
  // Registered-device dispatch: devices (with live health), ranked repos->projects,
  // and the sync status for the currently-selected repo. All backend-driven.
  const [dispatchDevices, setDispatchDevices] = useState<DispatchDevice[]>([])
  const [deviceRepos, setDeviceRepos] = useState<DispatchDeviceRepo[]>([])
  const [deviceSync, setDeviceSync] = useState<DispatchDeviceSync | null>(null)
  // Lightweight fleet list (agents devices list --json, no SSH) for the sidebar
  // HOSTS section — populated on mount so hosts show even before the panel opens.
  const [fleetDevices, setFleetDevices] = useState<{ name: string; online: boolean }[]>([])
  // This machine's real canonical device name (e.g. 'zion'), from the fleet fetch.
  // Local agents keep host==='this-mac' for routing but display under this name.
  const [localHostName, setLocalHostName] = useState<string>('')
  // Floor after-dispatch: plans awaiting review, one per sessionId (from `planReady`).
  const [pendingPlans, setPendingPlans] = useState<PendingPlan[]>([])
  const [cardDragActive, setCardDragActive] = useState(false)
  // The single open-the-Dispatch-panel entry point. Every legacy trigger (top-bar
  // button, cmd-K, cmd-palette, ticket rows, drag-drop) routes here, carrying an
  // optional prefill prompt and/or a ticket to pre-attach.
  const openDispatch = useCallback((opts?: { prefill?: string; ticketId?: string }) => {
    setDispatchPrefill(opts?.prefill ?? '')
    setDispatchPrefillTicketId(opts?.ticketId)
    setDispatchOpen(true)
  }, [])
  useEffect(() => {
    if (openDispatchTrigger !== undefined && openDispatchTrigger > 0) openDispatch()
  }, [openDispatchTrigger, openDispatch])
  useEffect(() => {
    if (quickSpawnTrigger !== undefined && quickSpawnTrigger > 0) openDispatch()
  }, [quickSpawnTrigger, openDispatch])
  useEffect(() => {
    if (!openDetailTaskId) return
    const task = unifiedTasks.find(t => t.id === openDetailTaskId)
    if (!task) return
    openDispatch({ ticketId: ticketKey(task) })
    onDetailTaskConsumed?.()
  }, [openDetailTaskId, unifiedTasks, onDetailTaskConsumed, openDispatch])
  const [pendingDispatches, setPendingDispatches] = useState<PendingDispatch[]>([])
  const [tick, setTick] = useState(0)
  // ---------- Floor 3-pane shell state ----------
  const floorPrefs0 = useRef(loadFloorPrefs()).current
  const [center, setCenter] = useState<CenterMode>('agents')
  // Dynamic task tabs: double-clicking a backlog ticket or an agent card opens a
  // closeable tab in the sub-tab strip. activeTaskTab === null means a fixed center
  // tab is showing; otherwise the named task tab owns the center pane.
  const [openTaskTabs, setOpenTaskTabs] = useState<TaskTab[]>([])
  const [activeTaskTab, setActiveTaskTab] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [projFilter, setProjFilter] = useState<string | null>(null)
  // Host scope: click a HOSTS row to filter the feed to that machine; click again to clear.
  const [hostFilter, setHostFilter] = useState<string | null>(null)
  // Recent (historical) sessions per host, fetched lazily only when a host filter has
  // 0 live agents — so an empty host shows recent work instead of a blank pane.
  const [recentByHost, setRecentByHost] = useState<Record<string, RemoteSessionLike[]>>({})
  // PR board: statuses for every PR URL the live feed carries. null = not fetched
  // yet (the gh fan-out runs lazily when the PRs center opens).
  const [prStatuses, setPrStatuses] = useState<PrStatusLike[] | null>(null)
  const [prMerging, setPrMerging] = useState<Set<string>>(() => new Set())
  const [prErrors, setPrErrors] = useState<Record<string, string>>({})
  // Recap ledger: fleet-wide recent (ended) sessions. null = not fetched yet — the
  // sweep is expensive (SSH fan-out), so it runs lazily when the Recap center opens.
  const [recapSessions, setRecapSessions] = useState<RemoteSessionLike[] | null>(null)
  const [floorSort, setFloorSort] = useState<FloorSort>('needs')
  // Group the live feed by an axis. Defaults to 'outcome' (ticket/PR/worktree) so a
  // fleet-scale floor shows deliverables, not ~1,100 agents (RUSH-1479). NEEDS YOU
  // stays pinned above the groups; 'none' falls back to flat phase sections
  // (NEEDS YOU -> RUNNING -> DONE). Reuses groupAgents() so the control bar and
  // the feed share one grouping implementation.
  const [floorGroup, setFloorGroup] = useState<FloorGroupBy | 'none'>('outcome')
  const [plain, setPlain] = useState(floorPrefs0.plain)
  const [sidebarOpen, setSidebarOpen] = useState(floorPrefs0.sidebar)
  // Collapsed = the icon rail (mockup default); expanded = the full text sidebar.
  const [railCollapsed, setRailCollapsed] = useState(floorPrefs0.rail)
  const [rightOpen, setRightOpen] = useState(floorPrefs0.right)
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(floorPrefs0.pinned))
  // Ordered pinned HOSTS names (null = default: pin the local machine).
  const [hostPins, setHostPins] = useState<string[] | null>(floorPrefs0.hostPins)
  const [statusChips, setStatusChips] = useState<StatusChip[]>([])
  const [abbrChips, setAbbrChips] = useState<AgentAbbr[]>([])
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => loadSavedViews())

  const activeViewName = useMemo(() => {
    const cur = { sort: floorSort, status: statusChips, abbrs: abbrChips, search: floorSearch }
    return savedViews.find((v) => viewMatches(v, cur))?.name ?? null
  }, [savedViews, floorSort, statusChips, abbrChips, floorSearch])

  const applyView = useCallback((v: SavedView) => {
    setFloorSort(v.sort)
    setStatusChips(v.status)
    setAbbrChips(v.abbrs)
    setFloorSearch(v.search)
  }, [])

  const saveView = useCallback((name: string) => {
    setSavedViews((prev) => {
      const next = upsertView(prev, { name, sort: floorSort, status: statusChips, abbrs: abbrChips, search: floorSearch })
      persistSavedViews(next)
      return next
    })
  }, [floorSort, statusChips, abbrChips, floorSearch])

  const deleteView = useCallback((name: string) => {
    setSavedViews((prev) => {
      const next = removeView(prev, name)
      persistSavedViews(next)
      return next
    })
  }, [])
  const [ticketGroup, setTicketGroup] = useState<TicketGroupBy>('project')
  const [ticketSort, setTicketSort] = useState<TicketSort>('priority')
  const [ticketSrc, setTicketSrc] = useState<Record<TicketSource, boolean>>({ LN: true, GH: true })
  const [remoteSessions, setRemoteSessions] = useState<RemoteSessionLike[]>([])
  const [offlineHosts, setOfflineHosts] = useState<string[]>([])
  // Per-agent reply failures (host 'replyResult' with ok=false, or a 'none' channel),
  // shown inline near the reply control instead of a toast. Cleared on the next send.
  const [replyErrors, setReplyErrors] = useState<Map<string, string>>(new Map())
  // Full discovered roster (name + reachability) so the sidebar can list idle
  // reachable hosts, not only hosts currently running an agent.
  const [hostRoster, setHostRoster] = useState<Array<{ name: string; online: boolean }>>([])
  // Freshness of the cross-host (remote) sweep, for the LIVE ACTIVITY sync chip.
  const [lastRemoteSync, setLastRemoteSync] = useState(0)
  const [syncingHosts, setSyncingHosts] = useState(false)
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
  const [hostInventories, setHostInventories] = useState<Record<string, HostInventory>>({})
  const [hostConfigError, setHostConfigError] = useState<string | null>(null)
  // Curated managed projects (sidebar top-3 + Projects pane), the Linear projects
  // available to link, and the most recent host folder-picker result (prefills the form).
  const [managedProjects, setManagedProjects] = useState<ManagedProject[]>([])
  const [linearProjects, setLinearProjects] = useState<LinearProjectLite[]>([])
  const [pickedFolder, setPickedFolder] = useState<{ path: string; repoSlug?: string; name: string; suggestedLinear?: LinearProjectLite } | null>(null)

  // Persist the durable Floor prefs (pinned set, plain/sidebar/right toggles, group-by, host pins).
  useEffect(() => {
    saveFloorPrefs({ plain, sidebar: sidebarOpen, rail: railCollapsed, right: rightOpen, pinned: [...pinned], hostPins })
  }, [plain, sidebarOpen, railCollapsed, rightOpen, pinned, hostPins])

  // Effective HOSTS pins: default to pinning just the local machine until the user
  // customizes. Pin/unpin and drag-reorder always write an explicit list.
  const effectiveHostPins = useMemo(
    () => hostPins ?? (localHostName ? [localHostName] : []),
    [hostPins, localHostName]
  )
  const toggleHostPin = useCallback((name: string) => {
    setHostPins((prev) => {
      const base = prev ?? (localHostName ? [localHostName] : [])
      return base.includes(name) ? base.filter((n) => n !== name) : [...base, name]
    })
  }, [localHostName])
  const reorderHostPins = useCallback((names: string[]) => setHostPins(names), [])

  // Cross-host merge: fold genuinely-remote sessions into the Floor. Two message
  // types arrive here:
  //   hostSessions  — full sweep (every online host); replaces the whole set + roster.
  //   localSessions — this-mac only (the fast 3s poll); replaces just the this-mac rows
  //                   so remote rows from the slower sweep are preserved.
  // Per-agent reply failures ('replyResult' with ok=false) surface inline near the reply
  // control instead of a toast; cleared on the next successful send.
  // Local-only Floor still works if neither ever arrives.
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'replyResult') {
        const agentId = String(msg.agentId ?? '')
        if (!agentId) return
        setReplyErrors((prev) => {
          const n = new Map(prev)
          if (msg.ok) n.delete(agentId)
          else n.set(agentId, String(msg.error || 'Reply failed'))
          return n
        })
        return
      }
      if (msg?.type === 'hostSessions') {
        setRemoteSessions(Array.isArray(msg.sessions) ? (msg.sessions as RemoteSessionLike[]) : [])
        const roster = Array.isArray(msg.hosts)
          ? (msg.hosts as Array<{ name: string; online: boolean }>)
              .filter((h) => h && typeof h.name === 'string')
              .map((h) => ({ name: h.name, online: !!h.online }))
          : []
        setHostRoster(roster)
        setOfflineHosts(roster.filter((h) => !h.online).map((h) => h.name))
        setLastRemoteSync(typeof msg.fetchedAt === 'number' ? msg.fetchedAt : Date.now())
        setSyncingHosts(false)
      } else if (msg?.type === 'localSessions') {
        const local = Array.isArray(msg.sessions) ? (msg.sessions as RemoteSessionLike[]) : []
        setRemoteSessions((prev) => [...prev.filter((s) => s.host !== 'this-mac'), ...local])
      } else if (msg?.type === 'recentSessions') {
        const rh = typeof msg.host === 'string' ? msg.host : ''
        const recent = Array.isArray(msg.sessions) ? (msg.sessions as RemoteSessionLike[]) : []
        setRecentByHost((p) => ({ ...p, [rh]: recent }))
      } else if (msg?.type === 'prBoard') {
        setPrStatuses(Array.isArray(msg.statuses) ? (msg.statuses as PrStatusLike[]) : [])
      } else if (msg?.type === 'mergePrResult') {
        const mu = typeof msg.url === 'string' ? msg.url : ''
        setPrMerging((prev) => { const next = new Set(prev); next.delete(mu); return next })
        if (msg.ok === true) {
          // Merged: refetch so the row settles (and any dependent rows update).
          setPrStatuses(null)
        } else {
          setPrErrors((prev) => ({ ...prev, [mu]: typeof msg.error === 'string' ? msg.error : 'merge failed' }))
        }
      } else if (msg?.type === 'recapSessions') {
        setRecapSessions(Array.isArray(msg.sessions) ? (msg.sessions as RemoteSessionLike[]) : [])
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Remote tier: sweep every online host over SSH. Expensive, so poll slowly and only
  // while the panel is visible; the sweep itself is cheapened backend-side (offline
  // hosts skipped, one SSH per host, CPU probe decoupled). Mirrors the throughput poll.
  useEffect(() => {
    if (!panelVisible) return
    const sweep = () => { setSyncingHosts(true); postMessage({ type: 'fetchHostSessions' }) }
    sweep()
    const id = setInterval(sweep, REMOTE_POLL_MS)
    return () => clearInterval(id)
  }, [panelVisible])

  // Local tier: this-mac sessions with no SSH — cheap, so poll fast. Keeps the feed
  // feeling live for local agents between the slow remote sweeps.
  useEffect(() => {
    if (!panelVisible) return
    const poll = () => postMessage({ type: 'fetchLocalSessions' })
    poll()
    const id = setInterval(poll, LOCAL_POLL_MS)
    return () => clearInterval(id)
  }, [panelVisible])

  // Host detail pane: receive fetched inventories + config-action errors.
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'hostInventory' && msg.inventory && typeof msg.host === 'string') {
        setHostInventories((prev) => ({ ...prev, [msg.host]: msg.inventory as HostInventory }))
        setHostConfigError(null)
      } else if (msg?.type === 'hostConfigError' && typeof msg.error === 'string') {
        setHostConfigError(msg.error)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Managed projects + linkable Linear projects for the sidebar top-3 and the
  // Projects pane. Fetch on mount; the host re-sends managedProjectsData after any
  // save/delete, so no optimistic update is needed. projectFolderPicked answers the
  // pane's Browse… button and prefills its add form.
  useEffect(() => {
    postMessage({ type: 'fetchManagedProjects' })
    postMessage({ type: 'fetchLinearProjects' })
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'managedProjectsData' && Array.isArray(msg.projects)) {
        setManagedProjects(msg.projects as ManagedProject[])
      } else if (msg?.type === 'linearProjectsData' && Array.isArray(msg.projects)) {
        setLinearProjects(msg.projects as LinearProjectLite[])
      } else if (msg?.type === 'projectFolderPicked' && typeof msg.path === 'string') {
        setPickedFolder({
          path: msg.path,
          repoSlug: typeof msg.repoSlug === 'string' ? msg.repoSlug : undefined,
          name: typeof msg.name === 'string' ? msg.name : '',
          suggestedLinear: msg.suggestedLinear as LinearProjectLite | undefined,
        })
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Consolidated dispatch data (installed agents / hosts / ranked targets) for the
  // single DispatchPanel, plus the Floor after-dispatch `planReady` signal. Both are
  // ext->webview, so one listener serves both. Panel still opens if data never arrives.
  useEffect(() => {
    postMessage({ type: 'fetchDispatchData' })
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'dispatchData') {
        if (Array.isArray(msg.agents)) setDispatchAgents(msg.agents as InstalledAgent[])
        if (Array.isArray(msg.hosts)) setDispatchHosts(msg.hosts as DispatchHost[])
        if (Array.isArray(msg.targets)) setDispatchTargets(msg.targets as DispatchTarget[])
      } else if (msg?.type === 'planReady' && msg.plan) {
        const plan = msg.plan as PendingPlan
        // De-dupe by sessionId so a re-emitted plan replaces the stale one.
        setPendingPlans((prev) => [...prev.filter((p) => p.sessionId !== plan.sessionId), plan])
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Registered-device data for the Dispatch panel's device path. Fetched when the
  // panel opens (device health SSH-probes every host, so we don't probe on every
  // mount). deviceHealth returns ALL registered devices folded with live stats
  // (reachable flag included) so offline devices still list as disabled rows.
  useEffect(() => {
    if (!dispatchOpen) return
    postMessage({ type: 'deviceHealth' })
    postMessage({ type: 'repos' })
  }, [dispatchOpen])
  // Cheap fleet fetch on mount (no SSH) so the sidebar HOSTS list is populated.
  useEffect(() => {
    postMessage({ type: 'listDevices' })
  }, [])
  useEffect(() => {
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'devicesData' && Array.isArray(msg.devices)) {
        if (typeof msg.local === 'string' && msg.local) setLocalHostName(msg.local)
        setFleetDevices(
          (msg.devices as Array<{ name: string; online?: boolean }>).map((d) => ({
            name: d.name,
            online: !!d.online,
          })),
        )
      } else if (msg?.type === 'deviceHealthData' && Array.isArray(msg.health)) {
        setDispatchDevices(
          (msg.health as Array<{ device: { name: string; host: string; secretRef?: string; softLimit?: number }; stats: { reachable?: boolean; runningAgents?: number; memPercent?: number; loadAvg1?: number } }>).map(
            ({ device, stats }) => ({
              name: device.name,
              host: device.host,
              secretRef: device.secretRef,
              softLimit: device.softLimit,
              reachable: !!stats?.reachable,
              runningAgents: stats?.runningAgents,
              memPercent: stats?.memPercent,
              loadAvg1: stats?.loadAvg1,
            }),
          ),
        )
      } else if (msg?.type === 'reposData' && Array.isArray(msg.repos)) {
        setDeviceRepos(msg.repos as DispatchDeviceRepo[])
      } else if (msg?.type === 'repoSyncData') {
        setDeviceSync((msg.status as DispatchDeviceSync | null) ?? null)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  const onRequestRepoSync = useCallback((deviceName: string, root: string) => {
    setDeviceSync(null)
    const dev = dispatchDevices.find((d) => d.name === deviceName)
    postMessage({ type: 'repoSync', root, host: dev?.host, secretRef: dev?.secretRef })
  }, [dispatchDevices])

  const onManageDevices = useCallback(() => {
    postMessage({ type: 'manageDevices' })
  }, [])

  const onDeviceDispatch = useCallback((req: DeviceDispatchRequest) => {
    setDispatchOpen(false)
    const now = Date.now()
    const perTicket = req.batch === 'per' && req.ticketIds.length > 1
    const seeds: (string | undefined)[] = perTicket ? req.ticketIds : [req.ticketIds[0]]
    const promptTitle = req.prompt.trim().slice(0, 60) || req.ticketIds[0] || 'New agent'
    seeds.forEach((tid) => {
      postMessage({
        type: 'dispatchTask',
        target: 'device',
        agentType: req.agent,
        deviceName: req.deviceName,
        host: req.host,
        secretRef: req.secretRef,
        projectPath: req.projectPath,
        repoSlug: req.repoSlug,
        syncPolicy: req.syncPolicy,
        mode: req.mode,
        title: perTicket && tid ? tid : promptTitle,
        description: req.prompt,
        identifier: tid ?? '',
      })
    })
    const pendings: PendingDispatch[] = seeds.map((tid, i) => ({
      id: `pending-dispatch-${now}-${i}`,
      agentType: req.agent,
      target: 'device',
      taskId: `dispatch-${now}-${i}`,
      taskIdentifier: tid ?? '',
      title: perTicket && tid ? tid : promptTitle,
      createdAt: now + i,
      deviceName: req.deviceName,
      secretRef: req.secretRef,
      projectPath: req.projectPath,
      repoSlug: req.repoSlug,
      syncPolicy: req.syncPolicy,
    }))
    setPendingDispatches((prev) => [...prev, ...pendings])
    setTimeout(() => {
      postMessage({ type: 'fetchAllTerminals' })
      postMessage({ type: 'fetchTasks' })
    }, 800)
  }, [])

  const newMenuRef = useRef<HTMLDivElement>(null)
  const statPopoverRef = useRef<HTMLDivElement>(null)
  const nextUpSectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Gate the 1s countdown on visibility: no point ticking the pending-dispatch
    // timeout clock while the panel is hidden — it just burns a wakeup per second
    // off-screen. The next reveal re-arms it (panelVisible flips true).
    if (pendingDispatches.length === 0 || !panelVisible) return
    const interval = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(interval)
  }, [pendingDispatches.length, panelVisible])

  useEffect(() => {
    if (pendingDispatches.length === 0) return
    const now = Date.now()
    setPendingDispatches((prev) => {
      // Lifecycle: surface confirmed Rush Cloud failures immediately, flip
      // anything past TTL to timedOut next, then fully remove once the
      // retention window has also passed. Each helper returns the same
      // reference when nothing changed, so steady state is a no-op.
      const failed = markCloudFailedPending(prev, tasks)
      const flipped = markTimedOutPending(failed, now)
      const pruned = pruneExpiredPending(flipped, now)
      return pruned
    })
  }, [tick, pendingDispatches, tasks])

  useEffect(() => {
    if (!newMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setNewMenuOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [newMenuOpen])

  useEffect(() => {
    if (!statPopover) return
    const handler = (e: MouseEvent) => {
      if (statPopoverRef.current && !statPopoverRef.current.contains(e.target as Node)) setStatPopover(null)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [statPopover])

  // Listen for command-palette-dispatched events. We can't call into App.tsx's
  // state from here, so the palette fires window-level CustomEvents we pick up.
  // Opening a task routes to the single DispatchPanel with that ticket attached.
  useEffect(() => {
    const onOpenTask = (e: Event) => {
      const ev = e as CustomEvent<{ taskId: string }>
      const taskId = ev.detail?.taskId
      if (!taskId) return
      const task = unifiedTasks.find((t) => t.id === taskId)
      if (!task) return
      openDispatch({ ticketId: ticketKey(task) })
    }
    const onFocusTerm = (e: Event) => {
      const ev = e as CustomEvent<{ terminalId: string }>
      const id = ev.detail?.terminalId
      if (!id) return
      postMessage({ type: 'focusTerminal', terminalId: id })
    }
    window.addEventListener(CMD_PALETTE_EVENTS.openTaskDetail, onOpenTask)
    window.addEventListener(CMD_PALETTE_EVENTS.focusTerminal, onFocusTerm)
    return () => {
      window.removeEventListener(CMD_PALETTE_EVENTS.openTaskDetail, onOpenTask)
      window.removeEventListener(CMD_PALETTE_EVENTS.focusTerminal, onFocusTerm)
    }
  }, [unifiedTasks, openDispatch])

  const baseItems = useMemo(() => {
    const list = buildUnifiedList(terminals, tasks)
    if (watchdogEnabled) {
      const lastEvent = watchdogEvents[watchdogEvents.length - 1]
      const lastNudge = [...watchdogEvents].reverse().find((e) => e.kind === 'nudge')
      const activity = lastNudge
        ? `Nudged ${lastNudge.terminalId?.split('-')[0] ?? 'terminal'} · ${relTime(new Date(lastNudge.ts).toISOString())}`
        : lastEvent
          ? `Last scan ${relTime(new Date(lastEvent.ts).toISOString())}`
          : 'Monitoring'
      list.unshift({
        kind: 'watchdog',
        id: 'watchdog',
        agentType: 'watchdog',
        displayName: 'Watchdog',
        activity,
        active: !!lastEvent,
        duration: '',
        timestamp: lastEvent ? new Date(lastEvent.ts).toISOString() : new Date().toISOString(),
        status: lastEvent ? 'running' : 'idle',
        files: [],
        toolCalls: 0,
        watchdogEvents,
      })
    }
    return list
  }, [terminals, tasks, watchdogEnabled, watchdogEvents])

  // Reconcile: drop a pending dispatch once a matching real terminal/task appears.
  useEffect(() => {
    if (pendingDispatches.length === 0) return
    setPendingDispatches((prev) => {
      const next = reconcilePending(prev, terminals, tasks)
      return next.length === prev.length ? prev : next
    })
  }, [terminals, tasks, pendingDispatches])

  const optimisticItems = useMemo<UnifiedAgent[]>(() => {
    void tick
    // Only render still-pending dispatches as optimistic cards. Timed-out
    // ones are surfaced as a separate dismissable banner above the grid
    // (see `timedOutDispatches` + banner render below) so they stand out
    // visually instead of masquerading as a running agent.
    return pendingDispatches
      .filter((p) => (p.status ?? 'pending') !== 'timedOut')
      .map((p) => ({
        kind: p.target === 'cloud' ? 'cloud' : 'terminal',
        id: p.id,
        agentType: p.agentType,
        displayName: p.taskIdentifier || p.title.slice(0, 40),
        activity: optimisticActivityLabel(p),
        active: true,
        duration: '',
        timestamp: new Date(p.createdAt).toISOString(),
        status: 'running',
        files: [],
        toolCalls: 0,
        mode: p.target === 'cloud' ? 'cloud' : 'auto',
        cloudProvider: p.target === 'cloud' ? 'anthropic' : null,
      }))
  }, [pendingDispatches, tick])

  // Timed-out dispatches surfaced as a warning banner. Collected separately
  // so the banner renders above the active grid and can be individually
  // dismissed without affecting still-pending entries.
  const timedOutDispatches = useMemo(() => {
    void tick
    return pendingDispatches.filter((p) => (p.status ?? 'pending') === 'timedOut')
  }, [pendingDispatches, tick])

  const dismissPending = (id: string) => {
    setPendingDispatches((prev) => prev.filter((p) => p.id !== id))
  }

  const rawItems = useMemo(() => [...optimisticItems, ...baseItems], [optimisticItems, baseItems])
  const items = useStableList(rawItems)
  const activeItems = useMemo(() => items.filter((i) => i.active), [items])
  const recentItems = useMemo(() => items.filter((i) => !i.active), [items])

  const pendingTaskIds = useMemo(
    () => new Set(pendingDispatches.map((p) => p.taskId)),
    [pendingDispatches]
  )

  // Queue eligible pool: urgent/high todo tasks not currently being dispatched.
  // Project filter is applied on top of this for the NEXT UP strip.
  const queueEligible = useMemo(() => {
    const eligible = unifiedTasks.filter(
      (t) => t.status === 'todo' && (t.priority === 'urgent' || t.priority === 'high')
    )
    return filterDispatchedTaskIds(eligible, pendingTaskIds)
  }, [unifiedTasks, pendingTaskIds])

  // Attach list for the cmd+k composer: every todo task (not just the
  // urgent/high Next Up pool), highest priority first.
  const composerTasks = useMemo(() => {
    const rank: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }
    const todo = unifiedTasks
      .filter((t) => t.status === 'todo')
      .sort((a, b) => (rank[a.priority || 'low'] ?? 3) - (rank[b.priority || 'low'] ?? 3))
    return filterDispatchedTaskIds(todo, pendingTaskIds)
  }, [unifiedTasks, pendingTaskIds])

  // Repo name of the workspace currently open in the IDE (e.g. "swarmify"
  // from "muqsitnawaz/swarmify"). Used to default the Next Up filter so
  // dispatches stay scoped to the repo the user is actually working on.
  const workspaceRepoName = useMemo(() => {
    if (!githubRepo) return null
    return githubRepo.includes('/') ? githubRepo.split('/').pop()! : githubRepo
  }, [githubRepo])

  const [queueRepoFilter, setQueueRepoFilter] = useState<string>(() => workspaceRepoName ?? 'all')
  const queueRepoFilterUserSet = useRef(false)

  // Distinct repo names present in the eligible queue. Derived from the
  // repo:* label on each Linear issue (resolved to "owner/repo" at fetch
  // time). Shown as just the repo name in the dropdown since they all share
  // the same owner.
  const queueRepos = useMemo(() => {
    const seen = new Set<string>()
    for (const t of queueEligible) {
      const full = t.metadata.repo
      if (!full) continue
      const name = full.includes('/') ? full.split('/').pop()! : full
      seen.add(name)
    }
    return Array.from(seen).sort()
  }, [queueEligible])

  // Once the workspace repo is known and there's at least one task tagged
  // for it, snap the filter to it — but only if the user hasn't manually
  // overridden the dropdown.
  useEffect(() => {
    if (queueRepoFilterUserSet.current) return
    if (!workspaceRepoName) return
    if (queueRepos.includes(workspaceRepoName) && queueRepoFilter !== workspaceRepoName) {
      setQueueRepoFilter(workspaceRepoName)
    }
  }, [workspaceRepoName, queueRepos, queueRepoFilter])

  // When the selected repo drains out of the eligible pool (all its tasks
  // got dispatched), fall back to "all" rather than showing an empty queue
  // the user can't clear without touching the dropdown. Skip this for the
  // workspace repo so a transient empty queue doesn't drop the user's repo
  // scope.
  useEffect(() => {
    if (queueRepoFilter === 'all') return
    if (queueRepoFilter === workspaceRepoName) return
    if (!queueRepos.includes(queueRepoFilter)) {
      setQueueRepoFilter('all')
    }
  }, [queueRepoFilter, queueRepos, workspaceRepoName])

  const queueTasks = useMemo(() => {
    const filtered = queueRepoFilter === 'all'
      ? queueEligible
      : queueEligible.filter((t) => {
          const full = t.metadata.repo
          if (!full) return false
          const name = full.includes('/') ? full.split('/').pop()! : full
          return name === queueRepoFilter
        })
    return filtered.slice(0, 4)
  }, [queueEligible, queueRepoFilter])

  // Intake queue: cloud teammates that a cloud provider flagged as
  // 'input_required'. Surface one banner per team; submit pipes through to
  // `agents factory answer <team> <text>` in the VS Code backend.
  const intakeTeams = useMemo(() => {
    const byTeam = new Map<string, { teammate: string; agentId: string }[]>()
    for (const t of tasks) {
      for (const a of t.agents) {
        if (a.status !== 'input_required') continue
        const existing = byTeam.get(t.task_name) ?? []
        existing.push({ teammate: (a.name ?? compactHumanLabel(a.prompt)) || `${a.agent_type} teammate`, agentId: a.agent_id })
        byTeam.set(t.task_name, existing)
      }
    }
    return Array.from(byTeam.entries()).map(([team, agents]) => ({ team, agents }))
  }, [tasks])

  // Gauge metrics
  const totalFiles = useMemo(() => {
    const fileSet = new Set<string>()
    for (const item of items) {
      for (const f of item.files) fileSet.add(f.split('/').pop() || f)
    }
    return fileSet.size
  }, [items])

  // Open PRs: items with a prUrl whose PR is not merged/completed.
  // swarmOverallStatus treats status === 'completed' as 'merged', so we exclude those.
  const openPRs = useMemo(
    () =>
      items
        .filter((i) => i.prUrl && i.status !== 'completed')
        .map((i) => ({
          key: i.id,
          title: i.displayName,
          url: i.prUrl as string,
          agentType: i.agentType,
          timestamp: i.timestamp,
        })),
    [items]
  )
  const totalPRs = openPRs.length

  // PRs shipped today: agents with pr_url that completed today.
  const shippedPRs = useMemo(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startMs = startOfDay.getTime()
    const out: Array<{ key: string; title: string; url: string; agentType: string; timestamp: string }> = []
    for (const task of tasks) {
      for (const a of task.agents) {
        if (!a.pr_url) continue
        if (a.status !== 'completed') continue
        if (!a.completed_at) continue
        if (new Date(a.completed_at).getTime() < startMs) continue
        out.push({
          key: `shipped-${a.agent_id}`,
          title: taskNameToTitle(task.task_name),
          url: a.pr_url,
          agentType: a.agent_type,
          timestamp: a.completed_at,
        })
      }
    }
    return out
  }, [tasks])
  const prsShippedToday = shippedPRs.length

  // Files touched today: unique files across agents that had activity today.
  const filesToday = useMemo(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startMs = startOfDay.getTime()
    const set = new Set<string>()
    for (const task of tasks) {
      for (const a of task.agents) {
        const ts = a.completed_at || a.started_at
        if (!ts) continue
        if (new Date(ts).getTime() < startMs) continue
        for (const f of a.files_created || []) set.add(f)
        for (const f of a.files_modified || []) set.add(f)
      }
    }
    return Array.from(set).sort()
  }, [tasks])
  const filesTouchedToday = filesToday.length

  const backlogRemaining = useMemo(() => {
    const todoCount = unifiedTasks.filter((t) => t.status === 'todo').length
    return Math.max(0, todoCount - queueTasks.length)
  }, [unifiedTasks, queueTasks.length])

  // Real LLM output tok/s -- extension parses active Claude session JSONL files
  // and sums usage.output_tokens over the last 60s rolling window.
  const [liveThroughput, setLiveThroughput] = useState(0)
  useEffect(() => {
    if (activeItems.length === 0) {
      setLiveThroughput(0)
      onThroughputChange?.(0)
      return
    }
    if (!panelVisible) {
      // Panel hidden: stop polling AND zero the throughput. ThroughputCounter
      // early-returns its 140ms sparkline interval when tokensPerSec <= 0, so
      // resetting here clears the animation instead of letting it run off-screen
      // against the last frozen value.
      setLiveThroughput(0)
      onThroughputChange?.(0)
      return
    }
    const poll = () => postMessage({ type: 'getFloorThroughput' })
    poll()
    const id = setInterval(poll, 2500)
    return () => clearInterval(id)
  }, [activeItems.length, onThroughputChange, panelVisible])
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type === 'floorThroughputData' && typeof msg.tokensPerSec === 'number') {
        setLiveThroughput(msg.tokensPerSec)
        onThroughputChange?.(msg.tokensPerSec)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onThroughputChange])

  // Draft-prompt result from the host. Stamp a nonce so the DispatchPanel effect
  // fires on every delivery (React would skip an object with unchanged fields).
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data
      if (msg?.type !== 'draftPromptResult') return
      setDraftResult({
        ok: !!msg.ok,
        text: typeof msg.text === 'string' ? msg.text : undefined,
        error: typeof msg.error === 'string' ? msg.error : undefined,
        nonce: ++draftNonce.current,
      })
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  const onDraftPrompt = useCallback((payload: { tickets: DraftTicketPayload[]; hint: string }) => {
    postMessage({ type: 'draftPrompt', tickets: payload.tickets, hint: payload.hint })
  }, [])

  const handleNewAgent = (agent: string) => {
    const commands: Record<string, string> = {
      claude: 'agents.newClaude',
      codex: 'agents.newCodex',
      gemini: 'agents.newGemini',
      opencode: 'agents.newOpencode',
      cursor: 'agents.newCursor',
    }
    postMessage({ type: 'executeCommand', command: commands[agent] })
  }

  const handleFocusTerminal = (t: TerminalInfo) => {
    postMessage({ type: 'focusTerminal', terminalId: t.id })
  }

  const handleRetry = useCallback((taskName: string) => {
    postMessage({ type: 'retrySwarm', taskName })
  }, [])

  const handleKill = (taskName: string) => {
    postMessage({ type: 'killSwarm', taskName })
  }

  // Panel hosts: the ranked host list from `dispatchData`, folded with LIVE load —
  // online-ness from the hostSessions offline set + current agent counts per host from
  // the cross-host session index. This is the "Run on" list the DispatchPanel ranks.
  const panelHosts = useMemo<DispatchHost[]>(() => {
    if (dispatchHosts.length === 0) return []
    const offline = new Set(offlineHosts)
    const agentsByHost = new Map<string, number>()
    for (const s of remoteSessions) agentsByHost.set(s.host, (agentsByHost.get(s.host) ?? 0) + 1)
    return dispatchHosts.map((h) => {
      const online = h.kind === 'cloud' ? h.online : !offline.has(h.id)
      const liveAgents = agentsByHost.get(h.id)
      return { ...h, online, agents: liveAgents ?? h.agents }
    })
  }, [dispatchHosts, offlineHosts, remoteSessions])

  // The single dispatch entry point. The consolidated panel emits ONE DispatchRequest;
  // we hand it to the backend (`dispatch`) and drop optimistic pending cards so the Floor
  // shows the agent(s) coming up immediately (trust-it's-working). Replaces the scattered
  // dispatchTask / quickSpawn senders.
  const onDispatchRequest = useCallback((req: DispatchRequest) => {
    setDispatchOpen(false)
    postMessage({ type: 'dispatch', request: req })
    const host = panelHosts.find((h) => h.id === req.runOn)
    const isCloud = host?.kind === 'cloud'
    const now = Date.now()
    const perTicket = req.batch === 'per' && req.ticketIds.length > 1
    const seeds: (string | undefined)[] = perTicket ? req.ticketIds : [req.ticketIds[0]]
    const promptTitle = req.prompt.trim().slice(0, 60) || req.ticketIds[0] || 'New agent'
    const pendings: PendingDispatch[] = seeds.map((tid, i) => ({
      id: `pending-dispatch-${now}-${i}`,
      agentType: req.agent,
      target: isCloud ? 'cloud' : 'local',
      taskId: `dispatch-${now}-${i}`,
      taskIdentifier: tid ?? '',
      title: perTicket && tid ? tid : promptTitle,
      createdAt: now + i,
    }))
    setPendingDispatches((prev) => [...prev, ...pendings])
    setTimeout(() => {
      postMessage({ type: 'fetchAllTerminals' })
      postMessage({ type: 'fetchTasks' })
    }, 800)
  }, [panelHosts])

  // ---------- Floor view-model derivation ----------
  // A once-a-second ticker (local useNow) drives the sync chip's live age (below). It is
  // deliberately NOT a dependency of the agent adapters: at 100+ agents, re-adapting the
  // whole feed every second (derivePhase / splitActivity / a per-agent question regex)
  // is the dominant idle cost. The adapter instead captures Date.now() at data-change
  // time only; each FeedItem's own leaf heartbeat (useNow) ticks the visible "since"
  // label, so nothing freezes while unchanged agents stop being re-derived every second.
  const nowMs = useNow(1000)

  // Local agents (drop the synthetic watchdog row) + genuinely-remote sessions
  // (host !== 'this-mac' so we don't double count this machine's own agents).
  const floorLocalAgents = useMemo(
    () => adaptUnified(items.filter((i) => i.kind !== 'watchdog'), { pinned, workspaceRepo: workspaceRepoName, nowMs, localHostName, projectRules }),
    [items, pinned, workspaceRepoName, nowMs, localHostName, projectRules]
  )
  // Session UUIDs already open as a terminal tab in THIS window (the rich, local
  // source). Used to avoid double-listing an agent that the machine-wide fetch also
  // reports for this-mac.
  const localTabSessionIds = useMemo(
    () => new Set(items.map((i) => i.terminal?.sessionId).filter((x): x is string => !!x)),
    [items]
  )
  const floorRemoteAgents = useMemo(
    () =>
      adaptRemote(
        // Show every machine-wide agent, not just this window's tabs: all remote
        // hosts, PLUS this-mac sessions running elsewhere (other windows / tmux /
        // standalone / headless / cloud) that aren't already an open tab here. Cloud
        // agents that are input_required are exactly the "needs you" case the field
        // exists for, so they surface too (with a cloud reply channel).
        remoteSessions.filter(
          (s) => s.host !== 'this-mac' || !localTabSessionIds.has(s.sessionId)
        ),
        pinned,
        localHostName,
        projectRules
      ),
    [remoteSessions, localTabSessionIds, pinned, localHostName, projectRules]
  )
  const floorAgents = useMemo(
    () => [...floorLocalAgents, ...floorRemoteAgents],
    [floorLocalAgents, floorRemoteAgents]
  )
  const floorTickets = useMemo(() => adaptTickets(unifiedTasks), [unifiedTasks])
  // Ticket id -> agents carrying it: the backlog's in-flight chips and the ticket
  // detail's "In flight" block + double-dispatch guard all join on this.
  const floorWorkers = useMemo(() => ticketWorkers(floorAgents), [floorAgents])
  // Per-project activity rollups: the rail's Projects flyout sub-counts and the
  // Projects pane's activity line both read from this one derivation.
  const floorRollups = useMemo(() => projectRollups(floorAgents, floorTickets), [floorAgents, floorTickets])

  // Lookup back to the source UnifiedAgent so the right pane can reuse the rich DetailPane.
  const unifiedById = useMemo(() => {
    const m = new Map<string, UnifiedAgent>()
    for (const i of items) m.set(i.id, i)
    return m
  }, [items])

  // Center list scoped by project filter + host filter + status/agent chips + search.
  const scopedAgents = useMemo(() => {
    let list = floorAgents
    if (projFilter) list = list.filter((a) => a.project === projFilter)
    if (hostFilter) list = list.filter((a) => (a.hostLabel ?? a.host) === hostFilter)
    if (statusChips.length) list = list.filter((a) => statusChips.some((c) => (c === 'needs' ? a.needs : a.phase === c)))
    if (abbrChips.length) list = list.filter((a) => abbrChips.includes(a.abbr))
    const q = floorSearch.trim().toLowerCase()
    if (q) list = list.filter((a) => `${a.name} ${a.branch} ${a.verb} ${a.target} ${a.project} ${a.host} ${a.hostLabel ?? ''}`.toLowerCase().includes(q))
    return list
  }, [floorAgents, projFilter, hostFilter, statusChips, abbrChips, floorSearch])

  // Empty host filter -> show that host's recent sessions instead of a blank pane.
  // Fetch once per host (lazily), then adapt through the SAME card path as live agents.
  const hostHasNoActive = !!hostFilter && scopedAgents.length === 0
  useEffect(() => {
    if (hostHasNoActive && hostFilter && recentByHost[hostFilter] === undefined) {
      postMessage({ type: 'fetchRecentSessions', host: hostFilter })
    }
  }, [hostHasNoActive, hostFilter, recentByHost])
  const recentAgents = useMemo(
    () => (hostFilter && hostHasNoActive ? adaptRemote(recentByHost[hostFilter] ?? [], pinned, localHostName, projectRules) : []),
    [hostFilter, hostHasNoActive, recentByHost, pinned, localHostName, projectRules]
  )

  // PR board: lazy gh fan-out over the live feed's PR URLs on first open of the
  // PRs center (and again after a merge clears prStatuses back to null).
  useEffect(() => {
    if (center === 'prs' && prStatuses === null) {
      postMessage({ type: 'fetchPrBoard', urls: collectPrUrls(floorAgents) })
    }
  }, [center, prStatuses, floorAgents])
  const prRows = useMemo(() => buildPrBoard(prStatuses ?? [], floorAgents), [prStatuses, floorAgents])
  // Recap ledger: lazy fleet sweep the first time the Recap center opens; live
  // sessions are excluded (the feed owns what's running, the ledger what finished).
  useEffect(() => {
    if (center === 'recap' && recapSessions === null) postMessage({ type: 'fetchRecap' })
  }, [center, recapSessions])
  const recapDays = useMemo(() => {
    if (!recapSessions) return []
    const liveIds = new Set(floorAgents.map((a) => a.sessionId).filter((id): id is string => !!id))
    return buildRecap(recapSessions, liveIds, Date.now())
  }, [recapSessions, floorAgents])

  const needsAgents = useMemo(() => scopedAgents.filter((a) => a.needs), [scopedAgents])
  const waitingAgents = useMemo(() => needsAgents.filter((a) => a.phase === 'waiting'), [needsAgents])
  const failedAgents = useMemo(() => needsAgents.filter((a) => a.phase === 'failed'), [needsAgents])
  const questionClusters = useMemo(() => clusterByQuestion(waitingAgents), [waitingAgents])
  // Needs-you agents that aren't a waiting question or a failure: a stalled agent,
  // or a completed agent whose PR is open and unreviewed (the "Review & merge"
  // row). Previously these were counted in the header but never rendered.
  const reviewNeedsAgents = useMemo(
    () => sortAgents(needsAgents.filter((a) => a.phase !== 'waiting' && a.phase !== 'failed'), floorSort),
    [needsAgents, floorSort]
  )
  // One attention-ordered stream: NEEDS YOU -> RUNNING -> READY -> DONE, where
  // status is a position, not a filter. Running and idle agents are the live
  // lane; done (without an unreviewed PR — those are NEEDS YOU) is the terminal
  // lane. idle is no longer dropped from the feed.
  const runningFeed = useMemo(
    () => sortAgents(scopedAgents.filter((a) => !a.needs && (a.phase === 'running' || a.phase === 'idle')), floorSort),
    [scopedAgents, floorSort]
  )
  const doneFeed = useMemo(
    () => sortAgents(scopedAgents.filter((a) => !a.needs && a.phase === 'done'), floorSort),
    [scopedAgents, floorSort]
  )

  const floorRunning = useMemo(() => floorAgents.filter((a) => a.phase === 'running').length, [floorAgents])
  const floorTok = useMemo(() => floorAgents.reduce((s, a) => s + a.tok, 0) + liveThroughput, [floorAgents, liveThroughput])

  // Selected agent: only when the user explicitly picks one. No auto-select — the right
  // rail must not slam to a "WAITING ON YOU" agent nobody clicked.
  const selectedFloorAgent: FloorAgent | null = useMemo(
    () => (selectedAgentId ? floorAgents.find((a) => a.id === selectedAgentId) ?? null : null),
    [selectedAgentId, floorAgents]
  )

  const selectedFloorTicket = useMemo(
    () => (selectedTicketId ? floorTickets.find((t) => t.id === selectedTicketId) ?? null : null),
    [selectedTicketId, floorTickets]
  )

  // Real hosts for the dispatch panel: this machine + every reachable remote.
  const floorHosts = useMemo(() => {
    const set = new Set<string>(['this-mac'])
    for (const s of remoteSessions) if (s.host && s.host !== 'this-mac') set.add(s.host)
    return [...set]
  }, [remoteSessions])

  // ---------- Floor interaction handlers ----------
  const togglePin = useCallback((id: string) => {
    setPinned((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Reply transport: dispatch on the agent's reply channel (a.reply), computed by the
  // adapter from the agent's source. Local tabs also get focused so the user sees the
  // answer land in the terminal; cloud/team deliver headlessly via the CLI. The host
  // replies with a 'replyResult' we surface inline on failure — no toast, no fake success.
  // `keystroke` (a digit or 'esc') is set when the reply must drive an interactive
  // select-list prompt (permission / plan / AskUserQuestion) rather than type free text;
  // the extension host sends it through the terminal/tmux rail instead of the label.
  const replyToAgent = useCallback((a: FloorAgent, text: string, keystroke?: string) => {
    if (a.reply.kind === 'none') {
      setReplyErrors((prev) => new Map(prev).set(a.id, a.reply.reason || 'No reply channel for this agent'))
      return
    }
    if (a.reply.kind === 'terminal' && a.reply.terminalId) {
      postMessage({ type: 'focusTerminal', terminalId: a.reply.terminalId })
    }
    setReplyErrors((prev) => { const n = new Map(prev); n.delete(a.id); return n })
    postMessage({ type: 'replyToAgent', agentId: a.id, reply: a.reply, text, keystroke })
  }, [])

  const retryFloorAgent = useCallback((a: FloorAgent) => {
    const u = unifiedById.get(a.id)
    if (u?.swarm) handleRetry(u.swarm.task_name)
    else if (u?.terminal) postMessage({ type: 'focusTerminal', terminalId: u.terminal.id })
  }, [unifiedById, handleRetry])

  const onAgentOption = useCallback((a: FloorAgent, option: string) => {
    if (option === 'Retry') retryFloorAgent(a)
    else if (option === 'View error') { const u = unifiedById.get(a.id); if (u?.terminal) postMessage({ type: 'focusTerminal', terminalId: u.terminal.id }) }
    else {
      // If this option maps to an interactive select-list keystroke (permission Approve=1
      // / Deny=esc, plan, AskUserQuestion), send that keystroke so the TUI prompt is
      // actually driven; otherwise send the label as free text.
      const idx = a.question?.options.indexOf(option) ?? -1
      const key = idx >= 0 ? a.question?.optionKeys?.[idx] : undefined
      replyToAgent(a, option, key || undefined)
    }
  }, [retryFloorAgent, replyToAgent, unifiedById])

  // Screenshot attach: the capture/attach transport isn't wired yet. Intentionally a
  // no-op (no fake success) rather than pretending it worked. TODO: wire capture path.
  const onAttachScreenshot = useCallback((_a: FloorAgent) => { /* TODO: screenshot transport pending */ }, [])

  /**
   * Open/resume the session in a real terminal (RUSH-1520). Prefers an already-
   * open local tab, then a remote tmux rail, then `agents sessions focus <id>`.
   */
  const openTerminalForAgent = useCallback((a: FloorAgent) => {
    if (a.reply.kind === 'terminal' && a.reply.terminalId) {
      postMessage({ type: 'focusTerminal', terminalId: a.reply.terminalId })
      return
    }
    if (a.reply.kind === 'tmux' && a.reply.muxTarget) {
      postMessage({
        type: 'focusRemoteSession',
        host: a.reply.host,
        muxSocket: a.reply.muxSocket,
        muxTarget: a.reply.muxTarget,
        sessionId: a.reply.sessionId ?? a.sessionId,
        label: a.name,
      })
      return
    }
    if (a.sessionId) {
      postMessage({ type: 'focusSession', sessionId: a.sessionId, host: a.host })
      return
    }
    const u = unifiedById.get(a.id)
    if (u?.terminal) {
      postMessage({ type: 'focusTerminal', terminalId: u.terminal.id })
    }
  }, [unifiedById])

  const onBatchReply = useCallback((cluster: FloorAgent[], option: string) => {
    for (const a of cluster) replyToAgent(a, option)
  }, [replyToAgent])

  // Reassign a failed agent's work to a different installed agent (FailureCard action).
  const reassignFloorAgent = useCallback((a: FloorAgent, toAgent: string) => {
    postMessage({ type: 'reassignAgent', sessionId: a.id, host: a.host, toAgent })
  }, [])

  // Nudge a stalled (wedged) agent to wake it back up.
  const nudgeFloorAgent = useCallback((a: FloorAgent) => {
    postMessage({ type: 'nudgeAgent', sessionId: a.id, host: a.host })
  }, [])

  const openPlanPreview = useCallback((a: FloorAgent, plan: PlanFile) => {
    postMessage({ type: 'openPlanPreview', path: plan.path, kind: plan.kind, host: a.host })
  }, [])

  // Plan-review actions (Floor after-dispatch): approve as-is/edited, or send back a note.
  const approvePlan = useCallback((sessionId: string, edited?: PlanStep[]) => {
    postMessage({ type: 'approvePlan', sessionId, edited })
    setPendingPlans((prev) => prev.filter((p) => p.sessionId !== sessionId))
  }, [])
  const sendBackPlan = useCallback((sessionId: string, note: string) => {
    postMessage({ type: 'sendBackPlan', sessionId, note })
    setPendingPlans((prev) => prev.filter((p) => p.sessionId !== sessionId))
  }, [])

  // ---------- Sub-tab strip: fixed-center selection + dynamic task tabs ----------
  // Selecting a fixed center clears any active task tab so the center pane returns.
  const selectCenter = useCallback((c: CenterMode) => {
    setActiveTaskTab(null)
    setCenter(c)
  }, [])

  const openTaskFromTicket = useCallback((ticket: FloorTicket) => {
    setOpenTaskTabs((prev) => openTaskTab(prev, { id: ticket.id, title: ticket.title, source: ticket.source }))
    setActiveTaskTab(ticket.id)
  }, [])

  // Open (or focus) a task tab from an agent card. Keys off the agent's linked ticket
  // when it has one (so it collapses with the ticket's own tab); otherwise the agent id.
  const openTaskFromAgent = useCallback((a: FloorAgent) => {
    const id = a.ticket ?? a.id
    const source: TicketSource = a.ticket?.startsWith('#') ? 'GH' : 'LN'
    setOpenTaskTabs((prev) => openTaskTab(prev, { id, title: a.ticket ?? a.name, source }))
    setActiveTaskTab(id)
  }, [])

  const selectTaskTab = useCallback((id: string) => setActiveTaskTab(id), [])

  const handleCloseTaskTab = useCallback((id: string) => {
    // Compute both next states from current state in one pass — no nested setState
    // (an updater must be pure; nesting one inside another ran the reducer twice
    // under StrictMode and lost the next active id). Deps keep the reads fresh.
    const res = closeTaskTab(openTaskTabs, activeTaskTab, id)
    setOpenTaskTabs(res.tabs)
    setActiveTaskTab(res.activeId)
  }, [openTaskTabs, activeTaskTab])

  const onScope = useCallback((value: string) => {
    if (value === '__queue') { setCenter('backlog'); return }
    if (value === '__recap') { setCenter('recap'); return }
    if (value === '__needs') {
      // A REAL needs-only view: toggle the same 'needs' status chip the controls bar
      // and saved views drive, so one filter mechanism serves all three surfaces.
      setCenter('agents'); setProjFilter(null); setHostFilter(null)
      setStatusChips((cur) => (cur.includes('needs') ? cur.filter((c) => c !== 'needs') : ['needs']))
      return
    }
    if (value.startsWith('host:')) {
      const h = value.slice(5)
      setCenter('agents'); setProjFilter(null)
      setHostFilter((cur) => (cur === h ? null : h)) // click again to clear
      // Scoping to a host replaces the needs narrowing, mirroring how '__needs'
      // replaces the project/host scope — the smart views are mutually exclusive.
      setStatusChips((cur) => cur.filter((c) => c !== 'needs'))
      return
    }
    setCenter('agents')
    setHostFilter(null)
    setProjFilter(value || null)
    // Project scope and 'All agents' ('') both drop the needs narrowing too.
    setStatusChips((cur) => cur.filter((c) => c !== 'needs'))
  }, [])

  // Selecting an agent opens its detail rail — the SAME setRightOpen(true) that
  // onSelectHost does. These two were the drifted pair: this one omitted it, so
  // clicking an agent card silently did nothing (the rail only renders when
  // rightOpen). Keep them symmetric.
  const selectFloorAgent = useCallback((id: string) => {
    setCenter('agents')
    setSelectedAgentId(id)
    setRightOpen(true)
  }, [])

  // Host detail pane: clicking a host in the sidebar opens its detail/config on
  // the right and fetches its inventory (cached backend-side).
  const onSelectHost = useCallback((hostName: string) => {
    setCenter('host')
    setSelectedHostId(hostName)
    setHostConfigError(null)
    setRightOpen(true)
    postMessage({ type: 'fetchHostInventory', host: hostName })
  }, [])
  const refreshHost = useCallback((hostName: string) => {
    postMessage({ type: 'fetchHostInventory', host: hostName, force: true })
  }, [])
  const enrollHostAction = useCallback((hostName: string, caps: string[]) => {
    setHostConfigError(null)
    postMessage({ type: 'enrollHost', host: hostName, caps })
  }, [])
  const removeHostAction = useCallback((hostName: string) => {
    setHostConfigError(null)
    postMessage({ type: 'removeHost', host: hostName })
  }, [])

  // Right-pane detail for the selected agent: a decision block when it needs you, then
  // the reused rich DetailPane (local) or a light remote summary (cross-host).
  const renderAgentDetail = () => {
    const a = selectedFloorAgent
    if (!a) {
      return <div className="detail-empty">Select an agent or issue to open its conversation and reply here.</div>
    }
    // The "needs you" decision block (why blocked · original task · the question +
    // option chips + reply). Extracted to AgentDecision so the preview harness renders
    // the exact same markup.
    const decision = a.needs ? (
      <AgentDecision
        agent={a}
        error={replyErrors.get(a.id)}
        onOption={(o) => onAgentOption(a, o)}
        onFreeText={(t) => replyToAgent(a, t)}
        onAttach={() => onAttachScreenshot(a)}
        onNudge={() => nudgeFloorAgent(a)}
      />
    ) : null

    const u = unifiedById.get(a.id)
    return (
      <>
        {decision}
        {u ? (
          <DetailPane
            item={u}
            onClose={() => setSelectedAgentId(null)}
            onFocusTerminal={handleFocusTerminal}
            onRetry={handleRetry}
            onKill={handleKill}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}>
            <div className="dhead" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              <div className="title">{a.project} / {a.name}</div>
              <div className="sub">host <b>{a.hostLabel ?? a.host}</b>{(a.worktreeSlug || a.branch) ? ` · ${a.worktreeSlug || a.branch}` : ''} · {a.phase}{a.tok ? ` · ${a.tok} tok/s` : ''}{a.ticket ? ` · ${a.ticket}` : ''}</div>
              {/* Artifacts row: the agent's outputs at a glance — the PR (click-through),
                  CI, the team it spawned, and tickets it created. Mirrors the card chips. */}
              {(a.prUrl || a.ci || a.spawnedTeam || (a.createdTickets?.length ?? 0) > 0 || (a.createdCommits?.length ?? 0) > 0 || (a.plans?.length ?? 0) > 0) && (
                <div className="arts">
                  {(a.plans ?? []).map((plan) => (
                    <button
                      key={plan.path}
                      type="button"
                      className="art plan"
                      title={`Preview ${plan.path}`}
                      onClick={() => openPlanPreview(a, plan)}
                    >
                      <Icon name="external" size={10} /> {plan.label}
                    </button>
                  ))}
                  {a.prUrl && (
                    <ExtLink href={a.prUrl} className="art pr" style={{ textDecoration: 'none' }}>
                      <Icon name="chevR" size={10} /> PR {a.pr ?? ''}
                    </ExtLink>
                  )}
                  {a.ci && <span className={`art ci ${a.ci}`}>CI {a.ci}</span>}
                  {a.spawnedTeam && <span className="art team"><Icon name="grip" size={10} /> team · {a.spawnedTeam}</span>}
                  {(a.createdTickets ?? []).map((t) => {
                    const href = linearIssueUrl(t)
                    const label = linearIssueLabel(t)
                    return href
                      ? <ExtLink key={t} href={href} className="art tk" style={{ textDecoration: 'none' }}><Icon name="plus" size={10} /> {label}</ExtLink>
                      : <span key={t} className="art tk"><Icon name="plus" size={10} /> {label}</span>
                  })}
                  {(a.createdCommits ?? []).map((sha) => (
                    <span key={sha} className="art commit"><Icon name="gitBranch" size={10} /> commit {sha}</span>
                  ))}
                </div>
              )}
              {/* Actions: give a selected agent something to DO (issue: clicking a card
                  offered nothing). Focus opens the session's terminal — local via the
                  live vscode terminal, remote via an ssh + tmux-attach terminal.
                  Headless (background) runs have no reply terminal/tmux, so they get a
                  dedicated Focus (attach a fresh terminal via `agents sessions focus`)
                  plus a Stop that kills the run's pid. */}
              <div className="opts" style={{ marginTop: 8, flexWrap: 'wrap', gap: 6 }}>
                {a.reply.kind === 'terminal' && a.reply.terminalId && (
                  <button className="opt" onClick={() => postMessage({ type: 'focusTerminal', terminalId: a.reply.terminalId })}>
                    <Icon name="chevR" size={11} /> Focus terminal
                  </button>
                )}
                {a.reply.kind === 'tmux' && a.reply.muxTarget && (
                  <button className="opt" onClick={() => postMessage({ type: 'focusRemoteSession', host: a.reply.host, muxSocket: a.reply.muxSocket, muxTarget: a.reply.muxTarget, sessionId: a.reply.sessionId, label: a.name })}>
                    <Icon name="chevR" size={11} /> Focus in terminal
                  </button>
                )}
                {a.context === 'headless' && a.sessionId && (
                  <button className="opt" onClick={() => postMessage({ type: 'focusSession', sessionId: a.sessionId!, host: a.host })}>
                    <Icon name="chevR" size={11} /> Focus
                  </button>
                )}
                {a.context === 'headless' && a.pid ? (
                  <button className="opt ghost" onClick={() => postMessage({ type: 'stopSession', sessionId: a.sessionId!, pid: a.pid })}>
                    Stop
                  </button>
                ) : null}
                {a.worktreePath && (
                  <button className="opt" onClick={() => postMessage({ type: 'revealWorktree', path: a.worktreePath, host: a.host })}>
                    <Icon name="chevR" size={11} /> Reveal worktree
                  </button>
                )}
                {a.prUrl && (
                  <ExtLink href={a.prUrl} className="opt ghost" style={{ textDecoration: 'none' }}>
                    <Icon name="chevR" size={11} /> Open PR {a.pr ?? ''}
                  </ExtLink>
                )}
              </div>
            </div>
            {/* Task anchor: the ORIGINAL prompt (markdown), distinct from the last message.
                Falls back through sessionTaskLine (prompt -> summary -> resp -> slug/branch)
                so the detail rail always shows a task, even for a promptless session. */}
            {(() => {
              const task = a.prompt?.trim() || sessionTaskLine(a)
              return task ? (
                <div className="sw-unified-detail-section">
                  <div className="sw-section-label">Task</div>
                  <div className="md">{renderMarkdown(task)}</div>
                </div>
              ) : null
            })()}
            {/* Progress timeline: the recent tool calls as a vertical rail, oldest -> now.
                For cloud rows the existing CloudActivityFeed still drives the AgentDetailView. */}
            {a.recent.length > 0 && (
              <div className="sw-unified-detail-section">
                <div className="sw-section-label">Progress <span className="sw-section-count">{Math.min(a.recent.length, 8)} recent</span></div>
                <VerticalTimeline recent={a.recent} nowMs={nowMs} />
              </div>
            )}
            {/* Streaming Activity feed: the recent assistant messages (markdown), newest at
                the bottom, capped by a live "now" verb/target indicator that updates on the
                3s poll. Falls back to the single last response when only `resp` is carried. */}
            {(a.messages.length > 0 || a.resp || a.verb || a.target) && (
              <div className="sw-unified-detail-section">
                <div className="sw-section-label">Activity</div>
                <div className="sw-activity-feed">
                  {(a.messages.length > 0 ? a.messages : (a.resp ? [a.resp] : [])).map((m, i) => (
                    <div key={i} className="sw-activity-msg md">{renderMarkdown(m)}</div>
                  ))}
                  {(a.verb || a.target) && (
                    <div className={`sw-activity-now nowline ${a.phase === 'stalled' ? 'stall' : ''}`}>
                      <span className="sw-activity-dot" />
                      <span className="v">{a.verb}</span> {a.target}
                    </div>
                  )}
                </div>
              </div>
            )}
            {!a.needs && (a.phase === 'idle' || a.phase === 'done') && a.reply.kind !== 'none' && (
              <div style={{ padding: '0 16px 14px' }}>
                <FollowUpBox key={a.id} onSend={(t) => replyToAgent(a, t)} />
                {replyErrors.get(a.id) && <div className="reply-err" role="alert">{replyErrors.get(a.id)}</div>}
              </div>
            )}
          </div>
        )}
      </>
    )
  }

  // The fixed sub-tabs: one per CenterMode, with a live count + (agents) needs badge.
  const fixedTabs: FixedTab[] = useMemo(() => [
    { center: 'agents', label: 'Agents', count: floorAgents.length, needs: needsAgents.length },
    { center: 'backlog', label: 'Backlog', count: floorTickets.length },
    { center: 'projects', label: 'Projects', count: managedProjects.length },
    { center: 'host', label: 'Hosts', count: fleetDevices.length },
    // Recap count = today's finished sessions (0 until the lazy sweep has run).
    { center: 'recap', label: 'Recap', count: recapDays[0]?.label === 'Today' ? recapDays[0].sessions : 0 },
    // PRs count = open rows once fetched; before the first fetch, the URL count.
    { center: 'prs', label: 'PRs', count: prStatuses === null ? collectPrUrls(floorAgents).length : prRows.filter((r) => r.state === 'open').length },
  ], [floorAgents, needsAgents.length, floorTickets.length, managedProjects.length, fleetDevices.length, recapDays, prStatuses, prRows])

  // Resolve the active task tab (if any) back to a bench FlatTask so its detail renders.
  const activeTab = activeTaskTab ? openTaskTabs.find((t) => t.id === activeTaskTab) ?? null : null
  const activeTabTask: FlatTask | null = activeTab
    ? (() => {
        const ut = unifiedTasks.find((t) => t.id === activeTab.id || t.metadata.identifier === activeTab.id)
        return ut
          ? { id: ut.id, source: ut.source, title: ut.title, description: ut.description, status: ut.status, priority: ut.priority, metadata: ut.metadata }
          : null
      })()
    : null
  // Only render a bar for centers that HAVE one (agents/backlog); a task tab suppresses it.
  const controlsMode = activeTaskTab ? null : floorControlsMode(center)

  const centerContent = activeTab ? (
    <div className="feed sw-tasktab-pane">
      <div className="sw-bench-detail">
        {activeTabTask ? (
          <TaskDetail
            task={activeTabTask}
            onDispatch={(t) => openDispatch({ ticketId: t.id })}
            onDismiss={() => handleCloseTaskTab(activeTab.id)}
            onOpenExternal={(url) => postMessage({ type: 'openExternal', url })}
          />
        ) : (
          <div className="detail-empty" style={{ flexDirection: 'column', gap: 12 }}>
            <span>{activeTab.title}</span>
            <button className="disp" onClick={() => openDispatch({ ticketId: activeTab.id })}>
              <Icon name="zap" size={12} /> Dispatch
            </button>
          </div>
        )}
      </div>
    </div>
  ) : center === 'backlog' ? (
    <BacklogCenter
      tickets={floorTickets}
      group={ticketGroup}
      sort={ticketSort}
      srcFilter={ticketSrc}
      projFilter={projFilter}
      search={floorSearch}
      selectedTicketId={selectedTicketId}
      workers={floorWorkers}
      onSelectTicket={(id) => setSelectedTicketId(id)}
      onOpenTask={openTaskFromTicket}
    />
  ) : center === 'recap' ? (
    <RecapPane
      days={recapDays}
      loading={recapSessions === null}
      onOpenUrl={(url) => postMessage({ type: 'openExternal', url })}
    />
  ) : center === 'prs' ? (
    <PrBoardPane
      rows={prRows}
      loading={prStatuses === null}
      merging={prMerging}
      errors={prErrors}
      onMerge={(url) => {
        setPrMerging((prev) => new Set(prev).add(url))
        setPrErrors((prev) => { const { [url]: _gone, ...rest } = prev; return rest })
        postMessage({ type: 'mergePr', url })
      }}
      onOpenUrl={(url) => postMessage({ type: 'openExternal', url })}
      onRefresh={() => setPrStatuses(null)}
      onSelectAgent={selectFloorAgent}
    />
  ) : (
    <div className="feed">
      <SavedViews
        views={savedViews}
        activeName={activeViewName}
        onApply={applyView}
        onSave={saveView}
        onDelete={deleteView}
        feedFilters={{
          group: floorGroup,
          onGroup: setFloorGroup,
          status: statusChips,
          onToggleStatus: (s) => setStatusChips((cur) => (
            cur.includes(s) ? cur.filter((c) => c !== s) : [...cur, s]
          )),
          abbrs: abbrChips,
          availableAbbrs: Array.from(new Set(floorAgents.map((a) => a.abbr))).sort(),
          onToggleAbbr: (a) => setAbbrChips((cur) => (
            cur.includes(a) ? cur.filter((c) => c !== a) : [...cur, a]
          )),
        }}
      />
      {(needsAgents.length > 0 || pendingPlans.length > 0) && (
        <>
          <div className="feed-sec attn">
            <Icon name="alert" size={11} /> NEEDS YOU · {needsAgents.length + pendingPlans.length}{projFilter ? ` · ${projFilter}` : ''}
            <span className="ln" />
          </div>
          {pendingPlans.map((plan) => (
            <PlanReview
              key={plan.sessionId}
              plan={plan}
              onApprove={(edited) => approvePlan(plan.sessionId, edited)}
              onSendBack={(note) => sendBackPlan(plan.sessionId, note)}
            />
          ))}
          <NeedsYouClusters
            clusters={questionClusters.filter((c) => c.length > 1)}
            onBatchReply={onBatchReply}
            onReplyOne={selectFloorAgent}
          />
          {questionClusters.filter((c) => c.length === 1).map((c) => (
            <FeedRow onOpenTask={openTaskFromAgent}
              key={c[0].id}
              agent={c[0]}
              selected={selectedFloorAgent?.id === c[0].id}
              plain={plain}
              onSelect={selectFloorAgent}
              onOption={onAgentOption}
              onFreeText={replyToAgent}
              onAttach={onAttachScreenshot}
              onOpenPlan={openPlanPreview}
              onOpenTerminal={openTerminalForAgent}
            />
          ))}
          {failedAgents.map((a) => (
            <FailureCard
              key={a.id}
              agent={a}
              agents={dispatchAgents}
              onRetry={() => retryFloorAgent(a)}
              onReassign={(toAgent) => reassignFloorAgent(a, toAgent)}
            />
          ))}
          {reviewNeedsAgents.map((a) => (
            <FeedRow onOpenTask={openTaskFromAgent}
              key={a.id}
              agent={a}
              selected={selectedFloorAgent?.id === a.id}
              plain={plain}
              onSelect={selectFloorAgent}
              onOption={onAgentOption}
              onFreeText={replyToAgent}
              onAttach={onAttachScreenshot}
              onOpenPlan={openPlanPreview}
              onOpenTerminal={openTerminalForAgent}
            />
          ))}
        </>
      )}

      <div className="feed-sec">{floorGroup === 'none' ? `RUNNING · ${runningFeed.length}` : `GROUPED BY ${floorGroup.toUpperCase()} · ${runningFeed.length + doneFeed.length}`}<span className="ln" />
        <span
          className={`fresh${syncingHosts ? ' syncing' : ''}${!syncingHosts && lastRemoteSync > 0 && nowMs - lastRemoteSync > 2 * REMOTE_POLL_MS ? ' stale' : ''}`}
          title="Last cross-host sync. Click to refresh now."
          onClick={() => { if (!syncingHosts) { setSyncingHosts(true); postMessage({ type: 'fetchHostSessions' }) } }}
        >
          <span className="rot"><Icon name="refresh" size={11} /></span>
          {syncingHosts
            ? 'syncing hosts…'
            : lastRemoteSync > 0
              ? `hosts synced ${sinceFromMs(Math.max(0, nowMs - lastRemoteSync))} ago`
              : 'not synced yet'}
        </span>
      </div>
      {floorGroup === 'none'
        ? runningFeed.map((a) => (
            <FeedRow onOpenTask={openTaskFromAgent}
              key={a.id}
              agent={a}
              selected={selectedFloorAgent?.id === a.id}
              plain={plain}
              onSelect={selectFloorAgent}
              onOption={onAgentOption}
              onFreeText={replyToAgent}
              onAttach={onAttachScreenshot}
              onOpenPlan={openPlanPreview}
              onOpenTerminal={openTerminalForAgent}
            />
          ))
        : [...groupAgents([...runningFeed, ...doneFeed], floorGroup).entries()].map(([k, arr]) => {
            // When grouped by project, enrich the header: "N agents" + a Linear project
            // link pill (mockup: "agents-cli · 8 agents · RUSH · Agents CLI").
            const linkedProject = floorGroup === 'project'
              ? managedProjects.find((p) => p.name === k)?.linearProjectName
              : undefined
            const countLabel = floorGroup === 'project'
              ? `${arr.length} agent${arr.length === 1 ? '' : 's'}`
              : `${arr.length}`
            return (
            <React.Fragment key={k}>
              <div className="feed-sec">
                {k} · {countLabel}
                {linkedProject && <span className="proj-lk">{linkedProject}</span>}
                <span className="ln" />
              </div>
              {arr.map((a) => (
                <FeedRow onOpenTask={openTaskFromAgent}
                  key={a.id}
                  agent={a}
                  selected={selectedFloorAgent?.id === a.id}
                  plain={plain}
                  onSelect={selectFloorAgent}
                  onOption={onAgentOption}
                  onFreeText={replyToAgent}
                  onAttach={onAttachScreenshot}
                  onOpenPlan={openPlanPreview}
              onOpenTerminal={openTerminalForAgent}
                />
              ))}
            </React.Fragment>
          )})}

      {floorGroup === 'none' && doneFeed.length > 0 && (
        <>
          <div className="feed-sec">DONE TODAY · {doneFeed.length}<span className="ln" /></div>
          {doneFeed.map((a) => (
            <FeedRow onOpenTask={openTaskFromAgent}
              key={a.id}
              agent={a}
              selected={selectedFloorAgent?.id === a.id}
              plain={plain}
              onSelect={selectFloorAgent}
              onOption={onAgentOption}
              onFreeText={replyToAgent}
              onAttach={onAttachScreenshot}
              onOpenPlan={openPlanPreview}
              onOpenTerminal={openTerminalForAgent}
            />
          ))}
        </>
      )}

      {hostHasNoActive && (
        <>
          <div className="feed-sec">RECENT · {recentAgents.length}{hostFilter ? ` · ${hostFilter}` : ''}<span className="ln" /></div>
          {recentAgents.length === 0 ? (
            <div className="detail-empty" style={{ padding: '10px 16px' }}>No recent sessions for this host.</div>
          ) : recentAgents.map((a) => (
            <FeedRow onOpenTask={openTaskFromAgent}
              key={a.id}
              agent={a}
              selected={selectedFloorAgent?.id === a.id}
              plain={plain}
              onSelect={selectFloorAgent}
              onOption={onAgentOption}
              onFreeText={replyToAgent}
              onAttach={onAttachScreenshot}
              onOpenPlan={openPlanPreview}
              onOpenTerminal={openTerminalForAgent}
            />
          ))}
        </>
      )}
    </div>
  )

  const rightContent = center === 'projects'
    ? <ProjectsPane
        projects={managedProjects}
        rollups={floorRollups}
        linearProjects={linearProjects}
        pickedFolder={pickedFolder}
        onSave={(p) => postMessage({ type: 'saveManagedProject', project: p })}
        onDelete={(id) => postMessage({ type: 'deleteManagedProject', id })}
        onPickFolder={() => postMessage({ type: 'pickProjectFolder' })}
        onClose={() => setCenter('agents')}
      />
    : center === 'host'
    ? (selectedHostId
      ? <HostDetail
          host={selectedHostId}
          inventory={hostInventories[selectedHostId] ?? null}
          configError={hostConfigError}
          onRefresh={() => refreshHost(selectedHostId)}
          onEnroll={(caps) => enrollHostAction(selectedHostId, caps)}
          onRemove={() => removeHostAction(selectedHostId)}
          onDispatch={() => setDispatchOpen(true)}
        />
      : <div className="detail-empty">Select a host to see its installed agents and configuration.</div>)
    : center === 'backlog'
    ? (selectedFloorTicket
      ? <TicketDetail
          ticket={selectedFloorTicket}
          hosts={floorHosts}
          workers={floorWorkers[selectedFloorTicket.id] ?? []}
          onSelectAgent={selectFloorAgent}
          onDispatch={() => openDispatch({ ticketId: selectedFloorTicket.id })}
        />
      : <div className="detail-empty">Select a ticket to see its details and dispatch an agent onto it.</div>)
    : renderAgentDetail()

  return (
    <div className="sw-floor-dashboard" style={{ padding: 0, overflow: 'hidden' }}>
      <FloorSubtabs
        fixed={fixedTabs}
        center={center}
        taskTabs={openTaskTabs}
        activeTaskTab={activeTaskTab}
        onSelectCenter={selectCenter}
        onSelectTaskTab={selectTaskTab}
        onCloseTaskTab={handleCloseTaskTab}
        onDispatch={() => openDispatch(selectedTicketId ? { ticketId: selectedTicketId } : undefined)}
      />

      {controlsMode && (
        <FloorControls
          mode={controlsMode}
          needsCount={needsAgents.length}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          rightOpen={rightOpen}
          onToggleRight={() => setRightOpen((o) => !o)}
          plain={plain}
          onTogglePlain={() => setPlain((o) => !o)}
          sort={floorSort}
          onSort={setFloorSort}
          group={floorGroup}
          onGroup={setFloorGroup}
          ticketGroup={ticketGroup}
          onTicketGroup={setTicketGroup}
          ticketSort={ticketSort}
          onTicketSort={setTicketSort}
          srcFilter={ticketSrc}
          onToggleSrc={(src) => setTicketSrc((p) => ({ ...p, [src]: !p[src] }))}
        />
      )}

      <div className="page" style={{ flex: 1, minHeight: 0, height: 'auto' }}>
        {sidebarOpen && (railCollapsed ? (
          <FloorRail
            agents={floorAgents}
            tickets={floorTickets}
            center={center}
            projFilter={projFilter}
            hostFilter={hostFilter}
            needsOnly={statusChips.includes('needs')}
            projects={managedProjects}
            devices={
              dispatchDevices.length
                ? dispatchDevices.map((d) => ({ name: d.name, online: !!d.reachable, agents: d.runningAgents ?? 0 }))
                : fleetDevices.map((d) => ({ name: d.name, online: d.online, agents: 0 }))
            }
            offlineHosts={offlineHosts}
            hostPins={effectiveHostPins}
            localHost={localHostName || undefined}
            onScope={onScope}
            onDispatch={() => openDispatch(selectedTicketId ? { ticketId: selectedTicketId } : undefined)}
            onManageProjects={() => { setCenter('projects'); setRightOpen(true) }}
            onExpand={() => setRailCollapsed(false)}
          />
        ) : (
          <FloorSidebar
            agents={floorAgents}
            tickets={floorTickets}
            projFilter={projFilter}
            hostFilter={hostFilter}
            offlineHosts={offlineHosts}
            devices={
              dispatchDevices.length
                ? dispatchDevices.map((d) => ({ name: d.name, online: !!d.reachable, agents: d.runningAgents ?? 0 }))
                : fleetDevices.map((d) => ({ name: d.name, online: d.online, agents: 0 }))
            }
            hostPins={effectiveHostPins}
            onToggleHostPin={toggleHostPin}
            onReorderHostPins={reorderHostPins}
            onScope={onScope}
            onCollapse={() => setRailCollapsed(true)}
            onSelectHost={onSelectHost}
            selectedHost={center === 'host' ? selectedHostId : null}
            hosts={hostRoster}
            localHost={localHostName || undefined}
            projects={managedProjects}
            onManageProjects={() => { setCenter('projects'); setRightOpen(true) }}
          />
        ))}
        <div className="feed-col">{centerContent}</div>
        {rightOpen && <div className="detail-col">{rightContent}</div>}
      </div>

      {cardDragActive && (
        <div
          className="sw-quick-dispatch-dropzone"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
          onDrop={(e) => {
            e.preventDefault()
            const text = e.dataTransfer.getData('text/plain')
            setCardDragActive(false)
            if (text) openDispatch({ prefill: text })
          }}
        >
          Drop to start an agent with this issue
        </div>
      )}

      {/* Intake Q&A -- teammates waiting on a human answer */}
      {intakeTeams.length > 0 && (
        <div className="sw-intake-section">
          {intakeTeams.map((team) => (
            <IntakeBanner key={team.team} team={team.team} teammates={team.agents} />
          ))}
        </div>
      )}

      {/* The single consolidated Dispatch panel — replaces the 5 legacy dispatch
          surfaces. Self-manages its open state via the `open` prop (returns null when
          closed) and re-seeds prefill/ticket each time it opens. */}
      <DispatchPanel
        open={dispatchOpen}
        tasks={unifiedTasks}
        agents={dispatchAgents}
        hosts={panelHosts}
        targets={dispatchTargets}
        prefill={dispatchPrefill}
        prefillTicketId={dispatchPrefillTicketId}
        onClose={() => setDispatchOpen(false)}
        onDispatch={onDispatchRequest}
        onDraftPrompt={onDraftPrompt}
        draftResult={draftResult}
        devices={dispatchDevices}
        deviceRepos={deviceRepos}
        deviceSync={deviceSync}
        onRequestRepoSync={onRequestRepoSync}
        onManageDevices={onManageDevices}
        onDeviceDispatch={onDeviceDispatch}
      />
    </div>
  )
}


/**
 * Inline banner for teammates waiting on human input.
 *
 * One banner per team; shows which teammates are blocked and provides a
 * single textarea whose submit forwards to `agents factory answer <team>`
 * via the extension backend. Oldest input_required teammate is the one
 * that gets the message (matches CLI behavior).
 */
function IntakeBanner({ team, teammates }: { team: string; teammates: { teammate: string; agentId: string }[] }) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const names = teammates.map((t) => t.teammate).join(', ')

  const submit = () => {
    const body = text.trim()
    if (!body || submitting) return
    setSubmitting(true)
    postMessage({ type: 'factoryAnswer', teamId: team, text: body })
    setText('')
    // Leave submitting=true briefly so the button disables until the next
    // status refresh removes this teammate from input_required.
    setTimeout(() => setSubmitting(false), 1500)
  }

  return (
    <div className="sw-intake-banner" role="status">
      <div className="sw-intake-banner-head">
        <Icon name="zap" size={13} />
        <span className="sw-intake-banner-title">
          {teammates.length === 1 ? 'Waiting on you' : `${teammates.length} teammates waiting on you`}
        </span>
        <span className="sw-intake-banner-sub">
          {team} · {names}
        </span>
      </div>
      <div className="sw-intake-banner-form">
        <textarea
          className="sw-intake-banner-input"
          placeholder="Your answer..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
          rows={2}
        />
        <button
          type="button"
          className="sw-btn primary sm"
          onClick={submit}
          disabled={!text.trim() || submitting}
        >
          Send
        </button>
      </div>
    </div>
  )
}

type IdentityLabel = { text: string; variant: 'plain' | 'cloud' | 'team' | 'plan' | 'ralph' | 'auto' }

function identityLabel(item: UnifiedAgent): IdentityLabel {
  const termLabel = item.terminal?.label?.trim()
  if (termLabel) return { text: termLabel, variant: 'plain' }
  if (item.kind === 'team') {
    const n = item.teamAgents?.length ?? 0
    return { text: n > 0 ? `TEAM · ${n}` : 'TEAM', variant: 'team' }
  }
  if (item.kind === 'cloud' || item.mode === 'cloud') {
    return { text: 'CLOUD', variant: 'cloud' }
  }
  if (item.mode === 'plan') return { text: 'PLAN', variant: 'plan' }
  if (item.mode === 'ralph') return { text: 'RALPH', variant: 'ralph' }
  if (item.mode === 'auto') return { text: 'AUTO', variant: 'auto' }
  return { text: item.terminal?.autoLabel || item.displayName || item.agentType, variant: 'plain' }
}

function statusPhrase(item: UnifiedAgent): { word: string; tone: 'running' | 'idle' | 'failed' | 'completed' | 'waiting'; when: string } {
  if (item.status === 'failed') {
    return { word: 'Failed', tone: 'failed', when: item.timestamp ? relTime(item.timestamp) : '' }
  }
  if (item.status === 'completed') {
    return { word: 'Done', tone: 'completed', when: item.timestamp ? relTime(item.timestamp) : '' }
  }
  if (item.terminal?.waitingForInput && (item.status === 'running' || item.active)) {
    return { word: 'Waiting', tone: 'waiting', when: item.duration || (item.timestamp ? relTime(item.timestamp) : '') }
  }
  if (item.status === 'running' || item.active) {
    return { word: 'Running', tone: 'running', when: item.duration || (item.timestamp ? relTime(item.timestamp) : '') }
  }
  return { word: 'Idle', tone: 'idle', when: item.timestamp ? relTime(item.timestamp) : '' }
}

interface ScanCycle {
  ts: number
  events: WatchdogEventUI[]
}

function groupIntoCycles(events: WatchdogEventUI[]): ScanCycle[] {
  if (events.length === 0) return []
  const GAP_MS = 45_000
  const cycles: ScanCycle[] = []
  let current: ScanCycle = { ts: events[0].ts, events: [] }
  for (const ev of events) {
    if (ev.ts - current.ts > GAP_MS && current.events.length > 0) {
      cycles.push(current)
      current = { ts: ev.ts, events: [] }
    }
    current.events.push(ev)
    current.ts = ev.ts
  }
  if (current.events.length > 0) cycles.push(current)
  return cycles.reverse()
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatStalledFor(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m ${sec % 60}s`
}

function WatchdogDetail({ events }: { events: WatchdogEventUI[] }) {
  const [expandedTails, setExpandedTails] = useState<Set<number>>(new Set())

  const toggleTail = (idx: number) => {
    setExpandedTails((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }

  if (events.length === 0) {
    return (
      <div className="sw-unified-detail-content">
        <div className="sw-unified-detail-empty" style={{ padding: '24px 0', textAlign: 'center' }}>
          No scans yet. Watchdog runs every minute — it will appear here once it checks a terminal.
        </div>
      </div>
    )
  }

  const cycles = groupIntoCycles(events)

  return (
    <div className="sw-unified-detail-content">
      {cycles.map((cycle, ci) => {
        const ticks = cycle.events.filter((e) => e.kind === 'tick')
        const nudges = cycle.events.filter((e) => e.kind === 'nudge')
        const rotates = cycle.events.filter((e) => e.kind === 'rotate')
        const errors = cycle.events.filter((e) => e.kind === 'error')

        return (
          <div key={ci} className="sw-unified-detail-section" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                {formatTime(cycle.events[0].ts)}
              </span>
              <span style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                {ticks.length} terminal{ticks.length !== 1 ? 's' : ''} scanned
                {nudges.length > 0 && ` · ${nudges.length} nudged`}
                {rotates.length > 0 && ` · ${rotates.length} rotated`}
                {errors.length > 0 && ` · ${errors.length} error${errors.length !== 1 ? 's' : ''}`}
              </span>
            </div>

            {ticks.map((tick, ti) => {
              const globalIdx = ci * 100 + ti
              const isTailOpen = expandedTails.has(globalIdx)
              const decision = cycle.events.find(
                (e) => e.kind === 'decision' && e.terminalId === tick.terminalId
              )
              const nudge = cycle.events.find(
                (e) => e.kind === 'nudge' && e.terminalId === tick.terminalId
              )

              return (
                <div
                  key={ti}
                  style={{
                    background: 'var(--ds-bg-panel)',
                    border: '1px solid var(--ds-border-subtle)',
                    borderRadius: 6,
                    padding: '10px 12px',
                    marginBottom: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>
                      {tick.terminalId}
                    </span>
                    {tick.agentType && (
                      <span style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>({tick.agentType})</span>
                    )}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                      stalled {tick.stalledForMs !== undefined ? formatStalledFor(tick.stalledForMs) : tick.message}
                    </span>
                  </div>

                  {(tick.lastUserMessage || tick.lastAssistantMessage ||
                    decision?.lastUserMessage || decision?.lastAssistantMessage ||
                    nudge?.lastUserMessage || nudge?.lastAssistantMessage) && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                      {(tick.lastUserMessage || decision?.lastUserMessage || nudge?.lastUserMessage) && (
                        <div style={{ fontSize: 11, lineHeight: 1.4 }}>
                          <span style={{ color: 'var(--ds-text-dim)' }}>User: </span>
                          <span style={{ color: 'var(--ds-text-muted)' }}>
                            {tick.lastUserMessage || decision?.lastUserMessage || nudge?.lastUserMessage}
                          </span>
                        </div>
                      )}
                      {(tick.lastAssistantMessage || decision?.lastAssistantMessage || nudge?.lastAssistantMessage) && (
                        <div style={{ fontSize: 11, lineHeight: 1.4 }}>
                          <span style={{ color: 'var(--ds-text-dim)' }}>Agent: </span>
                          <span style={{ color: 'var(--ds-text-muted)' }}>
                            {tick.lastAssistantMessage || decision?.lastAssistantMessage || nudge?.lastAssistantMessage}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {tick.tailLines && tick.tailLines.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <button
                        type="button"
                        className="sw-link-btn"
                        style={{ fontSize: 10.5, color: 'var(--ds-text-dim)', marginBottom: isTailOpen ? 6 : 0 }}
                        onClick={() => toggleTail(globalIdx)}
                      >
                        {isTailOpen ? 'Hide' : 'Show'} {tick.tailLines.length} lines read
                      </button>
                      {isTailOpen && (
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 9.5,
                            lineHeight: 1.5,
                            color: 'var(--ds-text-dim)',
                            background: 'var(--muted)',
                            borderRadius: 4,
                            padding: '6px 8px',
                            overflow: 'auto',
                            maxHeight: 160,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                        >
                          {tick.tailLines.join('\n')}
                        </pre>
                      )}
                    </div>
                  )}

                  {decision && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          className={`sw-badge ${nudge ? 'running' : 'ok'}`}
                          style={{ fontSize: 10 }}
                        >
                          {nudge ? 'NUDGE' : 'SKIP'}
                        </span>
                        {decision.reason && (
                          <span style={{ fontSize: 11, color: 'var(--ds-text-muted)' }}>
                            {decision.reason}
                          </span>
                        )}
                        <span style={{ flex: 1 }} />
                        {nudge && (
                          <span className="mono" style={{ fontSize: 10, color: 'var(--ds-text-dim)' }}>
                            sent {formatTime(nudge.ts)}
                          </span>
                        )}
                      </div>
                      {nudge && (
                        <div
                          style={{
                            fontSize: 11.5,
                            fontStyle: 'italic',
                            color: 'var(--ds-text)',
                            paddingLeft: 4,
                            borderLeft: '2px solid var(--brand)',
                          }}
                        >
                          "{nudge.nudgeText || nudge.message}"
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {rotates.map((ev, ri) => (
              <div
                key={`r${ri}`}
                style={{
                  background: 'var(--ds-bg-panel)',
                  border: '1px solid var(--ds-border-subtle)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  marginBottom: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span className="sw-badge ok" style={{ fontSize: 10 }}>ROTATE</span>
                <span className="mono" style={{ fontSize: 11 }}>{ev.terminalId}</span>
                <span style={{ fontSize: 11, color: 'var(--ds-text-muted)', flex: 1 }}>{ev.message}</span>
                {ev.reason && <span style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>{ev.reason}</span>}
              </div>
            ))}

            {errors.map((ev, ei) => (
              <div
                key={`e${ei}`}
                style={{
                  background: 'var(--ds-bg-panel)',
                  border: '1px solid var(--ds-border-subtle)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  marginBottom: 6,
                  display: 'flex',
                  gap: 6,
                  alignItems: 'flex-start',
                }}
              >
                <span className="sw-badge failed" style={{ fontSize: 10, flexShrink: 0 }}>ERROR</span>
                <span style={{ fontSize: 11, color: 'var(--ds-text-muted)' }}>{ev.message}</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// Memoized: with identity-stable `item` refs (see useStableList) and stable
// onSelect/onRetry callbacks, a token streamed by one agent re-renders ONLY
// that agent's card instead of all of them. Default shallow prop compare is
// correct here because every field change rebuilds that agent's item object.
const AgentCard = React.memo(function AgentCard({ item, selected, onSelect, dimmed, onRetry }: {
  item: UnifiedAgent
  selected: boolean
  onSelect: (id: string) => void
  // Recent/completed agents render with a muted appearance to distinguish
  // them visually from currently-active ones.
  dimmed?: boolean
  // Only shown for completed/stopped swarm agents — lets the user rerun a
  // finished task without re-dispatching through the modal.
  onRetry?: (taskName: string) => void
}) {
  const label = identityLabel(item)
  const status = statusPhrase(item)
  const name = item.teammateName
    ? item.teammateName
    : item.agentType.charAt(0).toUpperCase() + item.agentType.slice(1)
  const filesCount = item.files.length
  const hasCounts = item.toolCalls > 0 || filesCount > 0
  const canRetry = !item.active && item.swarm && onRetry

  return (
    <button
      type="button"
      className={`sw-floor-agent-card ${selected ? 'selected' : ''} ${dimmed ? 'dimmed' : ''}`}
      onClick={() => onSelect(item.id)}
      aria-pressed={selected}
    >
      <div className="sw-floor-agent-card-top">
        <AgentAvatar id={item.agentType} size={24} />
        <span className="sw-floor-agent-card-name">{name}</span>
        <span className={`sw-floor-agent-card-chunk ${label.variant}`}>{label.text}</span>
        {canRetry && (
          <span
            role="button"
            tabIndex={0}
            className="sw-floor-agent-card-retry"
            onClick={(e) => { e.stopPropagation(); onRetry!(item.swarm!.task_name) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); e.stopPropagation()
                onRetry!(item.swarm!.task_name)
              }
            }}
            title="Retry this task"
          >
            Retry
          </span>
        )}
      </div>

      <div className="sw-floor-agent-card-status-line">
        <span className={`sw-floor-agent-card-status-word ${status.tone}`}>{status.word}</span>
        {status.when && <span>{status.tone === 'running' ? status.when : `· ${status.when}`}</span>}
      </div>

      {item.activity && (
        <div className="sw-floor-agent-card-activity">{item.activity}</div>
      )}

      {(hasCounts || item.linearIssue || item.prUrl) && (
        <div className="sw-floor-agent-card-meta">
          {hasCounts && (
            <span className="sw-floor-agent-card-meta-counts">
              {item.toolCalls > 0 && <>{item.toolCalls} tools</>}
              {item.toolCalls > 0 && filesCount > 0 && <span className="sw-floor-agent-card-meta-sep"> · </span>}
              {filesCount > 0 && <>{filesCount} files</>}
            </span>
          )}
          <span className="sw-floor-agent-card-meta-spacer" />
          {item.linearIssue && <span className="sw-tag-linear">{item.linearIssue}</span>}
          {item.prUrl && <span className="sw-tag-pr">#{item.prUrl.match(/\/pull\/(\d+)/)?.[1] || 'PR'}</span>}
        </div>
      )}
    </button>
  )
})

const IDLE_AFTER_MS = 2 * 60 * 1000

function friendlyRelTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Math.max(0, nowMs - then)
  if (diff < 10_000) return 'Just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day}d ago`
  return `${Math.floor(day / 7)}w ago`
}

function DetailStatusRow({ item, onFocusTerminal }: { item: UnifiedAgent; onFocusTerminal: (t: TerminalInfo) => void }) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])
  const tsMs = item.timestamp ? new Date(item.timestamp).getTime() : NaN
  const staleMs = Number.isFinite(tsMs) ? nowMs - tsMs : 0
  const stale = staleMs > IDLE_AFTER_MS
  const effectiveItem: UnifiedAgent =
    item.status === 'running' && stale ? { ...item, status: 'idle', active: false } : item
  const phrase = statusPhrase(effectiveItem)
  const rel = friendlyRelTime(item.timestamp, nowMs)
  const focus = item.terminal ? () => onFocusTerminal(item.terminal!) : undefined
  const clickProps = focus
    ? { onClick: focus, role: 'button' as const, tabIndex: 0, style: { cursor: 'pointer' as const } }
    : {}
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        marginBottom: 14,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          {...clickProps}
          className={`sw-badge ${phrase.tone === 'completed' ? 'ok' : phrase.tone}`}
          title={focus ? 'Focus terminal' : undefined}
        >
          {phrase.word}
        </span>
        {item.prUrl && (
          <ExtLink
            href={item.prUrl}
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--brand)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Icon name="external" size={10} /> PR
          </ExtLink>
        )}
      </div>
      {rel && (
        <span className="sw-pill" {...clickProps} title={focus ? 'Focus terminal' : undefined}>
          {rel}
        </span>
      )}
    </div>
  )
}

function DetailPane({ item, onClose, onFocusTerminal, onRetry, onKill }: {
  item: UnifiedAgent
  onClose: () => void
  onFocusTerminal: (t: TerminalInfo) => void
  onRetry: (taskName: string) => void
  onKill: (taskName: string) => void
}) {
  const isActive = item.active

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, height: '100%', flex: 1 }}>
      <div className="sw-mc-pane-head">
        <AgentAvatar id={item.agentType} size={20} />
        <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {item.displayName}
        </span>
        <span className={`sw-unified-kind-badge ${item.kind}`}>{kindBadge(item.kind)}</span>
        {item.cloudProvider && <span className="mono sw-unified-provider">{item.cloudProvider}</span>}
        <div className="sw-spacer" />
        {item.swarm && (
          <>
            <button className="sw-btn secondary sm" onClick={() => onRetry(item.swarm!.task_name)}>
              <Icon name="refresh" size={11} />
              Retry
            </button>
            {isActive && (
              <button className="sw-btn danger sm" onClick={() => onKill(item.swarm!.task_name)}>
                <Icon name="x" size={11} />
                Kill
              </button>
            )}
          </>
        )}
        {item.terminal && (
          <button className="sw-btn secondary sm" onClick={() => onFocusTerminal(item.terminal!)}>
            <Icon name="terminal" size={11} />
            Focus
          </button>
        )}
        <button className="sw-btn secondary sm" onClick={onClose} aria-label="Close detail pane">
          <Icon name="x" size={11} />
        </button>
      </div>

      <div className="sw-mc-pane-body">
        <DetailStatusRow item={item} onFocusTerminal={onFocusTerminal} />

        {item.kind === 'watchdog' && <WatchdogDetail events={item.watchdogEvents ?? []} />}
        {item.terminal && <TerminalExpandedDetail terminal={item.terminal} />}
        {item.kind === 'team' && item.swarm && <TeamDetail swarm={item.swarm} onRetry={onRetry} onKill={onKill} />}
        {(item.kind === 'headless' || item.kind === 'cloud') && item.agent && (
          <AgentDetailView agent={item.agent} swarm={item.swarm} onRetry={onRetry} onKill={onKill} />
        )}
      </div>
    </div>
  )
}


function TeamDetail({ swarm, onRetry, onKill }: { swarm: TaskSummary; onRetry: (n: string) => void; onKill: (n: string) => void }) {
  const isActive = swarm.status_counts.running > 0
  return (
    <div className="sw-unified-detail-content">
      <div className="sw-unified-detail-section">
        <div className="sw-section-label">Agents</div>
        <div className="sw-unified-team-agents">
          {swarm.agents.map((a) => {
            const statusClass = a.status === 'running' ? 'running' : a.status === 'completed' ? 'ok' : a.status === 'failed' ? 'failed' : 'idle'
            const lastAction = a.bash_commands?.slice(-1)[0] || a.files_modified?.slice(-1)[0] || a.last_messages?.slice(-1)[0]?.slice(0, 80) || ''
            return (
              <div key={a.agent_id} className="sw-unified-team-agent">
                <AgentAvatar id={a.agent_type} size={16} />
                <span style={{ fontSize: 12, fontWeight: 550, textTransform: 'capitalize' }}>{a.agent_type}</span>
                <span className={`sw-badge ${statusClass}`}>{a.status}</span>
                <div className="sw-spacer" />
                {a.duration && <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>{a.duration}</span>}
                {a.pr_url && (
                  <ExtLink href={a.pr_url} className="mono" style={{ fontSize: 10.5, color: 'var(--brand)' }}>
                    <Icon name="external" size={10} /> PR
                  </ExtLink>
                )}
                {lastAction && (
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)', gridColumn: '1 / -1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: 24 }}>
                    {lastAction}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      <div className="sw-unified-detail-actions">
        <button className="sw-btn secondary sm" onClick={() => onRetry(swarm.task_name)}>
          <Icon name="refresh" size={11} />
          Retry
        </button>
        {isActive && (
          <button className="sw-btn danger sm" onClick={() => onKill(swarm.task_name)}>
            <Icon name="x" size={11} />
            Kill
          </button>
        )}
      </div>
    </div>
  )
}

function AgentDetailView({ agent, swarm, onRetry, onKill }: { agent: AgentDetail; swarm?: TaskSummary; onRetry: (n: string) => void; onKill: (n: string) => void }) {
  const isActive = agent.status === 'running'
  const isCloud = agent.mode === 'cloud' || !!agent.cloud_provider
  const allFiles = [...(agent.files_created || []), ...(agent.files_modified || [])]

  if (isCloud) {
    return (
      <div className="sw-unified-detail-content">
        {agent.repo_owner && agent.repo_name && (
          <div className="sw-unified-detail-section">
            <div className="sw-section-label">Repository</div>
            <div className="mono" style={{ fontSize: 12 }}>{agent.repo_owner}/{agent.repo_name}</div>
          </div>
        )}
        {agent.prompt && (
          <div className="sw-unified-detail-section">
            <div className="sw-section-label">Task</div>
            <div className="sw-unified-detail-text sw-cloud-prompt">
              {renderTodoDescription(agent.prompt, false)}
            </div>
          </div>
        )}
        {(agent.cloud_summary || isActive) && (
          <div className="sw-unified-detail-section">
            <div className="sw-section-label">Activity</div>
            {agent.cloud_summary ? (
              <CloudActivityFeed summary={agent.cloud_summary} />
            ) : (
              <div className="sw-unified-detail-text" style={{ color: 'var(--ds-text-dim)', fontStyle: 'italic' }}>
                Agent is running, no output yet...
              </div>
            )}
          </div>
        )}
        {swarm && (
          <div className="sw-unified-detail-actions">
            <button className="sw-btn secondary sm" onClick={() => onRetry(swarm.task_name)}>
              <Icon name="refresh" size={11} />
              Retry
            </button>
            {isActive && (
              <button className="sw-btn danger sm" onClick={() => onKill(swarm.task_name)}>
                <Icon name="x" size={11} />
                Stop
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="sw-unified-detail-content">
      {agent.prompt && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Task</div>
          <div className="sw-unified-detail-text">
            {renderTodoDescription(agent.prompt.slice(0, 500), false)}
          </div>
        </div>
      )}
      {agent.last_messages && agent.last_messages.length > 0 && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Activity</div>
          <div className="sw-activity-feed">
            {agent.last_messages
              .filter((m) => typeof m === 'string' && m.trim().length > 0)
              .map((m, i) => (
                <div key={i} className="sw-activity-msg md">{renderMarkdown(m)}</div>
              ))}
          </div>
        </div>
      )}
      {allFiles.length > 0 && (
        <div className="sw-unified-detail-section">
          <div className="sw-section-label">Files ({allFiles.length})</div>
          <div className="sw-unified-detail-files">
            {allFiles.slice(0, 8).map((f) => (
              <span key={f} className="mono sw-unified-file-pill">{f.split('/').pop()}</span>
            ))}
            {allFiles.length > 8 && <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>+{allFiles.length - 8} more</span>}
          </div>
        </div>
      )}
      {swarm && (
        <div className="sw-unified-detail-actions">
          <button className="sw-btn secondary sm" onClick={() => onRetry(swarm.task_name)}>
            <Icon name="refresh" size={11} />
            Retry
          </button>
          {isActive && (
            <button className="sw-btn danger sm" onClick={() => onKill(swarm.task_name)}>
              <Icon name="x" size={11} />
              Stop
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Format a Linear dueDate (YYYY-MM-DD) into short human text for the card.
// Picks the largest unit that's still informative: minutes if <1h away,
// hours if <24h, days if <14d, else absolute date. "Due in 45m / 3h / 2d".
// The reference point is end-of-day local-tz because Linear dueDate has no
// time component and a task due "today" isn't late until the day is over.
function formatDueDate(iso: string | undefined): { label: string; tone: 'overdue' | 'soon' | 'normal' } | null {
  if (!iso) return null
  const parts = iso.split('T')[0].split('-')
  if (parts.length < 3) return null
  const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2])
  if (!y || !m || !d) return null
  const due = new Date(y, m - 1, d, 23, 59, 59, 999)
  const diffMs = due.getTime() - Date.now()
  const absMs = Math.abs(diffMs)
  const mins = Math.max(1, Math.round(absMs / 60000))
  const hours = Math.round(absMs / 3600000)
  const days = Math.round(absMs / 86400000)
  if (diffMs < 0) {
    if (absMs < 3600000) return { label: `Overdue ${mins}m`, tone: 'overdue' }
    if (absMs < 86400000) return { label: `Overdue ${hours}h`, tone: 'overdue' }
    return { label: `Overdue ${days}d`, tone: 'overdue' }
  }
  if (diffMs < 3600000) return { label: `Due in ${mins}m`, tone: 'soon' }
  if (diffMs < 86400000) return { label: `Due in ${hours}h`, tone: 'soon' }
  if (days <= 3) return { label: `Due in ${days}d`, tone: 'soon' }
  if (days <= 14) return { label: `Due in ${days}d`, tone: 'normal' }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return { label: `Due ${MONTHS[m - 1]} ${d}`, tone: 'normal' }
}

// Dispatch card with agent picker
function DispatchCard({ task, onOpen, onOpenInBench, onDragStateChange }: { task: UnifiedTask; onOpen: (task: UnifiedTask) => void; onOpenInBench?: (taskId: string) => void; onDragStateChange?: (dragging: boolean) => void }) {
  const priorityCls = task.priority === 'urgent' ? 'urgent' : task.priority === 'high' ? 'high' : 'medium'
  const repo = task.metadata.repo
  // Owner prefix ("muqsitnawaz/") bloats the 280px card; show the bare repo
  // name and keep the full slug in the hover tooltip.
  const repoName = repo ? repo.split('/').pop() : null
  const due = formatDueDate(task.metadata.dueDate)
  const repoHref = repo ? `https://github.com/${repo}` : null

  const stopOpen = (e: React.MouseEvent) => { e.stopPropagation() }

  // Use div role=button (not a <button> element) so we can nest an anchor
  // (the repo chip via <ExtLink>) without invalid HTML. Nesting <a> inside
  // <button> is spec-invalid and caused React/VS Code to silently drop the
  // anchor click — that was the original "repo chip doesn't open" bug.
  return (
    <div
      role="button"
      tabIndex={0}
      data-foreman-id={`task-card-${task.metadata.identifier || task.id.slice(0, 8)}`}
      className="sw-queue-card sw-queue-card-clickable"
      onClick={() => onOpen(task)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(task)
        }
      }}
      draggable
      onDragStart={(e) => {
        const label = task.metadata.identifier ? `${task.metadata.identifier}: ${task.title}` : task.title
        e.dataTransfer.setData('text/plain', label)
        e.dataTransfer.effectAllowed = 'copy'
        // Deferred: synchronous DOM mutation inside dragstart cancels the
        // drag in Chromium, and the dropzone strip mounts on this signal.
        setTimeout(() => onDragStateChange?.(true), 0)
      }}
      onDragEnd={() => onDragStateChange?.(false)}
    >
      <div className="sw-queue-card-header">
        <div className={`sw-queue-priority-led ${priorityCls}`} />
        <span className="sw-queue-badge">{task.metadata.identifier || task.id.slice(0, 8)}</span>
        {repoHref ? (
          <ExtLink
            className="sw-queue-repo-chip mono"
            href={repoHref}
            onMouseDown={stopOpen}
            title={`Open ${repo} on GitHub`}
            style={{ marginLeft: 'auto' }}
          >
            {repoName}
          </ExtLink>
        ) : repo ? (
          <span className="sw-queue-repo-chip mono" title={repo} style={{ marginLeft: 'auto' }}>{repoName}</span>
        ) : null}
        {onOpenInBench && (
          <button
            type="button"
            className="sw-queue-bench-btn"
            title="Open in Bench"
            aria-label="Open in Bench"
            onClick={(e) => { e.stopPropagation(); onOpenInBench(task.id) }}
            onMouseDown={stopOpen}
            style={!repo ? { marginLeft: 'auto' } : undefined}
          >
            <Icon name="external" size={11} />
          </button>
        )}
      </div>
      <div className="sw-queue-title">{task.title}</div>
      {due && (
        <div className="sw-queue-meta-row">
          <span className={`sw-queue-due ${due.tone}`}>{due.label}</span>
        </div>
      )}
    </div>
  )
}

export type CloudProviderId = 'rush' | 'codex' | 'factory'

type DispatchPrefs = {
  lastAgent: string
  lastTarget: 'local' | 'cloud'
  lastCloudProvider: CloudProviderId
  notifyOnQuestion: boolean
  notifyOnFinish: boolean
  notifyChannel: string
  lastCodexEnv: string
  /** Most-recently-dispatched repos, newest first. Capped at MRU_MAX. */
  recentRepos: string[]
  /**
   * Per-task-type overrides for agent/target/cloudProvider. Keyed by the
   * task's type bucket (see `taskTypeKey`) — e.g. `docs` tasks remember
   * Gemini while `engineering` tasks remember Claude without either
   * leaking into the other. Missing keys fall back to the global
   * `lastAgent`/`lastTarget`/`lastCloudProvider` fields above.
   */
  byTaskType?: Record<string, Partial<Pick<DispatchPrefs, 'lastAgent' | 'lastTarget' | 'lastCloudProvider'>>>
}

const DISPATCH_PREFS_KEY = 'swarmify.dispatchPrefs.v1'
const MRU_MAX = 10
const RESERVED_LABEL_PREFIXES = ['repo:', 'agent:', 'priority:']

/**
 * Derive a stable "task type" bucket from a task's metadata, used as the
 * key in `DispatchPrefs.byTaskType`. Strategy: pick the first label that
 * isn't a reserved routing label (repo:, agent:, priority:). Falls back
 * to `task.source` (linear / github / markdown) so tasks without useful
 * labels still get a source-level override.
 */
function taskTypeKey(task: UnifiedTask): string {
  const labels = (task.metadata.labels || []).map((l) => (typeof l === 'string' ? l.toLowerCase() : ''))
  for (const l of labels) {
    if (!l) continue
    if (RESERVED_LABEL_PREFIXES.some((p) => l.startsWith(p))) continue
    return l
  }
  return task.source || 'default'
}

function loadDispatchPrefs(): DispatchPrefs {
  try {
    const raw = localStorage.getItem(DISPATCH_PREFS_KEY)
    if (!raw) return defaultPrefs()
    const parsed = JSON.parse(raw)
    return { ...defaultPrefs(), ...parsed }
  } catch {
    return defaultPrefs()
  }
}

/**
 * Merge the global prefs with any per-task-type overrides. Returns prefs
 * with agent/target/cloudProvider taking from the type-specific bucket
 * when present, falling back to the global defaults otherwise.
 */
function prefsForTask(p: DispatchPrefs, task: UnifiedTask): DispatchPrefs {
  const key = taskTypeKey(task)
  const override = p.byTaskType?.[key]
  if (!override) return p
  return {
    ...p,
    lastAgent: override.lastAgent ?? p.lastAgent,
    lastTarget: override.lastTarget ?? p.lastTarget,
    lastCloudProvider: override.lastCloudProvider ?? p.lastCloudProvider,
  }
}

function defaultPrefs(): DispatchPrefs {
  return {
    lastAgent: 'claude',
    lastTarget: 'local',
    lastCloudProvider: 'rush',
    notifyOnQuestion: true,
    notifyOnFinish: true,
    notifyChannel: 'ios',
    lastCodexEnv: '',
    recentRepos: [],
    byTaskType: {},
  }
}

function saveDispatchPrefs(p: DispatchPrefs): void {
  try { localStorage.setItem(DISPATCH_PREFS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

/** Push repos to the front of the MRU list, dedupe, cap at MRU_MAX. */
function bumpRecentRepos(existing: string[], used: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of used) {
    if (!r || seen.has(r)) continue
    seen.add(r)
    out.push(r)
  }
  for (const r of existing) {
    if (!r || seen.has(r)) continue
    seen.add(r)
    out.push(r)
  }
  return out.slice(0, MRU_MAX)
}

/**
 * Compact search input + typeahead dropdown in the TaskDetailModal header.
 * Lets the user jump between open tasks without closing the modal.
 * Current task is excluded from results. Empty query surfaces the first
 * 8 tasks so clicking the input gives an immediate browse list.
 */
function TaskSwitcher({ current, tasks, onPick }: {
  current: UnifiedTask
  tasks: UnifiedTask[]
  onPick: (task: UnifiedTask) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pool = tasks.filter((t) => t.id !== current.id)
    const filtered = q
      ? pool.filter((t) =>
          t.title.toLowerCase().includes(q) ||
          (t.metadata.identifier || '').toLowerCase().includes(q) ||
          (t.description || '').toLowerCase().includes(q),
        )
      : pool
    return filtered.slice(0, 8)
  }, [tasks, current.id, query])
  return (
    <div className="sw-task-switcher" style={{ position: 'relative', marginLeft: 'auto', marginRight: 8 }}>
      <input
        ref={inputRef}
        type="text"
        className="sw-dispatch-modal-search-input"
        placeholder={`Switch task (${tasks.length - 1} open)`}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) {
            e.preventDefault()
            onPick(results[0])
            setQuery('')
            setOpen(false)
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
        style={{ width: 220, fontSize: 12 }}
      />
      {open && results.length > 0 && (
        <div className="sw-task-detail-repo-suggest" style={{ width: 360, maxHeight: 320, overflowY: 'auto' }}>
          {results.map((t) => (
            <button
              key={t.id}
              type="button"
              className="sw-task-detail-repo-suggest-item"
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(t)
                setQuery('')
                setOpen(false)
              }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '6px 10px' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {t.metadata.identifier && (
                  <span className="sw-queue-badge" style={{ fontSize: 10 }}>{t.metadata.identifier}</span>
                )}
                {t.priority && (
                  <span className={`sw-queue-priority-label ${t.priority === 'urgent' ? 'urgent' : t.priority === 'high' ? 'high' : 'medium'}`} style={{ fontSize: 10 }}>
                    {t.priority.toUpperCase()}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 12, fontWeight: 500 }}>{t.title.slice(0, 70)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function TaskDetailModal({ task, tasks, onClose, onBack, onDispatch, onTaskSwitch, requireCloudRepo = false }: {
  task: UnifiedTask
  // Sibling tasks for the in-header switcher. When provided, the modal
  // shows a search input that filters these and lets the user jump to
  // another task without closing the modal.
  tasks?: UnifiedTask[]
  onClose: () => void
  // When provided, renders a "Back" button in the header that returns
  // the user to wherever they came from (e.g. DispatchModal list). No
  // button is rendered when the modal is opened directly from a queue
  // card — in that case there's no "back" to go to.
  onBack?: () => void
  onDispatch: (args: {
    agent: string
    target: 'local' | 'cloud'
    cloudProvider: CloudProviderId
    branch: string
    codexEnv: string
    targetRepos: string[]
    extraComments: string
    notify: { onQuestion: boolean; onFinish: boolean; channel: string }
  }) => void
  onTaskSwitch?: (task: UnifiedTask) => void
  requireCloudRepo?: boolean
}) {
  const prefs = useRef<DispatchPrefs>(loadDispatchPrefs())
  // Resolve per-task-type overrides at mount so e.g. `docs` tasks default
  // to Gemini while `engineering` tasks default to Claude, without the
  // two bleeding into each other. Falls back to global defaults when the
  // task's type has never been dispatched before.
  const seed = useMemo(() => prefsForTask(prefs.current, task), [task])
  const typeKey = useMemo(() => taskTypeKey(task), [task])
  const [agent, setAgent] = useState(seed.lastAgent)
  const [target, setTarget] = useState<'local' | 'cloud'>(seed.lastTarget)
  const [cloudProvider, setCloudProvider] = useState<CloudProviderId>(seed.lastCloudProvider)
  const [branch, setBranch] = useState('')
  const [codexEnv, setCodexEnv] = useState(prefs.current.lastCodexEnv)
  const [extraComments, setExtraComments] = useState('')
  const [notifyOnQuestion, setNotifyOnQuestion] = useState(prefs.current.notifyOnQuestion)
  const [notifyOnFinish, setNotifyOnFinish] = useState(prefs.current.notifyOnFinish)
  const [notifyChannel, setNotifyChannel] = useState(prefs.current.notifyChannel)

  // Seed selected repos from Linear `repo:<name>` labels. Repo picker lets
  // user add/remove; suggestions come from `gh repo list <owner>`.
  const initialRepos = useMemo(() => {
    const labelRepos = (task.metadata.labels || []).filter((l) => l.startsWith('repo:')).map((l) => l.slice(5))
    return labelRepos
  }, [task.metadata.labels])
  const [selectedRepos, setSelectedRepos] = useState<string[]>(initialRepos)
  const [repoOwner, setRepoOwner] = useState<string>('')
  const [availableRepos, setAvailableRepos] = useState<string[]>([])
  const [repoInput, setRepoInput] = useState('')
  const [repoSuggestOpen, setRepoSuggestOpen] = useState(false)
  const [branchSuggestOpen, setBranchSuggestOpen] = useState(false)
  // Branches keyed by repo — cached per-modal-open so switching back to a
  // repo that was already fetched is instant. Includes the repo's default
  // branch so the UI can mark it.
  const [branchesByRepo, setBranchesByRepo] = useState<Record<string, { branches: string[]; defaultBranch: string }>>({})

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    postMessage({ type: 'fetchGithubRepos' })
    const onMsg = (event: MessageEvent) => {
      const msg = event.data
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'githubReposList') {
        setRepoOwner(typeof msg.owner === 'string' ? msg.owner : '')
        setAvailableRepos(Array.isArray(msg.repos) ? msg.repos : [])
      }
      if (msg.type === 'githubBranchesList') {
        const repo = typeof msg.repo === 'string' ? msg.repo : ''
        const branches: string[] = Array.isArray(msg.branches) ? msg.branches : []
        const defaultBranch: string = typeof msg.defaultBranch === 'string' ? msg.defaultBranch : ''
        if (repo) setBranchesByRepo((prev) => ({ ...prev, [repo]: { branches, defaultBranch } }))
      }
    }
    window.addEventListener('message', onMsg)
    return () => {
      window.removeEventListener('keydown', esc)
      window.removeEventListener('message', onMsg)
    }
  }, [onClose])

  // When exactly one repo is selected, fetch its branches (cached).
  // Multi-repo dispatch (Rush Cloud) passes a single --branch applied to all
  // clones — we still let the user type, but don't fetch suggestions because
  // branches differ per repo.
  useEffect(() => {
    if (selectedRepos.length !== 1) return
    const repo = selectedRepos[0]
    if (branchesByRepo[repo]) return
    postMessage({ type: 'fetchGithubBranches', repo })
  }, [selectedRepos, branchesByRepo])

  // Persist selections on EVERY change so that closing the modal without
  // clicking Dispatch still remembers what the user picked. Previously we
  // only saved inside handleDispatch, which meant a half-configured modal
  // dismissed via Cancel/Escape would lose the user's choices on reopen.
  useEffect(() => {
    const byTaskType = { ...(prefs.current.byTaskType || {}) }
    // Persist the routing triple (agent/target/cloudProvider) under the
    // current task's type bucket so next time a task of the same type
    // opens, those are the seeded defaults. Notify/codexEnv stay global
    // because they're user-preference, not task-class.
    byTaskType[typeKey] = {
      lastAgent: agent,
      lastTarget: target,
      lastCloudProvider: cloudProvider,
    }
    const next: DispatchPrefs = {
      lastAgent: agent,
      lastTarget: target,
      lastCloudProvider: cloudProvider,
      notifyOnQuestion,
      notifyOnFinish,
      notifyChannel,
      lastCodexEnv: codexEnv,
      recentRepos: prefs.current.recentRepos,
      byTaskType,
    }
    saveDispatchPrefs(next)
    prefs.current = next
  }, [agent, target, cloudProvider, notifyOnQuestion, notifyOnFinish, notifyChannel, codexEnv, typeKey])

  // Re-seed state when the displayed task changes (via TaskSwitcher).
  // Without this, switching from a `docs` task to an `engineering` task
  // would keep the docs task's agent/target selection.
  const lastTypeKeyRef = useRef(typeKey)
  useEffect(() => {
    if (lastTypeKeyRef.current === typeKey) return
    lastTypeKeyRef.current = typeKey
    const override = prefs.current.byTaskType?.[typeKey]
    if (!override) return
    if (override.lastAgent) setAgent(override.lastAgent)
    if (override.lastTarget) setTarget(override.lastTarget)
    if (override.lastCloudProvider) setCloudProvider(override.lastCloudProvider)
  }, [typeKey])

  const singleRepo = selectedRepos.length === 1 ? selectedRepos[0] : ''
  const branchInfo = singleRepo ? branchesByRepo[singleRepo] : undefined
  const branchesForRepo = branchInfo?.branches || []
  const defaultBranch = branchInfo?.defaultBranch || ''
  const branchSuggestions = useMemo(() => {
    const q = branch.trim().toLowerCase()
    const matches = branchesForRepo.filter((b) => !q || b.toLowerCase().includes(q))
    // Pin the default branch to the top if it passes the filter.
    if (defaultBranch && matches.includes(defaultBranch)) {
      const rest = matches.filter((b) => b !== defaultBranch)
      return [defaultBranch, ...rest].slice(0, 8)
    }
    return matches.slice(0, 8)
  }, [branchesForRepo, branch, defaultBranch])

  const addRepo = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    // Accept bare name (suffix owner/) or owner/name
    const full = trimmed.includes('/') ? trimmed : (repoOwner ? `${repoOwner}/${trimmed}` : trimmed)
    if (selectedRepos.includes(full)) return
    setSelectedRepos((prev) => [...prev, full])
    setRepoInput('')
    setRepoSuggestOpen(false)
  }

  const removeRepo = (name: string) => {
    setSelectedRepos((prev) => prev.filter((r) => r !== name))
  }

  const repoSuggestions = useMemo(() => {
    const q = repoInput.trim().toLowerCase()
    const recent = prefs.current.recentRepos.filter((r) =>
      !selectedRepos.includes(r) && (!q || r.toLowerCase().includes(q))
    )
    const rest = availableRepos.filter((r) =>
      !selectedRepos.includes(r) && !recent.includes(r) && (!q || r.toLowerCase().includes(q))
    )
    // Recently-used repos first (up to 3), then the rest from gh repo list.
    // Mark recents so the UI can style/label them; cap total at 8.
    const out: { repo: string; recent: boolean }[] = []
    for (const r of recent.slice(0, 3)) out.push({ repo: r, recent: true })
    for (const r of rest) {
      if (out.length >= 8) break
      out.push({ repo: r, recent: false })
    }
    return out
  }, [availableRepos, selectedRepos, repoInput])

  const runTarget: 'local' | 'rush' | 'codex' = target === 'local' ? 'local' : cloudProvider === 'codex' ? 'codex' : 'rush'

  const modelsForTarget: Array<{ id: string; label: string }> = (() => {
    if (runTarget === 'local') return [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
      { id: 'gemini', label: 'Gemini' },
    ]
    if (runTarget === 'rush') return [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
    ]
    return [{ id: 'codex', label: 'Codex' }]
  })()

  useEffect(() => {
    if (!modelsForTarget.some((m) => m.id === agent)) {
      setAgent(modelsForTarget[0].id)
    }
  }, [runTarget, agent, modelsForTarget])

  const priorityCls = task.priority === 'urgent' ? 'urgent' : task.priority === 'high' ? 'high' : 'medium'
  const priorityLabel = task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : 'Medium'

  const createdAt = (task as UnifiedTask & { createdAt?: string }).createdAt
  const createdRel = createdAt ? relTime(new Date(createdAt).getTime()) : null

  // Show the task switcher only when there are sibling tasks to jump to.
  const switcherEnabled = !!onTaskSwitch && !!tasks && tasks.length > 1

  const hasCloudRepo = runTarget === 'local' || selectedRepos.length > 0 || (!requireCloudRepo && (runTarget === 'rush' || runTarget === 'codex'))
  const canDispatch = (runTarget !== 'codex' || codexEnv.trim().length > 0) && hasCloudRepo

  const handleDispatch = () => {
    // All other prefs are already persisted by the on-change effect above.
    // Dispatch only needs to bump the MRU repo list, which is the only
    // thing that should change on an actual dispatch (vs idle selection).
    const next: DispatchPrefs = {
      ...prefs.current,
      recentRepos: bumpRecentRepos(prefs.current.recentRepos, selectedRepos),
    }
    saveDispatchPrefs(next)
    prefs.current = next
    onDispatch({
      agent,
      target,
      cloudProvider,
      branch: branch.trim(),
      codexEnv: codexEnv.trim(),
      targetRepos: selectedRepos,
      extraComments: extraComments.trim(),
      notify: { onQuestion: notifyOnQuestion, onFinish: notifyOnFinish, channel: notifyChannel },
    })
  }

  return (
    <div className="sw-dispatch-modal-overlay" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div className="sw-task-detail-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sw-task-detail-head">
          <div className="sw-task-detail-head-top">
            {onBack && (
              <button
                type="button"
                className="sw-btn ghost sm"
                onClick={onBack}
                title="Back to dispatch list"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 6 }}
              >
                <span aria-hidden="true">&larr;</span>
                <span>Back</span>
              </button>
            )}
            <span className={`sw-queue-priority-led ${priorityCls}`} />
            {task.metadata.identifier && (
              <span className="sw-queue-badge">{task.metadata.identifier}</span>
            )}
            <span className={`sw-queue-priority-label ${priorityCls}`}>{priorityLabel}</span>
            <span className="sw-task-detail-meta">
              {task.source}{createdRel ? ` - created ${createdRel}` : ''}
            </span>
            {switcherEnabled && (
              <TaskSwitcher
                current={task}
                tasks={tasks || []}
                onPick={(t) => onTaskSwitch?.(t)}
              />
            )}
            <button className="sw-dispatch-modal-close" onClick={onClose} aria-label="Close">
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="sw-task-detail-title">{task.title}</div>
        </div>

        <div className="sw-task-detail-body">
          {task.description ? (
            <div className="sw-task-detail-desc">
              {renderTodoDescription(task.description, false)}
            </div>
          ) : (
            <div className="sw-task-detail-desc sw-task-detail-desc-empty">No description.</div>
          )}
        </div>

        <div className="sw-task-detail-form">
          <div className="sw-task-detail-row sw-task-detail-row-notes">
            <label className="sw-task-detail-label">Comments</label>
            <textarea
              className="sw-task-detail-input sw-task-detail-textarea"
              placeholder="Context, constraints, handoff notes"
              value={extraComments}
              onChange={(e) => setExtraComments(e.target.value)}
              rows={3}
            />
          </div>

          <div className="sw-task-detail-row">
            <label className="sw-task-detail-label">Run on</label>
            <div className="sw-task-detail-seg">
              <button
                type="button"
                className={`sw-task-detail-seg-btn ${target === 'local' ? 'active' : ''}`}
                onClick={() => setTarget('local')}
              >Local</button>
              <button
                type="button"
                className={`sw-task-detail-seg-btn ${target === 'cloud' && cloudProvider === 'rush' ? 'active' : ''}`}
                onClick={() => { setTarget('cloud'); setCloudProvider('rush') }}
              >Rush Cloud</button>
              <button
                type="button"
                className={`sw-task-detail-seg-btn ${target === 'cloud' && cloudProvider === 'codex' ? 'active' : ''}`}
                onClick={() => { setTarget('cloud'); setCloudProvider('codex') }}
              >Codex Cloud</button>
            </div>
          </div>

          <div className="sw-task-detail-row">
            <label className="sw-task-detail-label">Model</label>
            <div className="sw-task-detail-seg">
              {modelsForTarget.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`sw-task-detail-seg-btn ${agent === m.id ? 'active' : ''}`}
                  onClick={() => setAgent(m.id)}
                >{m.label}</button>
              ))}
            </div>
          </div>

          {runTarget !== 'local' && (
            <div className="sw-task-detail-row sw-task-detail-row-repos">
              <label className="sw-task-detail-label">
                {runTarget === 'rush' ? 'Repositories' : 'Repository'}
              </label>
              <div className="sw-task-detail-repos-picker">
                <div className="sw-task-detail-repo-chips">
                  {selectedRepos.map((r) => (
                    <span key={r} className="sw-task-detail-repo-chip">
                      {r}
                      <button
                        type="button"
                        className="sw-task-detail-repo-chip-x"
                        onClick={() => removeRepo(r)}
                        aria-label={`Remove ${r}`}
                      >
                        <Icon name="x" size={10} />
                      </button>
                    </span>
                  ))}
                  {selectedRepos.length === 0 && (
                    <span className="sw-task-detail-hint">
                      {runTarget === 'rush' ? 'Add one or more repos' : 'Add a repo'}
                    </span>
                  )}
                </div>
                <div className="sw-task-detail-repo-input-wrap">
                  <input
                    type="text"
                    className="sw-task-detail-input"
                    placeholder={repoOwner ? `${repoOwner}/repo or paste owner/repo` : 'owner/repo'}
                    value={repoInput}
                    onChange={(e) => { setRepoInput(e.target.value); setRepoSuggestOpen(true) }}
                    onFocus={() => setRepoSuggestOpen(true)}
                    onBlur={() => setTimeout(() => setRepoSuggestOpen(false), 150)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && repoInput.trim()) {
                        e.preventDefault()
                        addRepo(repoInput)
                      }
                      if (runTarget === 'codex' && selectedRepos.length >= 1) {
                        // Codex Cloud rejects multi-repo — block typing more.
                        e.preventDefault()
                      }
                    }}
                    disabled={runTarget === 'codex' && selectedRepos.length >= 1}
                  />
                  {repoSuggestOpen && repoSuggestions.length > 0 && (
                    <div className="sw-task-detail-repo-suggest">
                      {repoSuggestions.map(({ repo, recent }) => (
                        <button
                          key={repo}
                          type="button"
                          className={`sw-task-detail-repo-suggest-item ${recent ? 'recent' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); addRepo(repo) }}
                        >
                          <span className="sw-task-detail-repo-suggest-name">{repo}</span>
                          {recent && <span className="sw-task-detail-repo-suggest-badge">Recent</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {runTarget === 'codex' && (
                  <div className="sw-task-detail-hint">Codex Cloud: one repo per task (env bundles multi-repo).</div>
                )}
              </div>
            </div>
          )}

          {runTarget === 'codex' && (
            <div className="sw-task-detail-row">
              <label className="sw-task-detail-label">Codex env</label>
              <input
                type="text"
                className="sw-task-detail-input"
                placeholder="env_abc123"
                value={codexEnv}
                onChange={(e) => setCodexEnv(e.target.value)}
              />
            </div>
          )}

          {runTarget !== 'local' && (
            <div className="sw-task-detail-row">
              <label className="sw-task-detail-label">Branch</label>
              <div className="sw-task-detail-repo-input-wrap">
                <input
                  type="text"
                  className="sw-task-detail-input"
                  placeholder={
                    selectedRepos.length > 1
                      ? 'main (applied to all repos)'
                      : defaultBranch
                        ? `${defaultBranch} (default)`
                        : 'main (default)'
                  }
                  value={branch}
                  onChange={(e) => { setBranch(e.target.value); setBranchSuggestOpen(true) }}
                  onFocus={() => setBranchSuggestOpen(true)}
                  onBlur={() => setTimeout(() => setBranchSuggestOpen(false), 150)}
                />
                {branchSuggestOpen && branchSuggestions.length > 0 && (
                  <div className="sw-task-detail-repo-suggest">
                    {branchSuggestions.map((b) => {
                      const isDefault = b === defaultBranch
                      return (
                        <button
                          key={b}
                          type="button"
                          className={`sw-task-detail-repo-suggest-item ${isDefault ? 'recent' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); setBranch(b); setBranchSuggestOpen(false) }}
                        >
                          <span className="sw-task-detail-repo-suggest-name">{b}</span>
                          {isDefault && <span className="sw-task-detail-repo-suggest-badge">Default</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
                {selectedRepos.length > 1 && (
                  <div className="sw-task-detail-hint">One branch applies to every selected repo.</div>
                )}
              </div>
            </div>
          )}

          <div className="sw-task-detail-row sw-task-detail-row-notify">
            <label className="sw-task-detail-label">Notify me</label>
            <div className="sw-task-detail-notify">
              <label className="sw-task-detail-check">
                <input
                  type="checkbox"
                  checked={notifyOnQuestion}
                  onChange={(e) => setNotifyOnQuestion(e.target.checked)}
                />
                <span>When it asks a question</span>
              </label>
              <label className="sw-task-detail-check">
                <input
                  type="checkbox"
                  checked={notifyOnFinish}
                  onChange={(e) => setNotifyOnFinish(e.target.checked)}
                />
                <span>When it finishes</span>
              </label>
              <div className="sw-task-detail-channel">
                <span className="sw-task-detail-hint">Channel</span>
                <select
                  className="sw-task-detail-input sw-task-detail-select"
                  value={notifyChannel}
                  onChange={(e) => setNotifyChannel(e.target.value)}
                  disabled={!notifyOnQuestion && !notifyOnFinish}
                >
                  <option value="ios">iOS push</option>
                  <option value="email">Email</option>
                  <option value="linear">Linear comment</option>
                  <option value="none">None</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="sw-task-detail-foot">
          <button className="sw-btn secondary" onClick={onClose}>Cancel</button>
          <button className="sw-btn-dispatch" onClick={handleDispatch} disabled={!canDispatch}>
            Dispatch
          </button>
        </div>
      </div>
    </div>
  )
}
