/**
 * Workflow management library.
 *
 * Workflows are directory bundles with a WORKFLOW.md containing YAML frontmatter.
 * They optionally contain subagents/, skills/, and plugins/ subdirectories that
 * are composed at runtime by `agents run <workflow>`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId } from './types.js';
import {
  getSystemWorkflowsDir,
  getUserWorkflowsDir,
  getTrashWorkflowsDir,
  getEnabledExtraRepos,
} from './state.js';
import { listInstalledVersions, getVersionHomePath } from './versions.js';

/** Agents that support running workflows via `agents run`. */
export const WORKFLOW_CAPABLE_AGENTS: AgentId[] = ['claude'];

/** Parsed WORKFLOW.md frontmatter. */
export interface WorkflowFrontmatter {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  mcpServers?: string[];
  allowedAgents?: string[];
}

/** A workflow found during repo discovery. */
export interface DiscoveredWorkflow {
  name: string;
  path: string;
  frontmatter: WorkflowFrontmatter;
  subagentCount: number;
}

/** A workflow in central storage (~/.agents/workflows/ or ~/.agents-system/workflows/). */
export interface InstalledWorkflow {
  name: string;
  path: string;
  frontmatter: WorkflowFrontmatter;
  subagentCount: number;
}

/** Parse WORKFLOW.md frontmatter from a workflow directory. Returns null if invalid. */
export function parseWorkflowFrontmatter(workflowDir: string): WorkflowFrontmatter | null {
  const workflowMdPath = path.join(workflowDir, 'WORKFLOW.md');
  if (!fs.existsSync(workflowMdPath)) return null;

  try {
    const content = fs.readFileSync(workflowMdPath, 'utf-8');
    const lines = content.split('\n');
    if (lines[0] !== '---') return null;
    const endIndex = lines.slice(1).findIndex(l => l === '---');
    if (endIndex < 0) return null;

    const frontmatter = lines.slice(1, endIndex + 1).join('\n');
    const parsed = yaml.parse(frontmatter);
    if (!parsed || typeof parsed !== 'object') return null;

    return {
      name: parsed.name || '',
      description: parsed.description || '',
      model: parsed.model,
      tools: parsed.tools,
      skills: parsed.skills,
      mcpServers: parsed.mcpServers,
      allowedAgents: parsed.allowedAgents,
    };
  } catch {
    return null;
  }
}

/** Count subagent .md files in a workflow's subagents/ directory. */
export function countWorkflowSubagents(workflowDir: string): number {
  const subagentsDir = path.join(workflowDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return 0;
  try {
    return fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/**
 * Discover all workflow directories (those containing WORKFLOW.md) in a local path.
 * Checks if the path itself is a workflow, then scans a top-level workflows/ subdirectory,
 * then falls back to scanning all immediate subdirectories.
 */
export function discoverWorkflowsFromRepo(repoPath: string): DiscoveredWorkflow[] {
  const results: DiscoveredWorkflow[] = [];

  // The path itself may be a single workflow directory.
  if (fs.existsSync(path.join(repoPath, 'WORKFLOW.md'))) {
    const frontmatter = parseWorkflowFrontmatter(repoPath);
    if (frontmatter) {
      return [{
        name: path.basename(repoPath),
        path: repoPath,
        frontmatter,
        subagentCount: countWorkflowSubagents(repoPath),
      }];
    }
  }

  // Try a workflows/ subdirectory first, then fall back to scanning root subdirectories.
  const workflowsSubdir = path.join(repoPath, 'workflows');
  const scanDir = fs.existsSync(workflowsSubdir) ? workflowsSubdir : repoPath;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(scanDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const workflowPath = path.join(scanDir, entry.name);
    const frontmatter = parseWorkflowFrontmatter(workflowPath);
    if (frontmatter) {
      results.push({
        name: entry.name,
        path: workflowPath,
        frontmatter,
        subagentCount: countWorkflowSubagents(workflowPath),
      });
    }
  }

  return results;
}

/**
 * List all workflows in central storage.
 * User layer (~/.agents/workflows/) wins over system (~/.agents-system/workflows/).
 */
export function listInstalledWorkflows(): Map<string, InstalledWorkflow> {
  const result = new Map<string, InstalledWorkflow>();
  const extraRepos = getEnabledExtraRepos();

  const searchDirs = [
    getUserWorkflowsDir(),
    getSystemWorkflowsDir(),
    ...extraRepos.map(r => path.join(r.dir, 'workflows')),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (result.has(entry.name)) continue; // Higher-priority layer already present

      const workflowPath = path.join(dir, entry.name);
      const frontmatter = parseWorkflowFrontmatter(workflowPath);
      if (!frontmatter) continue;

      result.set(entry.name, {
        name: entry.name,
        path: workflowPath,
        frontmatter,
        subagentCount: countWorkflowSubagents(workflowPath),
      });
    }
  }

  return result;
}

/** Copy a workflow directory into user central storage (~/.agents/workflows/<name>/). */
export function installWorkflowCentrally(sourcePath: string, name: string): { success: boolean; error?: string } {
  const targetPath = path.join(getUserWorkflowsDir(), name);
  try {
    fs.mkdirSync(getUserWorkflowsDir(), { recursive: true });
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Move a workflow from user central storage to trash. */
export function removeWorkflow(name: string): { success: boolean; error?: string } {
  const sourcePath = path.join(getUserWorkflowsDir(), name);
  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: `Workflow '${name}' not found in ~/.agents/workflows/` };
  }
  try {
    const trashDir = getTrashWorkflowsDir();
    fs.mkdirSync(trashDir, { recursive: true });
    fs.renameSync(sourcePath, path.join(trashDir, `${name}-${Date.now()}`));
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** List workflow names synced into a specific agent version home (at {versionHome}/workflows/). */
export function listWorkflowsForAgent(_agent: AgentId, versionHome: string): string[] {
  const workflowsDir = path.join(versionHome, 'workflows');
  if (!fs.existsSync(workflowsDir)) return [];
  try {
    return fs.readdirSync(workflowsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(workflowsDir, d.name, 'WORKFLOW.md')))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/** Copy a workflow directory into a version home at {versionHome}/workflows/<name>/. */
export function syncWorkflowToVersion(
  workflowPath: string,
  name: string,
  _agent: AgentId,
  versionHome: string,
): { success: boolean; error?: string } {
  const targetDir = path.join(versionHome, 'workflows', name);
  try {
    fs.mkdirSync(path.join(versionHome, 'workflows'), { recursive: true });
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    fs.cpSync(workflowPath, targetDir, { recursive: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Remove a workflow from a specific agent version home. */
export function removeWorkflowFromVersion(
  agent: AgentId,
  version: string,
  name: string,
): { success: boolean; error?: string } {
  const versionHome = getVersionHomePath(agent, version);
  const targetDir = path.join(versionHome, 'workflows', name);
  if (!fs.existsSync(targetDir)) {
    return { success: false, error: `Workflow '${name}' not synced to ${agent}@${version}` };
  }
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** Iterate all installed (agent, version) pairs that support workflows. */
export function iterWorkflowsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const result: Array<{ agent: AgentId; version: string }> = [];
  for (const agentId of WORKFLOW_CAPABLE_AGENTS) {
    if (filter?.agent && filter.agent !== agentId) continue;
    const versions = listInstalledVersions(agentId);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      result.push({ agent: agentId, version });
    }
  }
  return result;
}
