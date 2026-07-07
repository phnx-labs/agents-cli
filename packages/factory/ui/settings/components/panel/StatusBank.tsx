import React from 'react'

export type StatusBankLevel = 'idle' | 'pending' | 'running' | 'failed'

export interface StatusBankItem {
  key: string
  label: string
  value: string
  level: StatusBankLevel
  gauge?: number
}

interface StatusBankProps {
  title: string
  items: StatusBankItem[]
}

function gaugeClass(level: StatusBankLevel) {
  if (level === 'failed') return 'danger'
  if (level === 'pending') return 'warn'
  return ''
}

export function StatusBank({ title, items }: StatusBankProps) {
  return (
    <section className="sw-panel-section">
      <div className="sw-panel-section-head">{title}</div>
      <div className="sw-status-bank">
        {items.map(item => (
          <div key={item.key} className="sw-status-bank-row">
            <div className="sw-status-bank-label">
              <span className={`sw-dot ${item.level}${item.level === 'running' ? ' pulse' : ''}`} />
              <span>{item.label}</span>
            </div>
            <div className="sw-status-bank-meta">
              <span className={`sw-badge ${item.level}`}>{item.value}</span>
              {typeof item.gauge === 'number' && (
                <div className="sw-gauge">
                  <div
                    className={`sw-gauge-fill ${gaugeClass(item.level)}`.trim()}
                    style={{ width: `${Math.max(8, Math.min(100, item.gauge))}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
