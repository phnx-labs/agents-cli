import React, { useEffect, useState } from 'react'
import { RefreshCw, Waypoints, KeyRound, ShieldAlert, FileEdit } from 'lucide-react'
import { Input } from '../ui/input'
import { postMessage } from '../../hooks'
import { AgentDial } from './AgentDial'
import { HarnessRoster } from './HarnessRoster'
import { AgentResources } from './AgentResources'
import { LaunchMatrix } from './LaunchMatrix'
import { StatusBank } from './StatusBank'
import type { StatusBankItem, StatusBankLevel } from './StatusBank'
import type {
  AgentSettings,
  SwarmStatus,
  SkillsStatus,
  BuiltInAgentConfig,
  NotificationSettings,
  SwarmAgentType,
  PromptPackAgentType,
  IconConfig,
  RunningCounts,
  AgentInventory,
  AgentRunStrategy,
  WatchdogPlaybookStatus,
} from '../../types'
import {
  ALL_SWARM_AGENTS,
  SWARM_AGENT_LABELS,
  AGENT_TITLE_TO_KEY,
  AGENT_KEY_TO_TITLE,
  AGENT_INSTALL_INFO,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_EDITOR_PREFERENCES,
} from '../../constants'
import { getIcon, formatPreviewTerminalTitle } from '../../utils'
import { FactorySection } from '../FactorySection'
import { SourcesSection } from './TuneSection'
import { ProjectRulesSection } from './ProjectRulesSection'

export interface PanelTabProps {
  settings: AgentSettings
  swarmStatus: SwarmStatus
  runningCounts: RunningCounts
  skillsStatus: SkillsStatus | null
  builtInAgents: BuiltInAgentConfig[]
  defaultAgent: string
  secondaryAgent: string
  installedAgents: Record<string, boolean>
  agentModels: Record<string, string[]>
  agentInventories: Record<string, AgentInventory>
  icons: IconConfig
  isLightTheme: boolean
  swarmInstalling: boolean
  isAddingAlias: boolean
  newAliasName: string
  newAliasAgent: string
  newAliasFlags: string
  aliasError: string
  onSaveSettings: (settings: AgentSettings) => void
  onInstallSwarmAgent: (agent: SwarmAgentType) => void
  onSetDefaultAgent: (agentTitle: string) => void
  onSetSecondaryAgent: (agentTitle: string) => void
  onAddAliasClick: () => void
  onCancelAddAlias: () => void
  onSaveAlias: () => void
  onRemoveAlias: (index: number) => void
  onAliasNameChange: (value: string) => void
  onAliasAgentChange: (value: string) => void
  onAliasFlagsChange: (value: string) => void
  linearConnected?: boolean
  onLinearKeySaved?: () => void
  availableSources: { linear: boolean; github: boolean }
  onUpdateTaskSources: (sources: Partial<AgentSettings['taskSources']>) => void
  onConnectLinear: () => void
  onConnectGitHub: () => void
  onSetAgentRunStrategy: (agentKey: string, strategy: AgentRunStrategy) => void
  watchdogPlaybookStatus: WatchdogPlaybookStatus | null
  onOpenWatchdogPlaybook: () => void
}

export function Rocker({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className="toggle-switch"
      data-state={on ? 'on' : 'off'}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-knob" />
    </button>
  )
}

function statusLevel(value: boolean): StatusBankLevel {
  return value ? 'running' : 'idle'
}

function skillGauge(total: number, installed: number) {
  if (total <= 0) return 12
  return (installed / total) * 100
}

export function PanelTab({
  settings,
  swarmStatus,
  runningCounts,
  skillsStatus,
  builtInAgents,
  defaultAgent,
  secondaryAgent,
  installedAgents,
  agentModels,
  agentInventories,
  icons,
  isLightTheme,
  swarmInstalling,
  isAddingAlias,
  newAliasName,
  newAliasAgent,
  newAliasFlags,
  aliasError,
  onSaveSettings,
  onInstallSwarmAgent,
  onSetDefaultAgent,
  onSetSecondaryAgent,
  onAddAliasClick,
  onCancelAddAlias,
  onSaveAlias,
  onRemoveAlias,
  onAliasNameChange,
  onAliasAgentChange,
  onAliasFlagsChange,
  linearConnected = false,
  onLinearKeySaved,
  availableSources,
  onUpdateTaskSources,
  onConnectLinear,
  onConnectGitHub,
  onSetAgentRunStrategy,
  watchdogPlaybookStatus,
  onOpenWatchdogPlaybook,
}: PanelTabProps) {
  const skillCommands = skillsStatus?.commands ?? []
  const display = settings.display
  const notifications = settings.notifications ?? DEFAULT_NOTIFICATION_SETTINGS
  const editor = settings.editor ?? DEFAULT_EDITOR_PREFERENCES
  const primaryKey = AGENT_TITLE_TO_KEY[defaultAgent] || 'claude'
  const secondaryKey = AGENT_TITLE_TO_KEY[secondaryAgent] || 'codex'
  const primaryInventory = agentInventories[primaryKey]
  const secondaryInventory = agentInventories[secondaryKey]
  const previewPrefix = 'CX'
  const previewSessionChunk = 'a1b2c3d4'
  const previewAutoLabel = display.autoLabelInTabTitles ? 'Agent Terminals' : null
  const previewDisplay = {
    showFullAgentNames: display.showFullAgentNames,
    showLabelsInTitles: display.showLabelsInTitles,
    autoLabelInTabTitles: display.autoLabelInTabTitles,
    showSessionIdInTitles: display.showSessionIdInTitles,
    labelReplacesTitle: display.labelReplacesTitle,
    showLabelOnlyOnFocus: display.showLabelOnlyOnFocus,
  }
  const previewFocused = formatPreviewTerminalTitle(previewPrefix, previewDisplay, {
    label: previewAutoLabel,
    sessionChunk: previewSessionChunk,
    isFocused: true,
  })
  const previewUnfocused = formatPreviewTerminalTitle(previewPrefix, previewDisplay, {
    label: previewAutoLabel,
    sessionChunk: previewSessionChunk,
    isFocused: false,
  })
  const previewManual = formatPreviewTerminalTitle(previewPrefix, previewDisplay, {
    label: 'Agent Terminals',
    sessionChunk: previewSessionChunk,
    isFocused: true,
  })
  const previewIcon = getIcon(icons.codex, isLightTheme)

  const getSkillSummary = (agent: PromptPackAgentType) => {
    const supported = skillCommands.filter(skill => skill.agents[agent]?.supported)
    const installed = supported.filter(skill => skill.agents[agent]?.installed)
    return {
      total: supported.length,
      installed: installed.length,
    }
  }

  const getAgentStatus = (agent: SwarmAgentType) => {
    const agentStatus = swarmStatus.agents[agent]
    const count = (runningCounts as Record<string, number>)[agent] ?? 0
    if (!agentStatus?.cliAvailable) return { label: 'CLI Missing', level: 'failed' as const }
    if (count > 0) return { label: `${count} running`, level: 'running' as const }
    if (!agentStatus?.mcpEnabled || !agentStatus?.commandInstalled) return { label: 'Setup', level: 'pending' as const }
    return { label: 'Standby', level: 'idle' as const }
  }

  const updateBuiltIn = (
    key: keyof AgentSettings['builtIn'],
    field: 'login' | 'instances',
    value: boolean | number
  ) => {
    onSaveSettings({
      ...settings,
      builtIn: {
        ...settings.builtIn,
        [key]: { ...settings.builtIn[key], [field]: value },
      },
    })
  }

  const updateBuiltInModel = (key: keyof AgentSettings['builtIn'], value: string) => {
    onSaveSettings({
      ...settings,
      builtIn: {
        ...settings.builtIn,
        [key]: { ...settings.builtIn[key], defaultModel: value || undefined },
      },
    })
  }

  const updateDisplay = (field: keyof AgentSettings['display'], value: boolean) => {
    onSaveSettings({
      ...settings,
      display: { ...settings.display, [field]: value },
    })
  }

  const updateNotifications = (updates: Partial<NotificationSettings>) => {
    onSaveSettings({
      ...settings,
      notifications: { ...notifications, ...updates },
    })
  }

  const updateEditor = (enabled: boolean) => {
    onSaveSettings({
      ...settings,
      editor: { ...editor, markdownViewerEnabled: enabled },
    })
  }

  const toggleSwarmAgent = (agent: SwarmAgentType, enabled: boolean) => {
    const current = settings.swarmEnabledAgents || ALL_SWARM_AGENTS
    const next = enabled
      ? [...current, agent].filter((value, index, array) => array.indexOf(value) === index)
      : current.filter(value => value !== agent)
    onSaveSettings({
      ...settings,
      swarmEnabledAgents: next,
    })
  }

  const setGithubOwner = (value: string) => {
    onSaveSettings({
      ...settings,
      githubOwner: value.trim() || undefined,
    })
  }

  const dialOptions = builtInAgents
    .filter(agent => agent.key !== 'shell')
    .map(agent => ({
      key: agent.key,
      label: agent.name,
      caption: agent.key === primaryKey ? 'Primary route selected' : 'Ready for launch',
    }))

  const bankItems: StatusBankItem[] = [
    {
      key: 'agents-cli',
      label: 'Agents CLI',
      value: swarmStatus.agentsCliAvailable ? (swarmStatus.agentsCliVersion ?? 'online') : 'offline',
      level: statusLevel(Boolean(swarmStatus.agentsCliAvailable)),
      gauge: swarmStatus.agentsCliAvailable ? 100 : 10,
    },
  ]

  const agentRows = (['claude', 'codex', 'gemini', 'opencode'] as SwarmAgentType[]).map(agent => {
    const status = getAgentStatus(agent)
    const skillSummary = agent === 'opencode' ? { total: 0, installed: 0 } : getSkillSummary(agent)
    return {
      agent,
      icon: getIcon(icons[agent], isLightTheme),
      config: settings.builtIn[agent],
      modelOptions: agentModels[agent] || [],
      status,
      skillSummary,
    }
  })

  return (
    <div className="sw-panel-tab">
      <div className="sw-panel-grid sw-panel-grid-top">
        <div className="sw-panel-summary-stack">
          <StatusBank title="Control Bus" items={bankItems} />
          <section className="sw-panel-section">
            <div className="sw-panel-section-head">Readout Strip</div>
            <div className="sw-panel-readouts">
              <div className="sw-panel-readout-block">
                <span className="sw-section-label">Focused Title</span>
                <div className="sw-readout glow">{previewFocused}</div>
              </div>
              <div className="sw-panel-readout-block">
                <span className="sw-section-label">Background Title</span>
                <div className="sw-readout">{previewUnfocused}</div>
              </div>
              {!display.autoLabelInTabTitles && (
                <div className="sw-panel-readout-block">
                  <span className="sw-section-label">Manual Label</span>
                  <div className="sw-readout">{previewManual}</div>
                </div>
              )}
            </div>
            <div className="sw-panel-preview-row">
              <img src={previewIcon} alt="Codex" className="sw-panel-preview-icon" />
              <span className="sw-panel-preview-caption">Terminal title live preview</span>
            </div>
          </section>
        </div>

        <div className="sw-panel-dials">
          <AgentDial
            title="Primary Agent"
            value={primaryKey}
            options={dialOptions}
            onChange={(key) => onSetDefaultAgent(AGENT_KEY_TO_TITLE[key] || 'CC')}
            shortcut="Cmd+Shift+A"
            meta={{
              model: (agentModels[primaryKey] || [])[0] || 'auto',
              version: primaryInventory?.defaultVersion || undefined,
              account: primaryInventory?.defaultAccount || undefined,
              plan: primaryInventory?.defaultPlan || undefined,
              running: (runningCounts as Record<string, number>)[primaryKey] ?? 0,
              skillsInstalled: primaryKey !== 'opencode' ? getSkillSummary(primaryKey as any).installed : undefined,
              skillsTotal: primaryKey !== 'opencode' ? getSkillSummary(primaryKey as any).total : undefined,
            }}
            inventory={primaryInventory}
            onSetStrategy={(strategy) => onSetAgentRunStrategy(primaryKey, strategy)}
          />
          <AgentDial
            title="Secondary Agent"
            value={secondaryKey}
            options={dialOptions.map(option => ({
              ...option,
              disabled: option.key === primaryKey,
              caption: option.key === primaryKey ? 'Reserved by primary route' : 'Hot standby route',
            }))}
            onChange={(key) => {
              if (key !== primaryKey) onSetSecondaryAgent(AGENT_KEY_TO_TITLE[key] || 'CX')
            }}
            shortcut="Cmd+Shift+B"
            meta={{
              model: (agentModels[secondaryKey] || [])[0] || 'auto',
              version: secondaryInventory?.defaultVersion || undefined,
              account: secondaryInventory?.defaultAccount || undefined,
              plan: secondaryInventory?.defaultPlan || undefined,
              running: (runningCounts as Record<string, number>)[secondaryKey] ?? 0,
              skillsInstalled: secondaryKey !== 'opencode' ? getSkillSummary(secondaryKey as any).installed : undefined,
              skillsTotal: secondaryKey !== 'opencode' ? getSkillSummary(secondaryKey as any).total : undefined,
            }}
            inventory={secondaryInventory}
            onSetStrategy={(strategy) => onSetAgentRunStrategy(secondaryKey, strategy)}
          />
        </div>
      </div>

      <HarnessRoster
        agentInventories={agentInventories}
        runningCounts={runningCounts}
        icons={icons}
        isLightTheme={isLightTheme}
        onSetAgentRunStrategy={onSetAgentRunStrategy}
      />

      <AgentResources />

      <div className="sw-panel-grid sw-panel-grid-main">
        <section className="sw-panel-section">
          <div className="sw-panel-section-head">Agent Bus</div>
          <div className="sw-panel-agent-stack">
            {agentRows.map(({ agent, icon, config, modelOptions, status, skillSummary }) => (
              <div key={agent} className="sw-panel-agent-card">
                <div className="sw-panel-agent-head">
                  <div className="sw-panel-agent-ident">
                    <img src={icon} alt={agent} className="sw-panel-agent-icon" />
                    <div>
                      <div className="sw-panel-agent-title">{SWARM_AGENT_LABELS[agent]}</div>
                      <div className="sw-panel-agent-sub">{status.label}</div>
                    </div>
                  </div>
                  <div className="sw-panel-agent-actions">
                    <span className={`sw-badge ${status.level}`}>{status.label}</span>
                    {status.level !== 'running' && (
                      <button
                        type="button"
                        className="sw-btn secondary sm"
                        onClick={() => onInstallSwarmAgent(agent)}
                        disabled={swarmInstalling || !swarmStatus.agents[agent]?.cliAvailable}
                      >
                        {swarmInstalling ? <RefreshCw size={12} className="animate-spin" /> : 'Setup'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="sw-panel-agent-controls">
                  <label className="sw-panel-rocker">
                    <span>Autostart</span>
                    <button
                      type="button"
                      className="toggle-switch"
                      data-state={config.login ? 'on' : 'off'}
                      role="switch"
                      aria-checked={config.login}
                      onClick={() => updateBuiltIn(agent, 'login', !config.login)}
                    >
                      <span className="toggle-knob" />
                    </button>
                  </label>
                  <label className="sw-panel-rocker">
                    <span>Swarm Enabled</span>
                    <button
                      type="button"
                      className="toggle-switch"
                      data-state={(settings.swarmEnabledAgents || ALL_SWARM_AGENTS).includes(agent) ? 'on' : 'off'}
                      role="switch"
                      aria-checked={(settings.swarmEnabledAgents || ALL_SWARM_AGENTS).includes(agent)}
                      onClick={() =>
                        toggleSwarmAgent(agent, !(settings.swarmEnabledAgents || ALL_SWARM_AGENTS).includes(agent))
                      }
                    >
                      <span className="toggle-knob" />
                    </button>
                  </label>
                  <div className="sw-panel-fader">
                    <span>Instances</span>
                    <div className="sw-fader-track">
                      <input
                        type="range"
                        min={1}
                        max={8}
                        value={config.instances}
                        onChange={(e) => updateBuiltIn(agent, 'instances', Number(e.target.value))}
                        className="sw-fader-input"
                        orient="vertical"
                      />
                      <div className="sw-fader-labels">
                        {[8,6,4,2].map(n => (
                          <span key={n} className={`sw-fader-mark${config.instances >= n ? ' lit' : ''}`}>{n}</span>
                        ))}
                      </div>
                    </div>
                    <div className="sw-readout" style={{ textAlign: 'center', marginTop: 4 }}>{config.instances}</div>
                  </div>
                  <label className="sw-panel-select">
                    <span>Default Model</span>
                    <select
                      value={config.defaultModel || ''}
                      onChange={(event) => updateBuiltInModel(agent, event.target.value)}
                    >
                      <option value="">Auto</option>
                      {modelOptions.map(model => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="sw-panel-agent-foot">
                  <div className="sw-panel-gauge-meta">
                    <span className="sw-section-label">Skills</span>
                    <span className="sw-readout">
                      {skillSummary.total ? `${skillSummary.installed}/${skillSummary.total}` : 'N/A'}
                    </span>
                  </div>
                  <div className="sw-gauge">
                    <div
                      className={`sw-gauge-fill ${status.level === 'failed' ? 'danger' : status.level === 'pending' ? 'warn' : ''}`.trim()}
                      style={{ width: `${skillGauge(skillSummary.total, skillSummary.installed)}%` }}
                    />
                  </div>
                </div>
                {!swarmStatus.agents[agent]?.cliAvailable && AGENT_INSTALL_INFO[agent]?.command && (
                  <div className="sw-panel-inline-hint sw-readout">
                    {AGENT_INSTALL_INFO[agent]?.command}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <div className="sw-panel-column">
          <section className="sw-panel-section">
            <div className="sw-panel-section-head">Launch Matrix</div>
            <LaunchMatrix
              settings={settings}
              builtInAgents={builtInAgents}
              agentModels={agentModels}
              agentInventories={agentInventories}
              onSaveSettings={onSaveSettings}
            />
          </section>

          <section className="sw-panel-section">
            <div className="sw-panel-section-head">Display Bank</div>
            <div className="sw-panel-toggle-list">
              {[
                ['showFullAgentNames', 'Full Agent Names'],
                ['showLabelsInTitles', 'Labels In Titles'],
                ['autoLabelInTabTitles', 'Auto Labels'],
                ['labelReplacesTitle', 'Replace Base Title'],
                ['showSessionIdInTitles', 'Session ID'],
                ['showLabelOnlyOnFocus', 'Hide Labels Off Focus'],
              ].map(([field, label]) => (
                <label key={field} className="sw-panel-rocker">
                  <span>{label}</span>
                  <button
                    type="button"
                    className="toggle-switch"
                    data-state={display[field as keyof typeof display] ? 'on' : 'off'}
                    role="switch"
                    aria-checked={display[field as keyof typeof display]}
                    onClick={() =>
                      updateDisplay(
                        field as keyof AgentSettings['display'],
                        !display[field as keyof typeof display]
                      )
                    }
                  >
                    <span className="toggle-knob" />
                  </button>
                </label>
              ))}
              <label className="sw-panel-rocker">
                <span>Markdown Viewer</span>
                <button
                  type="button"
                  className="toggle-switch"
                  data-state={editor.markdownViewerEnabled ? 'on' : 'off'}
                  role="switch"
                  aria-checked={editor.markdownViewerEnabled}
                  onClick={() => updateEditor(!editor.markdownViewerEnabled)}
                >
                  <span className="toggle-knob" />
                </button>
              </label>
              <label className="sw-panel-rocker">
                <span>Approval Alerts</span>
                <button
                  type="button"
                  className="toggle-switch"
                  data-state={notifications.enabled ? 'on' : 'off'}
                  role="switch"
                  aria-checked={notifications.enabled}
                  onClick={() => updateNotifications({ enabled: !notifications.enabled })}
                >
                  <span className="toggle-knob" />
                </button>
              </label>
            </div>
            <label className="sw-panel-select">
              <span>Alert Style</span>
              <select
                value={notifications.style}
                onChange={(event) =>
                  updateNotifications({ style: event.target.value as NotificationSettings['style'] })
                }
              >
                <option value="native">Native OS</option>
                <option value="vscode">VS Code</option>
              </select>
            </label>
          </section>
        </div>
      </div>

      <div className="sw-panel-grid sw-panel-grid-bottom">
        <section className="sw-panel-section sw-panel-section-factory">
          <FactorySection />
        </section>

        <section className="sw-panel-section">
          <div className="sw-panel-section-head">Watchdog</div>
          <div className="sw-panel-command-pack">
            <WatchdogPlaybookCard
              status={watchdogPlaybookStatus}
              onOpen={onOpenWatchdogPlaybook}
            />
          </div>
        </section>

        <section className="sw-panel-section">
          <div className="sw-panel-section-head">Cloud Dispatch</div>
          <div className="sw-panel-command-pack">
            <div className="sw-panel-command-card">
              <div className="sw-panel-command-line">
                <Waypoints size={14} />
                <span>GitHub owner (for <code>repo:&lt;name&gt;</code> label resolution)</span>
              </div>
              <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
                Linear tasks tagged <code>repo:agents</code> dispatch to <code>&lt;owner&gt;/agents</code>.
              </div>
              <Input
                placeholder="muqsitnawaz"
                defaultValue={settings.githubOwner ?? ''}
                onBlur={(e) => setGithubOwner(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setGithubOwner(e.currentTarget.value)
                    e.currentTarget.blur()
                  }
                }}
              />
            </div>
          </div>
        </section>

        <SourcesSection
          settings={settings}
          availableSources={availableSources}
          onUpdateTaskSources={onUpdateTaskSources}
          onConnectLinear={onConnectLinear}
          onConnectGitHub={onConnectGitHub}
        />

        <section className="sw-panel-section">
          <div className="sw-panel-section-head">Integrations</div>
          <div className="sw-panel-command-pack">
            <LinearApiKeyCard
              connected={linearConnected}
              onSaved={onLinearKeySaved}
            />
          </div>
        </section>

        <ProjectRulesSection settings={settings} onSaveSettings={onSaveSettings} />

      </div>
    </div>
  )
}

function formatPlaybookMtime(mtimeMs: number): string {
  if (!mtimeMs) return ''
  const ageSec = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000))
  if (ageSec < 60) return 'edited just now'
  if (ageSec < 3600) return `edited ${Math.round(ageSec / 60)} min ago`
  if (ageSec < 86400) return `edited ${Math.round(ageSec / 3600)} hr ago`
  return `edited ${Math.round(ageSec / 86400)} days ago`
}

function WatchdogPlaybookCard({
  status,
  onOpen,
}: {
  status: WatchdogPlaybookStatus | null
  onOpen: () => void
}) {
  const exists = !!status?.exists
  const lines = status?.lines ?? 0
  const mtimeLabel = exists ? formatPlaybookMtime(status?.mtimeMs ?? 0) : 'not created yet'
  const linesLabel = exists ? `${lines} ${lines === 1 ? 'line' : 'lines'}` : 'empty'
  return (
    <div className="sw-panel-command-card">
      <div className="sw-panel-command-line">
        <ShieldAlert size={14} />
        <span>Playbook for the auto-unblock watchdog</span>
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
        House rules appended to the built-in Watchdog prompt every tick. Stored
        at <code>~/.agents/playbooks/watchdog.md</code>. Empty playbook leaves
        the built-in prompt untouched.
      </div>
      <div className="sw-panel-command-metrics">
        <div className="sw-readout glow">{linesLabel}</div>
        <div className="sw-readout">{mtimeLabel}</div>
      </div>
      <button type="button" className="sw-btn primary" onClick={onOpen}>
        <FileEdit size={12} />
        {exists ? 'Edit Playbook' : 'Create Playbook'}
      </button>
    </div>
  )
}

function LinearApiKeyCard({
  connected,
  onSaved,
}: {
  connected: boolean
  onSaved?: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  // When already connected (linear CLI has a key in ~/.linear-cli/config.json),
  // hide the input row behind a "replace key" disclosure so the card reads as
  // a status display instead of a nag-for-credentials. New users (not yet
  // connected) always see the input inline.
  const [expanded, setExpanded] = useState(false)
  const showInput = !connected || expanded

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const m = event.data
      if (m?.type !== 'integrationStatus' || m.provider !== 'linear') return
      if (m.connected) {
        setStatus('success')
        setApiKey('')
        setExpanded(false)
        onSaved?.()
      } else if (m.error) {
        setStatus('error')
        setErrorMessage(m.error)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onSaved])

  const handleSave = () => {
    if (!apiKey.trim()) return
    setStatus('saving')
    setErrorMessage('')
    postMessage({ type: 'saveLinearApiKey', key: apiKey.trim() })
  }

  return (
    <div className="sw-panel-command-card">
      <div className="sw-panel-command-line">
        <KeyRound size={14} />
        <span>Linear API key</span>
        {connected && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              fontWeight: 600,
              color: '#238636',
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            Connected
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        {connected ? (
          <>
            <span>
              Reading from <code>~/.linear-cli/config.json</code> via the Linear CLI.
            </span>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                marginLeft: 'auto',
                background: 'transparent',
                border: 'none',
                color: 'var(--ds-text-link, #58a6ff)',
                cursor: 'pointer',
                fontSize: 11,
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              {expanded ? 'cancel' : 'replace key'}
            </button>
          </>
        ) : (
          <span>
            Paste a personal API key from <code>linear.app/settings/api</code>. Stored locally in{' '}
            <code>~/.linear-cli/config.json</code>.
          </span>
        )}
      </div>
      {showInput && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Input
            type="password"
            placeholder={connected ? 'Replace key (lin_api_...)' : 'lin_api_...'}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.currentTarget.value)
              if (status !== 'idle') setStatus('idle')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
            }}
            style={{ flex: 1 }}
            autoFocus={connected && expanded}
          />
          <button
            className="sw-btn secondary sm"
            onClick={handleSave}
            disabled={!apiKey.trim() || status === 'saving'}
          >
            {status === 'saving' ? 'Saving…' : connected ? 'Replace' : 'Save'}
          </button>
        </div>
      )}
      {status === 'success' && (
        <div style={{ fontSize: 11, color: '#238636', marginTop: 6 }}>Saved.</div>
      )}
      {status === 'error' && (
        <div style={{ fontSize: 11, color: '#cf222e', marginTop: 6 }}>
          {errorMessage || 'Failed to save. Try again.'}
        </div>
      )}
    </div>
  )
}
