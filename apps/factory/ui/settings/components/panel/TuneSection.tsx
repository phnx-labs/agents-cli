import React from 'react'
import { Rocker } from './PanelTab'
import { AgentAvatar } from '../mission-control/AgentAvatar'
import {
  AgentSettings,
  NotificationSettings,
  PrewarmPool,
} from '../../types'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_EDITOR_PREFERENCES,
  NOTIFICATION_AGENTS,
} from '../../constants'

interface EditorSectionProps {
  settings: AgentSettings
  onSaveSettings: (settings: AgentSettings) => void
}

export function EditorSection({ settings, onSaveSettings }: EditorSectionProps) {
  const markdownViewerEnabled = settings.editor?.markdownViewerEnabled ?? DEFAULT_EDITOR_PREFERENCES.markdownViewerEnabled

  const updateEditor = (updates: Partial<AgentSettings['editor']>) => {
    const current = settings.editor ?? DEFAULT_EDITOR_PREFERENCES
    onSaveSettings({ ...settings, editor: { ...current, ...updates } })
  }

  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">Editor</div>
      <div className="sw-rocker-row">
        <span className="sw-rocker-label">Markdown viewer</span>
        <Rocker on={markdownViewerEnabled} onChange={(v) => updateEditor({ markdownViewerEnabled: v })} />
      </div>
    </div>
  )
}

interface NotificationsSectionProps {
  settings: AgentSettings
  onSaveSettings: (settings: AgentSettings) => void
}

export function NotificationsSection({ settings, onSaveSettings }: NotificationsSectionProps) {
  const notifSettings = settings.notifications ?? DEFAULT_NOTIFICATION_SETTINGS
  const enabledAgents = notifSettings.enabledAgents || ['claude']

  const updateNotifications = (updates: Partial<NotificationSettings>) => {
    onSaveSettings({ ...settings, notifications: { ...notifSettings, ...updates } })
  }

  const toggleAgent = (agentKey: string) => {
    const isEnabled = enabledAgents.includes(agentKey)
    const newEnabled = isEnabled
      ? enabledAgents.filter(a => a !== agentKey)
      : [...enabledAgents, agentKey]
    updateNotifications({ enabledAgents: newEnabled })
  }

  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">Notifications</div>
      <div className="sw-rocker-row">
        <span className="sw-rocker-label">Notify when agent needs approval</span>
        <Rocker on={notifSettings.enabled} onChange={(v) => updateNotifications({ enabled: v })} />
      </div>

      {notifSettings.enabled && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {NOTIFICATION_AGENTS.map(agent => {
            const isActive = enabledAgents.includes(agent.key)
            return (
              <button
                key={agent.key}
                className={`sw-notif-chip ${isActive ? 'active' : ''}`}
                onClick={() => toggleAgent(agent.key)}
              >
                <AgentAvatar id={agent.key} size={14} />
                {agent.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface SourcesSectionProps {
  settings: AgentSettings
  availableSources: { linear: boolean; github: boolean }
  onUpdateTaskSources: (sources: Partial<AgentSettings['taskSources']>) => void
  onConnectLinear: () => void
  onConnectGitHub: () => void
}

export function SourcesSection({
  settings,
  availableSources,
  onUpdateTaskSources,
  onConnectLinear,
  onConnectGitHub,
}: SourcesSectionProps) {
  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">Sources</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
        <span className="sw-badge open" style={{ minWidth: 26, justifyContent: 'center' }}>LN</span>
        <span style={{ flex: 1, fontSize: '12px' }}>Linear</span>
        {availableSources.linear ? (
          <Rocker
            on={settings.taskSources?.linear ?? false}
            onChange={(v) => onUpdateTaskSources({ linear: v })}
          />
        ) : (
          <button className="sw-btn secondary sm" onClick={onConnectLinear}>
            Connect
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
        <span className="sw-badge" style={{ minWidth: 26, justifyContent: 'center', background: 'rgba(35,134,54,0.1)', color: '#238636' }}>GH</span>
        <span style={{ flex: 1, fontSize: '12px' }}>GitHub</span>
        {availableSources.github ? (
          <Rocker
            on={settings.taskSources?.github ?? false}
            onChange={(v) => onUpdateTaskSources({ github: v })}
          />
        ) : (
          <button className="sw-btn secondary sm" onClick={onConnectGitHub}>
            Connect
          </button>
        )}
      </div>

      {availableSources.github && settings.taskSources?.github && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 6px 34px' }}>
          <span style={{ flex: 1, fontSize: '11px', opacity: 0.75 }}>Only show issues assigned to me</span>
          <Rocker
            on={settings.taskSources?.githubAssignedOnly ?? false}
            onChange={(v) => onUpdateTaskSources({ githubAssignedOnly: v })}
          />
        </div>
      )}
    </div>
  )
}

interface PrewarmingSectionProps {
  prewarmEnabled: boolean
  prewarmLoaded: boolean
  prewarmPools: PrewarmPool[]
  onTogglePrewarm: () => void
}

export function PrewarmingSection({
  prewarmEnabled,
  prewarmLoaded,
  prewarmPools,
  onTogglePrewarm,
}: PrewarmingSectionProps) {
  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">Prewarming</div>
      <div className="sw-rocker-row">
        <span className="sw-rocker-label">Pre-warm sessions</span>
        <Rocker on={prewarmEnabled} onChange={onTogglePrewarm} />
      </div>

      {prewarmEnabled && prewarmLoaded && prewarmPools.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {prewarmPools.map(pool => {
            const total = pool.available + pool.pending
            const pct = total > 0 ? (pool.available / Math.max(total, 3)) * 100 : 0
            return (
              <div key={pool.agentType} className="sw-prewarm-gauge">
                <AgentAvatar id={pool.agentType} size={16} />
                <span style={{ fontSize: '11px', width: 60, textTransform: 'capitalize' }}>{pool.agentType}</span>
                <div className="sw-prewarm-gauge-bar">
                  <div className="sw-gauge">
                    <div
                      className={`sw-gauge-fill ${pct < 33 ? 'danger' : pct < 66 ? 'warn' : ''}`}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                </div>
                <span style={{ fontSize: '10px', color: 'var(--ds-text-dim)', fontFamily: '"Geist Mono", monospace' }}>
                  {pool.available}/{total}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
