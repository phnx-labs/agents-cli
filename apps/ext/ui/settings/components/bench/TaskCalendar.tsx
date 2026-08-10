import React, { useMemo } from 'react'
import type { CycleInfo } from '../../types'

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const DAY_MS = 86_400_000

interface DayCell {
  key: string
  num: number
  isToday: boolean
  isCreated: boolean
  isDue: boolean
  inCycle: boolean
  isOtherMonth: boolean
  // Position in the work window (created → due), 0..1 exclusive of endpoints.
  // null when the cell is not strictly between created and due.
  spanT: number | null
  // Position in the overdue burn-down (due → today), 0..1 exclusive of endpoints.
  // null when the task isn't overdue or the cell isn't in that range.
  overdueT: number | null
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function buildMonthGrid(
  anchorDate: Date,
  today: Date,
  createdDate: Date,
  dueDate: Date | null,
  cycleStart: Date | null,
  cycleEnd: Date | null,
): DayCell[] {
  const year = anchorDate.getFullYear()
  const month = anchorDate.getMonth()

  const firstOfMonth = new Date(year, month, 1)
  const lastOfMonth = new Date(year, month + 1, 0)

  // Monday = 0 in our grid. JS getDay(): 0=Sun, 1=Mon...
  const startDow = (firstOfMonth.getDay() + 6) % 7
  const daysInMonth = lastOfMonth.getDate()

  const createdMs = startOfDay(createdDate).getTime()
  const dueMs = dueDate ? startOfDay(dueDate).getTime() : null
  const todayMs = startOfDay(today).getTime()
  const spanDays = dueMs != null ? (dueMs - createdMs) / DAY_MS : 0
  const overdueDays = dueMs != null && todayMs > dueMs ? (todayMs - dueMs) / DAY_MS : 0

  const mark = (date: Date, key: string, isOtherMonth: boolean): DayCell => {
    const dMs = startOfDay(date).getTime()
    // spanT: strictly between created and due (the in-span tint cells)
    let spanT: number | null = null
    if (dueMs != null && spanDays > 0 && dMs > createdMs && dMs < dueMs) {
      spanT = (dMs - createdMs) / (dueMs - createdMs)
    }
    // overdueT: strictly between due and today (the burn-down tint cells)
    let overdueT: number | null = null
    if (dueMs != null && overdueDays > 0 && dMs > dueMs && dMs < todayMs) {
      overdueT = (dMs - dueMs) / (todayMs - dueMs)
    }
    return {
      key,
      num: date.getDate(),
      isToday: isSameDay(date, today),
      isCreated: isSameDay(date, createdDate),
      isDue: dueDate ? isSameDay(date, dueDate) : false,
      inCycle: isInCycle(date, cycleStart, cycleEnd),
      isOtherMonth,
      spanT,
      overdueT,
    }
  }

  const cells: DayCell[] = []

  // Leading days from previous month
  const prevMonthLast = new Date(year, month, 0).getDate()
  for (let i = startDow - 1; i >= 0; i--) {
    const day = prevMonthLast - i
    cells.push(mark(new Date(year, month - 1, day), `prev-${day}`, true))
  }

  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(mark(new Date(year, month, day), `cur-${day}`, false))
  }

  // Trailing days to fill last row
  const remaining = 7 - (cells.length % 7)
  if (remaining < 7) {
    for (let day = 1; day <= remaining; day++) {
      cells.push(mark(new Date(year, month + 1, day), `next-${day}`, true))
    }
  }

  return cells
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

function isInCycle(date: Date, start: Date | null, end: Date | null): boolean {
  if (!start || !end) return false
  const d = date.getTime()
  const s = startOfDay(start).getTime()
  const e = startOfDay(end).getTime()
  return d >= s && d <= e
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

interface TaskCalendarProps {
  createdAt?: string
  dueDate?: string
  cycleInfo?: CycleInfo | null
}

export function TaskCalendar({ createdAt, dueDate, cycleInfo }: TaskCalendarProps) {
  const data = useMemo(() => {
    if (!createdAt) return null

    const created = new Date(createdAt)
    if (isNaN(created.getTime())) return null

    const due = dueDate ? new Date(dueDate) : null
    const dueValid = due && !isNaN(due.getTime()) ? due : null

    const today = new Date()
    const cycleStart = cycleInfo ? new Date(cycleInfo.startsAt) : null
    const cycleEnd = cycleInfo ? new Date(cycleInfo.endsAt) : null

    // Anchor the month view to the due date when one exists — that's where
    // attention should go. Created date is the fallback (today's behavior).
    const anchor = dueValid ?? created

    const cells = buildMonthGrid(anchor, today, created, dueValid, cycleStart, cycleEnd)
    const monthYear = `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`

    const overdue = dueValid ? startOfDay(dueValid).getTime() < startOfDay(today).getTime() : false

    return { cells, monthYear, hasCycle: !!cycleInfo, hasDue: !!dueValid, overdue }
  }, [createdAt, dueDate, cycleInfo])

  if (!data) return null

  return (
    <div className="sw-task-calendar">
      <div className="sw-panel-section-head">Timeline</div>
      <div className="sw-calendar-header">
        <span className="sw-calendar-month">{data.monthYear}</span>
      </div>
      <div className="sw-calendar-weekdays">
        {WEEKDAYS.map(d => <span key={d}>{d}</span>)}
      </div>
      <div className="sw-calendar-grid">
        {data.cells.map(day => {
          const classes = ['sw-calendar-day']
          if (day.isOtherMonth) classes.push('other-month')
          if (day.inCycle) classes.push('in-cycle')
          if (day.isToday) classes.push('today')
          if (day.isCreated) classes.push('created')
          if (day.isDue) {
            classes.push('due')
            if (data.overdue) classes.push('overdue')
          }
          if (day.spanT != null) classes.push('in-span')
          if (day.overdueT != null) classes.push('in-overdue')
          if (day.isToday && data.overdue) classes.push('overdue')

          const t = day.overdueT ?? day.spanT
          const style = t != null ? ({ ['--t' as string]: t.toFixed(3) } as React.CSSProperties) : undefined

          return (
            <span key={day.key} className={classes.join(' ')} style={style}>
              {day.num}
            </span>
          )
        })}
      </div>
      <div className="sw-calendar-legend">
        <span className="sw-calendar-legend-item created">Created</span>
        {data.hasDue && (
          <span className={`sw-calendar-legend-item due${data.overdue ? ' overdue' : ''}`}>
            {data.overdue ? 'Overdue' : 'Due'}
          </span>
        )}
        {data.hasCycle && (
          <span className="sw-calendar-legend-item cycle">Cycle</span>
        )}
        <span className="sw-calendar-legend-item today-legend">Today</span>
      </div>
    </div>
  )
}
