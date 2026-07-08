import React, { useState } from 'react'
import { Icon } from './icons'
import type { FloorTicket } from './floorModel'
import { renderTodoDescription } from '../../utils/markdown'

// Right-pane ticket detail + Dispatch panel. Prototype ticketDetail():666-680.
// Backlog -> Dispatch -> running -> Needs-You -> Done is one closed loop; this is the
// Dispatch step. Agent/host/mode selection is component-local UI state, raised on submit.

const AGENTS = ['Claude', 'Codex', 'Gemini'] as const
const MODES: { label: string; value: 'plan' | 'edit' }[] = [
  { label: 'Plan', value: 'plan' },
  { label: 'Edit', value: 'edit' },
]

export interface DispatchChoice {
  agent: string
  host: string
  mode: 'plan' | 'edit'
}

interface TicketDetailProps {
  ticket: FloorTicket
  /** Available hosts to dispatch onto (SHELL supplies real host list). */
  hosts?: string[]
  onDispatch: (choice: DispatchChoice) => void
}

export function TicketDetail({ ticket: t, hosts = ['this-mac'], onDispatch }: TicketDetailProps) {
  const [agent, setAgent] = useState<string>(AGENTS[0])
  const [mode, setMode] = useState<'plan' | 'edit'>('edit')
  const [host, setHost] = useState<string>(hosts[0] ?? 'this-mac')
  const source = t.source === 'LN' ? 'Linear' : 'GitHub'

  return (
    <>
      <div className="dhead">
        <span className={`src ${t.source}`}>{t.source}</span>
        <div className="grow0">
          <div className="title">{t.id}</div>
          <div className="sub">
            {t.project} · <span className={`pri ${t.pri}`} style={{ display: 'inline-block', verticalAlign: 'middle' }} /> {t.pri} · {t.status.replace('-', ' ')}
          </div>
        </div>
      </div>
      <div className="dbody">
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{t.title}</div>
          <div style={{ fontSize: 12.5, color: 'var(--tx-mut)', lineHeight: 1.5 }}>{renderTodoDescription(t.desc, false)}</div>
          <div style={{ marginTop: 8 }}>
            {(t.labels || []).map((l) => (
              <span key={l} className="tlbl">{l}</span>
            ))}
          </div>
        </div>

        <div className="dispatch-panel">
          <div className="lbl">Dispatch an agent onto this ticket</div>
          <div className="dp-row">
            <span className="dp-k">Agent</span>
            <span className="opts">
              {AGENTS.map((ag) => (
                <button key={ag} className={`opt ${agent === ag ? 'primary' : 'ghost'}`} onClick={() => setAgent(ag)}>{ag}</button>
              ))}
            </span>
          </div>
          <div className="dp-row">
            <span className="dp-k">Host</span>
            <select className="sel" value={host} onChange={(e) => setHost(e.target.value)}>
              {hosts.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
          <div className="dp-row">
            <span className="dp-k">Mode</span>
            <span className="opts">
              {MODES.map((m) => (
                <button key={m.value} className={`opt ${mode === m.value ? 'primary' : 'ghost'}`} onClick={() => setMode(m.value)}>{m.label}</button>
              ))}
            </span>
          </div>
          <button
            className="disp"
            style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
            onClick={() => onDispatch({ agent: agent.toLowerCase(), host, mode })}
          >
            <Icon name="zap" size={12} /> Dispatch onto {t.id}
          </button>
        </div>

        <div>
          <div className="lbl">Links</div>
          <div style={{ fontSize: 12 }}>
            <span style={{ color: 'var(--brand-600)', cursor: 'pointer' }}>Open {t.id} in {source} <Icon name="chevR" size={11} /></span>
          </div>
        </div>
      </div>
    </>
  )
}
