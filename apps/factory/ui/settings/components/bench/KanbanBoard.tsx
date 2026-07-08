import React, { useMemo } from 'react'
import { TaskCard } from './TaskCard'
import type { FlatTask } from './TaskCard'

type Status = 'todo' | 'in_progress' | 'done'

const COLUMNS: Array<{ key: Status; label: string }> = [
  { key: 'todo', label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'done', label: 'Done' },
]

interface KanbanBoardProps {
  tasks: FlatTask[]
  selectedTaskId: string | null
  onOpen: (task: FlatTask) => void
}

export function KanbanBoard({ tasks, selectedTaskId, onOpen }: KanbanBoardProps) {
  const byStatus = useMemo(() => {
    const map: Record<Status, FlatTask[]> = { todo: [], in_progress: [], done: [] }
    for (const t of tasks) {
      const s: Status = t.status === 'in_progress' || t.status === 'done' ? t.status : 'todo'
      map[s].push(t)
    }
    return map
  }, [tasks])

  return (
    <div className="sw-kanban">
      {COLUMNS.map(col => {
        const items = byStatus[col.key]
        return (
          <div className={`sw-kanban-col ${col.key}`} key={col.key}>
            <div className="sw-kanban-col-head">
              <span className="sw-kanban-col-led" />
              <span className="sw-section-label">{col.label}</span>
              <span className="sw-section-count">{items.length}</span>
            </div>
            <div className="sw-kanban-col-body">
              {items.length === 0 ? (
                <div className="sw-kanban-col-empty">Empty</div>
              ) : (
                items.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    selected={task.id === selectedTaskId}
                    onClick={() => onOpen(task)}
                  />
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
