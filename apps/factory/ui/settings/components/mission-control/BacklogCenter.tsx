import React from 'react'
import { Icon } from './icons'
import {
  groupTickets,
  sortTickets,
  type FloorTicket,
  type TicketGroupBy,
  type TicketSort,
  type TicketSource,
} from './floorModel'

// Full ticket list (backlog) with group/sort/filter toolbar. Prototype
// backlogCenter():651-665 + ticketRow():641-650. Filtering/grouping/sorting reuse the
// canonical pure functions from floorModel — this stays presentation only.

const GROUP_OPTS: { value: TicketGroupBy; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'priority', label: 'Priority' },
  { value: 'source', label: 'Source' },
  { value: 'status', label: 'Status' },
  { value: 'owner', label: 'Owner' },
]
const SORT_OPTS: TicketSort[] = ['priority', 'id']

interface BacklogCenterProps {
  tickets: FloorTicket[]
  group: TicketGroupBy
  sort: TicketSort
  /** Which ticket sources are visible (Linear / GitHub chips). */
  srcFilter: Record<TicketSource, boolean>
  /** null = all projects; a project name scopes the list. */
  projFilter: string | null
  /** Free-text query from the top bar (matches id / title / labels). */
  search: string
  selectedTicketId: string | null
  onGroup: (by: TicketGroupBy) => void
  onSort: (by: TicketSort) => void
  onToggleSrc: (src: TicketSource) => void
  onSelectTicket: (id: string) => void
  onBackToAgents: () => void
}

function TicketRow({ ticket: t, selected, onSelect }: {
  ticket: FloorTicket
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div className={`trow2${selected ? ' selsel' : ''}`} data-tid={t.id} onClick={() => onSelect(t.id)}>
      <span className={`pri ${t.pri}`} />
      <span className={`src ${t.source}`}>{t.source}</span>
      <span className="tid">{t.id}</span>
      <span className="tt">{t.title}</span>
      <span className="tlabels">
        {(t.labels || []).slice(0, 2).map((l) => (
          <span key={l} className="tlbl">{l}</span>
        ))}
      </span>
      <span className={`tstat ${t.status}`}>{t.status.replace('-', ' ')}</span>
      <span className="tproj">{t.project}</span>
    </div>
  )
}

export function BacklogCenter({
  tickets, group, sort, srcFilter, projFilter, search, selectedTicketId,
  onGroup, onSort, onToggleSrc, onSelectTicket, onBackToAgents,
}: BacklogCenterProps) {
  // Backlog = work you can still dispatch onto, so completed tickets are excluded.
  const q = search.trim().toLowerCase()
  const list = tickets.filter(
    (t) =>
      t.status !== 'done' &&
      (projFilter === null || t.project === projFilter) &&
      srcFilter[t.source] &&
      (!q ||
        t.id.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        (t.labels || []).some((l) => l.toLowerCase().includes(q))),
  )
  const sorted = sortTickets(list, sort)
  const groups = groupTickets(sorted, group)

  return (
    <div className="feed">
      <div className="bktoolbar">
        <span className="seeall" onClick={onBackToAgents}><Icon name="chevL" size={11} /> Agents</span>
        <div className="bh2">BACKLOG · {list.length} tickets</div>
        <div className="grow" />
        <span className="bksel">
          Group{' '}
          <select value={group} onChange={(e) => onGroup(e.target.value as TicketGroupBy)}>
            {GROUP_OPTS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </span>
        <span className="bksel">
          Sort{' '}
          <select value={sort} onChange={(e) => onSort(e.target.value as TicketSort)}>
            {SORT_OPTS.map((o) => (
              <option key={o} value={o}>{o === 'id' ? 'ID' : 'Priority'}</option>
            ))}
          </select>
        </span>
        <span className={`chip ${srcFilter.LN ? 'on' : ''}`} onClick={() => onToggleSrc('LN')}>LN</span>
        <span className={`chip ${srcFilter.GH ? 'on' : ''}`} onClick={() => onToggleSrc('GH')}>GH</span>
      </div>
      {[...groups.entries()].map(([k, arr]) => (
        <React.Fragment key={k}>
          <div className="feed-sec">
            {k} <span style={{ color: 'var(--tx-dim)', fontWeight: 600 }}>· {arr.length}</span>
            <span className="ln" />
          </div>
          {arr.map((t) => (
            <TicketRow
              key={t.id}
              ticket={t}
              selected={selectedTicketId === t.id}
              onSelect={onSelectTicket}
            />
          ))}
        </React.Fragment>
      ))}
    </div>
  )
}
