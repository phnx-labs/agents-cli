import React from 'react'
import type { Swarm } from './types'
import { taskNameToTitle, swarmShortId, relTime } from './types'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './icons'
import { ExtLink } from '../common'

interface SwarmDetailPaneProps {
  swarm: Swarm | null
  onRetry: (swarm: Swarm) => void
  onKill: (swarm: Swarm) => void
  onCopyId: (swarm: Swarm) => void
}

export function SwarmDetailPane({ swarm, onRetry, onKill, onCopyId }: SwarmDetailPaneProps) {
  if (!swarm) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        <div className="sw-mc-pane-head">
          <Icon name="inbox" size={13} />
          <span style={{ fontSize: 12, fontWeight: 600 }}>Activity</span>
        </div>
        <div className="sw-mc-pane-body">
          <div className="sw-empty">
            <Icon name="inbox" size={24} />
            <div className="sw-empty-title">Select a swarm to see its activity</div>
            <div className="sw-empty-sub">
              Each swarm's per-agent stream shows which files they're editing, the most recent tool calls,
              and token usage.
            </div>
          </div>
        </div>
      </div>
    )
  }

  const id = swarmShortId(swarm.task_name)
  const title = taskNameToTitle(swarm.task_name)
  const branch = swarm.agents[0]?.cwd ?? ''
  const events = buildEvents(swarm)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      <div className="sw-mc-pane-head">
        <Icon name="radar" size={13} />
        <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        <div className="sw-spacer" />
        <button className="sw-icon-btn" onClick={() => onCopyId(swarm)} title="Copy swarm id">
          <Icon name="copy" size={14} />
        </button>
        <button className="sw-btn secondary sm" onClick={() => onRetry(swarm)}>
          <Icon name="refresh" size={11} />
          Retry
        </button>
        <button className="sw-btn danger sm" onClick={() => onKill(swarm)}>
          <Icon name="x" size={11} />
          Kill
        </button>
      </div>

      <div className="sw-mc-pane-body">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          <span className="sw-pill mono">{id}</span>
          {branch && <span className="sw-pill mono">{branch}</span>}
          <span className="sw-pill">{relTime(swarm.latest_activity)}</span>
        </div>

        <div className="sw-section-label" style={{ marginBottom: 8 }}>Agents</div>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginBottom: 20 }}>
          {swarm.agents.map((a) => {
            const statusClass =
              a.status === 'running' ? 'running' :
              a.status === 'completed' ? 'ok' :
              a.status === 'failed' ? 'failed' : 'idle'
            return (
              <div
                key={a.agent_id}
                style={{
                  border: '1px solid var(--ds-border-subtle)',
                  borderRadius: 'var(--r-md)',
                  padding: 10,
                  background: 'var(--ds-bg-panel)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <AgentAvatar id={a.agent_type} size={18} />
                  <span style={{ fontSize: 12.5, fontWeight: 550, textTransform: 'capitalize' }}>
                    {a.agent_type}
                  </span>
                  <div className="sw-spacer" />
                  <span className={`sw-badge ${statusClass}`}>{a.status}</span>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color: 'var(--ds-text-muted)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {summarizeAgent(a)}
                </div>
                {a.pr_url && (
                  <ExtLink
                    href={a.pr_url}
                    className="mono"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6, fontSize: 11, color: 'var(--brand)' }}
                  >
                    <Icon name="external" size={10} />
                    PR
                  </ExtLink>
                )}
              </div>
            )
          })}
        </div>

        <div className="sw-section-label" style={{ marginBottom: 8 }}>Activity stream</div>
        <div>
          {events.length === 0 && (
            <div className="sw-empty" style={{ padding: '16px 8px' }}>
              <div className="sw-empty-sub">No recent events yet.</div>
            </div>
          )}
          {events.map((ev, i) => (
            <div key={i} className="sw-mc-ev">
              <AgentAvatar id={ev.agent} size={16} />
              <span className="sw-mc-ev-time mono">{ev.t}</span>
              <div>
                <span className={`sw-mc-ev-kind ${ev.kind} mono`}>{ev.kind}</span>
                <span style={{ marginLeft: 8 }}>{ev.text}</span>
                {ev.detail && (
                  <span className="mono" style={{ marginLeft: 8, color: 'var(--ds-text-dim)', fontSize: 10.5 }}>
                    {ev.detail}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function stripMd(s: string): string {
  return s
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s/gm, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim()
}

function summarizeAgent(a: Swarm['agents'][number]): string {
  if (a.bash_commands?.length) return `$ ${a.bash_commands[a.bash_commands.length - 1]}`
  if (a.files_modified?.length) return `Edit ${a.files_modified[a.files_modified.length - 1]}`
  if (a.files_created?.length) return `Create ${a.files_created[a.files_created.length - 1]}`
  if (a.files_deleted?.length) return `Delete ${a.files_deleted[a.files_deleted.length - 1]}`
  if (a.last_messages?.length) return stripMd(a.last_messages[a.last_messages.length - 1]).slice(0, 160)
  return a.prompt ? stripMd(a.prompt).slice(0, 160) : 'waiting…'
}

interface Event {
  t: string
  agent: string
  kind: 'tool' | 'read' | 'msg'
  text: string
  detail?: string
}

function buildEvents(swarm: Swarm): Event[] {
  const events: Event[] = []
  for (const a of swarm.agents) {
    const mods = a.files_modified ?? []
    mods.slice(-4).forEach((f) => {
      events.push({ t: '', agent: a.agent_type.toLowerCase(), kind: 'tool', text: `Edit ${f}` })
    })
    const reads = a.files_created ?? []
    reads.slice(-2).forEach((f) => {
      events.push({ t: '', agent: a.agent_type.toLowerCase(), kind: 'tool', text: `Create ${f}` })
    })
    const cmds = a.bash_commands ?? []
    cmds.slice(-3).forEach((c) => {
      events.push({ t: '', agent: a.agent_type.toLowerCase(), kind: 'tool', text: `Bash ${c}` })
    })
    const msgs = a.last_messages ?? []
    msgs.slice(-2).forEach((m) => {
      events.push({ t: '', agent: a.agent_type.toLowerCase(), kind: 'msg', text: stripMd(m).slice(0, 240) })
    })
  }
  return events.slice(-20).reverse()
}
