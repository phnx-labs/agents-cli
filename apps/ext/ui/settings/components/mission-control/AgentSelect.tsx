// Agent picker — installed agents as pills, sign-in state below. Ports the
// prototype's renderAgent(): .agents/.apill + .agsub (dispatch.html).
import React from 'react'
import type { InstalledAgent } from './dispatch.types'

export interface AgentSelectProps {
  agents: InstalledAgent[]
  value: string
  onChange: (agentId: string) => void
}

export function AgentSelect({ agents, value, onChange }: AgentSelectProps) {
  const sel = agents.find(a => a.id === value)
  return (
    <>
      <div className="agents">
        {agents.map(g => (
          <span
            key={g.id}
            className={`apill ${g.id === value ? 'on' : ''} ${g.signedIn ? '' : 'out'}`}
            onClick={() => onChange(g.id)}
          >
            <span className="d" style={{ background: g.color }} />
            {g.name}
            {g.signedIn ? null : <span className="lk">·sign in</span>}
          </span>
        ))}
      </div>
      {sel && (
        <div className="agsub">
          <b>{sel.name}</b> · {sel.version}{sel.isDefault ? ' · default' : ''} ·{' '}
          {sel.signedIn
            ? <span className="si">signed in</span>
            : <span className="no">not signed in — agents add {sel.id}</span>}
        </div>
      )}
    </>
  )
}
