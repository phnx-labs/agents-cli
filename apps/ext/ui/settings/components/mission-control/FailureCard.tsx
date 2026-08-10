// Failure card — a failed agent with its reason, plus Retry or Reassign to a different
// installed agent. Distinct from a stall (which is a running agent gone quiet). Rendered
// in the Floor needs-you / feed, styled as a failed decision block (.decide.fail).
import React, { useState } from 'react'
import { Icon } from './icons'
import type { FloorAgent } from './floorModel'
import type { InstalledAgent } from './dispatch.types'

export interface FailureCardProps {
  agent: FloorAgent
  agents: InstalledAgent[]     // for reassign
  onRetry: () => void
  onReassign: (toAgent: string) => void
}

export function FailureCard({ agent, agents, onRetry, onReassign }: FailureCardProps) {
  const [toAgent, setToAgent] = useState('')

  const reassign = () => {
    if (toAgent) onReassign(toAgent)
  }

  const reason = agent.resp.trim() || 'The agent stopped with an error.'

  return (
    <div className="decide fail">
      <div className="ql fail">FAILED — NEEDS YOU</div>
      <div className="qt">
        {agent.name}
        {agent.target ? ` — ${agent.target}` : ''}
      </div>
      <div className="resp">
        <span className="q">{reason}</span>
      </div>
      <div className="opts">
        <button className="opt danger" onClick={onRetry}>
          <Icon name="refresh" size={12} /> Retry
        </button>
        <span className="reassign">
          <select
            className="sel"
            value={toAgent}
            onChange={(e) => setToAgent(e.target.value)}
          >
            <option value="">Reassign to…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id} disabled={!a.signedIn}>
                {a.name}
                {a.signedIn ? '' : ' (signed out)'}
              </option>
            ))}
          </select>
          <button className="opt ghost" onClick={reassign} disabled={!toAgent}>
            Go
          </button>
        </span>
      </div>
    </div>
  )
}
