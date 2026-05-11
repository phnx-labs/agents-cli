/**
 * Unified resource discovery for agents.
 * Scans filesystem (source of truth) to find all installed resources for an agent.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import { AGENTS, listInstalledMcpsWithScope } from './agents.js';
import { listInstalledCommandsWithScope } from './commands.js';
import { listInstalledSkillsWithScope, type SkillParseError } from './skills.js';
import { listInstalledHooksWithScope } from './hooks.js';
import { listInstalledInstructionsWithScope } from './rules/rules.js';
import { getEffectiveHome } from './versions.js';
import { listMcpServerConfigs } from './mcp.js';
import { WorkflowsHandler } from './resources/workflows.js';
import { WORKFLOW_CAPABLE_AGENTS } from './workflows.js';
import {
  getProjectAgentsDir,
  getUserAgentsDir,
  getSystemAgentsDir,
  getEnabledExtraRepos,
} from './state.js';

// ─── Resource resolver ────────────────────────────────────────────────────────

/** Resource kind — matches the subdirectory name under each repo root. */
export type ResourceKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'rules'
  | 'mcp'
  | 'permissions'
  | 'subagents'
  | 'profiles'
  | 'secrets';

/** A resource resolved with its origin. */
export interface ResolvedResource {
  name: string;
  /** Absolute path to the resource file or directory. */
  path: string;
  /**
   * Source layer: 'project' | 'user' | 'system' for built-in layers,
   * or the alias name (e.g. 'rush') for extra repos registered in agents.yaml.
   */
  source: string;
}

/**
 * Resolve a single resource by kind + name using project > user > system precedence.
 * For file-based resources the path ends in `.md`, `.yaml`, or `.yml` as appropriate.
 * Returns null when the resource does not exist in any scope.
 *
 * Extra repos are searched last (after system) to match syncResourcesToVersion order.
 */
export function resolveResource(
  kind: ResourceKind,
  name: string,
  cwd?: string,
): ResolvedResource | null {
  const projectDir = getProjectAgentsDir(cwd);
  const extraRepos = getEnabledExtraRepos();

  const candidates: Array<[string, string]> = [
    ...(projectDir ? [[path.join(projectDir, kind), 'project'] as [string, string]] : []),
    [path.join(getUserAgentsDir(), kind), 'user'],
    [path.join(getSystemAgentsDir(), kind), 'system'],
    ...extraRepos.map((e): [string, string] => [path.join(e.dir, kind), e.alias]),
  ];

  for (const [dir, source] of candidates) {
    if (!fs.existsSync(dir)) continue;

    // Try exact name (for directories like skills/subagents)
    const exactPath = path.join(dir, name);
    if (fs.existsSync(exactPath)) {
      return { name, path: exactPath, source };
    }

    // Try with common file extensions
    for (const ext of ['.md', '.yaml', '.yml']) {
      const withExt = exactPath + ext;
      if (fs.existsSync(withExt)) {
        return { name, path: withExt, source };
      }
    }
  }

  return null;
}

/**
 * List all resources of a given kind across project, user, and system scopes.
 * Returns a deduplicated union (project wins on name collision), each entry
 * annotated with its origin source.
 */
export function listResources(
  kind: ResourceKind,
  cwd?: string,
): ResolvedResource[] {
  const seen = new Set<string>();
  const results: ResolvedResource[] = [];
  const projectDir = getProjectAgentsDir(cwd);
  const extraRepos = getEnabledExtraRepos();

  const roots: Array<[string, string]> = [
    ...(projectDir ? [[path.join(projectDir, kind), 'project'] as [string, string]] : []),
    [path.join(getUserAgentsDir(), kind), 'user'],
    [path.join(getSystemAgentsDir(), kind), 'system'],
    ...extraRepos.map((e): [string, string] => [path.join(e.dir, kind), e.alias]),
  ];

  for (const [dir, source] of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rawName = entry.name.replace(/\.(md|yaml|yml)$/, '');
      if (seen.has(rawName)) continue;
      seen.add(rawName);
      results.push({
        name: rawName,
        path: path.join(dir, entry.name),
        source,
      });
    }
  }

  return results;
}

/** A single installed resource (command, skill, memory file, or hook). */
export interface ResourceEntry {
  name: string;
  path: string;
  scope: 'user' | 'project';
}

/** A skill resource entry with optional rule count. */
export interface SkillResourceEntry extends ResourceEntry {
  ruleCount?: number;
}

/** An MCP server resource entry. */
export interface McpResourceEntry {
  name: string;
  scope: 'user' | 'project';
  version?: string;
}

/** All resources installed for a specific agent. */
export interface AgentResources {
  agentId: AgentId;
  commands: ResourceEntry[];
  skills: SkillResourceEntry[];
  skillErrors: SkillParseError[];
  mcp: McpResourceEntry[];
  memory: ResourceEntry[];
  hooks: ResourceEntry[];
  workflows: ResourceEntry[];
}

/** Options for resource discovery. */
export interface GetAgentResourcesOptions {
  cwd?: string;
  scope?: 'user' | 'project' | 'all';
  /** For MCP scanning - whether the CLI is installed */
  cliInstalled?: boolean;
  /** Version home to scan for user-scoped resources */
  home?: string;
}

/**
 * Get all resources installed for a specific agent by scanning the filesystem.
 * This is the source of truth - not the tracking data in agents.yaml.
 */
export function getAgentResources(
  agentId: AgentId,
  options: GetAgentResourcesOptions = {}
): AgentResources {
  const { cwd = process.cwd(), scope = 'all', cliInstalled = true, home } = options;
  const agent = AGENTS[agentId];

  const shouldInclude = (resourceScope: 'user' | 'project'): boolean => {
    if (scope === 'all') return true;
    return resourceScope === scope;
  };

  // Commands
  const commands: ResourceEntry[] = [];
  for (const cmd of listInstalledCommandsWithScope(agentId, cwd, { home })) {
    if (shouldInclude(cmd.scope)) {
      commands.push({ name: cmd.name, path: cmd.path, scope: cmd.scope });
    }
  }

  // Skills
  const skills: SkillResourceEntry[] = [];
  const skillErrors: SkillParseError[] = [];
  for (const skill of listInstalledSkillsWithScope(agentId, cwd, { home, errors: skillErrors })) {
    if (shouldInclude(skill.scope)) {
      skills.push({
        name: skill.name,
        path: skill.path,
        scope: skill.scope,
        ruleCount: skill.ruleCount,
      });
    }
  }

  // MCP
  const mcp: McpResourceEntry[] = [];
  const mcpByName = new Map<string, McpResourceEntry>();

  // Project/user-scoped MCP definitions from .agents/mcp
  for (const server of listMcpServerConfigs(cwd)) {
    const scope = server.scope || 'user';
    if (shouldInclude(scope) && !mcpByName.has(server.name)) {
      mcpByName.set(server.name, { name: server.name, scope });
    }
  }

  if (cliInstalled) {
    const effectiveHome = home || getEffectiveHome(agentId);
    for (const m of listInstalledMcpsWithScope(agentId, cwd, { home: effectiveHome })) {
      if (!shouldInclude(m.scope)) continue;
      if (!mcpByName.has(m.name)) {
        mcpByName.set(m.name, { name: m.name, scope: m.scope, version: m.version });
      }
    }
  }

  mcp.push(...mcpByName.values());

  // Memory/Instructions
  const memory: ResourceEntry[] = [];
  for (const instr of listInstalledInstructionsWithScope(agentId, cwd, { home })) {
    if (instr.exists && shouldInclude(instr.scope)) {
      memory.push({
        name: agent.instructionsFile,
        path: instr.path,
        scope: instr.scope,
      });
    }
  }

  // Hooks
  const hooks: ResourceEntry[] = [];
  for (const hook of listInstalledHooksWithScope(agentId, cwd, { home })) {
    if (shouldInclude(hook.scope)) {
      hooks.push({ name: hook.name, path: hook.path, scope: hook.scope });
    }
  }

  // Workflows (claude only)
  const workflows: ResourceEntry[] = [];
  if (WORKFLOW_CAPABLE_AGENTS.includes(agentId as 'claude')) {
    for (const w of WorkflowsHandler.listAll(agentId as 'claude', cwd)) {
      workflows.push({ name: w.name, path: w.path, scope: w.layer === 'project' ? 'project' : 'user' });
    }
  }

  return {
    agentId,
    commands,
    skills,
    skillErrors,
    mcp,
    memory,
    hooks,
    workflows,
  };
}

/**
 * Get resources for all agents.
 */
export function getAllAgentResources(
  agentIds: AgentId[],
  options: GetAgentResourcesOptions & { cliStates?: Record<AgentId, { installed: boolean }> } = {}
): AgentResources[] {
  const { cliStates, ...restOptions } = options;

  return agentIds.map((agentId) => {
    const cliInstalled = cliStates?.[agentId]?.installed ?? true;
    return getAgentResources(agentId, { ...restOptions, cliInstalled });
  });
}
