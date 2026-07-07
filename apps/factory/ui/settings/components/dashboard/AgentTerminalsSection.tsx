import React, { useEffect, useState } from 'react'
import { IconConfig, TaskSummary, TerminalDetail } from '../../types'
import { getAgentDisplayName, getIcon } from '../../utils'
import { SectionHeader } from '../common'
import { getFilesChangedCount, getTerminalPrompt, stripXmlTags, truncateText } from './helpers'

interface AgentTerminalsSectionProps {
  selectedAgentType: string | null
  agentTerminals: TerminalDetail[]
  agentTerminalsLoading: boolean
  sessionTasks: Record<string, TaskSummary[]>
  expandedTerminalIds: Set<string>
  icons: IconConfig
  isLightTheme: boolean
  onCloseAgentTerminals: () => void
  onOpenTerminalFile: (filePath: string) => void
  onToggleExpanded: (terminalId: string) => void
}

function formatQuickSummaryLine(terminal: TerminalDetail, filesChangedFromTasks: number | null): string | null {
  const summary = terminal.quickSummary
  const filesEdited = Math.max(summary?.filesEdited || 0, filesChangedFromTasks || 0)
  const toolCalls = summary?.toolCalls || 0
  const webCount = (summary?.webSearches || 0) + (summary?.webFetches || 0)
  const mcpCalls = summary?.mcpCalls || 0

  if (filesEdited === 0 && toolCalls === 0 && webCount === 0 && mcpCalls === 0) {
    return null
  }

  const parts: string[] = []
  if (filesEdited > 0) parts.push(`Files ${filesEdited}`)
  parts.push(`Tools ${toolCalls}`)
  if (webCount > 0) parts.push(`Web ${webCount}`)
  if (mcpCalls > 0) parts.push(`MCP ${mcpCalls}`)
  return parts.join(' | ')
}

function getFilename(filePath: string): string {
  if (!filePath) return filePath
  const normalized = filePath.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || filePath
}

function formatToolLabel(toolName: string): string {
  if (toolName.length <= 18) return toolName
  return `${toolName.slice(0, 15)}...`
}

function formatTerminalUpdateTime(isoTimestamp?: string): string {
  if (!isoTimestamp) return 'No updates yet'
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return 'No updates yet'

  const diffMs = Math.max(0, Date.now() - date.getTime())
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  const diffWeeks = Math.floor(diffDays / 7)

  if (diffMins < 1) return 'Just now'
  if (diffMins === 1) return '1 min ago'
  if (diffMins < 60) return `${diffMins} mins ago`
  if (diffHours === 1) return '1 hour ago'
  if (diffHours < 24) return `${diffHours} hours ago`
  if (diffDays === 1) return '1 day ago'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffWeeks === 1) return '1 week ago'
  return `${diffWeeks} weeks ago`
}

export function AgentTerminalsSection({
  selectedAgentType,
  agentTerminals,
  agentTerminalsLoading,
  sessionTasks,
  expandedTerminalIds,
  icons,
  isLightTheme,
  onCloseAgentTerminals,
  onOpenTerminalFile,
  onToggleExpanded,
}: AgentTerminalsSectionProps) {
  const [, setRelativeTimeTick] = useState(0)
  const [expandedFileBadges, setExpandedFileBadges] = useState<Set<string>>(new Set())
  const [expandedToolBadges, setExpandedToolBadges] = useState<Set<string>>(new Set())

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setRelativeTimeTick(prev => prev + 1)
    }, 30_000)
    return () => window.clearInterval(timerId)
  }, [])

  if (!selectedAgentType) return null

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <SectionHeader className="mb-0">
          {getAgentDisplayName(selectedAgentType)} Terminals ({agentTerminals.length})
        </SectionHeader>
        <button
          onClick={onCloseAgentTerminals}
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          Close
        </button>
      </div>
      {agentTerminalsLoading ? (
        <div className="text-sm text-[var(--muted-foreground)] py-4">Loading...</div>
      ) : agentTerminals.length === 0 ? (
        <div className="text-sm text-[var(--muted-foreground)] py-4">
          No terminals found for {getAgentDisplayName(selectedAgentType)}.
        </div>
      ) : (
        <div className="space-y-3">
          {agentTerminals.map(terminal => {
            const rawLabel = terminal.label || terminal.autoLabel
            const displayLabel = rawLabel ? stripXmlTags(rawLabel) : null
            const agentName = getAgentDisplayName(terminal.agentType)
            const prompt = getTerminalPrompt(terminal)
            const hasMessages = terminal.messageCount && terminal.messageCount > 0
            const currentActivity = terminal.currentActivity || (hasMessages ? 'Working...' : 'Waiting for input')
            const activityLine = currentActivity.startsWith('>') ? currentActivity : `> ${currentActivity}`
            const isExpanded = expandedTerminalIds.has(terminal.id)
            const sessionId = terminal.sessionId || ''
            const filesChanged = getFilesChangedCount(sessionTasks[sessionId])
            const quickSummaryLine = formatQuickSummaryLine(terminal, filesChanged)
            const recentFiles = terminal.recentFiles || []
            const fileBadgesExpanded = expandedFileBadges.has(terminal.id)
            const visibleFiles = fileBadgesExpanded ? recentFiles : recentFiles.slice(0, 4)
            const hiddenFilesCount = Math.max(0, recentFiles.length - 4)
            const recentTools = terminal.recentTools || []
            const toolBadgesExpanded = expandedToolBadges.has(terminal.id)
            const visibleTools = toolBadgesExpanded ? recentTools : recentTools.slice(0, 4)
            const hiddenToolsCount = Math.max(0, recentTools.length - 4)
            const lastFilePath = terminal.lastFilePath || null
            const status = terminal.status || (hasMessages ? 'running' : 'idle')

            return (
              <div
                key={terminal.id}
                onClick={() => onToggleExpanded(terminal.id)}
                className="px-4 py-3 rounded-xl bg-[var(--muted)] transition-colors cursor-pointer hover:bg-[var(--muted-foreground)]/10"
              >
                <div className="flex items-center gap-3">
                  <img
                    src={getIcon(icons[terminal.agentType as keyof typeof icons] || icons.agents, isLightTheme)}
                    alt={terminal.agentType}
                    className="w-5 h-5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate flex items-center gap-2">
                      {displayLabel || `${agentName} ${terminal.index}`}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                        status === 'running' ? 'bg-emerald-500/15 text-emerald-600 border border-emerald-500/40' :
                        status === 'completed' ? 'bg-[var(--muted-foreground)]/15 text-[var(--muted-foreground)] border border-[var(--border)]' :
                        'bg-amber-500/15 text-amber-600 border border-amber-500/40'
                      }`}>
                        {status === 'running' ? 'Running' : status === 'completed' ? 'Done' : 'Idle'}
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--muted-foreground)] truncate">
                      {truncateText(prompt, 80)}
                    </div>
                  </div>
                  <span className="text-xs text-[var(--muted-foreground)] shrink-0">
                    {formatTerminalUpdateTime(terminal.lastActivityTimestamp)}
                  </span>
                </div>

                <div className="mt-2 ml-8 text-xs font-mono text-[var(--foreground)]">
                  {activityLine}
                </div>
                {quickSummaryLine && (
                  <div className="mt-1 ml-8 text-[11px] text-[var(--muted-foreground)]">
                    {quickSummaryLine}
                  </div>
                )}
                {visibleFiles.length > 0 && (
                  <div className="mt-1 ml-8 flex flex-wrap gap-1.5">
                    {visibleFiles.map(filePath => (
                      <button
                        key={filePath}
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenTerminalFile(filePath)
                        }}
                        className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[11px] text-[var(--foreground)] hover:border-[var(--primary)]/50"
                        title={filePath}
                      >
                        {getFilename(filePath)}
                      </button>
                    ))}
                    {hiddenFilesCount > 0 && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation()
                          setExpandedFileBadges(prev => {
                            const next = new Set(prev)
                            if (next.has(terminal.id)) next.delete(terminal.id)
                            else next.add(terminal.id)
                            return next
                          })
                        }}
                        className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      >
                        {fileBadgesExpanded ? 'Show less' : `+${hiddenFilesCount} more`}
                      </button>
                    )}
                  </div>
                )}
                {visibleTools.length > 0 && (
                  <div className="mt-1 ml-8 flex flex-wrap gap-1.5">
                    {visibleTools.map(toolName => (
                      <span
                        key={toolName}
                        className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground)]"
                        title={toolName}
                      >
                        {formatToolLabel(toolName)}
                      </span>
                    ))}
                    {hiddenToolsCount > 0 && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation()
                          setExpandedToolBadges(prev => {
                            const next = new Set(prev)
                            if (next.has(terminal.id)) next.delete(terminal.id)
                            else next.add(terminal.id)
                            return next
                          })
                        }}
                        className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      >
                        {toolBadgesExpanded ? 'Show less' : `+${hiddenToolsCount} more`}
                      </button>
                    )}
                  </div>
                )}

                {isExpanded && (
                  <div className="mt-3 ml-8 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-3 space-y-2">
                    <div className="text-xs text-[var(--muted-foreground)]">Full prompt</div>
                    <div className="text-sm text-[var(--foreground)] whitespace-pre-wrap">{prompt}</div>
                    <div className="grid gap-1 text-xs text-[var(--muted-foreground)]">
                      <div className="font-mono break-all">Session: {sessionId || 'not started'}</div>
                      <div>Messages: {terminal.messageCount ?? 0}</div>
                      {lastFilePath && (
                        <div
                          className="cursor-pointer hover:text-[var(--foreground)]"
                          onClick={(event) => {
                            event.stopPropagation()
                            onOpenTerminalFile(lastFilePath)
                          }}
                        >
                          Last file: {getFilename(lastFilePath)}
                        </div>
                      )}
                      {quickSummaryLine && <div>{quickSummaryLine}</div>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
