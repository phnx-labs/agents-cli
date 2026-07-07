import { AgentDetail, ApprovalStatus, TaskSummary, TerminalDetail } from '../../types'
import { getAgentDisplayName, getTaskSummaryStatus } from '../../utils'

export const SHORTCUTS = [
  ['Cmd+Shift+A', 'New agent'],
  ['Cmd+Shift+B', 'New secondary agent'],
  ['Cmd+Shift+L', 'Label agent'],
  ['Cmd+Shift+G', 'Commit & push'],
  ['Cmd+Shift+C', 'Clear & restart'],
  ['Cmd+R', 'Next agent'],
  ['Cmd+E', 'Previous agent'],
  ["Cmd+Shift+'", 'Prompts'],
]

export const PROMPT_PREVIEW_CHARS = 50

export const APPROVAL_BADGE_STYLES: Record<ApprovalStatus, string> = {
  pending: 'bg-amber-500/15 text-amber-600 border border-amber-500/40',
  approved: 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/40',
  running: 'bg-emerald-500/20 text-emerald-700 border border-emerald-500/40',
  complete: 'bg-[var(--muted-foreground)]/15 text-[var(--muted-foreground)] border border-[var(--border)]',
  rejected: 'bg-red-500/15 text-red-600 border border-red-500/40',
}

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars).trim()}...`
}

export function truncateMiddle(value: string, headChars: number, tailChars: number): string {
  if (value.length <= headChars + tailChars + 3) return value
  return `${value.slice(0, headChars)}...${value.slice(-tailChars)}`
}

export function stripXmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, '').trim()
}

export function getTerminalPrompt(terminal: TerminalDetail): string {
  const raw = terminal.firstUserMessage || terminal.lastUserMessage || terminal.label || terminal.autoLabel || ''
  const cleaned = stripXmlTags(raw.trim())
  return cleaned || 'Waiting for first message...'
}

export function getFilesChangedCount(tasksForSession?: TaskSummary[]): number | null {
  if (!tasksForSession || tasksForSession.length === 0) return null
  const uniqueFiles = new Set<string>()
  for (const task of tasksForSession) {
    for (const agent of task.agents) {
      for (const file of agent.files_created || []) uniqueFiles.add(file)
      for (const file of agent.files_modified || []) uniqueFiles.add(file)
      for (const file of agent.files_deleted || []) uniqueFiles.add(file)
    }
  }
  return uniqueFiles.size
}

export function deriveApprovalStatusFromTask(task: TaskSummary): ApprovalStatus {
  if (task.approval_status) return task.approval_status
  const statusLabel = getTaskSummaryStatus(task)
  if (statusLabel === 'running') return 'running'
  if (statusLabel === 'done') return 'complete'
  return 'pending'
}

export function formatMixFromTask(task: TaskSummary): string {
  if (task.mix) return task.mix
  const counts: Record<string, number> = {}
  for (const agent of task.agents || []) {
    const key = (agent.agent_type || 'agent').toLowerCase()
    counts[key] = (counts[key] || 0) + 1
  }
  const total = Math.max(task.agent_count || 0, Object.values(counts).reduce((sum, val) => sum + val, 0))
  if (!total) return 'Mix not set'
  const parts = Object.entries(counts).map(([key, count]) => `${Math.round((count / total) * 100)}% ${getAgentDisplayName(key)}`)
  return parts.length ? parts.join(', ') : 'Mix not set'
}

export function getAgentPromptSnippet(agent: AgentDetail): string {
  if (agent.prompt) return truncateText(agent.prompt, 120)
  if (agent.last_messages && agent.last_messages.length > 0) {
    return truncateText(agent.last_messages[agent.last_messages.length - 1], 120)
  }
  return 'No prompt'
}

export function titleize(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function approvalLabel(status: ApprovalStatus): string {
  switch (status) {
    case 'approved':
      return 'Approved'
    case 'running':
      return 'Running'
    case 'complete':
      return 'Complete'
    case 'rejected':
      return 'Changes requested'
    default:
      return 'Pending Approval'
  }
}
