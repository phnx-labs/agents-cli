import React from 'react'
import { BuiltInAgentConfig, IconConfig, RunningCounts } from '../../types'
import { postMessage } from '../../hooks'
import { getIcon, getAgentDisplayName } from '../../utils'
import { SectionHeader } from '../common'

interface RunningAgentsSectionProps {
  builtInAgents: BuiltInAgentConfig[]
  runningCounts: RunningCounts
  selectedAgentType: string | null
  currentMix: string | null
  icons: IconConfig
  isLightTheme: boolean
  onAgentClick: (agentKey: string) => void
}

export function RunningAgentsSection({
  builtInAgents,
  runningCounts,
  selectedAgentType,
  currentMix,
  icons,
  isLightTheme,
  onAgentClick,
}: RunningAgentsSectionProps) {
  return (
    <section>
      <SectionHeader>Running Now</SectionHeader>
      <div className="flex flex-wrap gap-3">
        {builtInAgents.map(agent => {
          const count = runningCounts[agent.key as keyof typeof runningCounts] as number
          const isSelected = selectedAgentType === agent.key
          const inMix = currentMix ? currentMix.toLowerCase().includes(agent.name.toLowerCase()) : false
          return (
            <div
              key={agent.key}
              onClick={() => count > 0 && onAgentClick(agent.key)}
              className={`group flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-colors ${
                isSelected
                  ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                  : 'bg-[var(--muted)]'
              } ${inMix ? 'border border-[var(--primary)]/50' : ''} ${count > 0 ? 'cursor-pointer hover:bg-[var(--muted-foreground)]/10' : ''}`}
              title={agent.name}
            >
              <img src={getIcon(agent.icon, isLightTheme)} alt={agent.name} className="w-5 h-5" />
              <span className="text-sm font-medium">{agent.name}</span>
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  postMessage({ type: 'spawnAgent', agentKey: agent.key })
                }}
                className={`w-6 text-center text-base font-semibold tabular-nums transition-colors ${isSelected ? '' : 'text-[var(--foreground)]'} hover:text-[var(--primary)]`}
              >
                <span className="group-hover:hidden">{count}</span>
                <span className="hidden group-hover:inline">+</span>
              </button>
            </div>
          )
        })}
        {Object.entries(runningCounts.custom).map(([name, count]) => {
          const isSelected = selectedAgentType === name
          return (
            <div
              key={name}
              onClick={() => count > 0 && onAgentClick(name)}
              className={`group flex items-center gap-2.5 px-4 py-2.5 rounded-xl transition-colors ${
                isSelected
                  ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                  : 'bg-[var(--muted)]'
              } ${count > 0 ? 'cursor-pointer hover:bg-[var(--muted-foreground)]/10' : ''}`}
              title={name}
            >
              <img src={icons.agents} alt={name} className="w-5 h-5" />
              <span className="text-sm font-medium">{name}</span>
              <button
                onClick={(event) => {
                  event.stopPropagation()
                  postMessage({ type: 'spawnAgent', agentKey: name, isCustom: true })
                }}
                className={`w-6 text-center text-base font-semibold tabular-nums transition-colors ${isSelected ? '' : 'text-[var(--foreground)]'} hover:text-[var(--primary)]`}
              >
                <span className="group-hover:hidden">{count}</span>
                <span className="hidden group-hover:inline">+</span>
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}
