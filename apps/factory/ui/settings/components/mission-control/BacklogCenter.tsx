import React from 'react'
import {
  groupTickets,
  sortTickets,
  type FloorAgent,
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
  subgroup: TicketGroupBy | 'none'
  sort: TicketSort
  /** Which ticket sources are visible (Linear / GitHub); set from the shared bar. */
  srcFilter: Record<TicketSource, boolean>
  /** null = all projects; a project name scopes the list. */
  projFilter: string | null
  /** Free-text query from the top bar (matches id / title / labels). */
  search: string
  selectedTicketId: string | null
  /** Agents keyed by the ticket they carry (ticketWorkers) — rows show who's on it. */
  workers?: Record<string, FloorAgent[]>
  onSelectTicket: (id: string) => void
  /** Double-click a row to open it as a closeable task tab in the sub-tab strip. */
  onOpenTask: (ticket: FloorTicket) => void
}

/** In-flight chip: phase dot + first worker's abbr (+N when several are on it). */
function WorkerChip({ workers }: { workers: FloorAgent[] }) {
  const first = workers[0]
  if (!first) return null
  const title = workers.map((a) => `${a.abbr} · ${a.name} · ${a.hostLabel ?? a.host}`).join('\n')
  return (
    <span className="twork" title={title}>
      <span className={`dot ${first.phase}`} />
      {first.abbr}
      {workers.length > 1 ? ` +${workers.length - 1}` : ''}
    </span>
  )
}

function TicketRow({ ticket: t, selected, workers = [], onSelect, onOpen }: {
  ticket: FloorTicket
  selected: boolean
  workers?: FloorAgent[]
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
      {workers.length > 0 && <WorkerChip workers={workers} />}
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
  tickets, group, subgroup, sort, srcFilter, projFilter, search, selectedTicketId, workers = {},
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
  const subgroupActive = subgroup !== 'none' && subgroup !== group

  return (
    <div className="feed">
      {[...groups.entries()].map(([k, arr]) => (
        <React.Fragment key={k}>
          <div className="feed-sec">
            {k} <span style={{ color: 'var(--tx-dim)', fontWeight: 600 }}>· {arr.length}</span>
            <span className="ln" />
          </div>
          {subgroupActive
            ? [...groupTickets(arr, subgroup).entries()].map(([subKey, subArr]) => (
                <React.Fragment key={`${k}:${subKey}`}>
                  <div className="feed-sec feed-subsec">
                    {subKey} <span style={{ color: 'var(--tx-dim)', fontWeight: 600 }}>· {subArr.length}</span>
                    <span className="ln" />
                  </div>
                  {subArr.map((t) => (
                    <TicketRow
                      key={t.id}
                      ticket={t}
                      selected={selectedTicketId === t.id}
                      workers={workers[t.id]}
                      onSelect={onSelectTicket}
                      onOpen={onOpenTask}
                    />
                  ))}
                </React.Fragment>
              ))
            : arr.map((t) => (
                <TicketRow
                  key={t.id}
                  ticket={t}
                  selected={selectedTicketId === t.id}
                  workers={workers[t.id]}
                  onSelect={onSelectTicket}
                  onOpen={onOpenTask}
                />
              ))}
        </React.Fragment>
      ))}
    </div>
  )
}
