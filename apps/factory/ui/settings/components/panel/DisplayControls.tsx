import React from 'react'
import { Rocker } from './PanelTab'
import {
  AgentSettings,
} from '../../types'

interface DisplayControlsProps {
  settings: AgentSettings
  onSaveSettings: (settings: AgentSettings) => void
}

export function DisplayControls({
  settings,
  onSaveSettings,
}: DisplayControlsProps) {
  const display = settings.display
  const showFullAgentNames = display?.showFullAgentNames ?? true
  const showSessionIdInTitles = display?.showSessionIdInTitles ?? true
  const showLabelsInTitles = display?.showLabelsInTitles ?? true
  const labelReplacesTitle = display?.labelReplacesTitle ?? false
  const autoLabelInTabTitles = display?.autoLabelInTabTitles ?? true

  const updateDisplay = (field: keyof AgentSettings['display'], value: boolean) => {
    onSaveSettings({
      ...settings,
      display: { ...settings.display, [field]: value },
    })
  }

  return (
    <div className="sw-panel-section">
      <div className="sw-panel-section-head">Display Controls</div>

      <div className="sw-rocker-grid">
        <div className="sw-rocker-row">
          <span className="sw-rocker-label">Full agent names</span>
          <Rocker on={showFullAgentNames} onChange={(v) => updateDisplay('showFullAgentNames', v)} />
        </div>

        <div className="sw-rocker-row">
          <span className="sw-rocker-label">Session IDs in titles</span>
          <Rocker on={showSessionIdInTitles} onChange={(v) => updateDisplay('showSessionIdInTitles', v)} />
        </div>

        <div className="sw-rocker-row">
          <span className="sw-rocker-label">Show labels</span>
          <Rocker on={showLabelsInTitles} onChange={(v) => updateDisplay('showLabelsInTitles', v)} />
        </div>

        <div className="sw-rocker-row">
          <span className="sw-rocker-label">Labels replace title</span>
          <Rocker
            on={labelReplacesTitle}
            onChange={(v) => updateDisplay('labelReplacesTitle', v)}
          />
        </div>

        <div className="sw-rocker-row">
          <span className="sw-rocker-label">Auto-label from first message</span>
          <Rocker
            on={autoLabelInTabTitles}
            onChange={(v) => updateDisplay('autoLabelInTabTitles', v)}
          />
        </div>
      </div>
    </div>
  )
}
