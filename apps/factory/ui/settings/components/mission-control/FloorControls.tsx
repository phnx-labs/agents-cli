import React from 'react'
import { Icon } from './icons'
import type { FloorSort, FloorGroupBy } from './floorModel'

// Single Floor filter bar (Sort · Status · Agent · search · stats · toggles · Dispatch).
// The old duplicate ".top" header (second FACTORY logo + theme toggle) was removed —
// the app-level TopBar is the one and only header. Controls are grouped with separators
// and the bar never wraps (overflow-x scrolls). Prototype: factory-floor-v2.html fbar.

export type StatusChip = 'needs' | 'running' | 'idle' | 'failed'

const SORT_OPTS: { value: FloorSort; label: string }[] = [
  { value: 'needs', label: 'Needs you first' },
  { value: 'recent', label: 'Recent activity' },
  { value: 'tok', label: 'tok/s' },
  { value: 'name', label: 'Name' },
]

// Group the live feed by an axis; 'none' keeps the default phase sections. Same axes
// as the Backlog's group control (BacklogCenter GROUP_OPTS) so the two bars match.
const GROUP_OPTS: { value: FloorGroupBy | 'none'; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'project', label: 'Project' },
  { value: 'host', label: 'Host' },
  { value: 'status', label: 'Status' },
  { value: 'agent', label: 'Agent' },
]

const SVG = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const

interface FloorControlsProps {
  /** Count of agents that need you — shown as the ⚑ flag pill. */
  needsCount?: number

  sidebarOpen: boolean
  onToggleSidebar: () => void
  rightOpen: boolean
  onToggleRight: () => void
  plain: boolean
  onTogglePlain: () => void

  sort: FloorSort
  onSort: (s: FloorSort) => void
  /** How the live feed is grouped ('none' = default phase sections). */
  group: FloorGroupBy | 'none'
  onGroup: (g: FloorGroupBy | 'none') => void

  onDispatch: () => void
}

export function FloorControls({
  needsCount = 0,
  sidebarOpen, onToggleSidebar, rightOpen, onToggleRight, plain, onTogglePlain,
  sort, onSort, group, onGroup,
  onDispatch,
}: FloorControlsProps) {
  const groupLabel = (GROUP_OPTS.find((o) => o.value === group) ?? GROUP_OPTS[0]).label
  const sortLabel = (SORT_OPTS.find((o) => o.value === sort) ?? SORT_OPTS[0]).label

  // Clean pill bar (mockup): the ad-hoc Status/Agent chips and the running tally are
  // gone — filtering lives in saved views + search. What remains reads as calm pills:
  // Group ▾ · Sort ▾ · ⚑needs, then the panel toggles + Dispatch.
  return (
    <div className="fbar clean">
      <div className="grow" />

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
      <button className="disp" onClick={onDispatch}><Icon name="zap" size={12} /> Dispatch</button>
    </div>
  )
}
