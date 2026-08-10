import React, { useMemo, useState } from 'react'
import type { FlatTask } from './TaskCard'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface DeadlineViewProps {
  tasks: FlatTask[]
  onOpen: (task: FlatTask) => void
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dueClass(due: Date, today: Date): string {
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const startDue = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime()
  if (startDue < startToday) return 'late'
  const days = Math.round((startDue - startToday) / 86_400_000)
  if (days <= 3) return 'soon'
  return 'normal'
}

export function DeadlineView({ tasks, onOpen }: DeadlineViewProps) {
  const [monthOffset, setMonthOffset] = useState(0)

  const { dated, unscheduled } = useMemo(() => {
    const dated: Array<{ task: FlatTask; due: Date }> = []
    const unscheduled: FlatTask[] = []
    for (const t of tasks) {
      const iso = t.metadata?.dueDate
      const d = iso ? new Date(iso) : null
      if (d && !isNaN(d.getTime())) dated.push({ task: t, due: d })
      else unscheduled.push(t)
    }
    return { dated, unscheduled }
  }, [tasks])

  const today = new Date()
  const anchor = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1)
  const year = anchor.getFullYear()
  const month = anchor.getMonth()

  const tasksByDay = useMemo(() => {
    const map = new Map<string, Array<{ task: FlatTask; due: Date }>>()
    for (const entry of dated) {
      const k = dayKey(entry.due)
      const arr = map.get(k) ?? []
      arr.push(entry)
      map.set(k, arr)
    }
    return map
  }, [dated])

  const cells = useMemo(() => {
    const firstOfMonth = new Date(year, month, 1)
    const startDow = (firstOfMonth.getDay() + 6) % 7
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const prevMonthLast = new Date(year, month, 0).getDate()
    const out: Array<{ key: string; num: number; date: Date; other: boolean }> = []
    for (let i = startDow - 1; i >= 0; i--) {
      const day = prevMonthLast - i
      out.push({ key: `prev-${day}`, num: day, date: new Date(year, month - 1, day), other: true })
    }
    for (let day = 1; day <= daysInMonth; day++) {
      out.push({ key: `cur-${day}`, num: day, date: new Date(year, month, day), other: false })
    }
    const remaining = (7 - (out.length % 7)) % 7
    for (let day = 1; day <= remaining; day++) {
      out.push({ key: `next-${day}`, num: day, date: new Date(year, month + 1, day), other: true })
    }
    return out
  }, [year, month])

  const isToday = (d: Date) =>
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()

  return (
    <div className="sw-deadline">
      <div className="sw-deadline-head">
        <button className="sw-deadline-nav" onClick={() => setMonthOffset(o => o - 1)} aria-label="Previous month">‹</button>
        <span className="sw-deadline-month">{MONTH_NAMES[month]} {year}</span>
        <button className="sw-deadline-nav" onClick={() => setMonthOffset(o => o + 1)} aria-label="Next month">›</button>
        {monthOffset !== 0 && (
          <button className="sw-deadline-today" onClick={() => setMonthOffset(0)}>Today</button>
        )}
        <span className="sw-section-line" />
        <span className="sw-deadline-count">{dated.length} scheduled · {unscheduled.length} unscheduled</span>
      </div>

      <div className="sw-deadline-weekdays">
        {WEEKDAYS.map(d => <span key={d}>{d}</span>)}
      </div>

      <div className="sw-deadline-grid">
        {cells.map(cell => {
          const items = tasksByDay.get(dayKey(cell.date)) ?? []
          const classes = ['sw-deadline-cell']
          if (cell.other) classes.push('other-month')
          if (isToday(cell.date)) classes.push('today')
          return (
            <div key={cell.key} className={classes.join(' ')}>
              <div className="sw-deadline-cell-num">{cell.num}</div>
              <div className="sw-deadline-cell-tasks">
                {items.map(({ task, due }) => (
                  <button
                    key={task.id}
                    className={`sw-deadline-chip ${dueClass(due, today)}`}
                    onClick={() => onOpen(task)}
                    title={task.title}
                  >
                    {task.priority && <span className={`sw-priority-led ${task.priority}`} />}
                    <span className="sw-deadline-chip-title">{task.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {unscheduled.length > 0 && (
        <div className="sw-deadline-unscheduled">
          <div className="sw-deadline-unscheduled-head">
            <span className="sw-section-label">Unscheduled</span>
            <span className="sw-section-count">{unscheduled.length}</span>
          </div>
          <div className="sw-deadline-unscheduled-body">
            {unscheduled.map(task => (
              <button
                key={task.id}
                className="sw-deadline-chip normal"
                onClick={() => onOpen(task)}
                title={task.title}
              >
                {task.priority && <span className={`sw-priority-led ${task.priority}`} />}
                <span className="sw-deadline-chip-title">{task.metadata?.identifier ? `${task.metadata.identifier} · ` : ''}{task.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
