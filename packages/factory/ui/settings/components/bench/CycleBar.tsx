import React, { useState, useEffect } from 'react'
import type { CycleInfo } from '../../types'

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0h'
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  if (days > 0) return `${days}d ${hours}h`
  const mins = Math.floor((ms % 3_600_000) / 60_000)
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

interface CycleBarProps {
  cycleInfo: CycleInfo
}

export function CycleBar({ cycleInfo }: CycleBarProps) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const start = new Date(cycleInfo.startsAt).getTime()
  const end = new Date(cycleInfo.endsAt).getTime()
  const total = end - start
  if (total <= 0) return null

  const remaining = Math.max(0, end - now)
  const elapsed = Math.min(total, now - start)
  const pctElapsed = Math.round((elapsed / total) * 100)
  const pctRemaining = 100 - pctElapsed

  const level = pctRemaining > 50 ? '' : pctRemaining > 25 ? 'warn' : 'danger'

  return (
    <div className="sw-cycle-bar">
      <div className="sw-cycle-bar-head">
        <span className="sw-cycle-bar-name">{cycleInfo.name}</span>
        <span className="sw-cycle-bar-remaining">
          {remaining > 0 ? `${formatRemaining(remaining)} remaining` : 'Cycle ended'}
        </span>
      </div>
      <div className="sw-cycle-bar-gauge">
        <div className={`sw-gauge`}>
          <div
            className={`sw-gauge-fill ${level}`}
            style={{ width: `${pctElapsed}%` }}
          />
        </div>
        <span className="sw-cycle-bar-pct">{pctElapsed}%</span>
      </div>
    </div>
  )
}
