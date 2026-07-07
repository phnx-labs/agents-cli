import React from 'react'
import { Icon } from './icons'
import type { AgentAbbr, FloorSort, FloorGroupBy } from './floorModel'

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

const DEFAULT_AGENT_CHIPS: AgentAbbr[] = ['CC', 'CX', 'GX']

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
  runningCount: number
  totalCount: number

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
  /** Which status chips are active. */
  activeStatus: StatusChip[]
  onToggleStatus: (chip: StatusChip) => void
  /** Which agent-type chips to show (defaults to CC/CX/GX like the prototype). */
  agentChips?: AgentAbbr[]
  /** Which agent-type chips are active. */
  activeAbbrs: AgentAbbr[]
  onToggleAbbr: (abbr: AgentAbbr) => void

  search: string
  onSearch: (q: string) => void
  onDispatch: () => void
}

export function FloorControls({
  runningCount, totalCount,
  sidebarOpen, onToggleSidebar, rightOpen, onToggleRight, plain, onTogglePlain,
  sort, onSort, group, onGroup, activeStatus, onToggleStatus, agentChips = DEFAULT_AGENT_CHIPS, activeAbbrs, onToggleAbbr,
  search, onSearch, onDispatch,
}: FloorControlsProps) {
  const statusOn = new Set(activeStatus)
  const abbrOn = new Set(activeAbbrs)

  return (
    <div className="fbar">
      <div className="fgroup">
        <span className="fgroup-label">Sort</span>
        <select className="sel" value={sort} onChange={(e) => onSort(e.target.value as FloorSort)}>
          {SORT_OPTS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="fsep" />

      <div className="fgroup">
        <span className="fgroup-label">Status</span>
        <span className={`chip needs ${statusOn.has('needs') ? 'on' : ''}`} onClick={() => onToggleStatus('needs')}>
          <Icon name="alert" size={11} /> Needs you
        </span>
        <span className={`chip ${statusOn.has('running') ? 'on' : ''}`} onClick={() => onToggleStatus('running')}>
          <span className="dot running" /> Running
        </span>
        <span className={`chip ${statusOn.has('idle') ? 'on' : ''}`} onClick={() => onToggleStatus('idle')}>
          <span className="dot idle" /> Idle
        </span>
        <span className={`chip ${statusOn.has('failed') ? 'on' : ''}`} onClick={() => onToggleStatus('failed')}>
          <span className="dot failed" /> Failed
        </span>
      </div>

      <div className="fsep" />

      <div className="fgroup">
        <span className="fgroup-label">Agent</span>
        {agentChips.map((ab) => (
          <span key={ab} className={`chip ${abbrOn.has(ab) ? 'on' : ''}`} onClick={() => onToggleAbbr(ab)}>{ab}</span>
        ))}
      </div>

      <div className="fsep" />

      <div className="fgroup">
        <span className="fgroup-label">Group</span>
        <select className="sel" value={group} onChange={(e) => onGroup(e.target.value as FloorGroupBy | 'none')}>
          {GROUP_OPTS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="fsep" />

      <input
        className="search"
        placeholder="search agents, branches, activity…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />

      <div className="grow" />

      <div className="stat"><span className="dot running" /><b>{runningCount}</b>/<span>{totalCount}</span> running</div>
      <button className="themebtn" onClick={onTogglePlain}>Plain language: {plain ? 'on' : 'off'}</button>
      <button
        className={`iconbtn ${sidebarOpen ? 'on' : ''}`}
        title="Show / hide projects sidebar"
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
