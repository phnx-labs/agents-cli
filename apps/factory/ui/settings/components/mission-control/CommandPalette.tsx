import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { UnifiedTask } from '../../types'
import { Icon } from './icons'

/**
 * Events the palette dispatches when a result is chosen. Consumers listen
 * on the window — CommandPalette doesn't know who's handling what, so it
 * stays decoupled from UnifiedAgentsPane/App state. Each event's detail
 * carries just enough to act on without re-looking-up the full object.
 */
export const CMD_PALETTE_EVENTS = {
  openTaskDetail: 'sw:openTaskDetail',
  focusTerminal: 'sw:focusTerminal',
  switchTab: 'sw:switchTab',
} as const

type Action = {
  id: string
  kind: 'task' | 'terminal' | 'action'
  label: string
  sublabel?: string
  badge?: string
  onRun: () => void
}

/**
 * Command palette opened via ⌘K / Ctrl+K. Fuzzy-filters tasks, active
 * agent terminals, and built-in actions in a single list. Arrow keys
 * navigate; Enter fires; Esc closes.
 *
 * Design notes:
 * - We keep this dumb: callers pass in the pool of tasks and the list of
 *   active-terminal IDs+labels. We don't reach into stores.
 * - Selection is by index (not id) so duplicate labels don't confuse nav.
 * - Each result commits via an `onRun` callback — either a direct fn the
 *   caller wired, or a `window.dispatchEvent(CMD_PALETTE_EVENTS.X)` for
 *   cross-component handoffs (UnifiedAgentsPane listens for task detail).
 */
export function CommandPalette({
  tasks,
  terminals,
  onClose,
  onSwitchTab,
}: {
  tasks: UnifiedTask[]
  terminals: Array<{ id: string; agentType: string; label: string | null; sessionId: string | null }>
  onClose: () => void
  onSwitchTab: (tab: 'floor' | 'bench' | 'panel') => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const allActions = useMemo<Action[]>(() => {
    const items: Action[] = []

    for (const t of tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress')) {
      items.push({
        id: `task:${t.id}`,
        kind: 'task',
        label: t.title,
        sublabel: t.metadata.identifier || t.source,
        badge: t.priority ? t.priority.toUpperCase() : undefined,
        onRun: () => {
          window.dispatchEvent(new CustomEvent(CMD_PALETTE_EVENTS.openTaskDetail, { detail: { taskId: t.id } }))
        },
      })
    }

    for (const t of terminals) {
      const label = t.label?.trim() || `${t.agentType} ${(t.sessionId || t.id).slice(0, 8)}`
      items.push({
        id: `term:${t.id}`,
        kind: 'terminal',
        label: `Focus ${label}`,
        sublabel: t.agentType,
        onRun: () => {
          window.dispatchEvent(new CustomEvent(CMD_PALETTE_EVENTS.focusTerminal, { detail: { terminalId: t.id } }))
        },
      })
    }

    const tabActions: Array<{ key: 'floor' | 'bench' | 'panel'; label: string }> = [
      { key: 'floor', label: 'Go to Floor' },
      { key: 'bench', label: 'Go to Bench' },
      { key: 'panel', label: 'Go to Panel' },
    ]
    for (const a of tabActions) {
      items.push({
        id: `tab:${a.key}`,
        kind: 'action',
        label: a.label,
        sublabel: 'Navigation',
        onRun: () => onSwitchTab(a.key),
      })
    }

    return items
  }, [tasks, terminals, onSwitchTab])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allActions.slice(0, 50)
    return allActions
      .filter((a) =>
        a.label.toLowerCase().includes(q) ||
        (a.sublabel || '').toLowerCase().includes(q),
      )
      .slice(0, 50)
  }, [allActions, query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-idx="${cursor}"]`)
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const commit = (idx: number) => {
    const action = filtered[idx]
    if (!action) return
    onClose()
    action.onRun()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filtered.length === 0) return
      setCursor((c) => (c + 1) % filtered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (filtered.length === 0) return
      setCursor((c) => (c - 1 + filtered.length) % filtered.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(cursor)
    }
  }

  return (
    <div className="sw-dispatch-modal-overlay" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div
        className="sw-dispatch-modal"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ maxWidth: 640, width: '90%' }}
      >
        <div className="sw-dispatch-modal-search">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Jump to task, focus agent, or run an action…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            style={{ flex: 1 }}
          />
          <span className="kbd-group">
            <span className="kbd">esc</span>
          </span>
        </div>
        <div
          ref={listRef}
          className="sw-dispatch-modal-body"
          style={{ maxHeight: 460, overflowY: 'auto' }}
        >
          {filtered.length === 0 ? (
            <div className="sw-dispatch-modal-empty">No matches.</div>
          ) : (
            <ul className="sw-dispatch-modal-list">
              {filtered.map((a, i) => (
                <li key={a.id}>
                  <div
                    data-idx={i}
                    className={`sw-dispatch-modal-row ${i === cursor ? 'selected' : ''}`}
                    onClick={() => commit(i)}
                    onMouseEnter={() => setCursor(i)}
                    role="button"
                  >
                    <span
                      className="sw-dispatch-modal-id"
                      style={{ minWidth: 56, opacity: 0.8 }}
                    >
                      {a.kind === 'task' ? 'Task' : a.kind === 'terminal' ? 'Agent' : 'Go'}
                    </span>
                    <span className="sw-dispatch-modal-title-text">{a.label}</span>
                    {a.badge && (
                      <span
                        className={`sw-dispatch-modal-priority ${a.badge.toLowerCase()}`}
                      >
                        {a.badge}
                      </span>
                    )}
                    {a.sublabel && (
                      <span
                        className="sw-dispatch-modal-id"
                        style={{ opacity: 0.55 }}
                      >
                        {a.sublabel}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="sw-dispatch-modal-foot" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
          <div className="sw-dispatch-modal-foot-info">
            <span className="kbd-group">
              <span className="kbd">↑</span>
              <span className="kbd">↓</span>
            </span>
            <span style={{ marginLeft: 8 }}>Navigate</span>
            <span className="kbd-group" style={{ marginLeft: 16 }}>
              <span className="kbd">↵</span>
            </span>
            <span style={{ marginLeft: 8 }}>Run</span>
          </div>
          <div className="sw-dispatch-modal-foot-actions">
            {filtered.length} result{filtered.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
    </div>
  )
}
