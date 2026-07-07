// Mode segmented control — Plan · Auto · Edit (default Auto). Ports the prototype's
// #modeSeg + #modehint (dispatch.html renderExpanded / wireExpanded).
import React from 'react'
import type { DispatchMode } from './dispatch.types'

export interface ModeSegProps {
  value: DispatchMode
  onChange: (mode: DispatchMode) => void
}

const MODES: { m: DispatchMode; label: string }[] = [
  { m: 'plan', label: 'Plan' },
  { m: 'auto', label: 'Auto' },
  { m: 'edit', label: 'Edit' },
]

function hint(mode: DispatchMode): React.ReactNode {
  if (mode === 'plan') return 'Read-only. Cannot edit files or run commands until you approve.'
  if (mode === 'auto') return <>Runs safe steps itself, <b>asks before anything risky</b> — deletes, pushes, installs.</>
  return 'Full access — edits files and runs commands without asking.'
}

export function ModeSeg({ value, onChange }: ModeSegProps) {
  return (
    <>
      <span className="seg">
        {MODES.map(({ m, label }) => (
          <button key={m} className={m === value ? 'on' : ''} onClick={() => onChange(m)}>{label}</button>
        ))}
      </span>
      <div className="modehint">{hint(value)}</div>
    </>
  )
}
