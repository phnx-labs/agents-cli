import React from 'react'
import { Icon } from './icons'

interface StatusBarProps {
  activeSwarmCount: number
  runningAgentCount: number
  branch?: string | null
  scopeLabel?: string
}

export function StatusBar({ activeSwarmCount, runningAgentCount, branch, scopeLabel }: StatusBarProps) {
  return (
    <footer className="sw-statusbar">
      <div className="sw-statusbar-item">
        <span className="sw-dot running pulse" style={{ color: 'var(--status-running)' }} />
        <span>
          {runningAgentCount} agent{runningAgentCount === 1 ? '' : 's'} running
        </span>
      </div>
      {branch && (
        <>
          <span className="sep">·</span>
          <div className="sw-statusbar-item">
            <Icon name="gitBranch" size={11} />
            <span>{branch}</span>
          </div>
        </>
      )}
      {scopeLabel && (
        <>
          <span className="sep">·</span>
          <div className="sw-statusbar-item">
            <Icon name="folder" size={11} />
            <span>{scopeLabel}</span>
          </div>
        </>
      )}
    </footer>
  )
}
