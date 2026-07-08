import React from 'react'
import { Icon } from './icons'
import type { FloorSort, FloorGroupBy, TicketGroupBy, TicketSort, TicketSource, CenterMode } from './floorModel'

// The Floor's ONE contextual controls bar. It renders a different pill set per active
// center (mode): 'agents' -> Group/Sort/⚑needs (the clean pill bar); 'backlog' ->
// Group/Sort + LN/GH source chips. The projects/host centers get NO bar — the parent
// gates rendering on floorControlsMode(center) so those tabs stay chrome-free. Dispatch
// now lives on the sub-tab strip (FloorSubtabs), not here. Prototype: fbar.
//
// Before this, both the agents bar AND the Backlog's own .bktoolbar rendered Group/Sort,
// so switching to Backlog showed two duplicate control rows. Now there is exactly one.

export type StatusChip = 'needs' | 'running' | 'idle' | 'failed'

/** Which control set (if any) a center wants. projects/host -> null (no bar). */
export function floorControlsMode(center: CenterMode): 'agents' | 'backlog' | null {
  if (center === 'agents') return 'agents'
  if (center === 'backlog') return 'backlog'
  return null
}

const SORT_OPTS: { value: FloorSort; label: string }[] = [
  { value: 'needs', label: 'Needs you first' },
  { value: 'recent', label: 'Recent activity' },
  { value: 'tok', label: 'tok/s' },
  { value: 'name', label: 'Name' },
]

// Group the live feed by an axis; 'none' keeps the default phase sections. Same axes
// as the Backlog's group control (TICKET_GROUP_OPTS) so the two modes match.
const GROUP_OPTS: { value: FloorGroupBy | 'none'; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'project', label: 'Project' },
  { value: 'host', label: 'Host' },
  { value: 'status', label: 'Status' },
  { value: 'agent', label: 'Agent' },
]

const TICKET_GROUP_OPTS: { value: TicketGroupBy; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'priority', label: 'Priority' },
  { value: 'source', label: 'Source' },
  { value: 'status', label: 'Status' },
  { value: 'owner', label: 'Owner' },
]
const TICKET_SORT_OPTS: TicketSort[] = ['priority', 'id']

const SVG = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const

interface FloorControlsProps {
  /** Which control set to render. projects/host centers render no bar (parent gates). */
  mode: 'agents' | 'backlog'

  /** Count of agents that need you — shown as the ⚑ flag pill (agents mode). */
  needsCount?: number

  sidebarOpen: boolean
  onToggleSidebar: () => void
  rightOpen: boolean
  onToggleRight: () => void
  plain: boolean
  onTogglePlain: () => void

  // --- agents-mode controls ---
  sort: FloorSort
  onSort: (s: FloorSort) => void
  /** How the live feed is grouped ('none' = default phase sections). */
  group: FloorGroupBy | 'none'
  onGroup: (g: FloorGroupBy | 'none') => void

  // --- backlog-mode controls ---
  ticketGroup: TicketGroupBy
  onTicketGroup: (by: TicketGroupBy) => void
  ticketSort: TicketSort
  onTicketSort: (by: TicketSort) => void
  srcFilter: Record<TicketSource, boolean>
  onToggleSrc: (src: TicketSource) => void
}

export function FloorControls({
  mode,
  needsCount = 0,
  sidebarOpen, onToggleSidebar, rightOpen, onToggleRight, plain, onTogglePlain,
  sort, onSort, group, onGroup,
  ticketGroup, onTicketGroup, ticketSort, onTicketSort, srcFilter, onToggleSrc,
}: FloorControlsProps) {
  const groupLabel = (GROUP_OPTS.find((o) => o.value === group) ?? GROUP_OPTS[0]!).label
  const sortLabel = (SORT_OPTS.find((o) => o.value === sort) ?? SORT_OPTS[0]!).label
  const ticketGroupLabel = (TICKET_GROUP_OPTS.find((o) => o.value === ticketGroup) ?? TICKET_GROUP_OPTS[0]!).label

  return (
    <div className="fbar clean">
      <div className="grow" />

      {mode === 'agents' ? (
        <>
          <label className="fpill fpill-sel" title="Group the feed">
            Group: <b>{groupLabel}</b>
            <select value={group} onChange={(e) => onGroup(e.target.value as FloorGroupBy | 'none')}>
              {GROUP_OPTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="fpill fpill-sel" title="Sort the feed">
            <b>{sortLabel}</b>
            <select value={sort} onChange={(e) => onSort(e.target.value as FloorSort)}>
              {SORT_OPTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          {needsCount > 0 && (
            <span className="fpill fpill-flag" title={`${needsCount} need you`}><Icon name="alert" size={11} /> {needsCount}</span>
          )}
        </>
      ) : (
        <>
          <label className="fpill fpill-sel" title="Group the backlog">
            Group: <b>{ticketGroupLabel}</b>
            <select value={ticketGroup} onChange={(e) => onTicketGroup(e.target.value as TicketGroupBy)}>
              {TICKET_GROUP_OPTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="fpill fpill-sel" title="Sort the backlog">
            <b>{ticketSort === 'id' ? 'ID' : 'Priority'}</b>
            <select value={ticketSort} onChange={(e) => onTicketSort(e.target.value as TicketSort)}>
              {TICKET_SORT_OPTS.map((o) => (
                <option key={o} value={o}>{o === 'id' ? 'ID' : 'Priority'}</option>
              ))}
            </select>
          </label>

          <span className={`chip ${srcFilter.LN ? 'on' : ''}`} onClick={() => onToggleSrc('LN')}>LN</span>
          <span className={`chip ${srcFilter.GH ? 'on' : ''}`} onClick={() => onToggleSrc('GH')}>GH</span>
        </>
      )}

      <button className="iconbtn plainbtn" title={`Plain language: ${plain ? 'on' : 'off'}`} onClick={onTogglePlain}>Aa</button>
      <button
        className={`iconbtn ${sidebarOpen ? 'on' : ''}`}
        title="Show / hide the left rail"
        onClick={onToggleSidebar}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" {...SVG}>
          <rect x="2.2" y="2.5" width="11.6" height="11" rx="1.4" />
          <line x1="6" y1="2.5" x2="6" y2="13.5" />
        </svg>
      </button>
      <button
        className={`iconbtn ${rightOpen ? 'on' : ''}`}
        title="Show / hide the detail panel"
        onClick={onToggleRight}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" {...SVG}>
          <rect x="2.2" y="2.5" width="11.6" height="11" rx="1.4" />
          <line x1="10" y1="2.5" x2="10" y2="13.5" />
        </svg>
      </button>
    </div>
  )
}
