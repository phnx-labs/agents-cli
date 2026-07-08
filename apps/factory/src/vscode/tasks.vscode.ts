// VS Code integration for unified task management
// Aggregates tasks from Linear + GitHub.

import * as vscode from 'vscode';
import { TaskSource, TaskSourceSettings } from '../core/settings';
import { UnifiedTask, CycleInfo, groupTasksBySource } from '../core/tasks';
import { fetchLinearTasks, isLinearAvailable } from './linear.vscode';
import { fetchGitHubTasks, isGitHubAvailable } from './github.vscode';

export interface TaskFetchResult {
  tasks: UnifiedTask[];
  cycleInfo: CycleInfo | null;
}

// Detect which task sources are available based on MCP configuration
export async function detectAvailableSources(context: vscode.ExtensionContext): Promise<{
  linear: boolean;
  github: boolean;
}> {
  const [linear, github] = await Promise.all([
    isLinearAvailable(context),
    isGitHubAvailable(context)
  ]);

  return { linear, github };
}

// Fetch tasks from each source that is both (a) available (CLI installed)
// and (b) enabled by the user in settings.
export async function fetchAllTasks(
  context: vscode.ExtensionContext,
  enabledSources: TaskSourceSettings
): Promise<TaskFetchResult> {
  const tasks: UnifiedTask[] = [];
  let cycleInfo: CycleInfo | null = null;
  const [linearOk, githubOk] = await Promise.all([
    isLinearAvailable(context),
    isGitHubAvailable(context),
  ]);

  const fetchPromises: Promise<void>[] = [];

  if (enabledSources.linear && linearOk) {
    fetchPromises.push(
      fetchLinearTasks(context).then(result => {
        tasks.push(...result.tasks);
        if (result.cycleInfo) cycleInfo = result.cycleInfo;
      }).catch(err => {
        console.error('[TASKS] Error fetching Linear tasks:', err);
      })
    );
  }

  if (enabledSources.github && githubOk) {
    fetchPromises.push(
      fetchGitHubTasks(context, { assignedOnly: enabledSources.githubAssignedOnly }).then(ghTasks => {
        tasks.push(...ghTasks);
      }).catch(err => {
        console.error('[TASKS] Error fetching GitHub tasks:', err);
      })
    );
  }

  await Promise.all(fetchPromises);

  return { tasks, cycleInfo };
}

// Get tasks grouped by source for UI display
export async function fetchTasksGrouped(
  context: vscode.ExtensionContext,
  enabledSources: TaskSourceSettings
): Promise<Map<TaskSource, UnifiedTask[]>> {
  const { tasks } = await fetchAllTasks(context, enabledSources);
  return groupTasksBySource(tasks);
}
