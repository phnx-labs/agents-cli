// Watchdog segmented control — Off · Keep moving (default) · Hands-off. Ports the
// prototype's #wdSeg + #wdhint + the WD hint map (dispatch.html).
import React from 'react'
import type { WatchdogPolicy } from './dispatch.types'

export interface WatchdogSegProps {
  value: WatchdogPolicy
  onChange: (policy: WatchdogPolicy) => void
}

const POLICIES: { w: WatchdogPolicy; label: string }[] = [
  { w: 'off', label: 'Off' },
  { w: 'keep', label: 'Keep moving' },
  { w: 'handsoff', label: 'Hands-off' },
]

function hint(policy: WatchdogPolicy): React.ReactNode {
  if (policy === 'keep') return <>If it stalls, auto-nudge it. If it&apos;s stuck after 2 tries, <b>ping you</b>.</>
  if (policy === 'off') return 'No auto-nudge'
  return 'Nudges to keep going, only pings on finish/fail'
}

export function WatchdogSeg({ value, onChange }: WatchdogSegProps) {
  return (
    <>
      <span className="seg">
        {POLICIES.map(({ w, label }) => (
          <button key={w} className={w === value ? 'on' : ''} onClick={() => onChange(w)}>{label}</button>
        ))}
      </span>
      <div className="modehint">{hint(value)}</div>
    </>
  )
}
