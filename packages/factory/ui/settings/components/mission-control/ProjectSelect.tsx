// Project / Repo picker. Ports the prototype's renderProject() (dispatch.html):
// ranked-by-usage dropdown, MOST USED badge on the top entry, uses count, and the
// mono path sub-line for local projects (hidden for cloud repos).
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

export function ProjectSelect({ items, value, cloud, onChange }: ProjectSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false), open)

  const ranked = [...items].sort((a, b) => b.uses - a.uses)
  const sel = ranked.find(i => i.id === value) ?? ranked[0]
  if (!sel) return null
  const top = ranked[0]

  return (
    <>
      <div ref={ref} className={`dd ${open ? 'open' : ''}`}>
        <button className="dd-btn" onClick={e => { e.stopPropagation(); setOpen(o => !o) }}>
          <span>{sel.label}</span>
          <span className="caret" style={{ marginLeft: 'auto' }}><Icon name="chevD" size={13} /></span>
        </button>
        <div className="dd-menu">
          {ranked.map(i => (
            <div
              key={i.id}
              className={`opt ${i.id === sel.id ? 'sel' : ''}`}
              onClick={() => { onChange(i.id); setOpen(false) }}
            >
              <span className="nm">{i.label}</span>
              {top && i.id === top.id ? <span className="badge used">MOST USED</span> : null}
              <span className="right"><span className="use">{i.uses}×</span></span>
            </div>
          ))}
        </div>
      </div>
      {cloud ? null : <div className="sub2 mono">{sel.path}</div>}
    </>
  )
}
