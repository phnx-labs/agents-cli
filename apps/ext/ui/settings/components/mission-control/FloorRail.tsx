import React, { useEffect, useState } from 'react'
import { Icon, type IconName } from './icons'
import {
  computeHostRows,
  orderManagedProjects,
  projectRollups,
  type CenterMode,
  type FloorAgent,
  type FloorTicket,
  type ManagedProject,
} from './floorModel'

// Collapsed left nav. Dispatch on top (the floor's primary verb), then the three
// smart scopes (All / Needs you / Backlog), then Projects and Hosts as FLYOUT menus —
// click one to scope the feed to a project or host directly, without expanding into
// the full FloorSidebar. The » button remains the single expand affordance.

export type RailKey = 'all' | 'needs' | 'queue' | 'recap' | 'projects' | 'hosts'

/** The scope state the rail reflects. needsOnly = the 'needs' status chip is active. */
export interface RailScopeState {
  center: CenterMode
  projFilter: string | null
  hostFilter: string | null
  needsOnly: boolean
}

/**
 * Which rail button reads as active for the current scope. Queue follows the center;
 * the agent scopes only light while the agents center is showing. 'all' is the
 * everything-else state: agents center with no project/host/needs narrowing.
 *
 * At most one button lights for ANY state: onScope keeps the smart views mutually
 * exclusive (scoping a project/host drops the needs chip and vice versa), and this
 * function is defensive about combined states anyway — a project/host scope wins
 * over a lingering needs chip, so 'needs' only lights with no other narrowing.
 */
export function railActive(key: RailKey, s: RailScopeState): boolean {
  if (key === 'queue') return s.center === 'backlog'
  if (key === 'recap') return s.center === 'recap'
  if (s.center !== 'agents') return false
  if (key === 'needs') return s.needsOnly && s.projFilter == null && s.hostFilter == null
  if (key === 'projects') return s.projFilter != null
  if (key === 'hosts') return s.hostFilter != null
  return !s.needsOnly && s.projFilter == null && s.hostFilter == null
}

export interface RailProjectRow {
  key: string
  name: string
  /** Agents currently on the project. */
  run: number
  /** Agents on the project waiting on the user (amber). */
  wait: number
  /** Open backlog tickets for the project (dim sub-count). */
  backlog: number
  /** Distinct open PRs carried by the project's agents (dim sub-count). */
  prs: number
  /** Curated ManagedProject vs discovered-from-agents only. */
  managed: boolean
}

/**
 * Rows for the Projects flyout: curated projects first (orderManagedProjects), then
 * any project that has live agents but isn't curated — those must still be scopable
 * from the rail, busiest first. Each row carries the full projectRollups counts so
 * one hover answers "what's happening in this project".
 */
export function railProjectRows(agents: FloorAgent[], projects: ManagedProject[], tickets: FloorTicket[] = []): RailProjectRow[] {
  const rollups = projectRollups(agents, tickets)
  const run: Record<string, number> = {}
  for (const [name, r] of Object.entries(rollups)) run[name] = r.run
  const managedNames = new Set(projects.map((p) => p.name))
  const rowFor = (key: string, name: string, managed: boolean): RailProjectRow => {
    const r = rollups[name]
    return { key, name, run: r?.run ?? 0, wait: r?.wait ?? 0, backlog: r?.backlog ?? 0, prs: r?.prs ?? 0, managed }
  }
  const rows = orderManagedProjects(projects, run).map((p) => rowFor(p.id, p.name, true))
  const extras = Object.keys(rollups)
    .filter((name) => !managedNames.has(name) && (rollups[name]?.run ?? 0) > 0)
    .sort((x, y) => (rollups[y]?.run ?? 0) - (rollups[x]?.run ?? 0) || x.localeCompare(y))
    .map((name) => rowFor(`agents:${name}`, name, false))
  return [...rows, ...extras]
}

interface FloorRailProps {
  agents: FloorAgent[]
  tickets: FloorTicket[]
  center: CenterMode
  /** Current project filter: null = All agents; a project name otherwise. */
  projFilter: string | null
  /** Current host filter: null = no host narrowing. */
  hostFilter: string | null
  /** The 'needs' status chip is on — the Needs-you button reflects and toggles it. */
  needsOnly: boolean
  /** Curated managed projects for the Projects flyout. */
  projects?: ManagedProject[]
  /** Registered device fleet, same shape FloorSidebar receives. */
  devices?: { name: string; online: boolean; agents: number }[]
  offlineHosts?: string[]
  hostPins?: string[]
  localHost?: string
  /**
   * Scope routing, identical to FloorSidebar's: '' = all, '__needs', '__queue',
   * 'host:<name>', or a project name.
   */
  onScope: (value: string) => void
  /** Open the Dispatch panel. */
  onDispatch?: () => void
  /** Open the Projects management pane (flyout footer). */
  onManageProjects?: () => void
  /** Expand to the full text sidebar. */
  onExpand: () => void
}

export function FloorRail({
  agents,
  tickets,
  center,
  projFilter,
  hostFilter,
  needsOnly,
  projects = [],
  devices = [],
  offlineHosts = [],
  hostPins = [],
  localHost,
  onScope,
  onDispatch,
  onManageProjects,
  onExpand,
}: FloorRailProps) {
  const [fly, setFly] = useState<null | 'projects' | 'hosts'>(null)
  useEffect(() => {
    if (!fly) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFly(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [fly])

  const scope = (value: string) => { setFly(null); onScope(value) }
  const state: RailScopeState = { center, projFilter, hostFilter, needsOnly }
  const needs = agents.filter((a) => a.needs).length
  const projRows = railProjectRows(agents, projects, tickets)
  const hostRows = computeHostRows(agents, devices, offlineHosts, hostPins, localHost)
  const anyOffline = hostRows.some((h) => h.offline)

  const iconBtn = (key: RailKey, icon: IconName, label: string, onClick: () => void, badge?: number, attn?: boolean, extra?: React.ReactNode) => (
    <button
      type="button"
      className={`rail-ib${railActive(key, state) ? ' on' : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Icon name={icon} size={17} />
      {badge != null && badge > 0 && <span className={`rail-bdg${attn ? ' attn' : ''}`}>{badge}</span>}
      {extra}
    </button>
  )

  return (
    <div className="floor-rail">
      <div className="floor-rail-col">
        {onDispatch && (
          <button type="button" className="rail-ib rail-dispatch" title="Dispatch an agent" aria-label="Dispatch an agent" onClick={() => { setFly(null); onDispatch() }}>
            <Icon name="plus" size={17} />
          </button>
        )}
        {iconBtn('all', 'radar', 'All agents', () => scope(''), agents.length)}
        {iconBtn('needs', 'alert', 'Needs you', () => scope('__needs'), needs || undefined, true)}
        {iconBtn('queue', 'inbox', 'Backlog', () => scope('__queue'), tickets.length || undefined)}
        {iconBtn('recap', 'clock', 'Recap', () => scope('__recap'))}

        <div className="rail-fly-anchor">
          {iconBtn('projects', 'folder', 'Projects', () => setFly((f) => (f === 'projects' ? null : 'projects')))}
          {fly === 'projects' && (
            <div className="rail-fly" role="menu" aria-label="Projects">
              <div className="fly-sec">Projects</div>
              {projRows.length === 0 && <div className="fly-empty">No projects yet</div>}
              {projRows.map((p) => (
                <button key={p.key} type="button" className={`fly-row${projFilter === p.name ? ' on' : ''}`} onClick={() => scope(p.name)}>
                  <span className="n">{p.name}</span>
                  {p.wait > 0 && <span className="w"><Icon name="clock" size={10} />{p.wait}</span>}
                  {(p.backlog > 0 || p.prs > 0) && (
                    <span className="fly-sub">
                      {p.backlog > 0 ? `${p.backlog} ticket${p.backlog === 1 ? '' : 's'}` : ''}
                      {p.backlog > 0 && p.prs > 0 ? ' · ' : ''}
                      {p.prs > 0 ? `${p.prs} PR${p.prs === 1 ? '' : 's'}` : ''}
                    </span>
                  )}
                  <span className="c">{p.run > 0 ? p.run : '—'}</span>
                </button>
              ))}
              {onManageProjects && (
                <button type="button" className="fly-row fly-manage" onClick={() => { setFly(null); onManageProjects() }}>
                  <Icon name="cog" size={12} />
                  <span className="n">Manage projects</span>
                </button>
              )}
            </div>
          )}
        </div>

        <div className="rail-fly-anchor">
          {iconBtn('hosts', 'terminal', 'Hosts', () => setFly((f) => (f === 'hosts' ? null : 'hosts')), undefined, false,
            anyOffline ? <span className="rail-off" title="A host is offline" /> : undefined)}
          {fly === 'hosts' && (
            <div className="rail-fly" role="menu" aria-label="Hosts">
              <div className="fly-sec">Hosts</div>
              {hostRows.map((h) => (
                <button key={h.name} type="button" className={`fly-row${hostFilter === h.name ? ' on' : ''}`} onClick={() => scope(`host:${h.name}`)}>
                  <span className={`fly-hd${h.offline ? ' off' : ''}`} />
                  <span className="n">{h.name}</span>
                  <span className="c">{h.offline ? <span style={{ color: 'var(--fail)' }}>offline</span> : h.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="rail-gap" />
        <button
          type="button"
          className="rail-ib rail-expand"
          title="Expand sidebar"
          aria-label="Expand sidebar"
          onClick={onExpand}
        >
          <Icon name="chevR" size={16} />
        </button>
      </div>
      {fly && <div className="rail-fly-backdrop" onClick={() => setFly(null)} />}
    </div>
  )
}
