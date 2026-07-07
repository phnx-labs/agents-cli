import React from 'react'
import { Icon } from './icons'
import type { FloorAgent, FloorTicket } from './floorModel'

// Collapsed left nav: a narrow column of icon buttons with count/needs badges, the
// mockup's default rail. Each button routes via the same onScope the full FloorSidebar
// uses ('' = all, '__needs', '__queue', a project name); the » button expands back to
// the full sidebar. Kept intentionally minimal — the rail is a summary, not the roster.

interface FloorRailProps {
  agents: FloorAgent[]
  tickets: FloorTicket[]
  /** Current scope: null = All agents; '__needs'/'__queue' or a project name otherwise. */
  scope: string | null
  onScope: (value: string) => void
  /** Expand to the full text sidebar. */
  onExpand: () => void
}

type RailButton = {
  key: string
  scope: string
  icon: string
  label: string
  badge?: number
  /** Amber (attention) badge vs neutral count badge. */
  attn?: boolean
}

export function FloorRail({ agents, tickets, scope, onScope, onExpand }: FloorRailProps) {
  const needs = agents.filter((a) => a.needs).length
  const buttons: RailButton[] = [
    { key: 'all', scope: '', icon: 'radar', label: 'All agents', badge: agents.length },
    { key: 'needs', scope: '__needs', icon: 'alert', label: 'Needs you', badge: needs || undefined, attn: true },
    { key: 'queue', scope: '__queue', icon: 'inbox', label: 'Backlog', badge: tickets.length || undefined },
    { key: 'projects', scope: '__projects', icon: 'folder', label: 'Projects' },
    { key: 'hosts', scope: '__hosts', icon: 'terminal', label: 'Hosts' },
  ]
  const isOn = (b: RailButton) =>
    b.scope === '' ? scope === null || scope === '' : scope === b.scope

  return (
    <div className="floor-rail">
      <div className="floor-rail-col">
        {buttons.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`rail-ib${isOn(b) ? ' on' : ''}`}
            title={b.label}
            aria-label={b.label}
            // Projects/Hosts need the full roster — expand into the sidebar; the
            // feed scopes route in place.
            onClick={() => (b.scope === '__projects' || b.scope === '__hosts' ? onExpand() : onScope(b.scope))}
          >
            <Icon name={b.icon} size={17} />
            {b.badge != null && b.badge > 0 && (
              <span className={`rail-bdg${b.attn ? ' attn' : ''}`}>{b.badge}</span>
            )}
          </button>
        ))}
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
    </div>
  )
}
