import React from 'react'
import { Button } from '../ui/button'
import { SectionHeader } from '../common'
import { ApprovalStatus, IconConfig, TaskSummary } from '../../types'
import { getAgentDisplayName, getIcon } from '../../utils'
import { APPROVAL_BADGE_STYLES, approvalLabel, formatMixFromTask, getAgentPromptSnippet, titleize } from './helpers'

interface ApprovalQueueSectionProps {
  pendingApprovals: TaskSummary[]
  approvalStates: Record<string, ApprovalStatus>
  mixEdits: Record<string, string>
  editingTask: string | null
  icons: IconConfig
  isLightTheme: boolean
  onApprove: (taskName: string) => void
  onReject: (taskName: string) => void
  onApplyEdits: (taskName: string) => void
  onCancelEdit: () => void
  onMixEditChange: (taskName: string, value: string) => void
}

export function ApprovalQueueSection({
  pendingApprovals,
  approvalStates,
  mixEdits,
  editingTask,
  icons,
  isLightTheme,
  onApprove,
  onReject,
  onApplyEdits,
  onCancelEdit,
  onMixEditChange,
}: ApprovalQueueSectionProps) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-4">
      <div className="flex items-center justify-between mb-2">
        <SectionHeader className="mb-0">Approval Queue</SectionHeader>
        <span className="text-[11px] text-[var(--muted-foreground)]">
          Review and approve the distribution plan below
        </span>
      </div>
      {pendingApprovals.length === 0 ? (
        <div className="text-sm text-[var(--muted-foreground)]">All swarms are approved or running.</div>
      ) : (
        <div className="space-y-3">
          {pendingApprovals.map(task => {
            const mixValue = mixEdits[task.task_name] || formatMixFromTask(task)
            const isEditing = editingTask === task.task_name
            const status = approvalStates[task.task_name] || 'pending'

            return (
              <div key={task.task_name} className="rounded-lg border border-[var(--border)] bg-[var(--muted)] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold break-words">{titleize(task.task_name)}</div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                      {mixValue}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-2 py-1 rounded-full ${APPROVAL_BADGE_STYLES[status]}`}>
                      {approvalLabel(status)}
                    </span>
                    <Button size="sm" onClick={() => onApprove(task.task_name)} variant="secondary">
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onReject(task.task_name)}>
                      Request edits
                    </Button>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {(task.agents || []).map(agent => {
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

                {isEditing && (
                  <div className="mt-3 space-y-2">
                    <label className="text-xs font-medium text-[var(--foreground)]">Adjust mix before approval</label>
                    <input
                      value={mixValue}
                      onChange={(event) => onMixEditChange(task.task_name, event.target.value)}
                      className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                      placeholder="70% Claude, 20% Codex, 10% Cursor"
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => onApplyEdits(task.task_name)}>Save mix</Button>
                      <Button size="sm" variant="ghost" onClick={onCancelEdit}>Cancel</Button>
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
