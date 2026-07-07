import React from 'react'
import type { TaskSummary, TerminalDetail, UnifiedTask, ProjectRule } from '../../types'
import { UnifiedAgentsPane, WatchdogEventUI } from './UnifiedAgentsPane'

interface MissionControlTabProps {
  tasks: TaskSummary[]
  tasksLoading: boolean
  terminals: TerminalDetail[]
  unifiedTasks: UnifiedTask[]
  unifiedTasksLoading: boolean
  onDispatch: () => void
  onNavigate?: (tab: 'floor' | 'bench' | 'panel') => void
  onOpenInBench?: (taskId: string) => void
  openDispatchTrigger?: number
  quickSpawnTrigger?: number
  openDetailTaskId?: string | null
  onDetailTaskConsumed?: () => void
  onThroughputChange?: (tokensPerSec: number) => void
  githubRepo?: string | null
  watchdogEnabled?: boolean
  watchdogEvents?: WatchdogEventUI[]
  projectRules?: ProjectRule[]
}

export function MissionControlTab({ tasks, tasksLoading, terminals, unifiedTasks, unifiedTasksLoading, onDispatch, onNavigate, onOpenInBench, openDispatchTrigger, quickSpawnTrigger, openDetailTaskId, onDetailTaskConsumed, onThroughputChange, githubRepo, watchdogEnabled, watchdogEvents, projectRules }: MissionControlTabProps) {
  return (
    <UnifiedAgentsPane
      terminals={terminals}
      tasks={tasks}
      tasksLoading={tasksLoading}
      unifiedTasks={unifiedTasks}
      unifiedTasksLoading={unifiedTasksLoading}
      onDispatch={onDispatch}
      onNavigate={onNavigate}
      onOpenInBench={onOpenInBench}
      openDispatchTrigger={openDispatchTrigger}
      quickSpawnTrigger={quickSpawnTrigger}
      openDetailTaskId={openDetailTaskId}
      onDetailTaskConsumed={onDetailTaskConsumed}
      onThroughputChange={onThroughputChange}
      githubRepo={githubRepo}
      watchdogEnabled={watchdogEnabled}
      watchdogEvents={watchdogEvents}
      projectRules={projectRules}
    />
  )
}
