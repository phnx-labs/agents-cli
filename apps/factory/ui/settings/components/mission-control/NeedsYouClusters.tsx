import React from 'react'
import type { FloorAgent } from './floorModel'

// Batch-triage cluster cards. Prototype clusterCard(): factory-floor.html:598-607.
// N agents asking the SAME question (same StructuredQuestion.clusterKey) collapse into
// one card so a class of decision is answered once ("… · Apply to all N").
// SHELL passes the multi-agent clusters here and renders singletons as <FeedItem>
// (mirrors agentsCenter():629-630, where arr.length>1 ? clusterCard : feedItem).

interface NeedsYouClustersProps {
  /** Each entry is a group of agents sharing one question. Expected length >= 2. */
  clusters: FloorAgent[][]
  /** A batch answer was chosen for the whole cluster; carries the button label. */
  onBatchReply: (cluster: FloorAgent[], option: string) => void
  /** The card (not an option button) was clicked — drill into arr[0] to reply to one. */
  onReplyOne: (id: string) => void
}

export function NeedsYouClusters({ clusters, onBatchReply, onReplyOne }: NeedsYouClustersProps) {
  return (
    <>
      {clusters.map((arr) => {
        const c = arr[0]
        if (!c) return null
        const danger = c.question?.kind === 'destructive'
        const options = c.question?.options ?? []
        const who =
          arr.slice(0, 3).map((a) => `${a.name} · ${a.hostLabel ?? a.host}`).join('   ·   ') +
          (arr.length > 3 ? `   +${arr.length - 3} more` : '')

        return (
          <div key={c.id} className="cluster" data-id={c.id} onClick={() => onReplyOne(c.id)}>
            <div className="ch">
              <span className="n">{arr.length}</span>
              <span className="qq">{c.question?.text ?? c.resp}</span>
              <span className="avs">
                {arr.slice(0, 5).map((a) => (
                  <span key={a.id} className={`av ${a.abbr}`}>{a.abbr}</span>
                ))}
              </span>
            </div>
            <div className="batchline">{who}</div>
            <div className="opts" onClick={(e) => e.stopPropagation()}>
              {options.map((o, i) => (
                <button key={o} className={`opt ${i === 0 && danger ? 'danger' : ''}`} onClick={() => onBatchReply(arr, o)}>
                  {o}
                </button>
              ))}
              <button className="opt ghost" onClick={() => onBatchReply(arr, 'Something else…')}>Something else…</button>
              <button className="opt batch" onClick={() => onBatchReply(arr, 'Apply to all')}>Apply to all {arr.length}</button>
            </div>
          </div>
        )
      })}
    </>
  )
}
