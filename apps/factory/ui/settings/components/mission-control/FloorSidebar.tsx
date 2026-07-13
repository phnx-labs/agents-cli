import React, { useState } from 'react'
import { Icon } from './icons'
import { computeHostRows, orderManagedProjects, type FloorAgent, type FloorTicket, type HostRow, type ManagedProject } from './floorModel'

// Left scope sidebar. Prototype buildSidebar(): factory-floor.html:563-579,
// wiring wireSidebar():580-588. Smart (All / Needs you), Queue (Backlog),
// Projects (with wait-counts), Hosts (with health). Counts are derived from the
// agents + tickets passed in — no data fetching here.

export const FLOOR_SIDEBAR_DEFAULT_WIDTH = 210
export const FLOOR_SIDEBAR_MIN_WIDTH = 176
export const FLOOR_SIDEBAR_MAX_WIDTH = 360

interface FloorSidebarProps {
  agents: FloorAgent[]
  tickets: FloorTicket[]
  /** Current project filter: null = All agents; a project name otherwise. */
  projFilter: string | null
  /** Current host scope: null = no host filter; a host name highlights that row. */
  hostFilter?: string | null
  /** Hosts known to be offline (health comes from SHELL, not hardcoded). */
  offlineHosts?: string[]
  /** Registered device fleet (agents devices) to surface under HOSTS, even with 0 agents. */
  devices?: { name: string; online: boolean; agents: number }[]
  /** Ordered list of pinned host names (pinned hosts render first, drag-reorderable). */
  hostPins?: string[]
  /** Pin/unpin a host (moves it above/below the divider). */
  onToggleHostPin?: (name: string) => void
  /** Persist a new pinned order after a drag. */
  onReorderHostPins?: (names: string[]) => void
  /**
   * Scope routing. '' = All agents, '__needs' = Needs you, '__queue' = Backlog,
   * otherwise a project name. Mirrors wireSidebar()'s data-proj values.
   */
  onScope: (value: string) => void
  /** Open the host detail/config pane for a host (clicking its name). */
  onSelectHost?: (host: string) => void
  /** Host currently shown in the detail pane, for highlight. */
  selectedHost?: string | null
  /**
   * Full discovered host roster (name + reachability), so idle-but-reachable
   * hosts appear too — not just hosts that happen to be running an agent.
   */
  hosts?: Array<{ name: string; online: boolean }>
  /** Local machine's canonical device name — always gets a HOSTS row, even off-registry. */
  localHost?: string
  /** Curated managed projects (top 3 render here; the rest fold into "+N more"). */
  projects?: ManagedProject[]
  /** Open the Projects management pane (gear + "+N more" row). */
  onManageProjects?: () => void
  /** Current sidebar width, persisted by the parent shell. */
  sidebarWidth?: number
  /** Persist a resized sidebar width. */
  onSidebarWidthChange?: (width: number) => void
  /** Collapse back to the icon rail. */
  onCollapse?: () => void
}

export function FloorSidebar({ agents, tickets, projFilter, hostFilter = null, offlineHosts = [], devices = [], hostPins = [], onToggleHostPin, onReorderHostPins, onScope, localHost, projects = [], onManageProjects, sidebarWidth = FLOOR_SIDEBAR_DEFAULT_WIDTH, onSidebarWidthChange, onCollapse }: FloorSidebarProps) {
  const byProj: Record<string, number> = {}
  const projWait: Record<string, number> = {}
  for (const a of agents) {
    byProj[a.project] = (byProj[a.project] || 0) + 1
    if (a.needs) projWait[a.project] = (projWait[a.project] || 0) + 1
  }
  const needs = agents.filter((a) => a.needs).length
  // HOSTS rows: local machine folded to its real device name, merged with the
  // online device fleet, pinned hosts first. Pure + unit-tested (computeHostRows).
  const hostRows = computeHostRows(agents, devices, offlineHosts, hostPins, localHost)
  const pinnedRows = hostRows.filter((h) => h.pinned)
  const restRows = hostRows.filter((h) => !h.pinned)

  const [dragName, setDragName] = useState<string | null>(null)
  const [overName, setOverName] = useState<string | null>(null)
  const [resizing, setResizing] = useState(false)

  const setWidth = (width: number) => {
    onSidebarWidthChange?.(Math.max(FLOOR_SIDEBAR_MIN_WIDTH, Math.min(FLOOR_SIDEBAR_MAX_WIDTH, Math.round(width))))
  }

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onSidebarWidthChange) return
    e.preventDefault()
    e.stopPropagation()
    const target = e.currentTarget
    const pointerId = e.pointerId
    target.setPointerCapture(pointerId)
    const startX = e.clientX
    const startWidth = sidebarWidth
    const prevCursor = document.documentElement.style.cursor
    const prevUserSelect = document.documentElement.style.userSelect
    document.documentElement.style.cursor = 'col-resize'
    document.documentElement.style.userSelect = 'none'
    setResizing(true)
    const onMove = (ev: PointerEvent) => setWidth(startWidth + ev.clientX - startX)
    let cleaned = false
    const onUp = () => {
      if (cleaned) return
      cleaned = true
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      document.documentElement.style.cursor = prevCursor
      document.documentElement.style.userSelect = prevUserSelect
      setResizing(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    window.addEventListener('pointercancel', onUp, { once: true })
  }

  const onResizeKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onSidebarWidthChange) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      setWidth(sidebarWidth - (e.shiftKey ? 32 : 16))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      setWidth(sidebarWidth + (e.shiftKey ? 32 : 16))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setWidth(FLOOR_SIDEBAR_MIN_WIDTH)
    } else if (e.key === 'End') {
      e.preventDefault()
      setWidth(FLOOR_SIDEBAR_MAX_WIDTH)
    }
  }

  // Drop `dragName` immediately before `target` in the persisted pin order.
  const dropBefore = (target: string) => {
    if (dragName && dragName !== target) {
      const without = hostPins.filter((n) => n !== dragName)
      const idx = without.indexOf(target)
      const next = idx < 0 ? [...without, dragName] : [...without.slice(0, idx), dragName, ...without.slice(idx)]
      onReorderHostPins?.(next)
    }
    setDragName(null)
    setOverName(null)
  }

  const renderHost = (h: HostRow) => (
    <div
      key={h.name}
      className={`sb-item sb-host${h.pinned ? ' pinned' : ''}${hostFilter === h.name ? ' on' : ''}${dragName === h.name ? ' dragging' : ''}${overName === h.name ? ' dragover' : ''}`}
      draggable={h.pinned}
      onDragStart={h.pinned ? (e) => { setDragName(h.name); e.dataTransfer.effectAllowed = 'move' } : undefined}
      onDragOver={h.pinned ? (e) => { e.preventDefault(); if (dragName && dragName !== h.name) setOverName(h.name) } : undefined}
      onDragLeave={h.pinned ? () => setOverName((n) => (n === h.name ? null : n)) : undefined}
      onDrop={h.pinned ? (e) => { e.preventDefault(); dropBefore(h.name) } : undefined}
      onDragEnd={() => { setDragName(null); setOverName(null) }}
      onClick={() => onScope(`host:${h.name}`)}
    >
      <span className="sb-grip" title={h.pinned ? 'Drag to reorder' : undefined}>
        {h.pinned ? <Icon name="grip" size={12} /> : null}
      </span>
      <span className={`hd ${h.offline ? 'off' : ''}`} />
      <span>{h.name}</span>
      <span className="c">{h.offline ? <span style={{ color: 'var(--fail)' }}>offline</span> : h.count}</span>
      <button
        type="button"
        className={`sb-pin${h.pinned ? ' on' : ''}`}
        title={h.pinned ? 'Unpin' : 'Pin to top'}
        onClick={(e) => { e.stopPropagation(); onToggleHostPin?.(h.name) }}
      >
        <Icon name="pin" size={12} />
      </button>
    </div>
  )

  return (
    <div className={`sidebar${resizing ? ' resizing' : ''}`}>
      <div className="sb-sec" style={{ display: 'flex', alignItems: 'center' }}>
        <span>SMART</span>
        {onCollapse && (
          <button type="button" className="sb-collapse" title="Collapse to rail" aria-label="Collapse sidebar" onClick={onCollapse}>
            <Icon name="chevL" size={13} />
          </button>
        )}
      </div>
      <div className={`sb-item ${projFilter === null ? 'on' : ''}`} onClick={() => onScope('')}>
        <span>All agents</span>
        <span className="c">{agents.length}</span>
      </div>
      <div className="sb-item" onClick={() => onScope('__needs')}>
        <span style={{ color: 'var(--wait)' }}><Icon name="alert" size={12} /> Needs you</span>
        <span className="c"><span className="w">{needs}</span></span>
      </div>

      <div className="sb-sec">QUEUE</div>
      <div className="sb-item" onClick={() => onScope('__queue')}>
        <span>Backlog</span>
        <span className="c">{tickets.length} tickets</span>
      </div>

      <div className="sb-sec" style={{ display: 'flex', alignItems: 'center' }}>
        <span>PROJECTS</span>
        <button
          type="button"
          title="Manage projects"
          onClick={() => onManageProjects?.()}
          style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--ds-text-faint)' }}
        >
          <Icon name="cog" size={12} />
        </button>
      </div>
      {orderManagedProjects(projects, byProj).slice(0, 3).map((p) => {
        const count = byProj[p.name] ?? 0
        return (
          <div key={p.id} className={`sb-item ${projFilter === p.name ? 'on' : ''}`} onClick={() => onScope(p.name)}>
            {p.linearProjectId ? <span className="hd" style={{ background: '#8b8ce8' }} title="Linear-linked" /> : null}
            <span>{p.name}</span>
            <span className="c">
              {projWait[p.name] ? <span className="w"><Icon name="clock" size={10} />{projWait[p.name]}</span> : null}
              {count > 0 ? count : <span style={{ color: 'var(--ds-text-faint)' }}>—</span>}
            </span>
          </div>
        )
      })}
      {projects.length > 3 ? (
        <div className="sb-item" style={{ color: 'var(--ds-text-faint)' }} onClick={() => onManageProjects?.()}>
          <span>＋{projects.length - 3} more · manage</span>
        </div>
      ) : null}

      <div className="sb-sec">HOSTS</div>
      {pinnedRows.map(renderHost)}
      {pinnedRows.length > 0 && restRows.length > 0 && <div className="sb-host-div" />}
      {restRows.map(renderHost)}
      <div
        className="sidebar-resize"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={FLOOR_SIDEBAR_MIN_WIDTH}
        aria-valuemax={FLOOR_SIDEBAR_MAX_WIDTH}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        title="Resize sidebar"
        onPointerDown={startResize}
        onKeyDown={onResizeKey}
      />
    </div>
  )
}
