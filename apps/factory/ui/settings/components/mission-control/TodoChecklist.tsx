import React, { useState } from 'react'
import { todoProgress, type TodoItem } from './floorModel'

// Per-session task checklist, parsed from the agent's latest TodoWrite call.
// Status is conveyed by a colored marker (done / in-progress / pending) plus a
// strikethrough on completed items -- no glyphs. Shared by the Floor detail pane,
// the feed card (bar-only), and the cloud activity feed.

/** Compact done/total progress bar -- the card affordance. Renders nothing when empty. */
export function TodoProgressBar({ todos }: { todos: TodoItem[] }) {
  const { done, total } = todoProgress(todos)
  if (total === 0) return null
  const pct = Math.round((done / total) * 100)
  return (
    <div className="sw-todobar" title={`${done} of ${total} tasks done`}>
      <span className="sw-todobar-frac">{done}/{total}</span>
      <span className="sw-todobar-track"><i style={{ width: `${pct}%` }} /></span>
    </div>
  )
}

/**
 * Card affordance: the progress bar with the full checklist EXPANDED beneath it by
 * default, so the current step reads at a glance without a click. The bar doubles as a
 * collapse/expand toggle (still collapsible for a denser feed). The in-progress item is
 * highlighted and completed items struck through via the shared `.sw-todocheck-item`
 * styles. Clicks are stopped so toggling never selects the card.
 */
export function CardChecklist({ todos }: { todos: TodoItem[] }) {
  const { done, total } = todoProgress(todos)
  const [open, setOpen] = useState(true)
  if (total === 0) return null
  const pct = Math.round((done / total) * 100)
  return (
    <div className="sw-cardchecklist">
      <button
        type="button"
        className="sw-cardchecklist-bar"
        aria-expanded={open}
        title={open ? 'Collapse checklist' : 'Expand checklist'}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
      >
        <span className="sw-todobar-frac">{done}/{total}</span>
        <span className="sw-todobar-track"><i style={{ width: `${pct}%` }} /></span>
        <span className="sw-cardchecklist-chev">{open ? '⌄' : '›'}</span>
      </button>
      {open && (
        <ul className="sw-todocheck-list">
          {todos.map((t, i) => (
            <li key={i} className={`sw-todocheck-item status-${t.status}`}>
              <span className="sw-todocheck-mk" />
              <span className="sw-todocheck-txt">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Full checklist with a tally header -- the detail-pane affordance. */
export function TodoChecklist({ todos }: { todos: TodoItem[] }) {
  const { done, total } = todoProgress(todos)
  if (total === 0) return null
  const pct = Math.round((done / total) * 100)
  return (
    <div className="sw-todocheck">
      <div className="sw-todocheck-head">
        <span className="sw-todocheck-frac">{done}/{total} tasks</span>
        <span className="sw-todobar-track" style={{ maxWidth: 180 }}><i style={{ width: `${pct}%` }} /></span>
      </div>
      <ul className="sw-todocheck-list">
        {todos.map((t, i) => (
          <li key={i} className={`sw-todocheck-item status-${t.status}`}>
            <span className="sw-todocheck-mk" />
            <span className="sw-todocheck-txt">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
