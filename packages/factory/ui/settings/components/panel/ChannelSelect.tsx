import React from 'react'
import { AgentAvatar } from '../mission-control/AgentAvatar'
import {
  BuiltInAgentConfig,
} from '../../types'
import {
  AGENT_TITLE_TO_KEY,
  AGENT_KEY_TO_TITLE,
} from '../../constants'

interface ChannelSelectProps {
  builtInAgents: BuiltInAgentConfig[]
  defaultAgent: string
  secondaryAgent: string
  installedAgents: Record<string, boolean>
  agentModels: Record<string, string[]>
  onSetDefaultAgent: (agentTitle: string) => void
  onSetSecondaryAgent: (agentTitle: string) => void
}

export function ChannelSelect({
  builtInAgents,
  defaultAgent,
  secondaryAgent,
  installedAgents,
  agentModels,
  onSetDefaultAgent,
  onSetSecondaryAgent,
}: ChannelSelectProps) {
  const selectableAgents = builtInAgents.filter(a => a.key !== 'shell' && (installedAgents[a.key] ?? true))
  const primaryKey = AGENT_TITLE_TO_KEY[defaultAgent] || 'claude'
  const secondaryKey = AGENT_TITLE_TO_KEY[secondaryAgent] || 'codex'

  const getModelDisplay = (agentKey: string): string => {
    const models = agentModels[agentKey]
    if (models && models.length > 0) return models[0]
    return 'default'
  }

  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">Channel Select</div>

      {/* PRIMARY */}
      <div style={{ marginBottom: 16 }}>
        <div className="sw-channel-label">
          Primary
          <span className="kbd kbd-inline">Cmd+Shift+A</span>
        </div>
        {selectableAgents.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--ds-text-dim)' }}>
            Install an agent to set a primary channel.
          </div>
        ) : (
          <>
            <div className="sw-agent-selector">
              {selectableAgents.map(agent => {
                const isSelected = primaryKey === agent.key
                return (
                  <button
                    key={agent.key}
                    className={`sw-agent-btn ${isSelected ? 'selected' : ''}`}
                    onClick={() => onSetDefaultAgent(AGENT_KEY_TO_TITLE[agent.key] || 'CC')}
                  >
                    <AgentAvatar id={agent.key} size={20} />
                    <span className="sw-agent-btn-name">{agent.name}</span>
                    <span className="sw-agent-btn-model">{getModelDisplay(agent.key)}</span>
                  </button>
                )
              })}
            </div>
            <div className="sw-readout" style={{ marginTop: 8 }}>
              {selectableAgents.find(a => a.key === primaryKey)?.name || 'Claude'} -- {getModelDisplay(primaryKey)}
            </div>
          </>
        )}
      </div>

      {/* SECONDARY */}
      <div>
        <div className="sw-channel-label">
          Secondary
          <span className="kbd kbd-inline">Cmd+Shift+B</span>
        </div>
        {selectableAgents.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--ds-text-dim)' }}>
            Install an agent to set a secondary channel.
          </div>
        ) : (
          <>
            <div className="sw-agent-selector">
              {selectableAgents.map(agent => {
                const isPrimary = primaryKey === agent.key
                const isSelected = secondaryKey === agent.key
                return (
                  <button
                    key={agent.key}
                    className={`sw-agent-btn ${isSelected ? 'selected' : ''}`}
                    style={isPrimary ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                    disabled={isPrimary}
                    onClick={() => onSetSecondaryAgent(AGENT_KEY_TO_TITLE[agent.key] || 'CX')}
                  >
                    <AgentAvatar id={agent.key} size={20} />
                    <span className="sw-agent-btn-name">{agent.name}</span>
                    <span className="sw-agent-btn-model">{getModelDisplay(agent.key)}</span>
                  </button>
                )
              })}
            </div>
            <div className="sw-readout" style={{ marginTop: 8 }}>
              {selectableAgents.find(a => a.key === secondaryKey)?.name || 'Codex'} -- {getModelDisplay(secondaryKey)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
