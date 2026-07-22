import React from 'react'
import { Icon } from './icons'
import { ThroughputCounter } from './UnifiedAgentsPane'

export type TabKey = 'floor' | 'bench' | 'panel'

interface TopBarProps {
  version?: string
  activeTab: TabKey
  onTabChange: (tab: TabKey) => void
  activeSwarmCount: number
  isLightTheme: boolean
  onToggleTheme?: () => void
  onOpenSettings?: () => void
  onOpenSearch?: () => void
  /**
   * The single live feed filter. When provided, the center becomes a real search
   * input that filters agents/branches/activity as you type; ⌘K still opens the
   * command palette (onOpenSearch). Omit both to keep the plain command-hint button.
   */
  search?: string
  onSearch?: (q: string) => void
  throughputTokensPerSec?: number
  watchdogEnabled?: boolean
  onToggleWatchdog?: () => void
}

export function TopBar({
  version,
  activeTab,
  onTabChange,
  activeSwarmCount,
  isLightTheme,
  onToggleTheme,
  onOpenSettings,
  onOpenSearch,
  search,
  onSearch,
  throughputTokensPerSec = 0,
  watchdogEnabled = false,
  onToggleWatchdog,
}: TopBarProps) {
  return (
    <header className="sw-topbar">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="zap" size={18} />
        </div>
        <span>Factory</span>
        {version && (
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--ds-text-dim)', marginLeft: 2 }}>
            v{version}
          </span>
        )}
      </div>
      <div className="divider-v" />
      <div className="sw-tabs">
        <button
          data-foreman-id="tab-floor"
          className={`sw-tab ${activeTab === 'floor' ? 'active' : ''}`}
          onClick={() => onTabChange('floor')}
        >
          Floor
          {activeSwarmCount > 0 && <span className="sw-tab-badge">{activeSwarmCount}</span>}
        </button>
        <button
          data-foreman-id="tab-bench"
          className={`sw-tab ${activeTab === 'bench' ? 'active' : ''}`}
          onClick={() => onTabChange('bench')}
        >
          Bench
        </button>
        <button
          data-foreman-id="tab-panel"
          className={`sw-tab ${activeTab === 'panel' ? 'active' : ''}`}
          onClick={() => onTabChange('panel')}
        >
          Panel
        </button>
      </div>
      <div className="sw-topbar-center">
        {onSearch ? (
          <div className="sw-cmd-hint sw-cmd-search">
            <Icon name="search" size={12} />
            <input
              className="sw-cmd-input"
              placeholder="Search agents, branches, activity…"
              value={search ?? ''}
              onChange={(e) => onSearch(e.target.value)}
            />
            <button
              type="button"
              className="sw-cmd-kbd"
              title="Open command palette"
              onClick={onOpenSearch}
            >
              ⌘K
            </button>
          </div>
        ) : (
          <button className="sw-cmd-hint" onClick={onOpenSearch}>
            <Icon name="search" size={12} />
            <span>Search or run command…</span>
            <div className="spacer" />
          </button>
        )}
      </div>
      <div className="sw-topbar-right">
        {throughputTokensPerSec > 0 && (
          <ThroughputCounter tokensPerSec={throughputTokensPerSec} />
        )}
        {onToggleWatchdog && (
          <button
            className="sw-icon-btn"
            onClick={onToggleWatchdog}
            title={watchdogEnabled ? 'Watchdog ON - click to disable' : 'Watchdog OFF - click to enable'}
            style={{ opacity: watchdogEnabled ? 1 : 0.45 }}
          >
            <Icon name="radar" size={14} />
          </button>
        )}
        <button className="sw-icon-btn" onClick={onToggleTheme} title="Toggle theme">
          <Icon name={isLightTheme ? 'moon' : 'sun'} size={14} />
        </button>
        <button className="sw-icon-btn" onClick={onOpenSettings} title="Settings">
          <Icon name="cog" size={14} />
        </button>
      </div>
    </header>
  )
}
