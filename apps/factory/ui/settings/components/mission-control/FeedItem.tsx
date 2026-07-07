import React, { useState } from 'react'
import { Icon } from './icons'
import { AgentAvatar, agentIdFromPrefix } from './AgentAvatar'
import { StructuredReply, type ReplyCallbacks } from './StructuredReply'
import { heartbeatLevel, sessionTaskLine, type FloorAgent, type FloorTicket } from './floorModel'
import { sinceFromMs } from './floorAdapter'
import { useNow } from './useNow'
import { TodoProgressBar } from './TodoChecklist'

// One agent row in the feed (feedItem: factory-floor.html:608-620) + the Next-Up
// ticketStrip teaser row (:621-623). Pure presentation; selection + replies raised
// via callbacks.

/** Qualitative throughput when plain, raw tok/s otherwise. Prototype plainTok():400. */
function plainTok(tok: number, plain: boolean): string {
  if (plain) return tok > 120 ? 'fast' : tok > 0 ? 'working' : ''
  return tok ? `${tok} tok/s` : ''
}

// Reply callbacks are agent-scoped (they take the FloorAgent, not a pre-bound closure)
// so the caller can pass the SAME stable function reference to every row. That is what
// lets React.memo(FeedItem) skip re-rendering unchanged rows — an inline `(o) => f(a, o)`
// per row would allocate a fresh prop each render and defeat the memo. The leaf binds
// them to its own agent below for StructuredReply (only rendered when a.needs).
interface FeedItemProps {
  agent: FloorAgent
  selected: boolean
  plain: boolean
  /** The row (not the reply controls) was clicked. */
  onSelect: (id: string) => void
  onOption: (agent: FloorAgent, option: string) => void
  onFreeText: (agent: FloorAgent, text: string) => void
  onAttach: (agent: FloorAgent) => void
}

function FeedItemImpl({ agent: a, selected, plain, onSelect, onOption, onFreeText, onAttach }: FeedItemProps) {
  // Live heartbeat: only a running / stalled agent with a known last-activity stamp ticks.
  // The shared 1s ticker re-renders just this leaf, never the parent list.
  const now = useNow(1000)
  const beats = a.lastActivityMs > 0 && (a.phase === 'running' || a.phase === 'stalled')
  const ageMs = beats ? Math.max(0, now - a.lastActivityMs) : NaN
  const level = beats ? heartbeatLevel(ageMs) : 'live'
  const stalled = a.phase === 'stalled' || level !== 'live'
  const liveSince = beats ? sinceFromMs(ageMs) : a.since

  const tok = plainTok(a.tok, plain)
  const filesLabel = !plain && a.files > 0 ? ` · ${a.files} ${a.files === 1 ? 'file' : 'files'}` : ''
  // tmux pane handle (unique addressing) + where the session is being viewed, appended
  // to the meta line. Both only show in full (non-plain) mode when the CLI supplies them.
  const paneLabel = !plain && a.pane ? ` · ${a.pane}` : ''
  const viewingLabel = !plain && a.viewingIn ? ` · viewing in ${a.viewingIn}` : ''
  // The worktree slug (or branch) sits between project and ticket so two sessions in
  // the same repo are distinguishable at a glance (the identical-cards bug).
  const wt = a.worktreeSlug || a.branch
  const meta = plain
    ? a.project
    : `${a.project} · ${a.hostLabel ?? a.host}${wt ? ` · ${wt}` : ''}${a.ticket ? ` · ${a.ticket}` : ''}${filesLabel}${paneLabel}${viewingLabel}`
  const destructive = a.question?.kind === 'destructive'
  const attn = a.phase === 'failed' ? 'fail' : stalled ? 'stall' : a.needs ? 'attn' : ''

  // Rolling summary line: the agent's own words for a running/stalled agent. Skip it
  // when it just echoes the response block. Suppress the now-line when the summary
  // already says the same thing (summary fell back to the now-line's activity string).
  const nowlineText = `${a.verb} ${a.target}`.trim()
  // One canonical task line (summary/preview -> response -> worktree/branch). This is
  // what fixes the identical, contextless "needs you" cards: a waiting session with no
  // narrative still shows its worktree slug instead of just "Edit <file>". Shown unless
  // it merely echoes the response block or the now-line.
  const taskLine = sessionTaskLine(a)
  const showSummary = !plain && !!taskLine && taskLine !== a.resp.trim() && taskLine !== nowlineText
  const showNowline = !plain && !!a.verb && !(showSummary && taskLine === nowlineText)

  const marker =
    a.pr ? <span className="pill pr">PR {a.pr}</span> :
    stalled ? <span className="pill stall">stalled</span> :
    a.phase === 'running' ? <span className="pill run">running</span> :
    a.phase === 'done' ? <span className="pill done">done</span> : null

  // CI badge for an open PR, beside the PR pill: green when checks pass (ready to
  // review/merge), red on failure, amber while they run.
  const ciBadge =
    a.pr && a.ci === 'passed' ? <span className="pill cipass">CI passed</span> :
    a.pr && a.ci === 'failed' ? <span className="pill cifail">CI failed</span> :
    a.pr && a.ci === 'running' ? <span className="pill cirun">CI running</span> : null

  return (
    <div
      className={`fitem ${attn}${selected ? ' selsel' : ''}`}
      data-id={a.id}
      onClick={() => onSelect(a.id)}
    >
      <div className="head">
        <span className={`dot ${a.phase}`} />
        <AgentAvatar id={agentIdFromPrefix(a.abbr) ?? a.abbr.toLowerCase()} size={20} title={a.abbr} />
        <span className="who">{a.name}</span>
        <span className="path">{meta}</span>
        <span className="when">
          {marker}
          {ciBadge}
          {tok && (
            <span className="tps">{!plain && <Icon name="zap" size={11} />}{tok}</span>
          )}
          <span className={`hb ${level}`}>
            {beats && <Icon name="clock" size={10} />}{liveSince} ago
          </span>
        </span>
      </div>
      <div className="resp">{destructive ? <span className="q">{a.resp}</span> : a.resp}</div>
      {!plain && a.todos.length > 0 && <TodoProgressBar todos={a.todos} />}
      {showSummary && <div className="summary">{taskLine}</div>}
      {showNowline && (
        <div className={`nowline ${stalled ? 'stall' : ''}`}>
          <Icon name="chevR" size={11} /> <span className="v">{a.verb}</span> {a.target}
        </div>
      )}
      {a.needs && (
        <div onClick={(e) => e.stopPropagation()}>
          <StructuredReply
            question={a.question}
            phase={a.phase}
            onOption={(o) => onOption(a, o)}
            onFreeText={(t) => onFreeText(a, t)}
            onAttach={() => onAttach(a)}
          />
        </div>
      )}
      {/* Contextual follow-up: an agent that isn't working (idle or done) and isn't
          already asking for you is ready for the next task. Queue one right on its row,
          delivered over the same reply channel (cloud -> `agents cloud message`, a live
          tmux/terminal -> sendText). Suppressed when there's no reachable channel. */}
      {!a.needs && (a.phase === 'idle' || a.phase === 'done') && a.reply.kind !== 'none' && (
        <FollowUpBox onSend={(t) => onFreeText(a, t)} />
      )}
    </div>
  )
}

// Slim per-agent "queue a follow-up task" input, shown on idle/done rows in place of the
// old standalone NEXT-UP dispatch list. Local state so a keystroke never re-renders the feed.
export function FollowUpBox({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const send = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }
  return (
    <div className="followup" onClick={(e) => e.stopPropagation()}>
      <Icon name="chevR" size={11} />
      <input
        aria-label="Queue a follow-up task"
        placeholder="Queue a follow-up task…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') send() }}
      />
      <button className="opt ghost" onClick={send}>Queue</button>
    </div>
  )
}

// Memoized: with stable, agent-scoped callback props (see FeedItemProps), a row only
// re-renders when its own agent object, selection, or `plain` actually changes — so a
// selection change or search keystroke re-renders 1-2 rows, not all 100+. The 1s "since"
// tick stays local to each row's useNow leaf and never touches this boundary.
export const FeedItem = React.memo(FeedItemImpl)

interface TicketStripProps {
  ticket: FloorTicket
  /** The Dispatch button was clicked. */
  onDispatch: (id: string) => void
  /** The row (not the Dispatch button) was clicked — open the ticket. */
  onSelect: (id: string) => void
}

// Next-Up backlog teaser row. Prototype ticketStrip(): factory-floor.html:621-623.
export function TicketStrip({ ticket: t, onDispatch, onSelect }: TicketStripProps) {
  return (
    <div className="trow" data-tid={t.id} onClick={() => onSelect(t.id)}>
      <span className={`pri ${t.pri}`} />
      <span className={`src ${t.source}`}>{t.source}</span>
      <span className="tid">{t.id}</span>
      <span className="tt">{t.title}</span>
      <button
        className="dispatch-sm"
        onClick={(e) => { e.stopPropagation(); onDispatch(t.id) }}
      >
        Dispatch <Icon name="chevR" size={10} />
      </button>
    </div>
  )
}
