import React from 'react'
import { Button } from '../ui/button'
import { SectionHeader } from '../common'
import { ApprovalStatus, IconConfig, TaskSummary } from '../../types'
import { formatAgentCount, formatSessionTimestamp, formatTimeAgoSafe, getAgentDisplayName, getIcon, getTaskSummaryStatus } from '../../utils'
import { APPROVAL_BADGE_STYLES, approvalLabel, deriveApprovalStatusFromTask, getAgentPromptSnippet, titleize } from './helpers'

interface RecentSwarmsSectionProps {
  tasks: TaskSummary[]
  tasksLoading: boolean
  tasksDisplayCount: number
  approvalStates: Record<string, ApprovalStatus>
  icons: IconConfig
  isLightTheme: boolean
  onApprove: (taskName: string) => void
  onRefreshTasks: () => void
  onLoadMoreTasks: () => void
}

export function RecentSwarmsSection({
  tasks,
  tasksLoading,
  tasksDisplayCount,
  approvalStates,
  icons,
  isLightTheme,
  onApprove,
  onRefreshTasks,
  onLoadMoreTasks,
}: RecentSwarmsSectionProps) {
  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <SectionHeader className="mb-0">Recent Swarms</SectionHeader>
        <Button variant="ghost" size="sm" onClick={onRefreshTasks} disabled={tasksLoading}>
          Refresh
        </Button>
      </div>
      {tasksLoading && tasks.length === 0 ? (
        <div className="text-center py-8 text-[var(--muted-foreground)]">Loading swarms...</div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-8 text-[var(--muted-foreground)]">No recent swarms found.</div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {[...tasks]
              .sort((a, b) => new Date(b.latest_activity).getTime() - new Date(a.latest_activity).getTime())
              .slice(0, tasksDisplayCount)
              .map(task => {
                const statusLabel = getTaskSummaryStatus(task)
                const latestAgent = task.agents[0]
                const latestTime = latestAgent?.started_at || task.latest_activity
                const approvalStatus = approvalStates[task.task_name] || deriveApprovalStatusFromTask(task)

                return (
                  <div key={task.task_name} className="rounded-xl bg-[var(--muted)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium break-words">{titleize(task.task_name)}</div>
                        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)] flex-wrap">
                          <span>{formatAgentCount(task.agent_count)} · {statusLabel}</span>
                          <span className={`px-2 py-0.5 rounded-full ${APPROVAL_BADGE_STYLES[approvalStatus]}`}>
                            {approvalLabel(approvalStatus)}
                          </span>
                        </div>
                      </div>
                      <div className="text-xs text-[var(--muted-foreground)] text-right shrink-0">
                        <div>{formatSessionTimestamp(latestTime)}</div>
                        <div>{formatTimeAgoSafe(latestTime)}</div>
                      </div>
                    </div>
                    {approvalStatus === 'pending' && (
                      <div className="mt-2">
                        <Button size="sm" variant="secondary" onClick={() => onApprove(task.task_name)}>
                          Approve plan
                        </Button>
                      </div>
                    )}
                    <div className="mt-3 space-y-2">
                      {task.agents.map(agent => {
                        const agentKey = (agent.agent_type || '').toLowerCase()
                        const iconKey = (agentKey in icons ? agentKey : 'agents') as keyof typeof icons
                        const displayName = getAgentDisplayName(agentKey || 'agents')
                        const idChunk = agent.agent_id ? agent.agent_id.slice(0, 8) : ''
                        const snippet = getAgentPromptSnippet(agent)
                        return (
                          <div
                            key={`${task.task_name}-${agent.agent_id}`}
                            className="flex items-start gap-3 px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border)]"
                          >
                            <img
                              src={getIcon(icons[iconKey], isLightTheme)}
                              alt={agent.agent_type}
                              className="w-4 h-4 mt-0.5 shrink-0"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-medium">
                                {displayName}
                                {idChunk && <span className="text-[var(--muted-foreground)] ml-1.5 font-mono">{idChunk}</span>}
                              </div>
                              <div className="text-[11px] text-[var(--muted-foreground)] mt-0.5 line-clamp-2">{snippet}</div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
          </div>
          {tasks.length > tasksDisplayCount && (
            <Button
              variant="outline"
              className="w-full mt-3"
              onClick={onLoadMoreTasks}
            >
              Load More ({tasks.length - tasksDisplayCount} remaining)
            </Button>
          )}
        </>
      )}
    </section>
  )
}
