import React from 'react'
import {
  groupTickets,
  sortTickets,
  type FloorTicket,
  type TicketGroupBy,
  type TicketSort,
  type TicketSource,
} from './floorModel'

// Full ticket list (backlog). Group/sort/source controls now live in the shared
// contextual bar (FloorControls, mode='backlog') — this component's own duplicate
// `.bktoolbar` was removed so the Backlog view renders ONE controls bar, not two.
// The group/sort/srcFilter props still arrive (applied to the list here); only the
// toolbar UI moved out. Double-click a row to open it as a closeable task tab.

interface BacklogCenterProps {
  tickets: FloorTicket[]
  group: TicketGroupBy
  sort: TicketSort
  /** Which ticket sources are visible (Linear / GitHub); set from the shared bar. */
  srcFilter: Record<TicketSource, boolean>
  /** null = all projects; a project name scopes the list. */
  projFilter: string | null
  /** Free-text query from the top bar (matches id / title / labels). */
  search: string
  selectedTicketId: string | null
  onSelectTicket: (id: string) => void
  /** Double-click a row to open it as a closeable task tab in the sub-tab strip. */
  onOpenTask: (ticket: FloorTicket) => void
}

function TicketRow({ ticket: t, selected, onSelect, onOpen }: {
  ticket: FloorTicket
  selected: boolean
  onSelect: (id: string) => void
  onOpen: (ticket: FloorTicket) => void
}) {
  return (
    <div
      className={`trow2${selected ? ' selsel' : ''}`}
      data-tid={t.id}
      onClick={() => onSelect(t.id)}
      onDoubleClick={() => onOpen(t)}
    >
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
  onSelectTicket, onOpenTask,
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
              onOpen={onOpenTask}
            />
          ))}
        </React.Fragment>
      ))}
    </div>
  )
}
