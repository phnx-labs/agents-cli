import React, { useMemo, useRef, useState, useCallback, useLayoutEffect } from 'react'
import { Icon } from './icons'
import {
  needsReconnect,
  type FloorAgent,
  type SessionFilter,
  type SessionGroup,
  type SessionSort,
} from './floorModel'
import {
  scopeSessions,
  groupSessions,
  sessionChipCounts,
  type SessionSection,
  type SessionScope,
} from './sessionsModel'
import { sessionRowView, type SessionRowView } from './recapModel'

// The Sessions surface: one place to see every session you own — local + remote,
// active + orphaned — and resume any of them, or a whole project's worth after a
// reboot. It reads the roster AGI EXT already polls (floorAgents); every filter /
// sort / group runs client-side, and the list is virtualized (fixed-offset
// windowing below), so hundreds of rows render like twenty.

const ROW_H = 140
const ROW_EXPANDED_EXTRA = 56
const HEADER_H = 36
const OVERSCAN = 4

export const SESSION_ROW_CSS = `
.sw-sessions .sx-band {
  display: flex; align-items: center; gap: 9px; padding: 9px 14px; height: auto;
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace;
  font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase;
  color: #8b94a6; background: #111828; border-bottom: 1px solid #1b2334; border-top: 0;
}
.sw-sessions .sx-band .g { width: 7px; height: 7px; border-radius: 50%; background: #a78bfa; font-size: 0; color: transparent; }
.sw-sessions .sx-band .lab { letter-spacing: 1.2px; color: #8b94a6; }
.sw-sessions .sx-band .cnt { color: #5c6675; font-size: 11px; letter-spacing: 0; text-transform: none; }
.sw-sessions .sx-band-act {
  margin-left: auto; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace;
  font-size: 11.5px; color: #a3e635; letter-spacing: 0; text-transform: none; font-weight: 400;
  border: 1px solid #34401a; background: #161e0b; border-radius: 6px; padding: 3px 10px;
}
.sw-sessions .sx-row {
  display: flex; align-items: flex-start; gap: 11px;
  padding: 12px 14px; cursor: default; overflow: hidden;
  border-top: 0; border-bottom: 1px solid #1b2334;
  grid-template-columns: none;
}
.sw-sessions .sx-row:last-child { border-bottom: none; }
.sw-sessions .sx-row:hover { background: #0f1625; }
.sw-sessions .sx-row.sel { background: rgba(163, 230, 53, 0.06); }
.sw-sessions .sx-row.active { background: #0f1625; }
.sw-sessions .sx-cb { flex: none; margin-top: 2px; width: 14px; height: 14px; border: 1.5px solid #5c6675; border-radius: 3px; background: transparent; }
.sw-sessions .sx-cb.on { background: #a3e635; border-color: #a3e635; }
.sw-sessions .sx-star { flex: none; margin-top: 1px; color: #5c6675; font-size: 13px; }
.sw-sessions .sx-star.on { color: #f5c518; }
.sw-sessions .sx-pdot { width: 8px; height: 8px; border-radius: 50%; background: #a78bfa; flex: none; margin-top: 5px; }
.sw-sessions .sx-pdot.off { background: #5c6675; }
.sw-sessions .sx-grow { min-width: 0; flex: 1; }
.sw-sessions .sx-titleline { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sw-sessions .sx-ttl { color: #e6e9ef; font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-sessions .sx-src { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 9.5px; letter-spacing: .3px; text-transform: uppercase; padding: 1px 5px; border-radius: 4px; flex: none; }
.sw-sessions .sx-src.agent { color: #4ade80; background: #0d2417; border: 1px solid #1c4a2f; }
.sw-sessions .sx-src.last { color: #6ea8fe; background: #0c1a2e; border: 1px solid #1c3a5a; }
.sw-sessions .sx-src.rename { color: #a78bfa; background: #1a1430; border: 1px solid #342a52; }
.sw-sessions .sx-roleline { display: flex; align-items: flex-start; gap: 9px; margin-top: 3px; font-size: 12.5px; }
.sw-sessions .sx-roletag { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 10.5px; font-weight: 700; flex: none; width: 62px; text-align: right; padding-top: 1px; letter-spacing: .2px; white-space: nowrap; }
.sw-sessions .sx-roletag.you { color: #6ea8fe; }
.sw-sessions .sx-roletag.agent { color: #d97757; }
.sw-sessions .sx-rolebody { min-width: 0; color: #8b94a6; }
.sw-sessions .sx-rolebody.clip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sw-sessions .sx-expand { font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: #5eead4; cursor: pointer; margin-left: 6px; background: none; border: 0; padding: 0; }
.sw-sessions .sx-expand:hover { color: #a3e635; }
.sw-sessions .sx-imgchip, .sw-sessions .sx-cmdchip, .sw-sessions .sx-slashchip {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px;
  border-radius: 5px; padding: 0 6px; margin-right: 5px;
}
.sw-sessions .sx-imgchip { color: #5eead4; background: #0c1a20; border: 1px solid #123; }
.sw-sessions .sx-cmdchip { color: #f5b544; background: #1c1608; border: 1px solid #3a2e12; }
.sw-sessions .sx-slashchip { color: #a78bfa; background: #160f28; border: 1px solid #2a2050; }
.sw-sessions .sx-full { margin: 6px 0 2px 71px; padding: 9px 11px; border-left: 2px solid #223; background: #0b101c; border-radius: 0 7px 7px 0; color: #8b94a6; font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
.sw-sessions .sx-metarow { display: flex; align-items: center; gap: 7px; margin-top: 8px; flex-wrap: wrap; padding-left: 71px; }
.sw-sessions .sx-metarow .sx-chip { display: inline-flex; align-items: center; gap: 5px; font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; padding: 1.5px 7px; border-radius: 5px; border: 1px solid #1b2334; color: #8b94a6; white-space: nowrap; background: #0c1220; }
.sw-sessions .sx-metarow .sx-chip.repo { color: #5eead4; border-color: #123; }
.sw-sessions .sx-metarow .sx-chip.pr { color: #a3e635; border-color: #2c3a16; background: #141c0a; }
.sw-sessions .sx-metarow .sx-chip.pr .ci { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; display: inline-block; }
.sw-sessions .sx-metarow .sx-chip.pr .ci.run { background: #f5b544; }
.sw-sessions .sx-metarow .sx-chip.pr .ci.fail { background: #f87171; }
.sw-sessions .sx-metarow .sx-chip.branch { color: #a78bfa; border-color: #241d3a; }
.sw-sessions .sx-metarow .sx-chip.host { color: #8b94a6; }
.sw-sessions .sx-metarow .sx-chip.nopr { color: #5c6675; }
.sw-sessions .sx-rowactions { display: flex; align-items: center; gap: 10px; flex: none; margin-top: 0; }
.sw-sessions button { appearance: none; font-family: inherit; }
.sw-sessions .sx-resumebtn {
  font-family: "JetBrains Mono","SF Mono",ui-monospace,monospace; font-size: 11px; color: #a3e635;
  border: 1px solid #34401a; background: #161e0b; border-radius: 6px; padding: 3px 10px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
}
.sw-sessions .sx-resumebtn:hover { background: #1e2a0d; border-color: #4a5a24; }
.sw-sessions .sx-age { color: #5c6675; font-size: 12px; flex: none; width: 34px; text-align: right; margin-top: 1px; }
.sw-sessions .sx-live { width: 10px; height: 10px; border-radius: 50%; background: #4ade80; flex: none; margin-top: 4px; box-shadow: 0 0 6px #4ade8066; }
.sw-sessions .sx-live.idle { background: #f5b544; box-shadow: 0 0 6px #f5b54455; }
.sw-sessions .sx-live.done { background: #5c6675; box-shadow: none; }
.sw-sessions .sx-live.orphan { background: #a78bfa; box-shadow: 0 0 6px #a78bfa66; }
`

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

function rowHeight(expanded: boolean, lastFull: string): number {
  if (!expanded) return ROW_H
  const lines = Math.max(2, lastFull.split(/\n/).length + Math.ceil(lastFull.length / 88))
  return ROW_H + ROW_EXPANDED_EXTRA + Math.min(lines, 10) * 16
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const counts = useMemo(() => sessionChipCounts(agents), [agents])

  // Distinct projects / hosts for the selectors — from the live roster, cheap.
  const projects = useMemo(() => [...new Set(agents.map((a) => a.project).filter(Boolean))].sort(), [agents])
  const hosts = useMemo(() => [...new Set(agents.map((a) => a.hostLabel ?? a.host).filter(Boolean))].sort(), [agents])

  const scope: SessionScope = useMemo(() => ({ filter, project, host, search }), [filter, project, host, search])
  const scoped = useMemo(() => scopeSessions(agents, scope), [agents, scope])
  const sections = useMemo(() => groupSessions(scoped, group, sort, desc, filter === 'starred'), [scoped, group, sort, desc, filter])

  // Flatten sections into a single windowable item list with per-item heights.
  const items: VItem[] = useMemo(() => {
    const out: VItem[] = []
    for (const s of sections) {
      out.push({ kind: 'header', section: s, height: HEADER_H })
      for (const a of s.agents) {
        const open = expanded.has(a.id)
        const lastFull = open ? sessionRowView(a).lastFull : ''
        out.push({ kind: 'row', agent: a, section: s, height: rowHeight(open, lastFull) })
      }
    }
    return out
  }, [sections, expanded])

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
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <div className="sw-sessions">
      <style>{SESSION_ROW_CSS}</style>
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
                    expanded={expanded.has(it.agent.id)}
                    height={it.height}
                    onToggleSelect={toggleSelect}
                    onToggleStar={onToggleStar}
                    onResume={onResume}
                    onSelect={onSelect}
                    onToggleExpand={toggleExpand}
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
  return (
    <div className={`sx-band${isReconnect ? ' recon' : ''}${section.kind === 'starred' ? ' star' : ''}`} style={{ height: HEADER_H }}>
      <span className="g" aria-hidden />
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
  expanded: boolean
  height: number
  onToggleSelect: (id: string) => void
  onToggleStar: (a: FloorAgent) => void
  onResume: (a: FloorAgent) => void
  onSelect: (a: FloorAgent) => void
  onToggleExpand: (id: string) => void
}

function PromptChips({ you }: { you: SessionRowView['you'] }) {
  if (you.kind === 'image') {
    return <><span className="sx-imgchip">{'\u{1F5BC}'} screenshot</span>{you.text}</>
  }
  if (you.kind === 'command') {
    return <><span className="sx-cmdchip">$ {you.chip}</span>{you.text}</>
  }
  if (you.kind === 'skill') {
    return <><span className="sx-slashchip">{you.chip}</span>{you.text}</>
  }
  return <>{you.text}</>
}

function SessionRowImpl({
  agent: a, selected, active, expanded, height,
  onToggleSelect, onToggleStar, onResume, onSelect, onToggleExpand,
}: RowProps) {
  const reconnect = needsReconnect(a)
  // pidAlive (from the CLI) tells the user WHAT resume will do: an orphaned session
  // whose process still runs is reattached; a crashed/dead one is relaunched from
  // its transcript. The CLI decides the mechanism — this is the honest tooltip.
  // Per-row Resume posts the SAME onResume the group "Resume all N" uses.
  const resumeTitle = reconnect
    ? (a.pidAlive === false ? 'Resume — relaunch from the transcript (process has exited)' : 'Reattach — the process is still running on its machine')
    : 'Resume this session'
  const row = sessionRowView(a)
  const liveClass = row.live === 'run' ? '' : row.live
  return (
    <div
      className={`sx-row${selected ? ' sel' : ''}${active ? ' active' : ''}`}
      style={{ height }}
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
      <span className={`sx-pdot${reconnect ? '' : ' off'}`} title={a.liveStatus || a.phase} />
      <span className="sx-grow">
        <div className="sx-titleline">
          <span className="sx-ttl" title={row.title}>{row.title}</span>
          <span className={`sx-src ${row.recapSourceClass}`}>{row.recapSource}</span>
        </div>
        <div className="sx-roleline">
          <span className="sx-roletag you">You ›</span>
          <span className="sx-rolebody clip"><PromptChips you={row.you} /></span>
        </div>
        {row.lastLine && (
          <div className="sx-roleline">
            <span className="sx-roletag agent">{row.harnessTag}</span>
            <span className={`sx-rolebody${expanded ? '' : ' clip'}`}>
              {row.lastLine}
              {row.lastFull && (
                <button
                  className="sx-expand"
                  aria-expanded={expanded}
                  onClick={(e) => { e.stopPropagation(); onToggleExpand(a.id) }}
                >{expanded ? '⌃ less' : '⌄ more'}</button>
              )}
            </span>
          </div>
        )}
        {expanded && row.lastFull && <div className="sx-full">{row.lastFull}</div>}
        <div className="sx-metarow">
          {row.repo && <span className="sx-chip repo">▪ {row.repo}</span>}
          {row.pr && (
            <span className="sx-chip pr">
              <span className={`ci${row.pr.ci === 'running' ? ' run' : row.pr.ci === 'failed' ? ' fail' : ''}`} />
              {' '}{row.pr.label}
            </span>
          )}
          {row.branch && <span className="sx-chip branch">⑂ {row.branch}</span>}
          {row.host && <span className="sx-chip host">{row.host}</span>}
          {!row.pr && <span className="sx-chip nopr">no PR</span>}
        </div>
      </span>
      <span className="sx-rowactions">
        <button
          className="sx-resumebtn"
          title={resumeTitle}
          onClick={(e) => { e.stopPropagation(); onResume(a) }}
        >↻ Resume</button>
        <span className="sx-age">{row.age}</span>
        <span className={`sx-live${liveClass ? ` ${liveClass}` : ''}`} title={a.liveStatus || a.phase} />
      </span>
    </div>
  )
}
export const SessionRow = React.memo(SessionRowImpl)
