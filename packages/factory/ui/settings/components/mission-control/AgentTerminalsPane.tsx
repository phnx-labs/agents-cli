import React, { useEffect, useRef, useState } from 'react'
import type { Terminal } from './types'
import { AgentAvatar, agentShortChunk } from './AgentAvatar'
import { Icon } from './icons'

interface TerminalsPaneProps {
  terminals: Terminal[]
  onFocus: (terminal: Terminal) => void
  onNewAgent: (agentKey: 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor') => void
}

const NEW_MENU: Array<{ agent: 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor'; name: string; keys: string[] }> = [
  { agent: 'claude', name: 'Claude', keys: ['⌘', '⇧', 'A'] },
  { agent: 'codex', name: 'Codex', keys: ['⌘', '⇧', 'B'] },
  { agent: 'gemini', name: 'Gemini', keys: ['⌘', '⇧', 'X'] },
  { agent: 'opencode', name: 'OpenCode', keys: ['⌘', '⇧', 'M'] },
  { agent: 'cursor', name: 'Cursor', keys: ['⌘', '⇧', 'U'] },
]

function labelForTerminal(t: Terminal): { label: string; running: boolean } {
  if (t.currentActivity) return { label: t.currentActivity, running: true }
  if (t.label) return { label: t.label, running: t.status === 'running' }
  if (t.status === 'idle') return { label: 'idle', running: false }
  return { label: t.role ?? 'terminal', running: t.status === 'running' }
}

export function AgentTerminalsPane({ terminals, onFocus, onNewAgent }: TerminalsPaneProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="sw-mc-terms">
      <div className="sw-mc-pane-head" style={{ borderBottom: '1px solid var(--ds-border-subtle)' }}>
        <Icon name="terminal" size={13} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>Agent Terminals</span>
        <span className="sw-section-count">{terminals.length}</span>
        <div className="sw-spacer" />
        <div style={{ position: 'relative' }} ref={ref}>
          <button className="sw-btn secondary sm" onClick={() => setOpen((o) => !o)}>
            <Icon name="plus" size={11} />
            New
            <Icon name="chevD" size={10} />
          </button>
          {open && (
            <div className="sw-menu">
              <div className="sw-menu-group-label">Open a terminal</div>
              {NEW_MENU.map((m) => (
                <button
                  key={m.agent}
                  className="sw-menu-item"
                  onClick={() => {
                    setOpen(false)
                    onNewAgent(m.agent)
                  }}
                >
                  <AgentAvatar id={m.agent} size={16} />
                  <span>{m.name}</span>
                  <span className="spacer" />
                  <span className="kbd-group">
                    {m.keys.map((k) => (
                      <span key={k} className="kbd kbd-inline">{k}</span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="sw-mc-term-body">
        {terminals.length === 0 && (
          <div className="sw-empty" style={{ padding: '24px 8px' }}>
            <div className="sw-empty-sub">
              No open agent terminals. Press{' '}
              <span className="kbd-group" style={{ display: 'inline-flex' }}>
                <span className="kbd kbd-inline">⌘</span>
                <span className="kbd kbd-inline">⇧</span>
                <span className="kbd kbd-inline">A</span>
              </span>{' '}
              to open Claude.
            </div>
          </div>
        )}
        {terminals.map((t) => {
          const chunk = agentShortChunk(t.sessionId) || (t.id ?? '').slice(-8)
          const { label, running } = labelForTerminal(t)
          return (
            <button
              key={t.id}
              className="sw-mc-term-row"
              title="Jump to terminal tab"
              onClick={() => onFocus(t)}
            >
              <AgentAvatar id={t.agentType} size={18} />
              <span className="mono sw-mc-term-sess">{t.agentType}-{chunk}</span>
              <span
                className="mono sw-mc-term-label"
                style={{ color: running ? 'var(--ds-text-muted)' : 'var(--ds-text-dim)' }}
              >
                {label}
              </span>
              <span className={`sw-dot ${running ? 'running pulse' : 'idle'}`} style={running ? { color: 'var(--status-running)' } : undefined} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
