import React, { useState } from 'react'
import { AgentAvatar } from '../mission-control/AgentAvatar'
import { Icon } from '../mission-control/icons'
import {
  AgentSettings,
  SwarmStatus,
  SkillsStatus,
  SwarmAgentType,
  PromptPackAgentType,
} from '../../types'
import {
  SWARM_AGENT_LABELS,
  AGENT_INSTALL_INFO,
} from '../../constants'

interface MachineStatusProps {
  settings: AgentSettings
  swarmStatus: SwarmStatus
  skillsStatus: SkillsStatus | null
  agentModels: Record<string, string[]>
  swarmInstalling: boolean
  onInstallSwarmAgent: (agent: SwarmAgentType) => void
  onSaveSettings: (settings: AgentSettings) => void
}

export function MachineStatus({
  settings,
  swarmStatus,
  skillsStatus,
  agentModels,
  swarmInstalling,
  onInstallSwarmAgent,
  onSaveSettings,
}: MachineStatusProps) {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)
  const [copiedAgent, setCopiedAgent] = useState<string | null>(null)

  const skillCommands = skillsStatus?.commands ?? []

  const getSkillSummary = (agent: PromptPackAgentType) => {
    if (!skillsStatus) return null
    const supported = skillCommands.filter(skill => skill.agents[agent]?.supported)
    const installed = supported.filter(skill => skill.agents[agent]?.installed)
    return {
      total: supported.length,
      installed: installed.length,
    }
  }

  const getAgentStatus = (agent: SwarmAgentType) => {
    const status = swarmStatus.agents[agent]
    if (!status) return { status: 'missing' as const, label: 'NOT INSTALLED' }
    if (!status.cliAvailable) return { status: 'missing' as const, label: 'NOT INSTALLED' }
    if (!status.mcpEnabled || !status.commandInstalled) return { status: 'setup' as const, label: 'SETUP REQ' }
    return { status: 'ready' as const, label: 'READY' }
  }

  const getAgentModelName = (agent: SwarmAgentType): string => {
    const config = settings.builtIn[agent as keyof AgentSettings['builtIn']]
    if (config?.defaultModel) return config.defaultModel
    const models = agentModels[agent]
    if (models && models.length > 0) return models[0]
    return 'default'
  }

  const providerMap: Record<string, string> = {
    claude: 'Anthropic',
    codex: 'OpenAI',
    gemini: 'Google',
    opencode: 'OpenCode',
  }

  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">Machine Status</div>
      {(['claude', 'codex', 'gemini'] as SwarmAgentType[]).map((agent) => {
        const { status, label: statusLabel } = getAgentStatus(agent)
        const agentStatus = swarmStatus.agents[agent]
        const isExpanded = expandedAgent === agent
        const modelName = getAgentModelName(agent)
        const installInfo = AGENT_INSTALL_INFO[agent]
        const modelOptions = agentModels[agent] || []

        return (
          <div key={agent}>
            <button
              className="sw-agent-status-card"
              onClick={() => setExpandedAgent(isExpanded ? null : agent)}
              style={{ width: '100%' }}
            >
              <AgentAvatar id={agent} size={24} />
              <div className="sw-agent-status-info">
                <div className="sw-agent-status-name">{SWARM_AGENT_LABELS[agent]}</div>
                <div className="sw-agent-status-sub">
                  {providerMap[agent] || agent} / {modelName}
                </div>
              </div>
              <span className={`sw-status-led ${status}`}>
                <span className={`sw-dot ${status === 'ready' ? 'running' : status === 'setup' ? 'pending' : 'idle'}`} />
                {statusLabel}
              </span>
              <Icon name="chevD" size={12} style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: '.15s', color: 'var(--ds-text-dim)' }} />
            </button>

            {isExpanded && (
              <div className="sw-agent-expand">
                {!agentStatus?.cliAvailable && installInfo?.command && (
                  <div style={{ marginBottom: 8 }}>
                    <div className="sw-readout" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{installInfo.command}</span>
                      <button
                        className="sw-btn ghost sm"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(installInfo.command!)
                            setCopiedAgent(agent)
                            setTimeout(() => setCopiedAgent((cur) => (cur === agent ? null : cur)), 1500)
                          } catch {
                            // Clipboard denied — surface inline so the user
                            // knows the command wasn't copied.
                            setCopiedAgent(`err:${agent}`)
                            setTimeout(() => setCopiedAgent((cur) => (cur === `err:${agent}` ? null : cur)), 2000)
                          }
                        }}
                      >
                        {copiedAgent === agent ? 'Copied' : copiedAgent === `err:${agent}` ? 'Copy failed' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}

                {agentStatus?.cliAvailable && status !== 'ready' && (
                  <button
                    className="sw-btn primary"
                    style={{ width: '100%', marginBottom: 8 }}
                    disabled={swarmInstalling}
                    onClick={() => onInstallSwarmAgent(agent)}
                  >
                    {swarmInstalling ? 'Configuring...' : 'Configure Agent'}
                  </button>
                )}

                {modelOptions.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {modelOptions.slice(0, 6).map(model => (
                      <span key={model} className="sw-pill" style={{ fontSize: '10px' }}>{model}</span>
                    ))}
                    {modelOptions.length > 6 && (
                      <span className="sw-pill" style={{ fontSize: '10px' }}>+{modelOptions.length - 6}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
