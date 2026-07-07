// Surface segmented control — Interactive · Headless (default Interactive).
// Orthogonal to Mode: a headless run still uses Mode's permissions (a headless
// auto-mode agent is the common case). Maps 1:1 to the CLI's --interactive /
// --headless axis. Interactive opens a terminal tab; Headless runs detached in the
// background (no tab) and shows in the Floor under its device, focusable later.
import React from 'react'

export interface SurfaceSegProps {
  headless: boolean
  onChange: (headless: boolean) => void
}

const SURFACES: { headless: boolean; label: string }[] = [
  { headless: false, label: 'Interactive' },
  { headless: true, label: 'Headless' },
]

function hint(headless: boolean): React.ReactNode {
  return headless
    ? <>Runs <b>in the background</b> — no terminal tab. Shows in the Floor under its device; open it later with Focus.</>
    : 'Opens a terminal tab you drive directly.'
}

export function SurfaceSeg({ headless, onChange }: SurfaceSegProps) {
  return (
    <>
      <span className="seg">
        {SURFACES.map(({ headless: h, label }) => (
          <button key={label} className={h === headless ? 'on' : ''} onClick={() => onChange(h)}>{label}</button>
        ))}
      </span>
      <div className="modehint">{hint(headless)}</div>
    </>
  )
}
