/**
 * Workflows resource handler.
 *
 * Workflows are directory bundles with a WORKFLOW.md containing YAML frontmatter.
 * They optionally contain subagents/, skills/, and plugins/ subdirectories.
 * Resolution order: project > user > system.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, Layer, ResolvedItem, ResourceHandler, LayerDirs } from './types.js';
import {
  getProjectAgentsDir,
  getUserWorkflowsDir,
  getSystemWorkflowsDir,
  getEnabledExtraRepos,
} from '../state.js';
import { parseWorkflowFrontmatter, countWorkflowSubagents } from '../workflows.js';

export interface WorkflowItem {
  name: string;
  description: string;
  model?: string;
  subagentCount: number;
}

function getLayerDirs(cwd?: string): LayerDirs {
  const projectDir = getProjectAgentsDir(cwd);
  const extraRepos = getEnabledExtraRepos();
  return {
    system: getSystemWorkflowsDir(),
    user: getUserWorkflowsDir(),
    project: projectDir ? path.join(projectDir, 'workflows') : null,
    extra: extraRepos.map(e => path.join(e.dir, 'workflows')),
  };
}

function listWorkflowsInDir(dir: string): Array<{ name: string; path: string }> {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') &&
        fs.existsSync(path.join(dir, e.name, 'WORKFLOW.md')))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

class WorkflowsHandlerImpl implements ResourceHandler<WorkflowItem> {
  readonly kind = 'workflow' as const;

  listAll(_agent: AgentId, cwd?: string): ResolvedItem<WorkflowItem>[] {
    const dirs = getLayerDirs(cwd);
    const seen = new Set<string>();
    const results: ResolvedItem<WorkflowItem>[] = [];
    const layerDirs: Array<{ dir: string; layer: Layer }> = [];

    if (dirs.project) layerDirs.push({ dir: dirs.project, layer: 'project' });
    layerDirs.push({ dir: dirs.user, layer: 'user' });
    layerDirs.push({ dir: dirs.system, layer: 'system' });
    for (const extraDir of dirs.extra) layerDirs.push({ dir: extraDir, layer: 'system' });

    for (const { dir, layer } of layerDirs) {
      for (const { name, path: workflowPath } of listWorkflowsInDir(dir)) {
        if (seen.has(name)) continue;
        const fm = parseWorkflowFrontmatter(workflowPath);
        if (!fm) continue;
        seen.add(name);
        results.push({
          name,
          item: {
            name: fm.name || name,
            description: fm.description,
            model: fm.model,
            subagentCount: countWorkflowSubagents(workflowPath),
          },
          layer,
          path: workflowPath,
        });
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  resolve(_agent: AgentId, name: string, cwd?: string): ResolvedItem<WorkflowItem> | null {
    const dirs = getLayerDirs(cwd);
    const searchDirs: Array<{ dir: string; layer: Layer }> = [];
    if (dirs.project) searchDirs.push({ dir: dirs.project, layer: 'project' });
    searchDirs.push({ dir: dirs.user, layer: 'user' });
    searchDirs.push({ dir: dirs.system, layer: 'system' });
    for (const extraDir of dirs.extra) searchDirs.push({ dir: extraDir, layer: 'system' });

    for (const { dir, layer } of searchDirs) {
      const workflowPath = path.join(dir, name);
      const fm = parseWorkflowFrontmatter(workflowPath);
      if (fm) {
        return {
          name,
          item: {
            name: fm.name || name,
            description: fm.description,
            model: fm.model,
            subagentCount: countWorkflowSubagents(workflowPath),
          },
          layer,
          path: workflowPath,
        };
      }
    }
    return null;
  }

  sync(_agent: AgentId, _versionHome: string, _cwd?: string): void {
    // Version-home copies are written by syncResourcesToVersion in versions.ts.
    // exec.ts resolves workflows at run time from source dirs directly.
  }

  format(_agent: AgentId): 'md' {
    return 'md';
  }

  targetDir(_agent: AgentId): string {
    return 'workflows';
  }
}

export const WorkflowsHandler = new WorkflowsHandlerImpl();
