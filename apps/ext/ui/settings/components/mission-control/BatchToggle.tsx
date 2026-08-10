// Batch fan-out toggle — shown only when 2+ tickets are attached. Ports the
// prototype's batchHtml + #batchSeg (dispatch.html render()).
import React from 'react'

export interface BatchToggleProps {
  count: number               // number of attached tickets (caller gates >= 2)
  value: 'all' | 'per'
  onChange: (value: 'all' | 'per') => void
}

export function BatchToggle({ count, value, onChange }: BatchToggleProps) {
  return (
    <div className="batch">
      Dispatch
      <span className="seg" style={{ marginLeft: 2 }}>
        <button className={value === 'all' ? 'on' : ''} onClick={() => onChange('all')}>1 agent, all {count}</button>
        <button className={value === 'per' ? 'on' : ''} onClick={() => onChange('per')}>1 agent per ticket</button>
      </span>
    </div>
  )
}
