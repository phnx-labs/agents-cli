import React from 'react'
import type { Swarm } from './types'
import { taskNameToTitle, relTime, swarmOverallStatus } from './types'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './icons'
import { ExtLink } from '../common'

interface CompletedSwarmsPaneProps {
  swarms: Swarm[]
  onClear: () => void
  onSelect: (swarm: Swarm) => void
}

export function CompletedSwarmsPane({ swarms, onClear, onSelect }: CompletedSwarmsPaneProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
      <div className="sw-mc-pane-head">
        <Icon name="inbox" size={13} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>Completed</span>
        <span className="sw-section-count">{swarms.length}</span>
        <div className="sw-spacer" />
        <button className="sw-btn ghost sm" onClick={onClear} disabled={swarms.length === 0}>
          Clear
        </button>
      </div>

      <div className="sw-mc-pane-body">
        {swarms.length === 0 && (
          <div className="sw-empty">
            <Icon name="inbox" size={20} />
            <div className="sw-empty-sub">No completed swarms yet.</div>
          </div>
        )}
        {swarms.map((s) => {
          const title = taskNameToTitle(s.task_name)
          const status = swarmOverallStatus(s)
          const agentIds = [...new Set(s.agents.map((a) => a.agent_type.toLowerCase()))]
          const pr = s.agents.map((a) => a.pr_url).find(Boolean)
          const duration = s.agents.map((a) => a.duration).find(Boolean)
          return (
            <div key={s.task_name} className="sw-mc-done" style={{ cursor: 'pointer' }} onClick={() => onSelect(s)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span className={`sw-badge ${status}`}>{status}</span>
                <div className="sw-spacer" />
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                  {relTime(s.latest_activity)}
                </span>
                <button
                  className="sw-icon-btn"
                  style={{ width: 20, height: 20 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect(s)
                  }}
                  title="Open details"
                >
                  <Icon name="chevD" size={11} style={{ transform: 'rotate(-90deg)' }} />
                </button>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 550, marginBottom: 6, lineHeight: 1.35 }}>
                {title}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ display: 'flex', gap: 2 }}>
                  {agentIds.map((a) => (
                    <AgentAvatar key={a} id={a} size={14} />
                  ))}
                </div>
                {duration && (
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                    {duration}
                  </span>
                )}
                {pr && (
                  <ExtLink
                    href={pr}
                    className="mono"
                    style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--brand)' }}
                  >
                    PR
                  </ExtLink>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
