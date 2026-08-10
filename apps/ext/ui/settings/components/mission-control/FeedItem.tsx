import React, { useState } from 'react'
import { Icon } from './icons'
import { FileIcon, ImageIcon } from './dispatchIcons'
import { AgentAvatar, agentIdFromPrefix } from './AgentAvatar'
import { StructuredReply, type ReplyCallbacks } from './StructuredReply'
import { heartbeatLevel, linearIssueLabel, linearIssueUrl, sessionTaskLine, todoProgress, type FloorAgent, type FloorAttachment, type FloorTicket } from './floorModel'
import { sinceFromMs } from './floorAdapter'
import { useNow } from './useNow'
import { CardChecklist } from './TodoChecklist'
import { MiniTimeline } from './Timeline'
import { renderMarkdown } from '../../utils/markdown'
import { ExtLink } from '../common/ExtLink'
import type { PlanFile } from '../../utils/planDetector'

/** First line of a block of text as a plain-text title — strips leading markdown
 *  (ATX headings, list bullets) and inline markers so a prompt like "## Problem"
 *  or "**Fix** the bug" reads cleanly in the title chip. */
function firstLine(text: string): string {
  const raw = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  const line = raw
    .replace(/^#+\s+/, '') // ATX heading
    .replace(/^[-*+]\s+/, '') // list bullet
    .replace(/[*_`]/g, '') // inline emphasis / code
    .trim()
  return line.length > 72 ? line.slice(0, 72) + '…' : line
}

// One agent row in the feed (feedItem: factory-floor.html:608-620) + the Next-Up
// ticketStrip teaser row (:621-623). Pure presentation; selection + replies raised
// via callbacks.

/** Qualitative throughput when plain, raw tok/s otherwise. Prototype plainTok():400. */
function plainTok(tok: number, plain: boolean): string {
  if (plain) return tok > 120 ? 'fast' : tok > 0 ? 'working' : ''
  return tok ? `${tok} tok/s` : ''
}

function TicketArtifact({ ticket, className }: { ticket: string; className: string }) {
  const href = linearIssueUrl(ticket)
  const label = linearIssueLabel(ticket)
  return href
    ? <ExtLink href={href} className={className} title={`Open ${label}`} style={{ textDecoration: 'none' }}><Icon name="plus" size={10} /> {label}</ExtLink>
    : <span className={className} title={`Created ticket ${label}`}><Icon name="plus" size={10} /> {label}</span>
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
  onOpenPlan: (agent: FloorAgent, plan: PlanFile) => void
  onOpenAttachment: (agent: FloorAgent, attachment: FloorAttachment) => void
  /**
   * Open/resume this session in a live terminal (RUSH-1520). Present when the
   * agent carries a sessionId (or a local terminal id) the host can focus.
   */
  onOpenTerminal?: (agent: FloorAgent) => void
}

function FeedItemImpl({ agent: a, selected, plain, onSelect, onOption, onFreeText, onAttach, onOpenPlan, onOpenAttachment, onOpenTerminal }: FeedItemProps) {
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
  // The worktree slug (or branch) disambiguates two sessions in the same repo (the
  // identical-cards bug). It now renders as its own clean chip (below) rather than being
  // concatenated into the meta string — so a stray `WT=<path>` can never leak into the
  // meta line. The meta line keeps project · host · ticket · files.
  const wt = a.worktreeSlug || a.branch
  const meta = plain
    ? a.project
    : `${a.project} · ${a.hostLabel ?? a.host}${filesLabel}${paneLabel}${viewingLabel}`
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
  // The ORIGINAL task anchors the card. When the session carries a prompt, the title
  // reads the task (its first line) and the prompt gets its own TASK block below; the
  // agent name stays as context in the title tooltip. Without a
  // prompt, the title stays the agent's own display name (prior behavior).
  const prompt = (a.prompt ?? '').trim()
  const title = !plain && prompt ? firstLine(prompt) : a.name
  const nameTitle = [prompt ? `${a.name} — ${prompt}` : a.name, a.sessionId ? `Session ${a.sessionId}` : ''].filter(Boolean).join('\n')
  const showTask = !plain && !!prompt
  // Only show the rolling summary line when it adds signal beyond the task block, the
  // response body, and the now-line (it merely echoes the prompt when they match).
  const showSummary =
    !plain && !!taskLine && taskLine !== a.resp.trim() && taskLine !== nowlineText &&
    !(showTask && taskLine === prompt)
  // The now-line is a LIVE-activity indicator — only meaningful while the agent is
  // actively working (running) or stuck mid-action (stalled). For an idle / needs-you /
  // done agent there's no live activity, and the verb is just the "Thinking..." fallback,
  // so showing it reads as a contextless "Thinking..." on a paused card.
  const isActive = a.phase === 'running' || a.phase === 'stalled'
  const showNowline = !plain && isActive && !!a.verb && !(showSummary && taskLine === nowlineText)

  const marker =
    a.pr ? (
      a.prUrl
        ? <ExtLink href={a.prUrl} className="pill pr" title="Open pull request" style={{ textDecoration: 'none' }}>PR {a.pr}</ExtLink>
        : <span className="pill pr">PR {a.pr}</span>
    ) :
    stalled ? <span className="pill stall">stalled</span> :
    a.phase === 'running' ? <span className="pill run">running</span> :
    a.phase === 'done' ? <span className="pill done">done</span> : null

  // CI badge for an open PR, beside the PR pill: green when checks pass (ready to
  // review/merge), red on failure, amber while they run.
  const ciBadge =
    a.pr && a.ci === 'passed' ? <span className="pill cipass">CI passed</span> :
    a.pr && a.ci === 'failed' ? <span className="pill cifail">CI failed</span> :
    a.pr && a.ci === 'running' ? <span className="pill cirun">CI running</span> : null

  // Background (headless) run: no terminal tab. Reads alongside the status pill so
  // a background agent is distinct from a terminal one within its device group.
  const bgBadge = a.context === 'headless'
    ? <span className="pill bg" title="Background (headless) — no terminal; open with Focus">bg</span>
    : null
  // Per-session rate/usage limit (RUSH-1523) — distinct from a healthy running card.
  const rateBadge = a.rateLimited
    ? <span className="pill rate" title="This session hit a rate or usage limit">rate limited</span>
    : null
  // Plan progress pill (RUSH-1380): a glanceable N/M in the header — the one at-a-glance
  // "how far along" signal that also survives compact (plain) rows, where the fuller
  // CardChecklist below is suppressed. Sourced from the same TodoWrite the checklist uses.
  const todoTally = a.todos.length ? todoProgress(a.todos) : null
  const todoBadge = todoTally && todoTally.total > 0
    ? <span className="pill todo" title={`Plan: ${todoTally.done} of ${todoTally.total} tasks done`}>{todoTally.done}/{todoTally.total}</span>
    : null
  const ticketHref = linearIssueUrl(a.ticket)
  const ticketBadge = a.ticket
    ? ticketHref
      ? <ExtLink href={ticketHref} className="pill ticket" title={`Open ${linearIssueLabel(a.ticket)}`} style={{ textDecoration: 'none' }}>{linearIssueLabel(a.ticket)}</ExtLink>
      : <span className="pill ticket">{linearIssueLabel(a.ticket)}</span>
    : null

  return (
    <div
      className={`fitem ${attn}${selected ? ' selsel' : ''}${a.rateLimited ? ' rate-limited' : ''}`}
      data-id={a.id}
      onClick={() => onSelect(a.id)}
    >
      <div className="head">
        <span className={`dot ${a.phase}`} />
        <AgentAvatar id={agentIdFromPrefix(a.abbr) ?? a.abbr.toLowerCase()} size={20} title={a.abbr} />
        <span className="who" title={nameTitle}>{title}</span>
        <span className="path">{meta}</span>
        {!plain && wt && <span className="wtchip mono" title={a.worktreePath || wt}>{wt}</span>}
        <span className="when">
          {marker}
          {todoBadge}
          {ticketBadge}
          {bgBadge}
          {rateBadge}
          {ciBadge}
          {onOpenTerminal && (a.sessionId || a.reply.kind === 'terminal' || a.reply.kind === 'tmux') && (
            <button
              type="button"
              className="open-term"
              title="Open / resume session in a terminal"
              onClick={(e) => { e.stopPropagation(); onOpenTerminal(a) }}
            >
              <Icon name="external" size={11} /> Terminal
            </button>
          )}
          {tok && (
            <span className="tps">{!plain && <Icon name="zap" size={11} />}{tok}</span>
          )}
          <span className={`hb ${level}`}>
            {beats && <Icon name="clock" size={10} />}{liveSince} ago
          </span>
        </span>
      </div>
      {showTask && (
        <div className="task">
          <span className="lab">Task</span>
          {renderMarkdown(prompt, { clamp: true })}
        </div>
      )}
      {/* Suppress the body when it just repeats the question the reply block already
          shows (the text-parse path sets question.text = resp), so it isn't printed twice. */}
      {a.resp && !(a.needs && a.question && a.question.kind !== 'retry' && a.question.text.trim() === a.resp.trim()) && (
        <div className={`resp${destructive ? ' q' : ''}`}>{renderMarkdown(a.resp, { clamp: true })}</div>
      )}
      {!plain && (a.spawnedTeam || (a.createdTickets?.length ?? 0) > 0 || (a.createdCommits?.length ?? 0) > 0 || (a.plans?.length ?? 0) > 0 || (a.attachments?.length ?? 0) > 0) && (
        <div className="artifacts" onClick={(e) => e.stopPropagation()}>
          {(a.attachments ?? []).map((attachment) => {
            const isImage = attachment.mediaType.startsWith('image/')
            return (
              <button
                key={attachment.path}
                type="button"
                className={`artifact attachment${isImage ? ' image' : ''}`}
                title={`Preview ${attachment.path}`}
                onClick={() => onOpenAttachment(a, attachment)}
              >
                <span className="artifact-thumb">
                  {isImage && attachment.thumbnailUri
                    ? <img src={attachment.thumbnailUri} alt="" />
                    : isImage ? <ImageIcon size={12} /> : <FileIcon size={12} />}
                </span>
                <span className="artifact-label">{attachment.label}</span>
              </button>
            )
          })}
          {(a.plans ?? []).map((plan) => (
            <button
              key={plan.path}
              type="button"
              className="artifact plan"
              title={`Preview ${plan.path}`}
              onClick={() => onOpenPlan(a, plan)}
            >
              <Icon name="external" size={10} /> {plan.label}
            </button>
          ))}
          {a.spawnedTeam && (
            <span className="artifact team" title={`Spawned a team: ${a.spawnedTeam}`}>
              <Icon name="grip" size={10} /> team · {a.spawnedTeam}
            </span>
          )}
          {(a.createdTickets ?? []).map((t) => (
            <TicketArtifact key={t} ticket={t} className="artifact ticket" />
          ))}
          {(a.createdCommits ?? []).map((sha) => (
            <span key={sha} className="artifact commit" title={`Created commit ${sha}`}>
              <Icon name="gitBranch" size={10} /> {sha}
            </span>
          ))}
        </div>
      )}
      {!plain && a.todos.length > 0 && <CardChecklist todos={a.todos} />}
      {showSummary && <div className="summary">{taskLine}</div>}
      {showNowline && (
        <div className={`nowline ${stalled ? 'stall' : ''}`}>
          <Icon name="chevR" size={11} /> <span className="v">{a.verb}</span> {a.target}
        </div>
      )}
      {!plain && a.recent.length > 0 && <MiniTimeline recent={a.recent} nowMs={now} />}
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
