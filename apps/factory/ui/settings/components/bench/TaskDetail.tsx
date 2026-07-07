import React from 'react'
import { Icon } from '../mission-control/icons'
import { TaskCalendar } from './TaskCalendar'
import type { FlatTask } from './TaskCard'
import type { CycleInfo } from '../../types'
import { renderTodoDescription } from '../../utils/markdown'

const SOURCE_CLASS: Record<string, string> = {
  linear: 'ln',
  github: 'gh',
}

const SOURCE_LABEL: Record<string, string> = {
  linear: 'LN',
  github: 'GH',
}

const STATUS_DISPLAY: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
}

function formatCommentDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const ms = Date.now() - d.getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString()
}

interface TaskDetailProps {
  task: FlatTask
  cycleInfo?: CycleInfo | null
  onDispatch: (task: FlatTask) => void
  onDismiss: (taskId: string) => void
  onOpenExternal: (url: string) => void
}

export function TaskDetail({ task, cycleInfo, onDispatch, onDismiss, onOpenExternal }: TaskDetailProps) {
  const srcClass = SOURCE_CLASS[task.source]
  const srcLabel = SOURCE_LABEL[task.source]
  const identifier = task.metadata?.identifier
  const assignee = task.metadata?.assignee?.trim()
  const labels = task.metadata?.labels?.filter(Boolean) ?? []
  const url = task.metadata?.url
  const state = task.metadata?.state
  const comments = task.metadata?.comments ?? []

  return (
    <>
      <div className="sw-bench-detail-head">
        <span className={`sw-source-badge ${srcClass}`}>{srcLabel}</span>
        <span className="detail-title">{task.title}</span>
        {task.priority && (
          <span className={`sw-priority-led ${task.priority}`} />
        )}
        {url && (
          <button
            className="sw-icon-btn"
            onClick={() => onOpenExternal(url)}
            title="Open externally"
          >
            <Icon name="external" size={14} />
          </button>
        )}
      </div>

      <div className="sw-bench-detail-body">
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
          <div className="sw-detail-meta" style={{ flex: '0 0 auto', minWidth: 180 }}>
            <div className="sw-detail-meta-row">
              <span className="sw-detail-meta-label">Status</span>
              <span className="sw-detail-meta-value">
                <span className={`sw-status-led ${task.status}`}>
                  {STATUS_DISPLAY[task.status] || task.status}
                </span>
              </span>
            </div>

            {identifier && (
              <div className="sw-detail-meta-row">
                <span className="sw-detail-meta-label">ID</span>
                <span className="sw-detail-meta-value" style={{ fontFamily: '"Geist Mono", monospace', fontSize: 11 }}>
                  {identifier}
                </span>
              </div>
            )}

            {labels.length > 0 && (
              <div className="sw-detail-meta-row">
                <span className="sw-detail-meta-label">Labels</span>
                <span className="sw-detail-meta-value" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {labels.map(label => (
                    <span key={label} className="sw-label-chip">{label}</span>
                  ))}
                </span>
              </div>
            )}

            {state && state !== task.status && (
              <div className="sw-detail-meta-row">
                <span className="sw-detail-meta-label">State</span>
                <span className="sw-detail-meta-value" style={{ fontFamily: '"Geist Mono", monospace', fontSize: 11 }}>
                  {state}
                </span>
              </div>
            )}

            {assignee && (
              <div className="sw-detail-meta-row">
                <span className="sw-detail-meta-label">Assignee</span>
                <span className="sw-detail-meta-value">{assignee}</span>
              </div>
            )}
          </div>

          {task.metadata?.createdAt && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <TaskCalendar
                createdAt={task.metadata.createdAt}
                dueDate={task.metadata.dueDate}
                cycleInfo={task.source === 'linear' ? cycleInfo : null}
              />
            </div>
          )}
        </div>

        {task.description && (
          <>
            <div className="sw-panel-section-head">Description</div>
            <div className="sw-detail-desc">{renderTodoDescription(task.description, false)}</div>
          </>
        )}

        {comments.length > 0 && (
          <>
            <div className="sw-panel-section-head">Comments ({comments.length})</div>
            <div className="sw-detail-activity">
              {comments.map((c, i) => (
                <div key={i} className="sw-detail-comment">
                  <div className="sw-detail-comment-head">
                    <span className="sw-detail-comment-author">{c.author || 'Unknown'}</span>
                    {c.createdAt && (
                      <span className="sw-detail-comment-time">{formatCommentDate(c.createdAt)}</span>
                    )}
                  </div>
                  <div className="sw-detail-comment-body">{renderTodoDescription(c.body, false)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="sw-bench-detail-actions">
        <button
          className="sw-btn primary"
          onClick={() => onDispatch(task)}
        >
          <Icon name="dispatch" size={12} />
          Dispatch
        </button>
        <button
          className="sw-btn ghost"
          onClick={() => onDismiss(task.id)}
        >
          Dismiss
        </button>
        {url && (
          <>
            <span className="sw-spacer" />
            <button
              className="sw-btn secondary"
              onClick={() => onOpenExternal(url)}
            >
              <Icon name="external" size={12} />
              {task.source === 'linear' ? 'Open in Linear' : task.source === 'github' ? 'Open in GitHub' : 'Open'}
            </button>
          </>
        )}
      </div>
    </>
  )
}
