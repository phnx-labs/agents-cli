import React from 'react'
import { postMessage } from '../../hooks'
import { getIcon } from '../../utils'
import type { AgentInventory, AgentInventoryVersion, AgentRunStrategy, IconConfig, RunningCounts } from '../../types'

const ROSTER_ORDER = ['claude', 'codex', 'gemini', 'antigravity', 'grok', 'kimi', 'droid', 'cursor', 'opencode']
const DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity',
  grok: 'Grok', kimi: 'Kimi', droid: 'Droid', cursor: 'Cursor', opencode: 'OpenCode',
}
const STRATEGIES: AgentRunStrategy[] = ['pinned', 'available', 'balanced']

function defaultVersion(inv: AgentInventory): AgentInventoryVersion | null {
  return inv.versions.find(v => v.isDefault) ?? inv.versions.find(v => v.signedIn) ?? inv.versions[0] ?? null
}

function usageState(v: AgentInventoryVersion | null): { label: string; tone: 'ok' | 'warn' | 'hot' | 'idle' } {
  if (!v || !v.signedIn) return { label: 'signed out', tone: 'idle' }
  if (v.usageStatus === 'out_of_credits') return { label: 'out of credits', tone: 'hot' }
  if (v.usageStatus === 'rate_limited') return { label: 'rate limited', tone: 'hot' }
  return { label: 'available', tone: v.sessionUsedPercent >= 80 ? 'warn' : 'ok' }
}

interface HarnessRosterProps {
  agentInventories: Record<string, AgentInventory>
  runningCounts: RunningCounts
  icons: IconConfig
  isLightTheme: boolean
  onSetAgentRunStrategy: (agentKey: string, strategy: AgentRunStrategy) => void
}

export function HarnessRoster({ agentInventories, runningCounts, icons, isLightTheme, onSetAgentRunStrategy }: HarnessRosterProps) {
  const keys = ROSTER_ORDER.filter(k => agentInventories[k])
  const extra = Object.keys(agentInventories).filter(k => !ROSTER_ORDER.includes(k))
  const allKeys = [...keys, ...extra]

  return (
    <section className="sw-panel-section">
      <div className="sw-panel-section-head">
        Harness Roster
        <button
          type="button"
          className="sw-roster-refresh"
          title="Re-scan installed agents"
          onClick={() => postMessage({ type: 'refreshAgentInventories', force: true })}
        >
          Refresh
        </button>
      </div>

      {allKeys.length === 0 ? (
        <div className="sw-roster-empty">
          No agents detected. Install a CLI with <span className="mono">agents add &lt;agent&gt;</span>, then Refresh.
        </div>
      ) : (
        <div className="sw-roster-grid">
          {allKeys.map(key => {
            const inv = agentInventories[key]
            const dv = defaultVersion(inv)
            const usage = usageState(dv)
            const running = (runningCounts as Record<string, number>)[key] ?? 0
            const pct = dv?.sessionUsedPercent ?? 0
            const iconSrc = getIcon(icons[key], isLightTheme)
            const name = DISPLAY_NAMES[key] || (key.charAt(0).toUpperCase() + key.slice(1))
            return (
              <div key={key} className={`sw-roster-card ${inv.signedInCount === 0 ? 'dim' : ''}`}>
                <div className="sw-roster-card-top">
                  {iconSrc ? <img src={iconSrc} alt="" className="sw-roster-logo" /> : <span className="sw-roster-logo placeholder">{key.slice(0, 2).toUpperCase()}</span>}
                  <div className="sw-roster-id">
                    <span className="sw-roster-name">{name}</span>
                    <span className="sw-roster-ver mono">{dv?.version ? `v${dv.version}` : 'not installed'}</span>
                  </div>
                  {running > 0 && <span className="sw-roster-running" title={`${running} running`}>{running}</span>}
                  <span className={`sw-roster-usage-led ${usage.tone}`} title={usage.label} />
                </div>

                <div className="sw-roster-rows">
                  <div className="sw-roster-row">
                    <span className="sw-roster-k">Account</span>
                    <span className="sw-roster-v">{inv.defaultAccount || dv?.email || '—'}</span>
                  </div>
                  <div className="sw-roster-row">
                    <span className="sw-roster-k">Plan</span>
                    <span className="sw-roster-v">{inv.defaultPlan || dv?.plan || '—'}</span>
                  </div>
                  <div className="sw-roster-row">
                    <span className="sw-roster-k">Usage</span>
                    <span className="sw-roster-v sw-roster-usage">
                      <span className={`sw-roster-gauge ${usage.tone}`}><i style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></span>
                      <span className="sw-roster-pct mono">{dv?.signedIn ? `${Math.round(pct)}%` : usage.label}</span>
                    </span>
                  </div>
                </div>

                <div className="sw-roster-foot">
                  <span className="sw-roster-chip mono">{inv.versions.length} ver</span>
                  <span className="sw-roster-chip mono">{inv.signedInCount} acct{inv.signedInCount === 1 ? '' : 's'}</span>
                  <span className="sw-roster-foot-spacer" />
                  <div className="sw-roster-strategy" role="tablist" aria-label={`${name} run strategy`}>
                    {STRATEGIES.map(s => (
                      <button
                        key={s}
                        type="button"
                        role="tab"
                        aria-selected={inv.strategy === s}
                        className={`sw-roster-strat-btn ${inv.strategy === s ? 'active' : ''}`}
                        disabled={s === 'balanced' && !inv.canRotate}
                        title={s === 'balanced' && !inv.canRotate ? 'Needs 2+ healthy versions' : `Run strategy: ${s}`}
                        onClick={() => onSetAgentRunStrategy(key, s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
