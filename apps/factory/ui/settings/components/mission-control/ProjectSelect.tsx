// Project / Repo picker. Ports the prototype's renderProject() (dispatch.html):
// renders items in their incoming order (confidence-first for managed projects,
// usage order for cloud repos), a MOST USED badge on the genuine max-uses entry, a
// Linear pill + confidence meter, and the mono path sub-line for local projects.
import React from 'react'
import { useRef, useState } from 'react'
import { Icon } from './icons'
import { useClickAway } from './dispatchIcons'
import type { DispatchTarget } from './dispatch.types'

export interface ProjectSelectProps {
  items: DispatchTarget[]     // already scoped to projects (local) or repos (cloud)
  value: string
  cloud: boolean              // hide the path sub-line for cloud repos
  onChange: (id: string) => void
}

// Small violet chip naming the linked Linear project. Inline-styled (dispatch.css
// is owned by another surface) — violet #8b8ce8 per the managed-projects spec.
function LinearPill({ name }: { name: string }) {
  return (
    <span
      title={`Linear · ${name}`}
      style={{
        fontSize: 9, fontWeight: 700, lineHeight: '14px', color: '#8b8ce8',
        border: '1px solid #8b8ce8', borderRadius: 4, padding: '0 4px',
        maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
    >
      {name}
    </span>
  )
}

// Tiny confidence meter: high = full lime, medium = ~60% cyan, low = ~25% dim.
function ConfMeter({ level }: { level: 'high' | 'medium' | 'low' }) {
  const pct = level === 'high' ? 100 : level === 'medium' ? 60 : 25
  const color = level === 'high' ? '#a3e635' : level === 'medium' ? '#5ad6c0' : 'var(--ds-text-dim)'
  return (
    <span
      title={`${level} confidence`}
      aria-label={`${level} confidence`}
      style={{
        display: 'inline-block', width: 28, height: 4, borderRadius: 2,
        background: 'var(--ds-bg-inset)', overflow: 'hidden',
      }}
    >
      <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} />
    </span>
  )
}

export function ProjectSelect({ items, value, cloud, onChange }: ProjectSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  // Preserve the incoming order: for managed projects that is buildManagedTargets'
  // confidence-first ranking (so the dropdown matches the sidebar); for cloud repos
  // it is usage order. The MOST USED badge still marks the genuine max-uses entry,
  // wherever it lands — never re-flatten confidence back into pure usage order.
  const sel = items.find(i => i.id === value) ?? items[0]
  if (!sel) return null
  const top = items.reduce((m, i) => (i.uses > m.uses ? i : m), items[0])

  return (
    <>
      <div ref={ref} className={`dd ${open ? 'open' : ''}`}>
        <button className="dd-btn" onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
          <span>{sel.label}</span>
          <span className="caret" style={{ marginLeft: 'auto' }}><Icon name="chevD" size={13} /></span>
        </button>
        <div className="dd-menu">
          {items.map(i => (
            <div
              key={i.id}
              className={`opt ${i.id === sel.id ? 'sel' : ''}`}
              onClick={() => { onChange(i.id); setOpen(false) }}
            >
              <span className="nm">{i.label}</span>
              {top && i.id === top.id ? <span className="badge used">MOST USED</span> : null}
              {i.linearProject ? <LinearPill name={i.linearProject} /> : null}
              {i.confidence ? <ConfMeter level={i.confidence} /> : null}
              <span className="right"><span className="use">{i.uses}×</span></span>
            </div>
          ))}
        </div>
      </div>
      {cloud ? null : <div className="sub2 mono">{sel.path}</div>}
    </>
  )
}
