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
import { isCapable } from './capabilities.js';
import {
  getProjectAgentsDir,
  getUserAgentsDir,
  getSystemAgentsDir,
  getEnabledExtraRepos,
} from './state.js';
import { isNameActiveInResourceProfile, type ProfiledResourceKind } from './resource-profiles.js';
import { resolveSnapshotSha } from './git.js';

// ─── Resource resolver ────────────────────────────────────────────────────────

/** Resource kind — matches the subdirectory name under each repo root. */
export type ResourceKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'rules'
  | 'mcp'
  | 'cli'
  | 'permissions'
  | 'subagents'
  | 'workflows'
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
  /**
   * Absolute path to the DotAgents repo root this resource resolved from (the
   * project/user/system/extra-repo dir — one level above the `kind`
   * subdirectory). DotAgents repos are git-tracked (plugins.ts), so this pairs
   * with {@link snapshotSha} to answer "which commit of which repo".
   */
  repoRoot: string;
  /**
   * Short HEAD sha of `repoRoot`'s git checkout, lazily resolved (a getter,
   * not computed at construction) and memoized per repoRoot
   * (`git.ts` `resolveSnapshotSha`) — a caller that never inspects provenance
   * never pays for the git shell-out, and resolving many resources from the
   * same repo pays for exactly one. `undefined` when `repoRoot` isn't a git
   * repo (or has no commits).
   */
  readonly snapshotSha: string | undefined;
}

/** Build a ResolvedResource with a lazy, memoized `snapshotSha` getter. */
function withProvenance(base: { name: string; path: string; source: string; repoRoot: string }): ResolvedResource {
  return {
    ...base,
    get snapshotSha() {
      return resolveSnapshotSha(base.repoRoot);
    },
  };
}

function profiledKind(kind: ResourceKind): ProfiledResourceKind | null {
  switch (kind) {
    case 'commands':
    case 'skills':
    case 'hooks':
    case 'mcp':
    case 'permissions':
    case 'subagents':
    case 'secrets':
      return kind;
    case 'rules':
      return 'memory';
    default:
      return null;
  }
}

function resourceIsActive(kind: ResourceKind, name: string, source: string): boolean {
  const activeKind = profiledKind(kind);
  return activeKind ? isNameActiveInResourceProfile(activeKind, name, source) : true;
}

/**
 * Documentation filenames that live *beside* resources, describing the directory
 * rather than being a resource in it. A DotAgents repo keeps a `README.md` (for
 * humans) and an `AGENTS.md` (for agents) in each resource dir, with
 * `CLAUDE.md`/`GEMINI.md` symlinked to the latter. Without this filter every one
 * of them materializes as a resource — `commands/README.md` installs a bogus
 * `/README` slash command into every agent home.
 *
 * `rules` is exempt: there `AGENTS.md` IS the resource (the composed ruleset that
 * syncs as each agent's memory file), not documentation about the directory.
 */
const DOC_BASENAMES = new Set(['readme', 'agents', 'claude', 'gemini']);

/**
 * True when `rawName` (a filename with its extension already stripped) names a
 * directory doc rather than a resource of `kind`. Exported so every enumerator
 * shares one definition — `listCentralCommands` and `discoverCommands` in
 * `commands.ts` do their own `readdirSync` scans, and without this they would
 * list a `README` that `resolveResource` then refuses to open.
 */
export function isDirectoryDoc(kind: ResourceKind, rawName: string): boolean {
  if (kind === 'rules') return false;
  return DOC_BASENAMES.has(rawName.toLowerCase());
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

  const candidates: Array<[string, string, string]> = [
    ...(projectDir ? [[path.join(projectDir, kind), 'project', projectDir] as [string, string, string]] : []),
    [path.join(getUserAgentsDir(), kind), 'user', getUserAgentsDir()],
    [path.join(getSystemAgentsDir(), kind), 'system', getSystemAgentsDir()],
    ...extraRepos.map((e): [string, string, string] => [path.join(e.dir, kind), e.alias, e.dir]),
  ];

  for (const [dir, source, repoRoot] of candidates) {
    if (!fs.existsSync(dir)) continue;

    // Try exact name (for directories like skills/subagents)
    const exactPath = path.join(dir, name);
    if (fs.existsSync(exactPath)) {
      if (resourceIsActive(kind, name, source)) {
        return withProvenance({ name, path: exactPath, source, repoRoot });
      }
      continue;
    }

    // Try with common file extensions. A directory doc (README/AGENTS/CLAUDE/
    // GEMINI) describes the directory and is never itself a resource.
    if (isDirectoryDoc(kind, name)) continue;
    for (const ext of ['.md', '.yaml', '.yml']) {
      const withExt = exactPath + ext;
      if (fs.existsSync(withExt)) {
        if (resourceIsActive(kind, name, source)) {
          return withProvenance({ name, path: withExt, source, repoRoot });
        }
        continue;
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

  const roots: Array<[string, string, string]> = [
    ...(projectDir ? [[path.join(projectDir, kind), 'project', projectDir] as [string, string, string]] : []),
    [path.join(getUserAgentsDir(), kind), 'user', getUserAgentsDir()],
    [path.join(getSystemAgentsDir(), kind), 'system', getSystemAgentsDir()],
    ...extraRepos.map((e): [string, string, string] => [path.join(e.dir, kind), e.alias, e.dir]),
  ];

  for (const [dir, source, repoRoot] of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { continue; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rawName = entry.name.replace(/\.(md|yaml|yml)$/, '');
      // Not isFile(): a Dirent for a symlink reports isFile() === false, and
      // CLAUDE.md/GEMINI.md are symlinks to AGENTS.md by convention. Anything
      // that is not a directory is a candidate doc; a resource directory that
      // happens to be named `agents/` is still a real resource.
      if (!entry.isDirectory() && isDirectoryDoc(kind, rawName)) continue;
      if (seen.has(rawName)) continue;
      if (!resourceIsActive(kind, rawName, source)) continue;
      seen.add(rawName);
      results.push(withProvenance({
        name: rawName,
        path: path.join(dir, entry.name),
        source,
        repoRoot,
      }));
    }
  }

  return results;
}

/** A single installed resource (command, skill, memory file, or hook). */
export interface ResourceEntry {
  name: string;
  path: string;
  scope: 'user' | 'project';
  /** One-line description pulled from frontmatter; not all resource kinds have one. */
  description?: string;
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
      commands.push({ name: cmd.name, path: cmd.path, scope: cmd.scope, description: cmd.description });
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
        description: skill.metadata.description || undefined,
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

  // Workflows
  const workflows: ResourceEntry[] = [];
  if (isCapable(agentId, 'workflows')) {
    for (const w of WorkflowsHandler.listAll(agentId as Parameters<typeof WorkflowsHandler.listAll>[0], cwd)) {
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
