import React, { useState } from 'react'
import { Icon } from './icons'
import type { SavedView } from './savedViews'

// Saved-view chips over the one stream (the mockup's Today / Engineering / My work
// row). Clicking a chip applies its filters; the active one is highlighted. The
// "Save view" affordance captures the current filters under an inline-typed name.
interface SavedViewsProps {
  views: SavedView[]
  activeName: string | null
  onApply: (v: SavedView) => void
  onSave: (name: string) => void
  onDelete: (name: string) => void
}

export function SavedViews({ views, activeName, onApply, onSave, onDelete }: SavedViewsProps) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const commit = () => {
    const n = name.trim()
    if (n) onSave(n)
    setName('')
    setAdding(false)
  }

  if (views.length === 0 && !adding) {
    return (
      <div className="savedviews">
        <span className="svadd" onClick={() => setAdding(true)}><Icon name="plus" size={10} /> Save view</span>
      </div>
    )
  }

  return (
    <div className="savedviews">
      {views.map((v) => (
        <span
          key={v.name}
          className={`svchip${activeName === v.name ? ' on' : ''}`}
          onClick={() => onApply(v)}
        >
          {v.name}
          <span className="svx" title="Delete view" onClick={(e) => { e.stopPropagation(); onDelete(v.name) }}>
            <Icon name="x" size={9} />
          </span>
        </span>
      ))}
      {adding ? (
        <input
          className="svinput"
          autoFocus
          value={name}
          placeholder="View name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') { setName(''); setAdding(false) }
          }}
          onBlur={commit}
        />
      ) : (
        <span className="svadd" onClick={() => setAdding(true)}><Icon name="plus" size={10} /> Save view</span>
      )}
    </div>
  )
}
