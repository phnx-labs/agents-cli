import React, { useState } from 'react'
import { Icon } from './icons'
import type { SavedView } from './savedViews'
import type { AgentAbbr, FloorGroupBy } from './floorModel'
import type { StatusChip } from './FloorControls'

// Feed header bar: saved-view chips + (when agents center) group-by and status/
// agent filter controls. Filter/group used to live only on FloorControls (top
// nav); operators look at the feed itself, so those affordances belong here
// next to "Save view" (RUSH-1526).

/** Same axes as FloorControls GROUP_OPTS — kept local so the header bar does not
 *  re-export FloorControls internals. */
export const FEED_GROUP_OPTS: { value: FloorGroupBy | 'none'; label: string }[] = [
  { value: 'outcome', label: 'Outcome' },
  { value: 'none', label: 'None' },
  { value: 'project', label: 'Project' },
  { value: 'host', label: 'Host' },
  { value: 'status', label: 'Status' },
  { value: 'agent', label: 'Agent' },
]

export const FEED_STATUS_OPTS: { value: StatusChip; label: string }[] = [
  { value: 'needs', label: 'Needs you' },
  { value: 'running', label: 'Running' },
  { value: 'idle', label: 'Idle' },
  { value: 'failed', label: 'Failed' },
]

interface SavedViewsProps {
  views: SavedView[]
  activeName: string | null
  onApply: (v: SavedView) => void
  onSave: (name: string) => void
  onDelete: (name: string) => void
  /**
   * When set, render group-by + status/agent filter chips in this same bar
   * (the feed header). Omit on non-agents surfaces so the bar stays Save-view-only.
   */
  feedFilters?: {
    group: FloorGroupBy | 'none'
    onGroup: (g: FloorGroupBy | 'none') => void
    subgroup: FloorGroupBy | 'none'
    onSubgroup: (g: FloorGroupBy | 'none') => void
    status: StatusChip[]
    onToggleStatus: (s: StatusChip) => void
    abbrs: AgentAbbr[]
    availableAbbrs: AgentAbbr[]
    onToggleAbbr: (a: AgentAbbr) => void
  }
}

export function SavedViews({
  views,
  activeName,
  onApply,
  onSave,
  onDelete,
  feedFilters,
}: SavedViewsProps) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const commit = () => {
    const n = name.trim()
    if (n) onSave(n)
    setName('')
    setAdding(false)
  }

  const groupLabel = feedFilters
    ? (FEED_GROUP_OPTS.find((o) => o.value === feedFilters.group) ?? FEED_GROUP_OPTS[0]!).label
    : ''
  const subgroupValue = feedFilters && feedFilters.group !== 'none' && feedFilters.subgroup !== feedFilters.group
    ? feedFilters.subgroup
    : 'none'
  const subgroupLabel = feedFilters
    ? (FEED_GROUP_OPTS.find((o) => o.value === subgroupValue) ?? FEED_GROUP_OPTS[1]!).label
    : ''
  const subgroupOptions = feedFilters
    ? FEED_GROUP_OPTS.filter((o) => o.value === 'none' || o.value !== feedFilters.group)
    : []

  return (
    <div className="savedviews feed-header-bar" data-testid="feed-header-bar">
      {views.map((v) => (
        <span
          key={v.name}
          className={`svchip${activeName === v.name ? ' on' : ''}`}
          onClick={() => onApply(v)}
        >
          {v.name}
          <span className="svx" title="Delete view" onClick={(e) => { e.stopPropagation(); onDelete(v.name) }}>
            <Icon name="x" size={9} />
          </span>
        </span>
      ))}
      {adding ? (
        <input
          className="svinput"
          autoFocus
          value={name}
          placeholder="View name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') { setName(''); setAdding(false) }
          }}
          onBlur={commit}
        />
      ) : (
        <span className="svadd" onClick={() => setAdding(true)}><Icon name="plus" size={10} /> Save view</span>
      )}

      {feedFilters && (
        <>
          <span className="sv-sep" aria-hidden="true" />
          <label className="fpill fpill-sel feed-header-group" title="Group the feed">
            Group: <b>{groupLabel}</b>
            <select
              value={feedFilters.group}
              onChange={(e) => feedFilters.onGroup(e.target.value as FloorGroupBy | 'none')}
              aria-label="Group feed by"
            >
              {FEED_GROUP_OPTS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="fpill fpill-sel feed-header-group" title="Subgroup the feed">
            Subgroup: <b>{subgroupLabel}</b>
            <select
              value={subgroupValue}
              disabled={feedFilters.group === 'none'}
              onChange={(e) => feedFilters.onSubgroup(e.target.value as FloorGroupBy | 'none')}
              aria-label="Subgroup feed by"
            >
              {subgroupOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          {FEED_STATUS_OPTS.map((o) => {
            const on = feedFilters.status.includes(o.value)
            return (
              <span
                key={o.value}
                className={`chip feed-header-status${on ? ' on' : ''}`}
                title={on ? `Clear ${o.label} filter` : `Filter: ${o.label}`}
                onClick={() => feedFilters.onToggleStatus(o.value)}
              >
                {o.label}
              </span>
            )
          })}
          {feedFilters.availableAbbrs.length > 0 && (
            <>
              <span className="sv-sep" aria-hidden="true" />
              {feedFilters.availableAbbrs.map((abbr) => {
                const on = feedFilters.abbrs.includes(abbr)
                return (
                  <span
                    key={abbr}
                    className={`chip feed-header-agent${on ? ' on' : ''}`}
                    title={on ? `Hide ${abbr}` : `Show only ${abbr}`}
                    onClick={() => feedFilters.onToggleAbbr(abbr)}
                  >
                    {abbr}
                  </span>
                )
              })}
            </>
          )}
        </>
      )}
    </div>
  )
}
