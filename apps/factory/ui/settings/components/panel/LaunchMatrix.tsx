import React, { useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { AgentAvatar } from '../mission-control/AgentAvatar'
import {
  AgentInventory,
  AgentSettings,
  BuiltInAgentConfig,
  QuickLaunchSlot,
  QUICK_LAUNCH_SLOT_KEYS,
  QuickLaunchSlotKey,
  getQuickLaunchSlot,
  setQuickLaunchSlotInConfig,
} from '../../types'

interface LaunchMatrixProps {
  settings: AgentSettings
  builtInAgents: BuiltInAgentConfig[]
  agentModels: Record<string, string[]>
  agentInventories: Record<string, AgentInventory>
  onSaveSettings: (settings: AgentSettings) => void
}

const MAC_KBD = (digit: string) => `⌘⇧${digit}` // ⌘⇧<digit>

// Aliases agents-cli accepts on the --model flag. We always offer the concrete
// model list from the catalog plus these three so the user can pin to a tier
// without picking a specific version.
const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku']

export function LaunchMatrix({
  settings,
  builtInAgents,
  agentModels,
  agentInventories,
  onSaveSettings,
}: LaunchMatrixProps) {
  const [expanded, setExpanded] = useState<QuickLaunchSlotKey | null>(null)

  const assignable = builtInAgents.filter(a => a.key !== 'shell')

  const writeSlot = (key: QuickLaunchSlotKey, slot: QuickLaunchSlot | undefined) => {
    onSaveSettings({
      ...settings,
      quickLaunch: setQuickLaunchSlotInConfig(settings.quickLaunch, key, slot),
    })
  }

  const patchSlot = (key: QuickLaunchSlotKey, patch: Partial<QuickLaunchSlot>) => {
    const current = getQuickLaunchSlot(settings.quickLaunch, key)
    if (!current) return
    writeSlot(key, { ...current, ...patch })
  }

  return (
    <div className="sw-panel-launch-matrix">
      {QUICK_LAUNCH_SLOT_KEYS.map(digit => {
        const slot = getQuickLaunchSlot(settings.quickLaunch, digit)
        const agentInfo = slot ? builtInAgents.find(a => a.key === slot.agent) : null
        const isOpen = expanded === digit
        const inventory = slot ? agentInventories[slot.agent] : undefined
        const versions = inventory?.versions || []
        const modelOptions = slot?.agent ? (agentModels[slot.agent] || []) : []
        const aliasOptions = slot?.agent === 'claude' ? CLAUDE_ALIASES : []
        const modelLabel = slot?.model || (slot?.modelAlias ? `${slot.modelAlias} (alias)` : '')

        return (
          <div
            key={digit}
            className={`sw-launch-slot ${slot ? 'armed' : 'empty'} ${isOpen ? 'open' : ''}`}
          >
            <div className="sw-launch-slot-row">
              <span className={`sw-dot ${slot ? 'running' : 'idle'}`} style={{ width: 6, height: 6 }} />
              <span className="kbd sw-launch-kbd">{MAC_KBD(digit)}</span>

              {slot && agentInfo ? (
                <>
                  <div className="sw-launch-agent">
                    <AgentAvatar id={slot.agent} size={18} />
                    <div>
                      <div className="sw-launch-agent-name">{slot.label || agentInfo.name}</div>
                      <div className="sw-launch-agent-sub">
                        {[
                          slot.version || (inventory?.defaultVersion ? `v${inventory.defaultVersion}` : null),
                          slot.mode ? slot.mode : null,
                          modelLabel || null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'auto'}
                      </div>
                    </div>
                  </div>
                  {slot.extraFlags ? (
                    <span className="sw-launch-flags-badge" title={slot.extraFlags}>
                      {slot.extraFlags.length > 24 ? slot.extraFlags.slice(0, 24) + '…' : slot.extraFlags}
                    </span>
                  ) : <span />}
                  <button
                    type="button"
                    className="sw-icon-btn"
                    onClick={() => setExpanded(isOpen ? null : digit)}
                    aria-label={isOpen ? 'Collapse' : 'Edit slot'}
                  >
                    {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </>
              ) : (
                <>
                  <select
                    value=""
                    onChange={(e) => {
                      const next = e.target.value
                      if (!next) return
                      writeSlot(digit, { agent: next })
                      setExpanded(digit)
                    }}
                    className="sw-launch-assign"
                  >
                    <option value="">Assign agent…</option>
                    {assignable.map(a => (
                      <option key={a.key} value={a.key}>{a.name}</option>
                    ))}
                  </select>
                  <span style={{ flex: 1 }} />
                  <span style={{ width: 26 }} />
                </>
              )}
            </div>

            {isOpen && slot && (
              <div className="sw-launch-editor">
                <label className="sw-panel-select">
                  <span>Agent</span>
                  <select
                    value={slot.agent}
                    onChange={(e) => writeSlot(digit, { agent: e.target.value })}
                  >
                    {assignable.map(a => (
                      <option key={a.key} value={a.key}>{a.name}</option>
                    ))}
                  </select>
                </label>

                <label className="sw-panel-select">
                  <span>Version</span>
                  <select
                    value={slot.version || ''}
                    onChange={(e) => patchSlot(digit, { version: e.target.value || undefined })}
                    disabled={versions.length === 0}
                  >
                    <option value="">
                      {inventory?.defaultVersion ? `Default (v${inventory.defaultVersion})` : 'Default'}
                    </option>
                    {versions.map(v => (
                      <option key={v.version} value={v.version}>
                        v{v.version}{v.isDefault ? ' • default' : ''}{v.signedIn ? '' : ' (signed-out)'}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="sw-panel-select">
                  <span>Mode</span>
                  <select
                    value={slot.mode || ''}
                    onChange={(e) => patchSlot(digit, { mode: (e.target.value || undefined) as 'plan' | 'edit' | undefined })}
                  >
                    <option value="">Agent default</option>
                    <option value="plan">plan (read-only)</option>
                    <option value="edit">edit</option>
                  </select>
                </label>

                <label className="sw-panel-select">
                  <span>Model</span>
                  <select
                    value={slot.modelAlias ? `alias:${slot.modelAlias}` : (slot.model || '')}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v.startsWith('alias:')) {
                        patchSlot(digit, { modelAlias: v.slice(6), model: undefined })
                      } else {
                        patchSlot(digit, { model: v || undefined, modelAlias: undefined })
                      }
                    }}
                  >
                    <option value="">Auto</option>
                    {aliasOptions.length > 0 && (
                      <optgroup label="Aliases">
                        {aliasOptions.map(a => (
                          <option key={a} value={`alias:${a}`}>{a}</option>
                        ))}
                      </optgroup>
                    )}
                    {modelOptions.length > 0 && (
                      <optgroup label="Models">
                        {modelOptions.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </label>

                <label className="sw-panel-select" style={{ gridColumn: 'span 2' }}>
                  <span>Extra flags</span>
                  <input
                    type="text"
                    value={slot.extraFlags || ''}
                    placeholder="--reasoning high --resume"
                    onChange={(e) => patchSlot(digit, { extraFlags: e.target.value || undefined })}
                    spellCheck={false}
                  />
                </label>

                <label className="sw-panel-select" style={{ gridColumn: 'span 2' }}>
                  <span>Label</span>
                  <input
                    type="text"
                    value={slot.label || ''}
                    placeholder={`Slot ${digit}`}
                    onChange={(e) => patchSlot(digit, { label: e.target.value || undefined })}
                  />
                </label>

                <div className="sw-launch-editor-foot" style={{ gridColumn: 'span 2' }}>
                  <button
                    type="button"
                    className="sw-btn danger sm"
                    onClick={() => { writeSlot(digit, undefined); setExpanded(null) }}
                  >
                    <X size={12} /> Remove slot
                  </button>
                  <button
                    type="button"
                    className="sw-btn secondary sm"
                    onClick={() => setExpanded(null)}
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      <div className="sw-launch-matrix-hint">
        Press the shortcut anywhere in the IDE to summon a configured agent.
      </div>
    </div>
  )
}
