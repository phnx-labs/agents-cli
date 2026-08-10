import React, { useMemo, useRef, useState, useCallback, useLayoutEffect } from 'react'
import { Icon } from './icons'
import { AgentAvatar, agentIdFromPrefix } from './AgentAvatar'
import {
  needsReconnect,
  type FloorAgent,
  type SessionFilter,
  type SessionGroup,
  type SessionSort,
} from './floorModel'
import {
  scopeSessions,
  sortSessions,
  groupSessions,
  sessionChipCounts,
  type SessionSection,
  type SessionScope,
} from './sessionsModel'

// The Sessions surface: one place to see every session you own — local + remote,
// active + orphaned — and resume any of them, or a whole project's worth after a
// reboot. It reads the roster Factory already polls (floorAgents); every filter /
// sort / group runs client-side, and the list is virtualized (fixed-offset
// windowing below), so hundreds of rows render like twenty.

const ROW_H = 34
const HEADER_H = 30
const OVERSCAN = 8

interface SessionsPaneProps {
  agents: FloorAgent[]
  /** Toggle the star (pin) on a session — parent owns the persisted set. */
  onToggleStar: (a: FloorAgent) => void
  /** Resume / focus a single session — parent routes to the owning machine. */
  onResume: (a: FloorAgent) => void
  /** Resume many at once (bulk reconnect). Parent loops the resume path. */
  onResumeMany: (agents: FloorAgent[]) => void
  /** Select a session for the detail pane. */
  onSelect: (a: FloorAgent) => void
  /** Currently selected session id (detail pane). */
  selectedId?: string | null
}

type VItem =
  | { kind: 'header'; section: SessionSection; height: number }
  | { kind: 'row'; agent: FloorAgent; section: SessionSection; height: number }

// A resumable, detached session is the acute case; colour its dot distinctly.
function statusClass(a: FloorAgent): string {
  const ls = (a.liveStatus ?? '').toLowerCase()
  if (ls === 'crashed') return 'fail'
  if (needsReconnect(a)) return 'orphan'
  if (a.phase === 'waiting') return 'wait'
  if (a.phase === 'failed') return 'fail'
  if (a.phase === 'running' || a.phase === 'stalled') return 'run'
  if (a.phase === 'done') return 'done'
  return 'idle'
}

const SORT_OPTS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Last active' },
  { value: 'started', label: 'Started' },
  { value: 'status', label: 'Status' },
  { value: 'name', label: 'Name' },
  { value: 'tok', label: 'Tokens/s' },
]
const GROUP_OPTS: { value: SessionGroup; label: string }[] = [
  { value: 'state', label: 'State' },
  { value: 'project', label: 'Project' },
  { value: 'host', label: 'Host' },
  { value: 'flat', label: 'Flat' },
]

export function SessionsPane({ agents, onToggleStar, onResume, onResumeMany, onSelect, selectedId }: SessionsPaneProps) {
  const [filter, setFilter] = useState<SessionFilter>('all')
  const [project, setProject] = useState<string | null>(null)
  const [host, setHost] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<SessionGroup>('state')
  const [sort, setSort] = useState<SessionSort>('recent')
  const [desc, setDesc] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  const counts = useMemo(() => sessionChipCounts(agents), [agents])

  // Distinct projects / hosts for the selectors — from the live roster, cheap.
  const projects = useMemo(() => [...new Set(agents.map((a) => a.project).filter(Boolean))].sort(), [agents])
  const hosts = useMemo(() => [...new Set(agents.map((a) => a.hostLabel ?? a.host).filter(Boolean))].sort(), [agents])

  const scope: SessionScope = useMemo(() => ({ filter, project, host, search }), [filter, project, host, search])
  const scoped = useMemo(() => scopeSessions(agents, scope), [agents, scope])
  const sections = useMemo(() => groupSessions(scoped, group, sort, desc), [scoped, group, sort, desc])

  // Flatten sections into a single windowable item list with per-item heights.
  const items: VItem[] = useMemo(() => {
    const out: VItem[] = []
    for (const s of sections) {
      out.push({ kind: 'header', section: s, height: HEADER_H })
      for (const a of s.agents) out.push({ kind: 'row', agent: a, section: s, height: ROW_H })
    }
    return out
  }, [sections])

  // Prefix-sum offsets: offsets[i] = pixel top of item i; offsets[n] = total height.
  const offsets = useMemo(() => {
    const o = new Array(items.length + 1)
    o[0] = 0
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + items[i]!.height
    return o
  }, [items])
  const totalH = offsets[items.length] ?? 0

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewportH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Binary-search the first visible item, then walk to the last — O(log n) + O(visible).
  const [start, end] = useMemo(() => {
    const top = scrollTop - OVERSCAN * ROW_H
    const bottom = scrollTop + viewportH + OVERSCAN * ROW_H
    if (items.length === 0) return [0, 0]
    // first i with offsets[i+1] > top
    let lo = 0
    let hi = items.length - 1
    let first = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] > top) { first = mid; hi = mid - 1 } else lo = mid + 1
    }
    let last = first
    while (last < items.length && offsets[last] < bottom) last++
    return [first, Math.min(last, items.length)]
  }, [scrollTop, viewportH, offsets, items.length])

  const visible = items.slice(start, end)
  const padTop = offsets[start] ?? 0
  const padBottom = totalH - (offsets[end] ?? totalH)

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectedAgents = useMemo(() => scoped.filter((a) => selected.has(a.id)), [scoped, selected])
  const reconnectAll = useMemo(() => scoped.filter(needsReconnect), [scoped])

  const resumeSection = useCallback((s: SessionSection) => onResumeMany(s.agents), [onResumeMany])

  return (
    <div className="sw-sessions">
      <div className="sx-filters">
        <div className="sx-chips">
          {(['all', 'active', 'orphaned', 'starred'] as SessionFilter[]).map((f) => (
            <button
              key={f}
              className={`sx-chip${filter === f ? ' on' : ''}${f === 'orphaned' ? ' orphan' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f[0]!.toUpperCase() + f.slice(1)}
              <span className="n">{counts[f]}</span>
            </button>
          ))}
        </div>
        <select className="sx-sel" value={project ?? ''} onChange={(e) => setProject(e.target.value || null)} title="Filter by project">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="sx-sel" value={host ?? ''} onChange={(e) => setHost(e.target.value || null)} title="Filter by machine">
          <option value="">All hosts</option>
          {hosts.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <div className="sx-search">
          <Icon name="search" size={12} />
          <input
            aria-label="Search sessions"
            placeholder="Search topic, repo, id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="sx-group" title="Group sessions">
          Group <b>{GROUP_OPTS.find((o) => o.value === group)!.label}</b>
          <select value={group} onChange={(e) => setGroup(e.target.value as SessionGroup)}>
            {GROUP_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="sx-group" title="Sort sessions">
          Sort <b>{SORT_OPTS.find((o) => o.value === sort)!.label}</b>
          <select value={sort} onChange={(e) => setSort(e.target.value as SessionSort)}>
            {SORT_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <button className="sx-dir" title={desc ? 'Descending' : 'Ascending'} onClick={() => setDesc((d) => !d)}>
          <Icon name={desc ? 'chevD' : 'chevR'} size={12} />
        </button>
      </div>

      <div className="sx-scroll" ref={scrollRef} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
        {items.length === 0 ? (
          <div className="sx-empty">No sessions match. {agents.length > 0 && <button className="sx-link" onClick={() => { setFilter('all'); setProject(null); setHost(null); setSearch('') }}>Clear filters</button>}</div>
        ) : (
          <div style={{ height: totalH, position: 'relative' }}>
            <div style={{ transform: `translateY(${padTop}px)` }}>
              {visible.map((it, i) =>
                it.kind === 'header' ? (
                  <SectionHeader
                    key={it.section.key}
                    section={it.section}
                    reconnectCount={it.section.band === 'reconnect' ? it.section.agents.length : 0}
                    onResumeAll={() => resumeSection(it.section)}
                  />
                ) : (
                  <SessionRow
                    key={it.agent.id}
                    agent={it.agent}
                    selected={selected.has(it.agent.id)}
                    active={selectedId === it.agent.id}
                    onToggleSelect={toggleSelect}
                    onToggleStar={onToggleStar}
                    onResume={onResume}
                    onSelect={onSelect}
                  />
                )
              )}
              {/* bottom spacer keeps the scrollbar honest */}
              <div style={{ height: padBottom }} aria-hidden />
            </div>
          </div>
        )}
      </div>

      {(selected.size > 0 || reconnectAll.length > 0) && (
        <div className="sx-bulk">
          {selected.size > 0 ? (
            <>
              <span className="sx-bulk-n"><b>{selected.size}</b> selected</span>
              <button className="sx-ghost" onClick={() => setSelected(new Set(scoped.map((a) => a.id)))}>Select all ({scoped.length})</button>
              <button className="sx-ghost" onClick={() => setSelected(new Set())}>Clear</button>
              <button className="sx-ghost" onClick={() => selectedAgents.forEach(onToggleStar)}>Star</button>
              <button className="sx-primary" onClick={() => onResumeMany(selectedAgents)}>Resume {selected.size} selected</button>
            </>
          ) : (
            <>
              <span className="sx-bulk-n"><b>{reconnectAll.length}</b> need reconnecting</span>
              <button className="sx-primary" onClick={() => onResumeMany(reconnectAll)}>Resume all {reconnectAll.length}</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SectionHeaderImpl({ section, reconnectCount, onResumeAll }: { section: SessionSection; reconnectCount: number; onResumeAll: () => void }) {
  const isReconnect = section.band === 'reconnect'
  const glyph = section.kind === 'starred' ? '★' : isReconnect ? '◍' : section.band === 'done' ? '✓' : '●'
  return (
    <div className={`sx-band${isReconnect ? ' recon' : ''}${section.kind === 'starred' ? ' star' : ''}`} style={{ height: HEADER_H }}>
      <span className="g">{glyph}</span>
      <span className="lab">{section.label}</span>
      <span className="cnt">{section.agents.length}</span>
      {reconnectCount > 0 && (
        <button className="sx-band-act" onClick={(e) => { e.stopPropagation(); onResumeAll() }}>Resume all {reconnectCount}</button>
      )}
    </div>
  )
}
const SectionHeader = React.memo(SectionHeaderImpl)

interface RowProps {
  agent: FloorAgent
  selected: boolean
  active: boolean
  onToggleSelect: (id: string) => void
  onToggleStar: (a: FloorAgent) => void
  onResume: (a: FloorAgent) => void
  onSelect: (a: FloorAgent) => void
}

function SessionRowImpl({ agent: a, selected, active, onToggleSelect, onToggleStar, onResume, onSelect }: RowProps) {
  const remote = a.host !== 'this-mac'
  const reconnect = needsReconnect(a)
  // A live, attached session focuses; a detached / crashed one resumes.
  const actionLabel = reconnect || a.phase === 'done' ? 'Resume' : 'Focus'
  const title = (a.topic || a.prompt || a.name || '').split('\n')[0] || a.name
  return (
    <div
      className={`sx-row${selected ? ' sel' : ''}${active ? ' active' : ''}`}
      style={{ height: ROW_H }}
      onClick={() => onSelect(a)}
    >
      <button
        className={`sx-cb${selected ? ' on' : ''}`}
        title="Select"
        onClick={(e) => { e.stopPropagation(); onToggleSelect(a.id) }}
      />
      <button
        className={`sx-star${a.pinned ? ' on' : ''}`}
        title={a.pinned ? 'Unstar' : 'Star — pin to top'}
        onClick={(e) => { e.stopPropagation(); onToggleStar(a) }}
      >{a.pinned ? '★' : '☆'}</button>
      <span className={`sx-dot ${statusClass(a)}`} title={a.liveStatus || a.phase} />
      <AgentAvatar id={agentIdFromPrefix(a.abbr) ?? a.abbr.toLowerCase()} size={18} title={a.abbr} />
      <span className="sx-topic" title={title}>{title}</span>
      <span className="sx-meta">
        <span className="proj">{a.project}</span>
        <span className="sep"> · </span>
        {a.hostLabel ?? a.host}
        {remote && <span className="sx-badge rem">remote</span>}
      </span>
      <span className="sx-age">
        {a.tok > 0 && <span className="tps">{a.tok} t/s · </span>}
        {a.needs ? <span className="needs">needs you</span> : a.since}
      </span>
      <button
        className={`sx-resume${reconnect ? ' pri' : ''}`}
        onClick={(e) => { e.stopPropagation(); onResume(a) }}
      >{actionLabel}</button>
    </div>
  )
}
export const SessionRow = React.memo(SessionRowImpl)
