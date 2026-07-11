import React from 'react'
import { Icon } from './icons'
import { recapCost, type RecapDay, type RecapEntry } from './recapModel'

// Recap ledger — "what happened while I was away". Day-grouped ended sessions
// across the whole fleet, each with duration/cost from the CLI's session metrics
// and PR/ticket artifacts. Data comes pre-shaped from buildRecap (recapModel.ts);
// this component only renders.

interface RecapPaneProps {
  days: RecapDay[]
  loading: boolean
  /** Open a session's PR in the browser (ExtLink-style, raised to the host). */
  onOpenUrl?: (url: string) => void
}

function RecapRow({ e, onOpenUrl }: { e: RecapEntry; onOpenUrl?: (url: string) => void }) {
  const ago = agoLabel(e.lastActivityMs)
  return (
    <div className="recap-row">
      <span className={`av ${e.abbr}`}>{e.abbr}</span>
      <span className="rc-title" title={e.title}>{e.title}</span>
      <span className="rc-meta">{e.project} · {e.host}{e.branch ? ` · ${e.branch}` : ''}</span>
      {e.ticket && <span className="rc-ticket">{e.ticket}</span>}
      {e.prUrl && (
        <button type="button" className="rc-pr" title={e.prUrl} onClick={() => onOpenUrl?.(e.prUrl!)}>
          <Icon name="gitBranch" size={11} /> PR
        </button>
      )}
      {e.durationMs > 0 && <span className="rc-dur">{recapDuration(e.durationMs)}</span>}
      {recapCost(e.costUsd) && <span className="rc-cost">{recapCost(e.costUsd)}</span>}
      <span className="rc-ago">{ago}</span>
    </div>
  )
}

/** Minute-granular duration for a ledger row — "43m", "1h 12m". Seconds are noise here. */
function recapDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000))
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

/** Compact "…ago" stamp for a ledger row (minute floor — seconds churn is noise here). */
function agoLabel(ms: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ms) / 60_000))
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export function RecapPane({ days, loading, onOpenUrl }: RecapPaneProps) {
  if (loading && days.length === 0) {
    return <div className="feed recap-empty">Sweeping the fleet for recent sessions…</div>
  }
  if (days.length === 0) {
    return <div className="feed recap-empty">No finished sessions yet — dispatch something and it lands here when it's done.</div>
  }
  return (
    <div className="feed">
      {days.map((d) => (
        <React.Fragment key={d.label}>
          <div className="feed-sec">
            {d.label}
            <span className="rc-rollup">
              {d.sessions} session{d.sessions === 1 ? '' : 's'}
              {d.costUsd > 0 ? ` · ${recapCost(d.costUsd)}` : ''}
              {d.prs > 0 ? ` · ${d.prs} PR${d.prs === 1 ? '' : 's'}` : ''}
            </span>
            <span className="ln" />
          </div>
          {d.entries.map((e) => (
            <RecapRow key={e.id} e={e} onOpenUrl={onOpenUrl} />
          ))}
        </React.Fragment>
      ))}
    </div>
  )
}
