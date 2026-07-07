import React from 'react'
import { AgentAvatar } from '../mission-control/AgentAvatar'
import {
  AgentSettings,
  BuiltInAgentConfig,
  QuickLaunchSlot,
} from '../../types'

interface PatchBayProps {
  settings: AgentSettings
  builtInAgents: BuiltInAgentConfig[]
  agentModels: Record<string, string[]>
  onSaveSettings: (settings: AgentSettings) => void
}

const SLOTS = [
  { key: 'slot1' as const, shortcut: 'Cmd+Shift+1' },
  { key: 'slot2' as const, shortcut: 'Cmd+Shift+2' },
  { key: 'slot3' as const, shortcut: 'Cmd+Shift+3' },
]

export function PatchBay({
  settings,
  builtInAgents,
  agentModels,
  onSaveSettings,
}: PatchBayProps) {
  const selectableAgents = builtInAgents.filter(a => a.key !== 'shell')

  const updateSlot = (slotKey: 'slot1' | 'slot2' | 'slot3', agent: string) => {
    const newSlot: QuickLaunchSlot | undefined = agent
      ? { agent, model: undefined, label: undefined }
      : undefined
    onSaveSettings({
      ...settings,
      quickLaunch: {
        ...settings.quickLaunch,
        [slotKey]: newSlot,
      },
    })
  }

  const updateSlotModel = (slotKey: 'slot1' | 'slot2' | 'slot3', model: string) => {
    const slot = settings.quickLaunch?.[slotKey]
    if (!slot) return
    onSaveSettings({
      ...settings,
      quickLaunch: {
        ...settings.quickLaunch,
        [slotKey]: { ...slot, model: model || undefined },
      },
    })
  }

  const removeSlot = (slotKey: 'slot1' | 'slot2' | 'slot3') => {
    onSaveSettings({
      ...settings,
      quickLaunch: {
        ...settings.quickLaunch,
        [slotKey]: undefined,
      },
    })
  }

  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">Patch Bay</div>

      {SLOTS.map(({ key, shortcut }) => {
        const slot = settings.quickLaunch?.[key]
        const agentInfo = slot ? builtInAgents.find(a => a.key === slot.agent) : null
        const modelOptions = slot?.agent ? (agentModels[slot.agent] || []) : []
        const isAssigned = !!slot?.agent

        return (
          <div
            key={key}
            className={`sw-patch-slot ${isAssigned ? '' : 'sw-patch-slot-empty'}`}
          >
            <span
              className={`sw-dot ${isAssigned ? 'running' : 'idle'}`}
              style={{ width: 6, height: 6 }}
            />

            <span className="kbd" style={{ minWidth: 100, textAlign: 'center' }}>
              {shortcut}
            </span>

            {isAssigned && agentInfo ? (
              <>
                <AgentAvatar id={slot!.agent} size={18} />
                <span style={{ fontSize: '12px', fontWeight: 600, flex: 1 }}>{agentInfo.name}</span>
                {modelOptions.length > 0 && (
                  <select
                    value={slot!.model || ''}
                    onChange={(e) => updateSlotModel(key, e.target.value)}
                    className="sw-alias-form-select"
                    style={{ width: 'auto', minWidth: 100 }}
                  >
                    <option value="">Default</option>
                    {modelOptions.map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                )}
                <button
                  className="sw-btn danger sm"
                  onClick={() => removeSlot(key)}
                >
                  Remove
                </button>
              </>
            ) : (
              <>
                <span style={{ flex: 1, fontSize: '12px', color: 'var(--ds-text-dim)' }}>
                  Patch an agent
                </span>
                <select
                  value=""
                  onChange={(e) => updateSlot(key, e.target.value)}
                  className="sw-alias-form-select"
                  style={{ width: 'auto', minWidth: 90 }}
                >
                  <option value="">Assign</option>
                  {selectableAgents.map(agent => (
                    <option key={agent.key} value={agent.key}>{agent.name}</option>
                  ))}
                </select>
              </>
            )}
          </div>
        )
      })}

      <div style={{ marginTop: 8, fontSize: '11px', color: 'var(--ds-text-dim)', fontStyle: 'italic' }}>
        Hold the shortcut to summon the patched agent anywhere in the IDE
      </div>
    </div>
  )
}
