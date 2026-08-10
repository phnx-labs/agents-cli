import React, { useState, useEffect } from 'react'
import type { TaskSource, UnifiedTask } from '../../types'

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

// Age tier — calibrated against a 14-day cycle.
type AgeTier = 'fresh' | 'aging' | 'stale' | 'rotten'
function ageTier(iso: string | undefined): AgeTier {
  if (!iso) return 'fresh'
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000
  if (days < 7) return 'fresh'
  if (days < 14) return 'aging'
  if (days < 30) return 'stale'
  return 'rotten'
}

// Due-date chip text + state. Days are calendar days from local midnight.
type DueInfo = { label: string; state: 'normal' | 'soon' | 'late' }
function dueInfo(iso: string | undefined): DueInfo | null {
  if (!iso) return null
  const due = new Date(iso)
  if (isNaN(due.getTime())) return null
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const days = Math.round((due.getTime() - startOfToday.getTime()) / 86_400_000)
  if (days < 0) return { label: `Overdue ${-days}d`, state: 'late' }
  if (days === 0) return { label: 'Due today', state: 'soon' }
  if (days === 1) return { label: 'Due tomorrow', state: 'soon' }
  if (days <= 3) return { label: `Due in ${days}d`, state: 'soon' }
  const month = due.toLocaleString('en-US', { month: 'short' })
  return { label: `Due ${month} ${due.getDate()}`, state: 'normal' }
}

const SOURCE_CLASS: Record<TaskSource, string> = {
  linear: 'ln',
  github: 'gh',
}

const SOURCE_LABEL: Record<TaskSource, string> = {
  linear: 'LN',
  github: 'GH',
}

export interface FlatTask {
  id: string
  source: TaskSource
  title: string
  description?: string
  status: 'todo' | 'in_progress' | 'done'
  priority?: 'urgent' | 'high' | 'medium' | 'low'
  metadata?: UnifiedTask['metadata']
}

interface TaskCardProps {
  task: FlatTask
  selected: boolean
  onClick: () => void
}

export function TaskCard({ task, selected, onClick }: TaskCardProps) {
  const srcClass = SOURCE_CLASS[task.source]
  const srcLabel = SOURCE_LABEL[task.source]
  const identifier = task.metadata?.identifier
  const assignee = task.metadata?.assignee?.trim()
  const labels = task.metadata?.labels?.filter(Boolean) ?? []
  const createdAt = task.metadata?.createdAt
  const dueDate = task.metadata?.dueDate

  const [, tick] = useState(0)
  useEffect(() => {
    if (!createdAt && !dueDate) return
    const id = setInterval(() => tick(n => n + 1), 60_000)
    return () => clearInterval(id)
  }, [createdAt, dueDate])

  const tier = ageTier(createdAt)
  const due = dueInfo(dueDate)
  // Ribbon goes red as soon as a task is overdue, even if it was created recently.
  const ribbonTier: AgeTier = due?.state === 'late' && tier === 'fresh' ? 'aging' : tier

  const cardClass = [
    'sw-task-card',
    selected ? 'selected' : '',
    ribbonTier !== 'fresh' ? `ribbon-${ribbonTier}` : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      className={cardClass}
      onClick={onClick}
      style={{ width: '100%', textAlign: 'left' }}
    >
      <div className="sw-task-card-top">
        <span className={`sw-source-badge ${srcClass}`}>{identifier || srcLabel}</span>
        {task.priority && (
          <span className={`sw-priority-led ${task.priority}`} />
        )}
      </div>

      <div className="sw-task-card-title">{task.title}</div>

      {task.description && (
        <div className="sw-task-card-desc">{task.description}</div>
      )}

      {(assignee || labels.length > 0 || due || createdAt) && (
        <div className="sw-task-card-meta">
          {assignee && (
            <span className="sw-label-chip">{assignee}</span>
          )}
          {labels.map(label => (
            <span key={`${task.id}-${label}`} className="sw-label-chip">
              {label}
            </span>
          ))}
          {due && (
            <span className={`sw-due-chip ${due.state}`}>{due.label}</span>
          )}
          {createdAt && (
            <span className={`sw-task-age tier-${tier}`}>{relativeTime(createdAt)}</span>
          )}
        </div>
      )}
    </button>
  )
}
