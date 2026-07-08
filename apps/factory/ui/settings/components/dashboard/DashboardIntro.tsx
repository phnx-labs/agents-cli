import React from 'react'
import { IconConfig } from '../../types'
import { Button } from '../ui/button'

interface DashboardIntroProps {
  showIntegrationCallout: boolean
  icons: IconConfig
  onNavigateToSettings: () => void
}

export function DashboardIntro({ showIntegrationCallout, icons, onNavigateToSettings }: DashboardIntroProps) {
  return (
    <>
      {showIntegrationCallout && (
        <section className="px-4 py-3 rounded-xl bg-[var(--muted)] border border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--background)]">
              <img src={icons.agents} alt="Agents" className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">Every swarm starts with `/swarm` in your IDE</p>
              <p className="text-xs text-[var(--muted-foreground)]">
                Describe your Mix of Agents with `/swarm`, install a CLI agent, and enable Swarm to see tasks here.
              </p>
            </div>
            <Button size="sm" onClick={onNavigateToSettings}>
              Configure
            </Button>
          </div>
        </section>
      )}

    </>
  )
}
