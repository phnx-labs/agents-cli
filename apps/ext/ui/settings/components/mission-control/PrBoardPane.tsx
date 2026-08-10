import React from 'react'
import { Icon } from './icons'
import type { PrBoardRow } from './prBoardModel'

// PR board — every open PR the floor's agents have produced, with CI + review +
// mergeable state and a Merge button that appears only on readyToMerge rows
// (approved + green + no conflict). Merging goes through the host's plain
// `gh pr merge --rebase`; refusals come back as an inline row error.

interface PrBoardPaneProps {
  rows: PrBoardRow[]
  loading: boolean
  /** URLs with a merge in flight (button shows a busy state). */
  merging: Set<string>
  /** Per-URL inline merge errors (gh refusals). */
  errors: Record<string, string>
  onMerge: (url: string) => void
  onOpenUrl: (url: string) => void
  onRefresh: () => void
  /** Jump to the owning agent's card. */
  onSelectAgent?: (id: string) => void
}

function ciBadge(ci: PrBoardRow['ci']) {
  if (!ci) return null
  const label = ci === 'passed' ? 'CI passed' : ci === 'failed' ? 'CI failed' : 'CI running'
  return <span className={`prb-ci ${ci}`}>{label}</span>
}

function reviewBadge(review: PrBoardRow['review']) {
  if (!review) return null
  const label = review === 'approved' ? 'Approved' : review === 'changes_requested' ? 'Changes requested' : 'Review required'
  return <span className={`prb-rev ${review}`}>{label}</span>
}

export function PrBoardPane({ rows, loading, merging, errors, onMerge, onOpenUrl, onRefresh, onSelectAgent }: PrBoardPaneProps) {
  if (loading && rows.length === 0) {
    return <div className="feed prb-empty">Checking open pull requests…</div>
  }
  return (
    <div className="feed">
      <div className="feed-sec">
        Pull requests
        <span className="prb-count">{rows.filter((r) => r.state === 'open').length} open</span>
        <span className="ln" />
        <button type="button" className="prb-refresh" title="Refresh" onClick={onRefresh}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {rows.length === 0 && (
        <div className="prb-empty">No open PRs from the floor's agents — dispatch something that ships.</div>
      )}
      {rows.map((r) => (
        <React.Fragment key={r.url}>
          <div className={`prb-row${r.state !== 'open' ? ' settled' : ''}`}>
            <button type="button" className="prb-num" title={r.url} onClick={() => onOpenUrl(r.url)}>
              #{r.number}
            </button>
            <span className="prb-title" title={r.title}>{r.title}</span>
            {r.owner && (
              <button type="button" className="prb-owner" title={`${r.owner.name} · ${r.owner.hostLabel ?? r.owner.host}`} onClick={() => onSelectAgent?.(r.owner!.id)}>
                {r.owner.abbr}
              </button>
            )}
            {r.isDraft && <span className="prb-draft">draft</span>}
            {r.state !== 'open' && <span className="prb-state">{r.state}</span>}
            {ciBadge(r.ci)}
            {reviewBadge(r.review)}
            {r.mergeable === 'conflicting' && <span className="prb-conflict">conflicts</span>}
            {r.readyToMerge && (
              <button
                type="button"
                className="prb-merge"
                disabled={merging.has(r.url)}
                onClick={() => onMerge(r.url)}
              >
                {merging.has(r.url) ? 'Merging…' : 'Merge'}
              </button>
            )}
          </div>
          {errors[r.url] && <div className="prb-err" role="alert">{errors[r.url]}</div>}
        </React.Fragment>
      ))}
    </div>
  )
}
