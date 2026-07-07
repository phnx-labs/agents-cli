import type { AgentDetail, TaskSummary, TerminalDetail } from '../../types'

// A "Swarm" in Mission Control is a TaskSummary from agents-cli teams.
export type Swarm = TaskSummary
export type SwarmAgent = AgentDetail
export type Terminal = TerminalDetail

export interface ActivityEvent {
  t: string // relative time "3m 12s"
  agent: string // agent id (claude/codex/…)
  kind: 'tool' | 'read' | 'msg'
  text: string
  detail?: string
}

export function splitSwarms(tasks: TaskSummary[]): { active: TaskSummary[]; completed: TaskSummary[] } {
  const active: TaskSummary[] = []
  const completed: TaskSummary[] = []
  for (const t of tasks) {
    if (t.status_counts.running > 0) active.push(t)
    else completed.push(t)
  }
  return { active, completed }
}

export function swarmShortId(taskName: string): string {
  // Generate a stable short identifier from task name
  let hash = 0
  for (let i = 0; i < taskName.length; i++) hash = (hash * 31 + taskName.charCodeAt(i)) | 0
  const n = Math.abs(hash) % 900 + 100
  return `sw-${n}`
}

export function taskNameToTitle(taskName: string): string {
  // task_name is "task-id:description" or just a description
  const colonIdx = taskName.indexOf(':')
  if (colonIdx > 0) return taskName.slice(colonIdx + 1).trim()
  return taskName
}

export function swarmOverallStatus(swarm: TaskSummary): 'running' | 'merged' | 'failed' | 'open' | 'idle' {
  const { status_counts } = swarm
  if (status_counts.running > 0) return 'running'
  if (status_counts.failed > 0 && status_counts.completed === 0) return 'failed'
  if (status_counts.completed > 0) return 'merged'
  return 'idle'
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Math.max(0, Date.now() - then)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day}d ago`
  const wk = Math.floor(day / 7)
  return `${wk}w ago`
}

export function shortDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const min = Math.floor(seconds / 60)
  const rem = seconds % 60
  if (min < 60) return `${min}m ${rem.toString().padStart(2, '0')}s`
  const hr = Math.floor(min / 60)
  const minRem = min % 60
  return `${hr}h ${minRem.toString().padStart(2, '0')}m`
}
