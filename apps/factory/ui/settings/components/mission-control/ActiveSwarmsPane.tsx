import React from 'react'
import type { Swarm } from './types'
import { swarmShortId, taskNameToTitle, relTime } from './types'
import { AgentAvatar } from './AgentAvatar'
import { Icon } from './icons'

interface ActiveSwarmsPaneProps {
  swarms: Swarm[]
  selectedTaskName: string | null
  onSelect: (taskName: string) => void
  onDispatch: () => void
}

export function ActiveSwarmsPane({ swarms, selectedTaskName, onSelect, onDispatch }: ActiveSwarmsPaneProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <div className="sw-mc-pane-head">
        <Icon name="radar" size={13} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>Active Swarms</span>
        <span className="sw-section-count">{swarms.length}</span>
        <div className="sw-spacer" />
        <button className="sw-btn primary sm" onClick={onDispatch}>
          <Icon name="plus" size={11} />
          Dispatch
        </button>
      </div>

      <div className="sw-mc-pane-body">
        {swarms.length === 0 && (
          <div className="sw-empty">
            <Icon name="radar" size={20} />
            <div className="sw-empty-title">No active swarms</div>
            <div className="sw-empty-sub">
              Dispatch a swarm via <span className="mono">/swarm</span> in any agent, or use the Dispatch
              button above.
            </div>
          </div>
        )}

        {swarms.map((s) => {
          const id = swarmShortId(s.task_name)
          const title = taskNameToTitle(s.task_name)
          const agentIds = [...new Set(s.agents.map((a) => a.agent_type.toLowerCase()))]
          const branch = s.agents[0]?.cwd ? s.agents[0].cwd.split('/').slice(-2).join('/') : ''
          const selected = selectedTaskName === s.task_name
          return (
            <button
              key={s.task_name}
              className={`sw-mc-active ${selected ? 'selected' : ''}`}
              onClick={() => onSelect(s.task_name)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span className="sw-dot running pulse" style={{ color: 'var(--status-running)' }} />
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                  {id}
                </span>
                <div className="sw-spacer" />
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)' }}>
                  {relTime(s.latest_activity)}
                </span>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 550, marginBottom: 6, lineHeight: 1.35 }}>
                {title}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ display: 'flex', gap: 2 }}>
                  {agentIds.map((a) => (
                    <AgentAvatar key={a} id={a} size={14} />
                  ))}
                </div>
                {branch && (
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {branch}
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
