import React, { useState } from 'react'
import { Icon } from './icons'
import type { FloorAgent, FloorTicket } from './floorModel'
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

/**
 * Dispatch CTA copy for a ticket that may already be in flight: the guard turns the
 * button into an explicit "anyway" when workers exist. Pure — unit-tested directly
 * (the full TicketDetail render needs DOMPurify/DOM, which the test runner lacks).
 */
export function dispatchCta(ticketId: string, workers: FloorAgent[]): { label: string; caution: boolean; note: string | null } {
  const first = workers[0]
  if (!first) return { label: `Dispatch onto ${ticketId}`, caution: false, note: null }
  return {
    label: `Dispatch anyway onto ${ticketId}`,
    caution: true,
    note: `${first.abbr} is already on this ticket — dispatching adds a second agent.`,
  }
}

/** The "In flight" block: agents already carrying the ticket, each row jumps to its card. */
export function TicketInFlight({ workers, onSelectAgent }: { workers: FloorAgent[]; onSelectAgent?: (id: string) => void }) {
  if (workers.length === 0) return null
  return (
    <div className="dflight">
      <div className="lbl">In flight</div>
      {workers.map((a) => (
        <button key={a.id} type="button" className="dflight-row" onClick={() => onSelectAgent?.(a.id)}>
          <span className={`dot ${a.phase}`} />
          <span className="abbr">{a.abbr}</span>
          <span className="n">{a.name}</span>
          <span className="h">{a.hostLabel ?? a.host}</span>
          {a.pr && <span className="pr">{a.pr}</span>}
        </button>
      ))}
    </div>
  )
}

interface TicketDetailProps {
  ticket: FloorTicket
  /** Available hosts to dispatch onto (SHELL supplies real host list). */
  hosts?: string[]
  /** Agents already carrying this ticket (ticketWorkers[t.id]) — the in-flight block. */
  workers?: FloorAgent[]
  /** Jump to a worker's agent card/detail. */
  onSelectAgent?: (id: string) => void
  onDispatch: (choice: DispatchChoice) => void
}

export function TicketDetail({ ticket: t, hosts = ['this-mac'], workers = [], onSelectAgent, onDispatch }: TicketDetailProps) {
  const cta = dispatchCta(t.id, workers)
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

        <TicketInFlight workers={workers} onSelectAgent={onSelectAgent} />

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
          {cta.note && <div className="dflight-note">{cta.note}</div>}
          <button
            className={`disp${cta.caution ? ' caution' : ''}`}
            style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
            onClick={() => onDispatch({ agent: agent.toLowerCase(), host, mode })}
          >
            <Icon name="zap" size={12} /> {cta.label}
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
