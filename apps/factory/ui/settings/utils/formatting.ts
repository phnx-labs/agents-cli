import type { TaskSummary, DisplayPreferences } from '../types'

/**
 * Format a timestamp (Unix ms) as relative time since now
 * Used for: agent terminals created time
 */
export function formatTimeSince(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just started'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return `${diffDays}d ago`
}

/**
 * Format an ISO date string as relative time
 * Used for: sessions, tasks
 */
export function formatTimeAgo(isoDate: string): string {
  const date = new Date(isoDate)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins === 1) return '1 min ago'
  if (diffMins < 60) return `${diffMins} mins ago`
  if (diffHours === 1) return '1 hour ago'
  if (diffHours < 24) return `${diffHours} hours ago`
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return `${Math.floor(diffDays / 7)} weeks ago`
}

/**
 * Format a session timestamp for display
 */
export function formatSessionTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return date.toLocaleString()
}

/**
 * Safe wrapper for formatTimeAgo that handles invalid dates
 */
export function formatTimeAgoSafe(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'Unknown time'
  return formatTimeAgo(timestamp)
}

/**
 * Format a preview string, truncating to max words
 */
export function formatPreview(preview?: string, maxWords: number = 20): string {
  if (!preview) return 'No preview available.'
  const compact = preview.replace(/\s+/g, ' ').trim()
  if (!compact) return 'No preview available.'
  const words = compact.split(' ')
  if (words.length <= maxWords) return compact
  return `${words.slice(0, maxWords).join(' ')}...`
}

/**
 * Get overall status for a task summary
 */
export function getTaskSummaryStatus(task: TaskSummary): string {
  if (task.status_counts.running > 0) return 'running'
  if (task.status_counts.failed > 0) return 'failed'
  if (task.status_counts.stopped > 0) return 'stopped'
  if (task.status_counts.completed > 0) return 'done'
  return 'unknown'
}

/**
 * Format agent count with proper pluralization
 */
export function formatAgentCount(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'}`
}

// Simple mapping for agent display names
const AGENT_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  shell: 'Shell',
}

/**
 * Get display name for an agent key
 */
export function getAgentDisplayName(agentKey: string): string {
  return AGENT_DISPLAY_NAMES[agentKey] || agentKey.charAt(0).toUpperCase() + agentKey.slice(1)
}

/**
 * Format actual time from ISO timestamp
 * Shows "10:32 AM" for today, "Jan 27, 10:32 AM" for other days
 */
export function formatActualTime(isoTimestamp?: string): string {
  if (!isoTimestamp) return 'Waiting for first message...'

  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return 'Waiting for first message...'

  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  if (isToday) {
    return timeStr
  }

  const dateStr = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })

  return `${dateStr}, ${timeStr}`
}

const TERMINAL_PREFIX_NAMES: Record<string, string> = {
  CC: 'Claude',
  CX: 'Codex',
  GX: 'Gemini',
  OC: 'OpenCode',
  CR: 'Cursor',
  SH: 'Shell',
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  shell: 'Shell',
}

export interface TerminalTitlePreviewOptions {
  label?: string | null
  sessionChunk?: string | null
  isFocused?: boolean
}

export function formatPreviewTerminalTitle(
  prefix: string,
  display: DisplayPreferences,
  options?: TerminalTitlePreviewOptions
): string {
  let showLabelsInTitles = display.showLabelsInTitles
  if (options?.isFocused === false && display.showLabelOnlyOnFocus) {
    showLabelsInTitles = false
  }

  const base = display.showFullAgentNames
    ? (TERMINAL_PREFIX_NAMES[prefix] || prefix)
    : prefix
  const sessionChunk = display.showSessionIdInTitles ? options?.sessionChunk?.trim() : null
  const label = options?.label?.trim()

  if (sessionChunk) {
    if (showLabelsInTitles && label) {
      return `${base} ${sessionChunk} - ${label}`
    }
    return `${base} ${sessionChunk}`
  }

  if (!showLabelsInTitles || !label) {
    return base
  }

  if (display.labelReplacesTitle) {
    return label
  }

  return `${base} - ${label}`
}
