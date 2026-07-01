/**
 * Version management module for agents-cli.
 *
 * Handles installing, removing, listing, and switching between agent CLI versions.
 * Each version is installed into an isolated directory under ~/.agents/.system/versions/{agent}/{version}/
 * with its own HOME directory for config isolation. Resources (commands, skills, hooks, memory,
 * MCP servers, permissions, subagents, plugins) from ~/.agents/ are synced into version homes
 * via copies or conversions (not symlinks).
 *
 * Key responsibilities:
 * - Version lifecycle: install, remove, list, resolve (project-level or global default)
 * - Resource discovery: scan ~/.agents/ for available resources across all types
 * - Resource sync: copy/convert resources into a version's isolated config directory
 * - Diff and reconciliation: detect new/unsynced resources and prompt users to sync them
 * - Agent/version target resolution: parse agent@version specs from CLI flags
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import * as TOML from 'smol-toml';
import { checkbox, select, confirm } from '@inquirer/prompts';
import type { AgentId, VersionResources } from './types.js';
import { getVersionsDir, getShimsDir, ensureAgentsDir, readMeta, writeMeta, getCommandsDir, getSkillsDir, getHooksDir, getResolvedRulesDir, getUserRulesDir, getPermissionsDir, getSubagentsDir, getVersionResources, recordVersionResources, ensureVersionResourcePatterns, getMcpDir, getProjectAgentsDir, getPromptcutsPath, getUserPromptcutsPath, getEnabledExtraRepos, getAgentsDir, getOptionalUserAgentsDir, getUserAgentsDir, getTrashVersionsDir, getActiveRulesPreset, getHomeDir } from './state.js';
import { defaultPatterns, expandPatterns } from './resource-patterns.js';
import { resolveResource, listResources } from './resources.js';
import { AGENTS, agentConfigDirName, getAccountEmail, getMcpConfigPathForHome, parseMcpConfig, resolveAgentName, formatAgentError, findInPath } from './agents.js';
import { getDefaultPermissionSet, applyPermissionsToVersion as applyPermsToVersion, discoverPermissionGroups, getTotalPermissionRuleCount, buildPermissionsFromGroups, CODEX_RULES_FILENAME, getActivePermissionPresetName, readPermissionPresetRecipe, PERMISSION_PRESET_ENV_VAR } from './permissions.js';
import { installMcpServers, parseMcpServerConfig } from './mcp.js';
import { markdownToToml } from './convert.js';
import { createVersionedAlias, removeVersionedAlias, switchConfigSymlink, getConfigSymlinkVersion, ensureClaudeInsideSymlink } from './shims.js';
import { importInstallScriptBinary } from './import.js';
import { IS_WINDOWS } from './platform/index.js';
import { listInstalledSubagents, transformSubagentForClaude, syncSubagentToOpenclaw } from './subagents.js';
import { listInstalledWorkflows, syncWorkflowToVersion } from './workflows.js';
import { parseHookManifest, registerHooksToSettings } from './hooks.js';
import { supports, explainSkip, capableAgents } from './capabilities.js';
import { discoverPlugins, syncPluginToVersion, isPluginSynced, pluginSupportsAgent, cleanOrphanedPluginSkills } from './plugins.js';
import { composeRulesFromState } from './rules/compose.js';
import { loadManifest, saveManifest, buildManifest as buildSyncManifest, isStale } from './staleness/index.js';
import { emit } from './events.js';
import { safeJoin } from './paths.js';
import { installCommandSkillToVersion, listCommandSkillsInVersion, readSkillSourceCommandMarker, shouldInstallCommandAsSkill } from './command-skills.js';
import { getWriter, getDetector } from './staleness/registry.js';

/** Promisified exec for running shell commands. */
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const RULES_DOC_FILENAME = 'README.md';

// Strict shape for an agent version string. Anything outside this is rejected
// at parse time so it can't reach an exec/shell boundary or get interpolated
// into a generated bash alias. Must allow "latest" plus npm-dist-tag /
// semver-shaped values (digits, dots, dashes, +, _).
const VERSION_RE = /^(?:latest|(?!.*\.\.)[A-Za-z0-9._+-]{1,64})$/;

/**
 * Resource selection for syncing to a version.
 * Each field can be:
 * - 'all' - sync all available resources of this type
 * - string[] - sync only these specific resources
 * - undefined - skip this resource type
 */
export interface ResourceSelection {
  commands?: string[] | 'all';
  skills?: string[] | 'all';
  hooks?: string[] | 'all';
  memory?: string[] | 'all';
  mcp?: string[] | 'all';
  permissions?: string[] | 'all';
  subagents?: string[] | 'all';
  plugins?: string[] | 'all';
  workflows?: string[] | 'all';
}

/**
 * Available resources in ~/.agents/ for syncing.
 *
 * `promptcuts` is a boolean, not a list — there is at most one
 * ~/.agents/promptcuts.yaml file. It is NOT version-scoped: the
 * expand-promptcuts hook reads it directly, so no per-version copy
 * is made and no sync step is needed.
 */
export interface AvailableResources {
  commands: string[];
  skills: string[];
  hooks: string[];
  memory: string[];
  mcp: string[];
  permissions: string[];
  subagents: string[];
  plugins: string[];
  workflows: string[];
  promptcuts: boolean;
}

type ResourceBase = { scope: 'project' | 'user'; base: string };
type ScopedMcpResource = { name: string; scope: 'project' | 'user' };

function getResourceBases(cwd: string): ResourceBase[] {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  const userBase = getUserAgentsDir();
  const systemBase = getAgentsDir();
  const resourceBases: ResourceBase[] = [];
  if (projectAgentsDir) {
    resourceBases.push({ scope: 'project', base: projectAgentsDir });
  }
  resourceBases.push({ scope: 'user', base: userBase });
  resourceBases.push({ scope: 'user', base: systemBase });
  for (const extra of getEnabledExtraRepos()) {
    resourceBases.push({ scope: 'user', base: extra.dir });
  }
  return resourceBases;
}

function getScopedMcpResources(cwd: string): ScopedMcpResource[] {
  const resources = new Map<string, ScopedMcpResource>();
  for (const { base, scope } of getResourceBases(cwd)) {
    const mcpDir = path.join(base, 'mcp');
    if (!fs.existsSync(mcpDir)) continue;
    const files = fs.readdirSync(mcpDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      const config = parseMcpServerConfig(path.join(mcpDir, file));
      if (config?.name && !resources.has(config.name)) {
        resources.set(config.name, { name: config.name, scope });
      }
    }
  }
  return Array.from(resources.values());
}

/**
 * Get all available resources from ~/.agents/.
 */
export function getAvailableResources(cwd: string = process.cwd()): AvailableResources {
  const result: AvailableResources = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
    workflows: [],
    promptcuts: false,
  };

  const projectAgentsDir = getProjectAgentsDir(cwd);
  const resourceBases = getResourceBases(cwd);

  // Commands (*.md files)
  const commandNames = new Set<string>();
  for (const { base } of resourceBases) {
    const commandsDir = path.join(base, 'commands');
    if (!fs.existsSync(commandsDir)) continue;
    const names = fs.readdirSync(commandsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
    for (const name of names) {
      commandNames.add(name);
    }
  }
  result.commands = Array.from(commandNames);

  // Skills (directories, excluding hidden)
  const skillNames = new Set<string>();
  for (const { base } of resourceBases) {
    const skillsDir = path.join(base, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    const names = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
    for (const name of names) {
      skillNames.add(name);
    }
  }
  result.skills = Array.from(skillNames);

  // Hooks (files). A hook is an actual script: known script extension, OR
  // executable bit on a file with a non-data extension. Auxiliary content
  // like `README.md` (docs) or `promptcuts.yaml` (data read directly by the
  // expand-promptcuts script) lives in hooks/ but is not a hook. Older sync
  // runs chmod 0o755'd everything they copied, so an exec bit alone can no
  // longer be trusted as the signal.
  const NON_SCRIPT_EXTS = new Set(['.md', '.markdown', '.rst', '.txt', '.yaml', '.yml', '.json', '.toml', '.ini', '.conf']);
  const SCRIPT_EXTS     = new Set(['.sh', '.bash', '.zsh', '.py', '.js', '.ts', '.mjs', '.cjs', '.rb', '.pl', '.ps1']);
  const hookNames = new Set<string>();
  for (const { base } of resourceBases) {
    const hooksDir = path.join(base, 'hooks');
    if (!fs.existsSync(hooksDir)) continue;
    for (const name of fs.readdirSync(hooksDir)) {
      if (name.startsWith('.')) continue;
      try {
        const stat = fs.statSync(path.join(hooksDir, name));
        if (!stat.isFile()) continue;
        const ext = path.extname(name).toLowerCase();
        if (SCRIPT_EXTS.has(ext)) { hookNames.add(name); continue; }
        if ((stat.mode & 0o111) !== 0 && !NON_SCRIPT_EXTS.has(ext)) hookNames.add(name);
      } catch { /* ignore unreadable */ }
    }
  }
  result.hooks = Array.from(hookNames);

  // Rules — list available presets across layers (project > user > extras > system).
  // The composer selects exactly one preset per sync; this list drives the
  // resource-count display and `agents rules switch` picker. Routes through
  // the rules-dir getters so test mocks work the same as production paths.
  const presetNames = new Set<string>();
  const rulesDirs: string[] = [];
  if (projectAgentsDir) rulesDirs.push(path.join(projectAgentsDir, 'rules'));
  rulesDirs.push(getUserRulesDir());
  rulesDirs.push(getResolvedRulesDir());
  for (const extra of getEnabledExtraRepos()) {
    rulesDirs.push(path.join(extra.dir, 'rules'));
  }
  for (const rulesDir of rulesDirs) {
    const rulesYamlPath = path.join(rulesDir, 'rules.yaml');
    if (!fs.existsSync(rulesYamlPath)) continue;
    try {
      const parsed = yaml.parse(fs.readFileSync(rulesYamlPath, 'utf-8')) as { presets?: Record<string, unknown> } | null;
      for (const name of Object.keys(parsed?.presets || {})) {
        presetNames.add(name);
      }
    } catch {
      // malformed rules.yaml — skip silently; the composer will surface the error.
    }
  }
  result.memory = Array.from(presetNames);

  result.mcp = getScopedMcpResources(cwd).map(resource => resource.name);

  // Permission groups (from permissions/groups/*.yaml)
  const permissionNames = new Set<string>();
  for (const { base } of resourceBases) {
    const permsGroupsDir = path.join(base, 'permissions', 'groups');
    if (!fs.existsSync(permsGroupsDir)) continue;
    const names = fs.readdirSync(permsGroupsDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => f.replace(/\.(yaml|yml)$/, ''));
    for (const name of names) {
      permissionNames.add(name);
    }
  }
  result.permissions = Array.from(permissionNames);

  // Subagents (directories with AGENT.md)
  const subagentNames = new Set<string>();
  for (const { base } of resourceBases) {
    const subagentsDir = path.join(base, 'subagents');
    if (!fs.existsSync(subagentsDir)) continue;
    const names = fs.readdirSync(subagentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(subagentsDir, d.name, 'AGENT.md')))
      .map(d => d.name);
    for (const name of names) {
      subagentNames.add(name);
    }
  }
  result.subagents = Array.from(subagentNames);

  // Workflows (directories with WORKFLOW.md)
  const workflowNames = new Set<string>();
  for (const { base } of resourceBases) {
    const workflowsDir = path.join(base, 'workflows');
    if (!fs.existsSync(workflowsDir)) continue;
    const names = fs.readdirSync(workflowsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(workflowsDir, d.name, 'WORKFLOW.md')))
      .map(d => d.name);
    for (const name of names) {
      workflowNames.add(name);
    }
  }
  result.workflows = Array.from(workflowNames);

  // Plugins (directories with .claude-plugin/plugin.json)
  const allPlugins = discoverPlugins();
  result.plugins = allPlugins.map(p => p.name);

  // Promptcuts — present if either layer exists. Reads merge user + system
  // with user precedence (see readMergedPromptcuts); writes always go to user.
  result.promptcuts = fs.existsSync(getUserPromptcutsPath()) || fs.existsSync(getPromptcutsPath());

  return result;
}

// Files/dirs that are never synced into a version home (OS metadata, local tooling).
const SKILL_COPY_IGNORE = new Set(['.DS_Store', '.git', '.gitignore', '.venv', '__pycache__', 'node_modules']);

function shouldSkillEntryBeSkipped(name: string): boolean {
  return SKILL_COPY_IGNORE.has(name);
}

/**
 * Recursively compare two directories: every file in src must exist in dest with identical content.
 * Skips the same entries that copyDir skips (symlinks and SKILL_COPY_IGNORE members).
 */
function skillDirsMatch(src: string, dest: string): boolean {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (shouldSkillEntryBeSkipped(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) return false;
      if (!skillDirsMatch(srcPath, destPath)) return false;
    } else {
      if (!fs.existsSync(destPath)) return false;
      const srcContent = fs.readFileSync(srcPath, 'utf-8');
      const destContent = fs.readFileSync(destPath, 'utf-8');
      if (srcContent !== destContent) return false;
    }
  }
  return true;
}

/**
 * Get what's ACTUALLY synced to a version by inspecting the version home.
 * This is the source of truth - not the tracking in agents.yaml.
 */
export function getActuallySyncedResources(agent: AgentId, version: string, options: { cwd?: string } = {}): AvailableResources {
  const versionHome = path.join(getVersionsDir(), agent, version, 'home');
  const cwd = options.cwd || process.cwd();

  const result: AvailableResources = {
    commands: [],
    skills: [],
    hooks: [],
    memory: [],
    mcp: [],
    permissions: [],
    subagents: [],
    plugins: [],
    workflows: [],
    promptcuts: false,
  };

  // Dispatch each kind through DETECTORS. The registry guarantees a detector
  // exists for every supported (agent, kind) pair; unsupported pairs leave
  // the field empty. The previous per-agent if-ladder silently dropped
  // antigravity/gemini/grok detection — see PR description for details.
  const ctx = { version, versionHome, cwd };
  result.commands    = getDetector('commands',    agent)?.list(ctx) ?? [];
  result.skills      = getDetector('skills',      agent)?.list(ctx) ?? [];
  result.hooks       = getDetector('hooks',       agent)?.list(ctx) ?? [];
  result.memory      = getDetector('rules',       agent)?.list(ctx) ?? [];
  result.mcp         = getDetector('mcp',         agent)?.list(ctx) ?? [];
  result.permissions = getDetector('permissions', agent)?.list(ctx) ?? [];
  result.subagents   = getDetector('subagents',   agent)?.list(ctx) ?? [];
  result.plugins     = getDetector('plugins',     agent)?.list(ctx) ?? [];
  result.workflows   = getDetector('workflows',   agent)?.list(ctx) ?? [];
  return result;
}

/** Resource names that only exist in the project's `.agents/` layer, grouped by kind. */
export interface ProjectOnlyResources {
  commands: Set<string>;
  skills: Set<string>;
  hooks: Set<string>;
  subagents: Set<string>;
  plugins: Set<string>;
  workflows: Set<string>;
}

/**
 * Names that exist ONLY in the project's `.agents/` layer (no matching entry in
 * user/system/extra layers). Sync intentionally skips project-layer commands,
 * skills, hooks, subagents, plugins, and workflows for security — see the
 * defense comments above each sync branch in syncResourcesToVersion. Without
 * this filter, those names would forever appear in the "New resources" diff
 * because they live in `available` but never reach `actuallySynced`.
 */
export function getProjectOnlyResources(cwd: string = process.cwd()): ProjectOnlyResources {
  const empty: ProjectOnlyResources = {
    commands: new Set(), skills: new Set(), hooks: new Set(),
    subagents: new Set(), plugins: new Set(), workflows: new Set(),
  };

  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return empty;

  const trustedBases: string[] = [getUserAgentsDir(), getAgentsDir(), ...getEnabledExtraRepos().map(e => e.dir)];

  const trustedNames = (relSubdir: string, predicate: (full: string, name: string) => boolean): Set<string> => {
    const acc = new Set<string>();
    for (const base of trustedBases) {
      const dir = path.join(base, relSubdir);
      if (!fs.existsSync(dir)) continue;
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (entry.startsWith('.')) continue;
          if (predicate(path.join(dir, entry), entry)) acc.add(entry);
        }
      } catch { /* ignore unreadable */ }
    }
    return acc;
  };

  const readProjectNames = (relSubdir: string, predicate: (full: string, name: string) => boolean): string[] => {
    const dir = path.join(projectAgentsDir, relSubdir);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter(e => !e.startsWith('.'))
        .filter(e => predicate(path.join(dir, e), e));
    } catch { return []; }
  };

  const isMdFile = (full: string, name: string) =>
    name.endsWith('.md') && (() => { try { return fs.statSync(full).isFile(); } catch { return false; } })();
  const isDir = (full: string) => { try { return fs.statSync(full).isDirectory(); } catch { return false; } };
  const hasFile = (sub: string) => (full: string) => isDir(full) && fs.existsSync(path.join(full, sub));

  const stripMd = (n: string) => n.replace(/\.md$/, '');

  const trustedCommands = new Set([...trustedNames('commands', isMdFile)].map(stripMd));
  const projectCommands = readProjectNames('commands', isMdFile).map(stripMd);
  for (const n of projectCommands) if (!trustedCommands.has(n)) empty.commands.add(n);

  const trustedSkills = trustedNames('skills', (full) => isDir(full));
  for (const n of readProjectNames('skills', (full) => isDir(full))) if (!trustedSkills.has(n)) empty.skills.add(n);

  // Hooks: project entries are files; trusted entries are also files. Name match
  // is filename-with-extension (sync compares by full filename, line 2031).
  const trustedHooks = trustedNames('hooks', (full) => { try { return fs.statSync(full).isFile(); } catch { return false; } });
  for (const n of readProjectNames('hooks', (full) => { try { return fs.statSync(full).isFile(); } catch { return false; } })) {
    if (!trustedHooks.has(n)) empty.hooks.add(n);
  }

  const trustedSubagents = trustedNames('subagents', hasFile('AGENT.md'));
  for (const n of readProjectNames('subagents', hasFile('AGENT.md'))) {
    if (!trustedSubagents.has(n)) empty.subagents.add(n);
  }

  const trustedWorkflows = trustedNames('workflows', hasFile('WORKFLOW.md'));
  for (const n of readProjectNames('workflows', hasFile('WORKFLOW.md'))) {
    if (!trustedWorkflows.has(n)) empty.workflows.add(n);
  }

  const trustedPlugins = trustedNames('plugins', hasFile('.claude-plugin/plugin.json'));
  for (const n of readProjectNames('plugins', hasFile('.claude-plugin/plugin.json'))) {
    if (!trustedPlugins.has(n)) empty.plugins.add(n);
  }

  return empty;
}

/**
 * Compare available resources with what's ACTUALLY synced to version home.
 * Returns only NEW resources that haven't been synced yet.
 * Source of truth: the actual files/config, NOT agents.yaml tracking.
 *
 * `projectOnly` (recommended): the result of `getProjectOnlyResources(cwd)`.
 * Names listed there are filtered out for kinds that sync intentionally
 * excludes the project layer — otherwise they would re-appear as "new"
 * on every run and "Yes, sync all new" would silently do nothing for them.
 */
export function getNewResources(
  available: AvailableResources,
  actuallySynced: AvailableResources,
  projectOnly?: ProjectOnlyResources
): AvailableResources {
  const exclude = projectOnly || {
    commands: new Set<string>(), skills: new Set<string>(), hooks: new Set<string>(),
    subagents: new Set<string>(), plugins: new Set<string>(), workflows: new Set<string>(),
  };
  return {
    commands: available.commands.filter(c => !actuallySynced.commands.includes(c) && !exclude.commands.has(c)),
    skills: available.skills.filter(s => !actuallySynced.skills.includes(s) && !exclude.skills.has(s)),
    hooks: available.hooks.filter(h => !actuallySynced.hooks.includes(h) && !exclude.hooks.has(h)),
    // Memory/rules presets are mutually exclusive — only one can be active.
    // If any preset is synced, don't report others as "new".
    memory: actuallySynced.memory.length > 0
      ? []
      : available.memory.filter(m => !actuallySynced.memory.includes(m)),
    mcp: available.mcp.filter(m => !actuallySynced.mcp.includes(m)),
    permissions: available.permissions.filter(p => !actuallySynced.permissions.includes(p)),
    subagents: available.subagents.filter(s => !actuallySynced.subagents.includes(s) && !exclude.subagents.has(s)),
    plugins: available.plugins.filter(p => !actuallySynced.plugins.includes(p) && !exclude.plugins.has(p)),
    workflows: available.workflows.filter(w => !actuallySynced.workflows.includes(w) && !exclude.workflows.has(w)),
    // Promptcuts aren't version-scoped — the hook reads ~/.agents/promptcuts.yaml
    // directly, so there is never a "new" per-version state to reconcile.
    promptcuts: false,
  };
}

/**
 * Check if there are any new resources to sync.
 * When version is provided, uses version-specific capability checks.
 */
export function hasNewResources(diff: AvailableResources, agent?: AgentId, version?: string): boolean {
  const commandsApply = agent ? supports(agent, 'commands', version).ok : true;
  const hooksApply = agent ? supports(agent, 'hooks', version).ok : true;
  const mcpApply = agent ? supports(agent, 'mcp', version).ok : true;
  const permsApply = agent ? supports(agent, 'allowlist', version).ok : true;
  const subagentsApply = agent ? supports(agent, 'subagents', version).ok : true;
  const pluginsApply = agent ? supports(agent, 'plugins', version).ok : true;
  const workflowsApply = agent ? supports(agent, 'workflows', version).ok : true;
  return (
    (diff.commands.length > 0 && commandsApply) ||
    diff.skills.length > 0 ||
    (diff.hooks.length > 0 && hooksApply) ||
    (diff.memory.length > 0 && commandsApply) ||
    (diff.mcp.length > 0 && mcpApply) ||
    (diff.permissions.length > 0 && permsApply) ||
    (diff.subagents.length > 0 && subagentsApply) ||
    (diff.plugins.length > 0 && pluginsApply) ||
    (diff.workflows.length > 0 && workflowsApply)
  );
}

/**
 * Build a summary string of new resources.
 * E.g., "2 commands, 5 permission groups"
 */
function buildNewResourcesSummary(newResources: AvailableResources, agent: AgentId, version?: string): string {
  const agentConfig = AGENTS[agent];
  const parts: string[] = [];

  // Use version-aware gates so Codex >= 0.117.0 (which converts commands to skills) doesn't
  // double-count and so "16 commands" never appears in the summary when commands have
  // already been emitted as skills in the version home.
  const commandsApply = supports(agent, 'commands', version).ok;
  const commandsAsSkills = version ? shouldInstallCommandAsSkill(agent, version) : false;
  const rulesApply = supports(agent, 'rules', version).ok;

  if (newResources.commands.length > 0 && (commandsApply || commandsAsSkills)) {
    parts.push(`${newResources.commands.length} command${newResources.commands.length === 1 ? '' : 's'}`);
  }
  if (newResources.skills.length > 0) {
    parts.push(`${newResources.skills.length} skill${newResources.skills.length === 1 ? '' : 's'}`);
  }
  if (newResources.hooks.length > 0 && agentConfig.supportsHooks) {
    parts.push(`${newResources.hooks.length} hook${newResources.hooks.length === 1 ? '' : 's'}`);
  }
  if (newResources.memory.length > 0 && rulesApply) {
    parts.push(`${newResources.memory.length} rule file${newResources.memory.length === 1 ? '' : 's'}`);
  }
  if (newResources.mcp.length > 0 && supports(agent, 'mcp', version).ok) {
    parts.push(`${newResources.mcp.length} MCP${newResources.mcp.length === 1 ? '' : 's'}`);
  }
  if (newResources.permissions.length > 0 && supports(agent, 'allowlist', version).ok) {
    parts.push(`${newResources.permissions.length} permission group${newResources.permissions.length === 1 ? '' : 's'}`);
  }
  if (newResources.subagents.length > 0 && supports(agent, 'subagents', version).ok) {
    parts.push(`${newResources.subagents.length} subagent${newResources.subagents.length === 1 ? '' : 's'}`);
  }
  if (newResources.plugins.length > 0 && supports(agent, 'plugins', version).ok) {
    parts.push(`${newResources.plugins.length} plugin${newResources.plugins.length === 1 ? '' : 's'}`);
  }
  if (newResources.workflows.length > 0 && supports(agent, 'workflows', version).ok) {
    parts.push(`${newResources.workflows.length} workflow${newResources.workflows.length === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}

/**
 * Prompt user to select which NEW resources to sync.
 * Only shows resources that haven't been synced yet.
 */
export async function promptNewResourceSelection(
  agent: AgentId,
  newResources: AvailableResources,
  version?: string
): Promise<ResourceSelection | null> {
  const agentConfig = AGENTS[agent];
  const selection: ResourceSelection = {};

  // Version-aware gates. When version is known, prefer per-version capability checks; the
  // commands branch is allowed when either native commands are supported OR when the
  // version emits commands as converted skills (Codex >= 0.117.0).
  const commandsApply = supports(agent, 'commands', version).ok;
  const commandsAsSkills = version ? shouldInstallCommandAsSkill(agent, version) : false;
  const commandsBranch = commandsApply || commandsAsSkills;
  const rulesBranch = supports(agent, 'rules', version).ok;

  // Get permission group info for display
  const permissionGroups = discoverPermissionGroups();
  const newPermissionGroups = permissionGroups.filter(g => newResources.permissions.includes(g.name));
  const totalNewPermissionRules = newPermissionGroups.reduce((sum, g) => sum + g.ruleCount, 0);

  // Build the summary
  const summary = buildNewResourcesSummary(newResources, agent, version);
  console.log(chalk.cyan(`\nNew resources available:`));
  console.log(chalk.gray(`  ${summary}`));

  // Ask how to handle new resources
  const action = await select<'all' | 'specific' | 'skip'>({
    message: 'Sync new resources?',
    choices: [
      { value: 'all', name: 'Yes, sync all new' },
      { value: 'specific', name: 'Select specific items' },
      { value: 'skip', name: 'Skip' },
    ],
    default: 'all',
  });

  if (action === 'skip') {
    return null;
  }

  if (action === 'all') {
    // Sync all new resources
    if (newResources.commands.length > 0 && commandsBranch) selection.commands = newResources.commands;
    if (newResources.skills.length > 0) selection.skills = newResources.skills;
    if (newResources.hooks.length > 0 && agentConfig.supportsHooks) selection.hooks = newResources.hooks;
    if (newResources.memory.length > 0 && rulesBranch) selection.memory = newResources.memory;
    if (newResources.mcp.length > 0 && supports(agent, 'mcp', version).ok) selection.mcp = newResources.mcp;
    if (newResources.permissions.length > 0 && supports(agent, 'allowlist', version).ok) selection.permissions = newResources.permissions;
    if (newResources.subagents.length > 0 && supports(agent, 'subagents', version).ok) selection.subagents = newResources.subagents;
    if (newResources.plugins.length > 0 && supports(agent, 'plugins', version).ok) selection.plugins = newResources.plugins;
    if (newResources.workflows.length > 0 && supports(agent, 'workflows', version).ok) selection.workflows = newResources.workflows;
    return selection;
  }

  // Select specific items for each category
  if (newResources.commands.length > 0 && commandsBranch) {
    const selected = await checkbox({
      message: 'Select new commands to sync:',
      choices: newResources.commands.map(c => ({ name: c, value: c, checked: true })),
    });
    if (selected.length > 0) selection.commands = selected;
  }

  if (newResources.skills.length > 0) {
    const selected = await checkbox({
      message: 'Select new skills to sync:',
      choices: newResources.skills.map(s => ({ name: s, value: s, checked: true })),
    });
    if (selected.length > 0) selection.skills = selected;
  }

  if (newResources.hooks.length > 0 && agentConfig.supportsHooks) {
    const selected = await checkbox({
      message: 'Select new hooks to sync:',
      choices: newResources.hooks.map(h => ({ name: h, value: h, checked: true })),
    });
    if (selected.length > 0) selection.hooks = selected;
  }

  if (newResources.memory.length > 0 && rulesBranch) {
    const selected = await checkbox({
      message: 'Select new rule files to sync:',
      choices: newResources.memory.map(m => ({ name: m, value: m, checked: true })),
    });
    if (selected.length > 0) selection.memory = selected;
  }

  if (newResources.mcp.length > 0 && supports(agent, 'mcp', version).ok) {
    const selected = await checkbox({
      message: 'Select new MCPs to sync:',
      choices: newResources.mcp.map(m => ({ name: m, value: m, checked: true })),
    });
    if (selected.length > 0) selection.mcp = selected;
  }

  if (newResources.permissions.length > 0 && supports(agent, 'allowlist', version).ok) {
    const selected = await checkbox({
      message: 'Select new permission groups to sync:',
      choices: newPermissionGroups.map(g => ({
        name: `${g.name} (${g.ruleCount} rules)`,
        value: g.name,
        checked: true,
      })),
    });
    if (selected.length > 0) selection.permissions = selected;
  }

  if (newResources.subagents.length > 0 && supports(agent, 'subagents', version).ok) {
    const selected = await checkbox({
      message: 'Select new subagents to sync:',
      choices: newResources.subagents.map(s => ({ name: s, value: s, checked: true })),
    });
    if (selected.length > 0) selection.subagents = selected;
  }

  if (newResources.plugins.length > 0 && supports(agent, 'plugins', version).ok) {
    const allPlugins = discoverPlugins();
    const pluginMap = new Map(allPlugins.map(p => [p.name, p]));
    const selected = await checkbox({
      message: 'Select new plugins to sync:',
      choices: newResources.plugins.map(name => {
        const plugin = pluginMap.get(name);
        const desc = plugin?.manifest.description;
        return { name: desc ? `${name} - ${desc}` : name, value: name, checked: true };
      }),
    });
    if (selected.length > 0) selection.plugins = selected;
  }

  if (newResources.workflows.length > 0 && supports(agent, 'workflows', version).ok) {
    const selected = await checkbox({
      message: 'Select new workflows to sync:',
      choices: newResources.workflows.map(w => ({ name: w, value: w, checked: true })),
    });
    if (selected.length > 0) selection.workflows = selected;
  }

  return selection;
}

/**
 * Prompt user to select which resources to sync from ~/.agents/.
 * Returns the selection, or null if user cancels.
 */
export async function promptResourceSelection(agent: AgentId): Promise<ResourceSelection | null> {
  const available = getAvailableResources();
  const agentConfig = AGENTS[agent];
  const selection: ResourceSelection = {};

  // Get permission group info for display
  const permissionGroups = discoverPermissionGroups();
  const totalPermissionRules = permissionGroups.reduce((sum, g) => sum + g.ruleCount, 0);

  // Build category choices based on what's available.
  // Constrain to ResourceSelection keys — promptcuts is in AvailableResources
  // for visibility but is never synced per-version, so it has no ResourceSelection entry.
  type CategoryKey = keyof ResourceSelection;
  const categories: { key: CategoryKey; label: string; available: boolean; displayCount: string }[] = [
    { key: 'commands', label: 'Commands', available: supports(agent, 'commands').ok && available.commands.length > 0, displayCount: `${available.commands.length} available` },
    { key: 'skills', label: 'Skills', available: available.skills.length > 0, displayCount: `${available.skills.length} available` },
    { key: 'hooks', label: 'Hooks', available: agentConfig.supportsHooks && available.hooks.length > 0, displayCount: `${available.hooks.length} available` },
    { key: 'memory', label: 'Rules', available: supports(agent, 'rules').ok && available.memory.length > 0, displayCount: `${available.memory.length} available` },
    { key: 'mcp', label: 'MCPs', available: supports(agent, 'mcp').ok && available.mcp.length > 0, displayCount: `${available.mcp.length} available` },
    { key: 'permissions', label: 'Permissions', available: supports(agent, 'allowlist').ok && permissionGroups.length > 0, displayCount: `${permissionGroups.length} groups, ${totalPermissionRules} rules` },
    { key: 'subagents', label: 'Subagents', available: supports(agent, 'subagents').ok && available.subagents.length > 0, displayCount: `${available.subagents.length} available` },
    { key: 'plugins', label: 'Plugins', available: supports(agent, 'plugins').ok && available.plugins.length > 0, displayCount: `${available.plugins.length} available` },
  ];

  const availableCategories = categories.filter(c => c.available);

  if (availableCategories.length === 0) {
    console.log(chalk.gray('No resources available to sync.'));
    return {};
  }

  // Step 1: Select categories (with "Select All" shortcut at the top)
  console.log();
  const SELECT_ALL_KEY = '__select_all__' as CategoryKey;
  const selectedCategories = await checkbox<CategoryKey>({
    message: 'Which resources would you like to sync?',
    choices: [
      { name: chalk.bold('Select All (sync everything)'), value: SELECT_ALL_KEY, checked: false },
      ...availableCategories.map(c => ({
        name: `${c.label} (${c.displayCount})`,
        value: c.key,
        checked: true, // Default all checked
      })),
    ],
  });

  if (selectedCategories.length === 0) {
    return {};
  }

  // If "Select All" was picked, or all individual categories are selected, sync everything without per-category prompts
  const allCategoryKeys = availableCategories.map(c => c.key);
  if (selectedCategories.includes(SELECT_ALL_KEY) || allCategoryKeys.every(k => selectedCategories.includes(k))) {
    for (const c of availableCategories) {
      selection[c.key] = 'all';
    }
    return selection;
  }

  // Step 2: For each selected category, ask all/specific/skip
  for (const category of selectedCategories) {
    const categoryLabel = categories.find(c => c.key === category)!.label;

    // Special handling for permissions - show groups
    if (category === 'permissions') {
      const choice = await select<'all' | 'specific' | 'skip'>({
        message: `${categoryLabel}:`,
        choices: [
          { name: `Select all (${permissionGroups.length} groups)`, value: 'all' },
          { name: 'Select specific groups', value: 'specific' },
          { name: 'Skip', value: 'skip' },
        ],
        default: 'all',
      });

      if (choice === 'all') {
        selection.permissions = 'all';
      } else if (choice === 'specific') {
        const selected = await checkbox<string>({
          message: 'Select permission groups to sync:',
          choices: permissionGroups.map(g => ({
            name: `${g.name} (${g.ruleCount} rules)`,
            value: g.name,
            checked: true,
          })),
        });
        if (selected.length > 0) {
          selection.permissions = selected;
        }
      }
    } else {
      // Standard handling for other categories
      const items = available[category];

      const choice = await select<'all' | 'specific' | 'skip'>({
        message: `${categoryLabel}:`,
        choices: [
          { name: `Select all (${items.length})`, value: 'all' },
          { name: 'Select specific', value: 'specific' },
          { name: 'Skip', value: 'skip' },
        ],
        default: 'all',
      });

      if (choice === 'all') {
        selection[category] = 'all';
      } else if (choice === 'specific') {
        const selected = await checkbox<string>({
          message: `Select ${categoryLabel.toLowerCase()} to sync:`,
          choices: items.map(item => ({
            name: item,
            value: item,
            checked: true,
          })),
        });
        if (selected.length > 0) {
          selection[category] = selected;
        }
      }
    }
    // 'skip' means we don't set anything for this category
  }

  return selection;
}

/** Parsed agent@version specification from CLI input. */
export interface AgentSpec {
  agent: AgentId;
  version: string;
}

/**
 * Parse agent@version syntax.
 * Examples:
 *   "claude@1.5.0" -> { agent: "claude", version: "1.5.0" }
 *   "claude" -> { agent: "claude", version: "latest" }
 *   "codex@latest" -> { agent: "codex", version: "latest" }
 */
export function parseAgentSpec(spec: string): AgentSpec | null {
  const parts = spec.split('@');
  if (parts.length > 2) {
    return null;
  }
  const version = parts[1] || 'latest';

  const agent = resolveAgentName(parts[0]);
  if (!agent) {
    return null;
  }

  // Reject any version string that could escape an exec context or a
  // bash-shim interpolation. Real agent versions are semver-shaped or "latest".
  if (!VERSION_RE.test(version)) {
    return null;
  }

  return {
    agent,
    version,
  };
}

/**
 * Get the directory where a specific version is installed.
 */
export function getVersionDir(agent: AgentId, version: string): string {
  return path.join(getVersionsDir(), agent, version);
}

/**
 * Get the binary path for a specific agent version.
 */
export function getBinaryPath(agent: AgentId, version: string): string {
  const agentConfig = AGENTS[agent];
  if (agent === 'grok') {
    const grokDownloads = path.join(getVersionHomePath(agent, version), '.grok', 'downloads');
    // Best effort: first matching file for this version
    try {
      const entries = fs.readdirSync(grokDownloads);
      const match = entries.find((e: string) => e.includes(version) && e.startsWith('grok-'));
      if (match) return path.join(grokDownloads, match);
      const first = entries.find((e: string) => e.startsWith('grok-'));
      if (first) return path.join(grokDownloads, first);
    } catch {}
    return path.join(grokDownloads, `grok-${version}`);
  }
  if (agent === 'droid') {
    // Factory's installer drops a standalone native binary (no npm package,
    // nothing in node_modules/.bin). The binary is global, not per-version —
    // config isolation rides the ~/.factory symlink switch, not a separate
    // binary per version. Install location is platform-specific:
    //   macOS/Linux: ~/.local/bin/droid       (curl app.factory.ai/cli | sh)
    //   Windows:     %USERPROFILE%\bin\droid.exe  (irm app.factory.ai/cli/windows | iex)
    // Mirror the shim's `droid` branch so isVersionInstalled/`agents view`
    // agree with what actually executes.
    return IS_WINDOWS
      ? path.join(getHomeDir(), 'bin', 'droid.exe')
      : path.join(getHomeDir(), '.local', 'bin', 'droid');
  }
  const versionDir = getVersionDir(agent, version);
  return path.join(versionDir, 'node_modules', '.bin', agentConfig.cliCommand);
}

/**
 * Get the isolated HOME directory for a specific agent version.
 * Each version has its own config isolation (like jobs sandbox).
 */
export function getVersionHomePath(agent: AgentId, version: string): string {
  return path.join(getVersionDir(agent, version), 'home');
}

/**
 * Check if a specific version is installed.
 */
export function isVersionInstalled(agent: AgentId, version: string): boolean {
  const binaryPath = getBinaryPath(agent, version);
  return fs.existsSync(binaryPath);
}

/**
 * Get the latest available version from npm for an agent.
 */
export async function getLatestNpmVersion(agent: AgentId): Promise<string | null> {
  const agentConfig = AGENTS[agent];
  if (!agentConfig.npmPackage) return null;

  try {
    const { stdout } = await execFileAsync('npm', ['view', agentConfig.npmPackage, 'version'], { shell: process.platform === 'win32' });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get the oldest published version from npm for an agent.
 */
export async function getOldestNpmVersion(agent: AgentId): Promise<string | null> {
  const agentConfig = AGENTS[agent];
  if (!agentConfig.npmPackage) return null;

  try {
    const { stdout } = await execFileAsync('npm', ['view', agentConfig.npmPackage, 'versions', '--json'], { shell: process.platform === 'win32' });
    const parsed = JSON.parse(stdout.trim());
    // `npm view ... versions --json` returns an array (multiple versions) or a
    // bare string (single published version). Normalize to an array.
    const versions: string[] = Array.isArray(parsed) ? parsed : [parsed];
    const sorted = versions.filter((v) => VERSION_RE.test(v)).sort(compareVersions);
    return sorted[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if 'latest' version is already installed (by resolving to actual version).
 */
export async function isLatestInstalled(agent: AgentId): Promise<{ installed: boolean; version: string | null }> {
  const latestVersion = await getLatestNpmVersion(agent);
  if (!latestVersion) {
    return { installed: false, version: null };
  }
  return { installed: isVersionInstalled(agent, latestVersion), version: latestVersion };
}

/**
 * Check if 'oldest' published version is already installed (by resolving to actual version).
 */
export async function isOldestInstalled(agent: AgentId): Promise<{ installed: boolean; version: string | null }> {
  const oldestVersion = await getOldestNpmVersion(agent);
  if (!oldestVersion) {
    return { installed: false, version: null };
  }
  return { installed: isVersionInstalled(agent, oldestVersion), version: oldestVersion };
}

// Per-process cache for listInstalledVersions. The agent's versions dir mtime
// changes whenever a version dir is added or removed (install/remove), so a
// stamp match means the installed set is unchanged and we skip the readdir +
// N binary stats. Mirrors the readMeta() cache in state.ts. Hot path:
// resolveAgentTargets and every enumerate-style consumer hit this.
const installedVersionsCache = new Map<AgentId, { stamp: number; versions: string[] }>();

/** Drop the installed-versions cache (call after install/remove mutations). */
export function invalidateInstalledVersionsCache(agent?: AgentId): void {
  if (agent) installedVersionsCache.delete(agent);
  else installedVersionsCache.clear();
}

/**
 * List all installed versions for an agent (cached by versions-dir mtime).
 */
export function listInstalledVersions(agent: AgentId): string[] {
  const agentVersionsDir = path.join(getVersionsDir(), agent);
  let stamp: number;
  try {
    stamp = fs.statSync(agentVersionsDir).mtimeMs;
  } catch {
    installedVersionsCache.set(agent, { stamp: 0, versions: [] });
    return [];
  }

  const cached = installedVersionsCache.get(agent);
  if (cached && cached.stamp === stamp) {
    return cached.versions;
  }

  const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  const versions: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const binaryPath = getBinaryPath(agent, entry.name);
      if (fs.existsSync(binaryPath)) {
        versions.push(entry.name);
      }
    }
  }

  versions.sort(compareVersions);
  installedVersionsCache.set(agent, { stamp, versions });
  return versions;
}

/**
 * List every version directory for an agent, including ones missing the
 * binary (typically home-only leftovers from a prior `removeVersion`).
 *
 * Used by `agents prune cleanup` to surface stale installs that the regular
 * `listInstalledVersions` filters out. Do NOT use elsewhere — every other
 * call site assumes a working binary.
 */
export function listInstalledVersionDirs(agent: AgentId): Array<{ version: string; hasBinary: boolean }> {
  const agentVersionsDir = path.join(getVersionsDir(), agent);
  if (!fs.existsSync(agentVersionsDir)) {
    return [];
  }
  const entries = fs.readdirSync(agentVersionsDir, { withFileTypes: true });
  const out: Array<{ version: string; hasBinary: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    out.push({
      version: entry.name,
      hasBinary: fs.existsSync(getBinaryPath(agent, entry.name)),
    });
  }
  return out.sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Get the global default version for an agent.
 */
export function getGlobalDefault(agent: AgentId): string | null {
  const meta = readMeta();
  return meta.agents?.[agent] || null;
}

/**
 * Set the global default version for an agent.
 */
export function setGlobalDefault(agent: AgentId, version: string | undefined): void {
  const meta = readMeta();
  if (!meta.agents) {
    meta.agents = {};
  }
  if (version === undefined) {
    delete meta.agents[agent];
  } else {
    meta.agents[agent] = version;
    emit('version.switch', { agent, version });
  }
  writeMeta(meta);
}

/**
 * Install a specific version of an agent.
 */
export async function installVersion(
  agent: AgentId,
  version: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; installedVersion: string; error?: string }> {
  const agentConfig = AGENTS[agent];

  // Validate before deriving filesystem paths or npm package specs. The CLI
  // parser already enforces this for user input; this guard protects direct
  // callers and tests the critical install path at the source.
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version: ${JSON.stringify(version)}`);
  }

  if (!agentConfig.npmPackage) {
    if (!agentConfig.installScript) {
      return { success: false, installedVersion: version, error: 'Agent has no npm package' };
    }

    if (version !== 'latest' && !agentConfig.installScript.includes('VERSION')) {
      return {
        success: false,
        installedVersion: version,
        error: `${agentConfig.name} installer does not support version-pinned installs. Use ${agent}@latest.`,
      };
    }

    let installedVersion = version;
    try {
      const script = agentConfig.installScript.replaceAll('VERSION', version);
      onProgress?.(`Installing ${agentConfig.name}@${version} via official installer...`);
      await execAsync(script, { timeout: 120000 });

      if (version === 'latest') {
        installedVersion = await getCliVersionFromPath(agent) || version;
        // Fold any stale literal `latest` dir from an earlier probe-failed
        // install into the real version so it stops shadowing `agents view`.
        await reconcileStaleLatestDir(agent, installedVersion);
      }

      onProgress?.(`${agentConfig.name} installed. Setting up agents-cli version home for isolation...`);
    } catch (err: any) {
      emit('version.install', { agent, version, error: err.message });
      return { success: false, installedVersion: version, error: `${agentConfig.name} installer failed: ${err.message}` };
    }

    ensureAgentsDir();
    const versionDir = getVersionDir(agent, installedVersion);
    fs.mkdirSync(versionDir, { recursive: true });
    fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });

    // Symlink the installed binary into the version's node_modules/.bin so
    // listInstalledVersions (which checks getBinaryPath) sees this version as
    // installed. Without this, `agents add antigravity@latest` succeeds
    // but `agents view` shows the agent under "Not Managed" because
    // listInstalledVersions returns [] — the installer drops the binary in
    // ~/.local/bin (or similar) rather than the version's node_modules/.bin.
    //
    // Agents whose binary is special-cased in getBinaryPath (grok ->
    // ~/.grok/downloads, droid -> ~/.local/bin/droid) need no symlink — and
    // creating one is actively harmful: `which <cli>` can resolve to OUR OWN
    // dispatcher shim, because ~/.agents/.cache/shims sits ahead of ~/.local/bin
    // on PATH. Symlinking node_modules/.bin/<cli> at the shim makes the shim
    // exec itself forever. So we skip the resolver-backed agents here AND, for
    // everyone else, filter the shims dir out of the `which` candidates so the
    // same race can't bite a non-special-cased installScript agent.
    if (agent !== 'grok' && agent !== 'droid') {
      // findInPath is a pure-Node PATH scan that already skips our own shims
      // dir — so it returns the genuine install, never our dispatcher shim
      // (which sits ahead of ~/.local/bin on PATH and would otherwise be
      // captured, producing a self-referential node_modules/.bin/<cli> link
      // that exec-loops forever).
      const installedBinary = findInPath(agentConfig.cliCommand);
      if (installedBinary) {
        importInstallScriptBinary(
          { agentId: agent, npmPackage: agentConfig.npmPackage, cliCommand: agentConfig.cliCommand },
          installedVersion,
          installedBinary,
          versionDir
        );
      }
      /* If null: binary missing from PATH (install script failed silently) or
         only our shim is present. Leave the version dir empty so getBinaryPath
         correctly reports it uninstalled. */
    }

    createVersionedAlias(agent, installedVersion);
    emit('version.install', { agent, version: installedVersion });
    return { success: true, installedVersion };
  }

  // Resolve the `oldest` alias to a concrete npm version up front so the rest
  // of the install path treats it as an ordinary pinned install. (`latest`
  // keeps its bare-package-name + post-install-rename handling below.)
  if (version === 'oldest') {
    const oldest = await getOldestNpmVersion(agent);
    if (!oldest) {
      return {
        success: false,
        installedVersion: version,
        error: `Could not resolve the oldest published version for ${agentConfig.name} from npm.`,
      };
    }
    version = oldest;
  }

  ensureAgentsDir();
  const versionDir = getVersionDir(agent, version);

  // Create version directory and isolated home
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(path.join(versionDir, 'home'), { recursive: true });

  // Initialize package.json (only for real npm agents)
  const packageJson = {
    name: `agents-${agent}-${version}`,
    version: '1.0.0',
    private: true,
  };
  fs.writeFileSync(path.join(versionDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  // Install the package
  const packageSpec = version === 'latest'
    ? agentConfig.npmPackage
    : `${agentConfig.npmPackage}@${version}`;
  // The `${agentConfig.npmPackage}@` prefix is load-bearing: it ensures `version`
  // (which VERSION_RE permits to start with `-`) is never passed as a standalone npm CLI flag.

  try {
    // Check npm is available
    const winShell = process.platform === 'win32';
    try {
      await execFileAsync('npm', ['--version'], { shell: winShell });
    } catch {
      return {
        success: false,
        installedVersion: version,
        error: 'npm is not installed. Install Node.js and npm first: https://nodejs.org/',
      };
    }

    onProgress?.(`Installing ${packageSpec}...`);
    const { stdout } = await execFileAsync('npm', ['install', packageSpec], { cwd: versionDir, shell: winShell });

    // Determine the actual installed version
    let installedVersion = version;
    if (version === 'latest') {
      const pkgJsonPath = path.join(versionDir, 'node_modules', agentConfig.npmPackage.replace(/^@/, '').split('/')[0], 'package.json');
      // Try to read the actual version from installed package
      try {
        const installedPkgPath = path.join(versionDir, 'node_modules', agentConfig.npmPackage, 'package.json');
        if (fs.existsSync(installedPkgPath)) {
          const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf-8'));
          installedVersion = installedPkg.version;

          // Rename the directory to the actual version
          if (installedVersion !== 'latest') {
            const actualVersionDir = getVersionDir(agent, installedVersion);
            if (!fs.existsSync(actualVersionDir)) {
              fs.renameSync(versionDir, actualVersionDir);
            } else {
              // Already exists — drop the 'latest' install artifacts but keep
              // `home/` (may contain conversation history from sessions that
              // ran while the user was on `latest`).
              removeInstallArtifacts(versionDir);
            }
          }
        }
      } catch (e) {
        // Failed to determine version - this shouldn't happen
        throw new Error(`Failed to determine installed version: ${(e as Error).message}`);
      }
    }

    // Create versioned alias (e.g., claude@2.0.65)
    createVersionedAlias(agent, installedVersion);

    // Claude reads its global config from CLAUDE_CONFIG_DIR/.claude.json —
    // i.e. inside the per-version .claude dir — while the rest of agents-cli
    // manages the home-level file. Symlink INSIDE to OUTSIDE so Claude and
    // agents-cli see the same content.
    if (agent === 'claude') {
      try {
        ensureClaudeInsideSymlink(installedVersion);
      } catch {
        /* non-fatal; the install itself succeeded */
      }
    }

    emit('version.install', { agent, version: installedVersion });
    return { success: true, installedVersion };
  } catch (err) {
    // Clean up on failure — preserve `home/` in case a prior install left
    // conversation history behind that we must not wipe on a failed reinstall.
    if (fs.existsSync(versionDir)) {
      removeInstallArtifacts(versionDir);
    }
    emit('version.install', { agent, version, error: (err as Error).message });
    return { success: false, installedVersion: version, error: (err as Error).message };
  }
}

/**
 * Remove install artifacts from a version directory, preserving `home/` which
 * contains the user's conversation history, sessions, history.jsonl, tasks,
 * todos, file-history, etc. Used by the install pipeline (NOT by removeVersion)
 * to clean up staging artifacts when a fresh install collides with an existing
 * dir. removeVersion uses soft-delete instead.
 */
function removeInstallArtifacts(versionDir: string): void {
  for (const entry of fs.readdirSync(versionDir)) {
    if (entry === 'home') continue;
    fs.rmSync(path.join(versionDir, entry), { recursive: true, force: true });
  }
}

/**
 * Fold a stale literal `latest` version dir into the real resolved version.
 *
 * Script-installed agents (droid, grok) have no npm package to read a version
 * from, so the installer resolves the version by probing `<cli> --version`
 * after the install script runs. When that probe failed (3s timeout, or the
 * freshly-dropped binary not yet resolvable on PATH) the installer fell back to
 * the literal string `latest`, creating a `versions/<agent>/latest/` dir. A
 * later install where the probe succeeded then created a SECOND dir at the real
 * semver, orphaning `latest` — and because these agents' getBinaryPath points
 * at a single global binary regardless of version dir, `latest` keeps showing
 * up in `agents view` next to the real version forever.
 *
 * Call this once the install path has resolved a real version: if a stale
 * `latest` dir exists, rename it onto the real version (preserving `home/`), or
 * if the real dir already exists, soft-delete the `latest` dir to trash. No-op
 * when nothing was resolved or no stale dir is present, so it is safe to call
 * on every script-based install. Returns the action taken (for tests/logging).
 */
export async function reconcileStaleLatestDir(
  agent: AgentId,
  installedVersion: string,
): Promise<'none' | 'renamed' | 'trashed'> {
  if (installedVersion === 'latest') return 'none';

  const staleLatestDir = getVersionDir(agent, 'latest');
  const realVersionDir = getVersionDir(agent, installedVersion);
  if (staleLatestDir === realVersionDir || !fs.existsSync(staleLatestDir)) {
    return 'none';
  }

  if (!fs.existsSync(realVersionDir)) {
    fs.renameSync(staleLatestDir, realVersionDir);
    return 'renamed';
  }

  // Both dirs exist. Stripping install artifacts would not hide `latest` for
  // global-binary agents (getBinaryPath ignores dir contents), so the whole
  // dir must go. Soft-delete to trash so any `home/` data stays recoverable
  // via `agents restore <agent>@latest`, then rewrite session file paths to
  // point at the trashed location so history stays readable. The session-db
  // module is imported lazily — it carries a top-level await that the CJS test
  // harness can't statically transform, so it must stay out of the eager graph.
  const trashPath = softDeleteVersionDir(agent, 'latest');
  if (trashPath) {
    const { updateSessionFilePaths } = await import('./session/db.js');
    updateSessionFilePaths(staleLatestDir, trashPath);
  }
  return 'trashed';
}

/**
 * Soft-delete a version directory by moving it to ~/.agents/.system/trash/versions/.
 * Returns the trash path on success or null on failure / no source.
 *
 * Trash layout: ~/.agents/.system/trash/versions/<agent>/<version>/<timestamp>/
 * The timestamp suffix lets a user soft-delete the same version twice (after
 * re-install) without collision and gives a chronological audit trail.
 *
 * The whole versionDir moves — including `home/` (transcripts, sessions). The
 * user can recover everything via `agents trash restore <agent>@<version>`.
 * Nothing is ever hard-deleted.
 */
export function softDeleteVersionDir(agent: AgentId, version: string): string | null {
  const versionDir = getVersionDir(agent, version);
  if (!fs.existsSync(versionDir)) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashRoot = getTrashVersionsDir();
  const trashAgentDir = path.join(trashRoot, agent, version);
  const trashDest = path.join(trashAgentDir, stamp);

  try {
    fs.mkdirSync(trashAgentDir, { recursive: true, mode: 0o700 });
    try {
      fs.renameSync(versionDir, trashDest);
    } catch (renameErr) {
      // On Windows, rename fails with EPERM/EACCES when any file in the tree
      // is locked by a running process. Fall back to recursive copy + delete.
      if ((renameErr as NodeJS.ErrnoException).code !== 'EPERM' && (renameErr as NodeJS.ErrnoException).code !== 'EACCES') throw renameErr;
      fs.cpSync(versionDir, trashDest, { recursive: true });
      fs.rmSync(versionDir, { recursive: true, force: true });
    }
    return trashDest;
  } catch {
    return null;
  }
}

/**
 * Remove a specific version of an agent.
 *
 * Soft-delete only: moves the entire version directory (including `home/`)
 * to ~/.agents/.system/trash/versions/. Recoverable via `agents trash restore`.
 * Nothing is hard-deleted.
 */
export function removeVersion(agent: AgentId, version: string): boolean {
  const versionDir = getVersionDir(agent, version);

  if (!fs.existsSync(versionDir)) {
    return false;
  }

  const trashPath = softDeleteVersionDir(agent, version);
  if (!trashPath) {
    return false;
  }

  // Remove versioned alias (e.g., claude@2.0.65)
  removeVersionedAlias(agent, version);

  // Clear default if it was the removed version - user must explicitly pick a new one
  if (getGlobalDefault(agent) === version) {
    const meta = readMeta();
    if (meta.agents?.[agent]) {
      delete meta.agents[agent];
      writeMeta(meta);
    }
    const remaining = listInstalledVersions(agent);
    if (remaining.length > 0) {
      console.log(chalk.yellow(`Default version removed. Run: agents use ${agent}@<version> to set a new default`));
    }
  }

  // Clean up dangling config symlink if it pointed to the removed version
  const symlinkVersion = getConfigSymlinkVersion(agent);
  if (symlinkVersion === version) {
    const configPath = path.join(getHomeDir(), agentConfigDirName(agent));
    try {
      fs.unlinkSync(configPath);
    } catch {
      // Ignore if already gone
    }
  }

  emit('version.remove', { agent, version });
  return true;
}

/**
 * Print the standard footer after one or more versions were soft-deleted to
 * trash. Reminds the user that sessions stay readable and how to restore.
 */
export function printTrashFooter(moved: Array<{ agent: AgentId; version: string }>): void {
  if (moved.length === 0) return;
  console.log();
  console.log(chalk.gray('Sessions remain accessible via `agents sessions`.'));
  if (moved.length === 1) {
    const { agent, version } = moved[0];
    console.log(chalk.gray(`Restore with: agents restore ${agent}@${version}`));
  } else {
    console.log(chalk.gray('Restore with: agents restore <agent>@<version>  (run `agents trash list` to see)'));
  }
}

/**
 * Remove all versions of an agent. Preserves each version's `home/` directory
 * so conversation history is never deleted; the per-version folders (now
 * containing only `home/`) remain under the agent dir.
 */
export function removeAllVersions(agent: AgentId): number {
  const versions = listInstalledVersions(agent);
  let removed = 0;

  for (const version of versions) {
    if (removeVersion(agent, version)) {
      removed++;
    }
  }

  return removed;
}

/**
 * Get the resolved version for an agent in the current context.
 * Checks project manifest first, then global default.
 */
export function resolveVersion(agent: AgentId, projectPath?: string): string | null {
  // Check project manifest
  if (projectPath) {
    const version = getProjectVersion(agent, projectPath);
    if (version) {
      return version;
    }
  }

  // Fall back to global default
  return getGlobalDefault(agent);
}

/**
 * Normalize a user-supplied @version token across CLI subcommands.
 *
 *   undefined / "" / "default" / "pinned" -> undefined  (caller falls back to project pin or global default)
 *   "any"                       -> undefined  (caller imposes no version constraint — e.g. resume across any version)
 *   "latest"                    -> highest installed version (process.exit if none installed)
 *   "oldest"                    -> lowest installed version (process.exit if none installed)
 *   "x.y.z" (installed)         -> "x.y.z"
 *   "x.y.z" (not installed)     -> process.exit with installed-list hint
 *
 * `pinned` is a synonym for `default`: both name the project pin / global
 * default, which the caller resolves.
 *
 * Use this anywhere the user can type `agents <cmd> claude@<token>` to keep the
 * vocabulary consistent. Subcommands with different semantics for `latest`
 * (install/remove/use, where `latest` means npm-latest) keep their existing
 * parsing.
 */
export function resolveVersionAlias(agent: AgentId, raw: string | undefined | null): string | undefined {
  if (!raw || raw === 'default' || raw === 'pinned' || raw === 'any') return undefined;

  if (raw === 'latest' || raw === 'oldest') {
    const installed = listInstalledVersions(agent);
    if (installed.length === 0) {
      console.error(chalk.red(`No ${agent} versions installed.`));
      console.error(chalk.gray(`Install one: agents versions install ${agent}`));
      process.exit(1);
    }
    return raw === 'oldest' ? installed[0] : installed[installed.length - 1];
  }

  if (!isVersionInstalled(agent, raw)) {
    const installed = listInstalledVersions(agent);
    console.error(chalk.red(`${agent}@${raw} is not installed.`));
    if (installed.length > 0) {
      console.error(chalk.gray(`Installed: ${installed.join(', ')}`));
    }
    console.error(chalk.gray(`Install it: agents versions install ${agent}@${raw}`));
    process.exit(1);
  }
  return raw;
}

/**
 * Loose variant of resolveVersionAlias for record-filter contexts (sessions,
 * team history). Same `default`/`pinned`/`latest`/`oldest` semantics, but explicit
 * versions pass through unchanged so historical records of uninstalled versions
 * remain queryable.
 */
export function resolveVersionAliasLoose(agent: AgentId, raw: string | undefined | null): string | undefined {
  if (!raw || raw === 'default' || raw === 'pinned' || raw === 'any') return undefined;
  if (raw === 'latest' || raw === 'oldest') {
    const installed = listInstalledVersions(agent);
    if (installed.length === 0) return undefined;
    return raw === 'oldest' ? installed[0] : installed[installed.length - 1];
  }
  return raw;
}

/**
 * Get version specified in a project-root agents.yaml (not the user ~/.agents/.system/agents.yaml).
 */
export function getProjectVersion(agent: AgentId, startPath: string): string | null {
  const userAgentsYaml = path.join(getUserAgentsDir(), 'agents.yaml');
  let dir = path.resolve(startPath);

  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, 'agents.yaml');
    if (manifestPath !== userAgentsYaml && fs.existsSync(manifestPath)) {
      try {
        const content = fs.readFileSync(manifestPath, 'utf-8');
        const parsed = yaml.parse(content);
        const version = parsed?.agents?.[agent];
        if (typeof version === 'string' && version.trim()) {
          const normalized = version.trim();
          if (!VERSION_RE.test(normalized)) {
            throw new Error(`Invalid version in agents.yaml for ${agent}: ${normalized}. Allowed: latest or [A-Za-z0-9._+-]{1,64}`);
          }
          return normalized;
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Invalid version in agents.yaml')) {
          throw err;
        }
        // Ignore parsing errors
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Compare semver versions for sorting.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map((n) => parseInt(n, 10) || 0);
  const bParts = b.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal !== bVal) {
      return aVal - bVal;
    }
  }

  return 0;
}

/**
 * Get actual version from an installed 'latest' directory.
 */
export async function getInstalledVersion(agent: AgentId, version: string): Promise<string | null> {
  const binaryPath = getBinaryPath(agent, version);
  if (!fs.existsSync(binaryPath)) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version']);
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : version;
  } catch {
    return version;
  }
}

async function getCliVersionFromPath(agent: AgentId): Promise<string | null> {
  const agentConfig = AGENTS[agent];
  try {
    const { stdout } = await execFileAsync(agentConfig.cliCommand, ['--version'], { timeout: 3000, shell: process.platform === 'win32' });
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Outcome of syncing resources to a version home, keyed by resource type. */
export interface SyncResult {
  commands: boolean;
  skills: boolean;
  hooks: boolean;
  memory: string[];
  permissions: boolean;
  mcp: string[];
  subagents: string[];
  plugins: string[];
  workflows: string[];
}

/** Diff between central ~/.agents/ resources and what is synced to a version home. */
export interface ResourceDiff {
  commands: { added: string[]; dangling: string[] };
  skills: { added: string[]; dangling: string[] };
  hooks: { added: string[]; dangling: string[] };
  memory: { added: string[]; dangling: string[] };
  totalAdded: number;
  totalDangling: number;
}

/**
 * Get the diff between central resources (~/.agents/) and what's synced to a version.
 * Uses filesystem state - no tracking needed.
 */
export function getResourceDiff(agent: AgentId, version: string): ResourceDiff {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, agentConfigDirName(agent));

  const diff: ResourceDiff = {
    commands: { added: [], dangling: [] },
    skills: { added: [], dangling: [] },
    hooks: { added: [], dangling: [] },
    memory: { added: [], dangling: [] },
    totalAdded: 0,
    totalDangling: 0,
  };

  // Helper to check symlink status
  const getSymlinkStatus = (linkPath: string): 'valid' | 'dangling' | 'none' => {
    try {
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) return 'none';
      // Check if target exists
      try {
        fs.statSync(linkPath);
        return 'valid';
      } catch {
        return 'dangling';
      }
    } catch {
      return 'none';
    }
  };

  // Commands: check directory symlink (or individual files for Gemini / generated skills for newer Codex)
  const centralCommands = getCommandsDir();
  const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);

  if (shouldInstallCommandAsSkill(agent, version)) {
    const centralFiles = fs.existsSync(centralCommands)
      ? fs.readdirSync(centralCommands).filter(f => f.endsWith('.md'))
      : [];
    const centralNames = new Set(centralFiles.map(f => f.replace('.md', '')));
    const versionNames = new Set(listCommandSkillsInVersion(agentDir));

    for (const file of centralFiles) {
      const name = file.replace('.md', '');
      if (!versionNames.has(name)) {
        diff.commands.added.push(file);
      }
    }

    for (const name of versionNames) {
      if (!centralNames.has(name)) {
        diff.commands.dangling.push(`${name}.md`);
      }
    }
  } else if (agentConfig.format === 'toml') {
    // Gemini: compare .md files in central vs .toml files in version
    if (fs.existsSync(centralCommands)) {
      const centralFiles = fs.readdirSync(centralCommands).filter(f => f.endsWith('.md'));
      const versionFiles = fs.existsSync(commandsTarget)
        ? fs.readdirSync(commandsTarget).filter(f => f.endsWith('.toml'))
        : [];
      const versionNames = new Set(versionFiles.map(f => f.replace('.toml', '')));

      for (const file of centralFiles) {
        const name = file.replace('.md', '');
        if (!versionNames.has(name)) {
          diff.commands.added.push(file);
        }
      }
      // Check for dangling (toml exists but no md source)
      const centralNames = new Set(centralFiles.map(f => f.replace('.md', '')));
      for (const file of versionFiles) {
        const name = file.replace('.toml', '');
        if (!centralNames.has(name)) {
          diff.commands.dangling.push(file);
        }
      }
    }
  } else {
    // Other agents: check directory symlink
    const status = getSymlinkStatus(commandsTarget);
    if (status === 'none' && fs.existsSync(centralCommands)) {
      const files = fs.readdirSync(centralCommands).filter(f => f.endsWith('.md'));
      diff.commands.added = files;
    } else if (status === 'dangling') {
      diff.commands.dangling = ['commands/'];
    }
  }

  // Skills: check directory symlink (skip if agent natively reads ~/.agents/skills/)
  if (!agentConfig.nativeAgentsSkillsDir) {
    const centralSkills = getSkillsDir();
    const skillsTarget = path.join(agentDir, 'skills');
    const skillsStatus = getSymlinkStatus(skillsTarget);
    if (skillsStatus === 'none' && fs.existsSync(centralSkills)) {
      const dirs = fs.readdirSync(centralSkills).filter(f => {
        const stat = fs.statSync(path.join(centralSkills, f));
        return stat.isDirectory() && !f.startsWith('.');
      });
      diff.skills.added = dirs;
    } else if (skillsStatus === 'dangling') {
      diff.skills.dangling = ['skills/'];
    }
  }

  // Hooks: check directory symlink (if agent supports hooks)
  if (agentConfig.supportsHooks) {
    const centralHooks = getHooksDir();
    const hooksTarget = path.join(agentDir, 'hooks');
    const hooksStatus = getSymlinkStatus(hooksTarget);
    if (hooksStatus === 'none' && fs.existsSync(centralHooks)) {
      const files = fs.readdirSync(centralHooks).filter(f => !f.startsWith('.'));
      diff.hooks.added = files;
    } else if (hooksStatus === 'dangling') {
      diff.hooks.dangling = ['hooks/'];
    }
  }

  // Rules: check individual file symlinks
  const systemRulesDir = getResolvedRulesDir();
  if (fs.existsSync(systemRulesDir)) {
    const ruleFiles = fs.readdirSync(systemRulesDir).filter(f => f.endsWith('.md') && f !== RULES_DOC_FILENAME);
    for (const file of ruleFiles) {
      const targetName = file === 'AGENTS.md' ? agentConfig.instructionsFile : file;
      const targetPath = path.join(agentDir, targetName);
      const status = getSymlinkStatus(targetPath);
      if (status === 'none') {
        diff.memory.added.push(file);
      } else if (status === 'dangling') {
        diff.memory.dangling.push(targetName);
      }
    }
  }

  // Calculate totals
  diff.totalAdded = diff.commands.added.length + diff.skills.added.length +
    diff.hooks.added.length + diff.memory.added.length;
  diff.totalDangling = diff.commands.dangling.length + diff.skills.dangling.length +
    diff.hooks.dangling.length + diff.memory.dangling.length;

  return diff;
}

/**
 * Enumerate the DotAgent repo names that resources can be scoped to:
 * the fixed `project` / `user` / `system` layers plus every enabled extra
 * repo alias. Used to validate `agents sync <agent> --repo <name>`.
 */
export function listRepoNames(): string[] {
  return ['project', 'user', 'system', ...getEnabledExtraRepos().map(e => e.alias)];
}

/** Pattern-selectable resource kinds — every kind whose selection is
 * driven by `source:name` patterns (memory is preset-driven, handled apart). */
type SelectableKind = 'commands' | 'skills' | 'hooks' | 'subagents' | 'permissions' | 'mcp' | 'plugins' | 'workflows';

/**
 * Build the name→source-layer map for one resource kind, the input
 * `expandPatterns` matches `source:*` patterns against. This is the single
 * source of truth for how each kind attributes its source layer:
 *   - commands/skills/hooks/subagents → real layer from `listResources`
 *   - permissions                     → always the system repo
 *   - mcp                             → project vs user scope preserved
 *   - plugins/workflows               → user repo
 * Both the persisted-pattern sync path and `buildRepoScopedSelection` use it
 * so the attribution can't drift between the two.
 */
function resourceSourceMap(kind: SelectableKind, cwd: string, available: AvailableResources): Map<string, string> {
  switch (kind) {
    case 'commands':
    case 'skills':
    case 'hooks':
    case 'subagents':
      return new Map(listResources(kind, cwd).map(r => [r.name, r.source]));
    case 'permissions':
      return new Map(available.permissions.map(n => [n, 'system']));
    case 'mcp':
      return new Map(getScopedMcpResources(cwd).map(r => [r.name, r.scope]));
    case 'plugins':
      return new Map(available.plugins.map(n => [n, 'user']));
    case 'workflows':
      return new Map(available.workflows.map(n => [n, 'user']));
  }
}

/**
 * Build a ResourceSelection scoped to a single DotAgent repo (`system`,
 * `user`, `project`, or an extra-repo alias). Every resource kind is filtered
 * to the entries whose source layer matches `repo`, reusing the same
 * name→source maps and `source:*` pattern expansion the persisted-pattern
 * sync path uses. Passing the result as an explicit `selection` means the sync
 * touches only that repo's resources — no orphan-sweep of the other layers.
 *
 * `memory` is set to `[]` (not omitted): that empty-array sentinel is what
 * `syncResourcesToVersion`'s `skipMemory` gate keys on to leave the memory
 * file untouched — it's a merge of all layers, not a per-repo artifact.
 */
export function buildRepoScopedSelection(repo: string, cwd: string = process.cwd()): ResourceSelection {
  const patterns = [`${repo}:*`];
  const available = getAvailableResources(cwd);
  const selection: ResourceSelection = {};

  const kinds: SelectableKind[] = ['commands', 'skills', 'hooks', 'subagents', 'permissions', 'mcp', 'plugins', 'workflows'];
  for (const kind of kinds) {
    const names = expandPatterns(patterns, resourceSourceMap(kind, cwd, available));
    if (names.length > 0) selection[kind] = names;
  }

  // Empty-array sentinel → skip the memory writer (see skipMemory below).
  selection.memory = [];
  return selection;
}

/**
 * Sync central resources (~/.agents/) into a specific version's config directory.
 * Copies selected resources from central storage into {versionHome}/.{agent}/.
 *
 * @param agent - The agent ID
 * @param version - The version string
 * @param selection - Optional resource selection. If not provided, syncs all resources.
 *
 * For Gemini: commands are converted from markdown to TOML.
 */
export function syncResourcesToVersion(agent: AgentId, version: string, selection?: ResourceSelection, options: { projectDir?: string; cwd?: string; force?: boolean } = {}): SyncResult {
  const agentConfig = AGENTS[agent];
  const versionHome = getVersionHomePath(agent, version);
  const agentDir = path.join(versionHome, agentConfigDirName(agent));
  fs.mkdirSync(agentDir, { recursive: true });
  // Capture whether the caller passed a selection. The pattern-expansion
  // path below reassigns `selection`, but for manifest write semantics we
  // care about the ORIGINAL intent: a caller passing no selection means
  // "full sync; persist the staleness manifest after."
  const userPassedSelection = selection !== undefined;

  const result: SyncResult = { commands: false, skills: false, hooks: false, memory: [], permissions: false, mcp: [], subagents: [], plugins: [], workflows: [] };
  const cwd = options.cwd || process.cwd();
  const projectAgentsDir = options.projectDir || getProjectAgentsDir(cwd);
  const userAgentsDir = getUserAgentsDir();
  // Extra DotAgent repos registered via `agents repo add`. Looked up last so
  // project/user/system repos win on name collisions.
  const extraRepos = getEnabledExtraRepos();
  const available = getAvailableResources(cwd);

  // Write default resource selection patterns for this version (idempotent —
  // only sets fields that aren't already present, preserving user edits).
  {
    const extraAliases = extraRepos.map(e => e.alias);
    const allLayers = defaultPatterns(extraAliases);
    const noProject = defaultPatterns(extraAliases, false);
    ensureVersionResourcePatterns(agent, version, {
      commands:    allLayers,
      skills:      allLayers,
      hooks:       noProject,     // hooks: no project layer (security)
      subagents:   noProject,
      plugins:     noProject,
      workflows:   noProject,
      permissions: ['system:*'],
      mcp:         ['user:*'],
    });
  }

  // If no explicit selection was passed, build one from the persisted resource
  // patterns. This lets users customize agents.yaml to control which resources
  // are synced (e.g. "skills: [system:brain-scan user:creative]").
  // When patterns are the default (every layer wildcard), the expanded result
  // equals the full available set — identical to the old behavior.
  if (!selection) {
    const vr = getVersionResources(agent, version);
    if (vr) {
      const patternSelection: ResourceSelection = {};

      // Listable resource types: use listResources to get name→source maps.
      const listableTypes: Array<['commands' | 'skills' | 'hooks' | 'subagents', 'commands' | 'skills' | 'hooks' | 'subagents']> = [
        ['commands', 'commands'],
        ['skills',   'skills'],
        ['hooks',    'hooks'],
        ['subagents','subagents'],
      ];
      for (const [type, kind] of listableTypes) {
        const patterns = vr[type];
        if (!Array.isArray(patterns) || patterns.length === 0) continue;
        patternSelection[type] = expandPatterns(patterns, resourceSourceMap(kind, cwd, available));
      }

      // permissions / mcp / plugins / workflows: source attribution lives in
      // resourceSourceMap so it can't drift from buildRepoScopedSelection.
      if (Array.isArray(vr.permissions) && vr.permissions.length > 0) {
        patternSelection.permissions = expandPatterns(vr.permissions, resourceSourceMap('permissions', cwd, available));
      }
      if (Array.isArray(vr.mcp) && vr.mcp.length > 0) {
        patternSelection.mcp = expandPatterns(vr.mcp, resourceSourceMap('mcp', cwd, available));
      }
      if (Array.isArray(vr.plugins) && vr.plugins.length > 0) {
        patternSelection.plugins = expandPatterns(vr.plugins, resourceSourceMap('plugins', cwd, available));
      }
      if (Array.isArray(vr.workflows) && vr.workflows.length > 0) {
        patternSelection.workflows = expandPatterns(vr.workflows, resourceSourceMap('workflows', cwd, available));
      }

      // memory is not pattern-controlled (rulesPreset handles it) — always sync.
      patternSelection.memory = 'all';

      if (Object.keys(patternSelection).length > 0) {
        selection = patternSelection;
      }
    }
  }

  // Fast guard: skip the entire sync when the caller requested a full sync and
  // nothing has changed since the last full sync. Pattern-derived selections
  // still count as full syncs because they are the persisted intended scope,
  // not a one-off caller override.
  if (!userPassedSelection && !options.force) {
    const manifest = loadManifest(agent, version);
    if (manifest && !isStale(manifest, agent, version, cwd)) {
      return { commands: false, skills: false, hooks: false, memory: [], permissions: false, mcp: [], subagents: [], plugins: [], workflows: [] };
    }
  }

  // Helper: remove a path (symlink or real) if it exists
  const removePath = (p: string) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink() || stat.isFile()) {
        fs.unlinkSync(p);
      } else if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch { /* file already removed or inaccessible */ }
  };

  // Helper: copy a directory recursively
  const copyDir = (src: string, dest: string) => {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (shouldSkillEntryBeSkipped(entry.name)) continue;
      const srcPath = safeJoin(src, entry.name);
      const destPath = safeJoin(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };

  // Helper: resolve selection to list of items
  const resolveSelection = (sel: string[] | 'all' | undefined, available: string[]): string[] => {
    if (sel === 'all') return available;
    if (Array.isArray(sel)) {
      const availableSet = new Set(available);
      return sel.filter((item) => availableSet.has(item));
    }
    return [];
  };

  // Sync commands — dispatch through WRITERS.commands. The writer dispatches
  // between native (file copy / TOML conversion) and commands-as-skills
  // (grok, Codex >= 0.117.0) based on `shouldInstallCommandAsSkill`. The
  // previous COMMANDS_CAPABLE_AGENTS gate excluded grok even though it
  // takes the commands-as-skills path — silently dropping every command.
  const commandsWriter = getWriter('commands', agent);
  const commandsToSync = selection
    ? resolveSelection(selection.commands, available.commands)
    : available.commands; // No selection = sync all
  const commandsAsSkills = shouldInstallCommandAsSkill(agent, version);

  if (commandsToSync.length > 0 && commandsWriter) {
    const commandsTarget = path.join(agentDir, agentConfig.commandsSubdir);
    if (commandsAsSkills && agentConfig.commandsSubdir) {
      removePath(commandsTarget);
    }
    const r = commandsWriter.write({ version, versionHome, selection: commandsToSync, cwd });
    result.commands = r.synced.length > 0;
  }

  // Orphan-sweep stale top-level command files from previous syncs under a
  // different cwd. Only runs in "full sync" mode — i.e. when the caller did
  // not pass an explicit `selection`. Callers that pass explicit selections
  // are using the incremental/additive API (sync exactly these; leave others
  // alone), so the sweep would be a contract violation there. The
  // cross-project leak always comes from the no-selection shim auto-sync at
  // launch.
  if (!userPassedSelection && commandsWriter && !shouldInstallCommandAsSkill(agent, version)) {
    const commandsTargetSweep = path.join(agentDir, agentConfig.commandsSubdir);
    if (fs.existsSync(commandsTargetSweep)) {
      const ext = agentConfig.format === 'toml' ? '.toml' : '.md';
      const trustedCommands = new Set(commandsToSync);
      for (const entry of fs.readdirSync(commandsTargetSweep, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        if (!entry.name.endsWith(ext)) continue;
        const name = entry.name.slice(0, -ext.length);
        if (!trustedCommands.has(name)) {
          removePath(safeJoin(commandsTargetSweep, entry.name));
        }
      }
    }
  }

  // Sync skills — dispatch through WRITERS.skills. Agents that natively read
  // ~/.agents/skills/ (Gemini) are not registered; we clear the version-home
  // skills dir for them so a stale per-version copy never shadows central.
  const skillsWriter = getWriter('skills', agent);
  let skillsToSync = selection
    ? resolveSelection(selection.skills, available.skills)
    : available.skills;
  if (commandsAsSkills && commandsToSync.length > 0 && skillsToSync.length > 0) {
    const commandNames = new Set(commandsToSync);
    const skillRoots = [
      path.join(getUserAgentsDir(), 'skills'),
      getSkillsDir(),
      ...getEnabledExtraRepos().map((e) => path.join(e.dir, 'skills')),
    ];
    skillsToSync = skillsToSync.filter((skill) => {
      if (!commandNames.has(skill)) return true;
      return readSkillSourceCommandMarker(skill, skillRoots) !== skill;
    });
  }

  if (agentConfig.nativeAgentsSkillsDir) {
    removePath(path.join(agentDir, 'skills'));
  } else if (skillsWriter) {
    if (skillsToSync.length > 0) {
      const r = skillsWriter.write({ version, versionHome, selection: skillsToSync, cwd });
      result.skills = r.synced.length > 0;
    }

    // Orphan-sweep stale skill directories from previous syncs under a
    // different cwd. Only runs in "full sync" mode (no explicit selection) —
    // see the matching guard on the commands sweep above for why. Skip
    // dot-dirs to keep plugin-managed subtrees (.plugins/, .promptcuts) intact.
    const skillsTargetSweep = path.join(agentDir, 'skills');
    if (!userPassedSelection && fs.existsSync(skillsTargetSweep) && !fs.lstatSync(skillsTargetSweep).isSymbolicLink()) {
      // Trust real skills AND command-skills: when commandsAsSkills, the
      // commands writer (above) materialized each command as a skill dir under
      // skills/. Those names are not in skillsToSync, so without this they'd be
      // swept as orphans — silently deleting every converted command (e.g.
      // /recap on kimi/grok).
      const trustedSkills = new Set(skillsToSync);
      if (commandsAsSkills) for (const cmd of commandsToSync) trustedSkills.add(cmd);
      for (const entry of fs.readdirSync(skillsTargetSweep, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (!trustedSkills.has(entry.name)) {
          removePath(safeJoin(skillsTargetSweep, entry.name));
        }
      }
    }
  }

  // Sync hooks — dispatch through WRITERS.hooks. supports() gate enforces
  // the version cutoff (codex >= 0.116.0, gemini >= 0.26.0).
  const hooksGate = supports(agent, 'hooks', version);
  const hooksWriter = getWriter('hooks', agent);
  if (agentConfig.supportsHooks && hooksWriter) {
    if (!hooksGate.ok) {
      console.warn(explainSkip(agent, 'hooks', hooksGate, version) + ' -- skipped');
    } else {
      const hooksToSync = selection
        ? resolveSelection(selection.hooks, available.hooks)
        : available.hooks;

      if (hooksToSync.length > 0) {
        const r = hooksWriter.write({ version, versionHome, selection: hooksToSync, cwd });
        // Remove orphan files from version home. The trusted set is the
        // manifest-declared hook list (`available.hooks`) — auxiliary files
        // like README.md or promptcuts.yaml may exist alongside hooks at the
        // source but are not hooks and must not linger in version homes from
        // older syncs.
        const hooksTarget = path.join(agentDir, 'hooks');
        const trustedHookNames = new Set(available.hooks);
        if (fs.existsSync(hooksTarget)) {
          for (const file of fs.readdirSync(hooksTarget).filter(f => !f.startsWith('.'))) {
            if (!trustedHookNames.has(file)) {
              removePath(safeJoin(hooksTarget, file));
            }
          }
        }
        result.hooks = r.synced.length > 0;
      }
    }
  }

  // Sync rules — dispatch through WRITERS.rules. The registry routes to the
  // single-target writer for any agent that declares `rules: { file }` in
  // its capability matrix (grok included; the previous gate used the wrong
  // CAPABLE_AGENTS list and silently skipped it). Project rules are NOT
  // synced into the version home — they are composed into the workspace at
  // agents-run time (see compileRulesForProject).
  const skipMemory = selection && Array.isArray(selection.memory) && selection.memory.length === 0;
  const rulesWriter = getWriter('rules', agent);
  if (!skipMemory && rulesWriter) {
    try {
      // If selection.memory names a single preset, treat it as a one-shot
      // override; otherwise read the persisted active preset.
      const overridePreset = Array.isArray(selection?.memory) && selection!.memory.length === 1 && selection!.memory[0] !== 'AGENTS'
        ? selection!.memory[0]
        : null;
      const preset = overridePreset || getActiveRulesPreset(agent, version);
      const r = rulesWriter.write({ version, versionHome, selection: { preset }, cwd });
      result.memory.push(...r.synced);
      // rulesPreset is tracked separately via setActiveRulesPreset.
    } catch (err) {
      // No rules.yaml yet, or a typo'd preset name. Don't fail the whole sync —
      // just leave the agent without a synced rules file.
      console.warn(`Skipping rules sync for ${agent}@${version}: ${(err as Error).message}`);
    }
  }

  // Apply permissions (if agent supports them).
  // Groups live in ~/.agents/permissions/groups/. Optional recipes in
  // ~/.agents/permissions/presets/<name>.yaml pick a subset via `includes:`.
  // If AGENTS_PERMISSION_PRESET is set, we resolve that recipe and use its
  // includes list as the group filter (intersected with groups on disk).
  // Note: discoverPermissionGroups intentionally reads from user + system
  // only — never from a project's .agents/permissions/. Permissions gate
  // every other action, so a cloned public repo must not be able to widen
  // its own sandbox by shipping a permissions group. Same defense as hooks.
  const permissionGroups = discoverPermissionGroups();
  const allGroupNames = permissionGroups.map(g => g.name);
  const activePresetName = getActivePermissionPresetName();
  let presetFilteredGroups: string[] | null = null;
  if (activePresetName) {
    const recipe = readPermissionPresetRecipe(activePresetName);
    if (recipe) {
      const available = new Set(allGroupNames);
      presetFilteredGroups = recipe.includes.filter(g => available.has(g));
    } else {
      console.warn(`${PERMISSION_PRESET_ENV_VAR}=${activePresetName} but no recipe at ~/.agents/permissions/presets/${activePresetName}.yaml — falling back to all groups`);
    }
  }
  const permissionsWriter = getWriter('permissions', agent);
  let permsToSync: string[];
  if (selection) {
    permsToSync = resolveSelection(selection.permissions, allGroupNames);
    // If a preset recipe is active, the recipe's includes list always wins —
    // even when the caller passed an explicit array via selection. Without
    // this intersection, `agents add`'s buildAutomaticSelection would pass
    // every group name discovered on disk (including 99-deny), bypassing
    // the sandbox filter.
    if (presetFilteredGroups) {
      const filterSet = new Set(presetFilteredGroups);
      permsToSync = permsToSync.filter(g => filterSet.has(g));
    }
  } else {
    permsToSync = permissionsWriter ? (presetFilteredGroups ?? allGroupNames) : [];
  }

  if (permsToSync.length > 0 && permissionsWriter) {
    const r = permissionsWriter.write({ version, versionHome, selection: permsToSync, cwd });
    result.permissions = r.synced.length > 0;
    // permissions patterns already written via ensureVersionResourcePatterns above.
  }

  // Install MCP servers (if agent supports them)
  // For Claude/Codex: uses CLI commands (claude mcp add, codex mcp add)
  // For others: edits config files directly
  //
  // Mirror the hooks defense: exclude project-scoped MCPs from the sync. An
  // MCP server is an executable invoked under the agent's authority, so a
  // cloned public repo's .agents/mcp/foo.yaml could install an arbitrary
  // command. We pre-compute the set of project-scoped names and drop them
  // before handing the list to installMcpServers. (The deeper helper-side
  // dedup in lib/mcp.ts still lets a project entry shadow a same-named
  // user entry, so name-collision shadowing is not fully closed here —
  // tracked separately for a follow-up in lib/mcp.ts.)
  const projectScopedMcpNames = new Set(
    getScopedMcpResources(cwd).filter(r => r.scope === 'project').map(r => r.name)
  );
  const mcpWriter = getWriter('mcp', agent);
  const mcpToSyncAll = selection
    ? resolveSelection(selection.mcp, available.mcp)
    : (mcpWriter ? available.mcp : []);
  const mcpToSync = mcpToSyncAll.filter(n => !projectScopedMcpNames.has(n));

  if (mcpToSync.length > 0 && mcpWriter) {
    const r = mcpWriter.write({ version, versionHome, selection: mcpToSync, cwd });
    result.mcp = r.synced;
    // mcp patterns already written via ensureVersionResourcePatterns above.
  }

  // Sync subagents — dispatch through WRITERS.subagents. listInstalledSubagents
  // reads only user + system layers (project excluded for the same defense
  // as commands/skills/hooks).
  const subagentsWriter = getWriter('subagents', agent);
  const subagentsToSync = selection
    ? resolveSelection(selection.subagents, available.subagents)
    : (subagentsWriter ? available.subagents : []);

  if (subagentsToSync.length > 0 && subagentsWriter) {
    const r = subagentsWriter.write({ version, versionHome, selection: subagentsToSync, cwd });
    result.subagents.push(...r.synced);

    // Orphan-sweep for Claude only — see comment on commands/skills sweep
    // for the no-selection guard. OpenClaw stores subagents as siblings of
    // other resources so a readdir sweep would over-reach.
    if (!userPassedSelection && agent === 'claude') {
      const claudeAgentsDir = path.join(agentDir, 'agents');
      if (fs.existsSync(claudeAgentsDir)) {
        const trustedSubagents = new Set(subagentsToSync);
        for (const entry of fs.readdirSync(claudeAgentsDir, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name.startsWith('.')) continue;
          if (!entry.name.endsWith('.md')) continue;
          const name = entry.name.slice(0, -'.md'.length);
          if (!trustedSubagents.has(name)) {
            removePath(safeJoin(claudeAgentsDir, entry.name));
          }
        }
      }
    }
  }

  // Sync plugins — dispatch through WRITERS.plugins.
  const pluginsWriter = getWriter('plugins', agent);
  const pluginsToSync = selection
    ? resolveSelection(selection.plugins, available.plugins)
    : (pluginsWriter ? available.plugins : []);

  if (pluginsToSync.length > 0 && pluginsWriter) {
    const r = pluginsWriter.write({ version, versionHome, selection: pluginsToSync, cwd });
    result.plugins.push(...r.synced);
  }

  // Sync workflows — dispatch through WRITERS.workflows.
  const workflowsWriter = getWriter('workflows', agent);
  const workflowsToSync = selection
    ? resolveSelection(selection.workflows, available.workflows)
    : (workflowsWriter ? available.workflows : []);

  if (workflowsToSync.length > 0 && workflowsWriter) {
    const r = workflowsWriter.write({ version, versionHome, selection: workflowsToSync, cwd });
    result.workflows.push(...r.synced);
  }

  // Write manifest after a full sync (no user-passed selection) so the next
  // launch can skip the slow path. Pattern-derived selections still count as
  // "full" — the agents.yaml patterns describe the intended scope, not a
  // one-off override, so the resulting state matches what the manifest
  // records as the synced set.
  if (!userPassedSelection) {
    saveManifest(agent, version, buildSyncManifest(agent, version, cwd));
  }

  return result;
}

/**
 * Get the effective HOME directory for an agent.
 * If version-managed with a resolved version, returns the version's home directory.
 * Otherwise returns the real HOME.
 */
export function getEffectiveHome(agentId: AgentId): string {
  const resolved = resolveVersion(agentId, process.cwd());
  if (resolved && isVersionInstalled(agentId, resolved)) {
    return getVersionHomePath(agentId, resolved);
  }
  return getHomeDir();
}

/** Result of resolving agent/version targets from CLI input or interactive selection. */
export interface VersionSelectionResult {
  selectedAgents: AgentId[];
  versionSelections: Map<AgentId, string[]>;
}

/** Extended target result that distinguishes managed versions from direct (unmanaged) agent homes. */
export interface InstalledAgentTargetResult {
  selectedAgents: AgentId[];
  directAgents: AgentId[];
  versionSelections: Map<AgentId, string[]>;
}

/**
 * Thrown when the user references an agent@version that is not installed.
 * Carries the parsed (agentId, version) so callers can react — e.g. prompt
 * to install it on demand — without having to parse the error message.
 */
export class VersionNotInstalledError extends Error {
  constructor(
    public readonly agentId: AgentId,
    public readonly version: string,
    public readonly installedVersions: readonly string[]
  ) {
    const installed = installedVersions.length > 0 ? installedVersions.join(', ') : '(none)';
    super(`Version ${version} is not installed for ${AGENTS[agentId].name}. Installed versions: ${installed}`);
    this.name = 'VersionNotInstalledError';
  }
}

/**
 * Resolve a comma-separated --agents list into concrete version selections.
 * Bare agents target the default version, or the newest installed version when no default exists.
 * Explicit agent@version targets only that installed version.
 */
export function resolveAgentVersionTargets(
  value: string,
  availableAgents: readonly AgentId[],
  options: { allVersions?: boolean } = {}
): VersionSelectionResult {
  const selectedAgents: AgentId[] = [];
  const versionSelections = new Map<AgentId, string[]>();
  const explicitSelections = new Set<AgentId>();
  const rawTargets = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  // Expand literal `all` (with optional @all) into every available agent's all
  // installed versions. Skip agents with no installed versions so `all` is
  // lenient — only explicit `claude@all` errors when claude isn't installed.
  const targets: string[] = [];
  for (const t of rawTargets) {
    if (t === 'all' || t === 'all@all') {
      for (const a of availableAgents) {
        if (listInstalledVersions(a).length > 0) {
          targets.push(`${a}@all`);
        }
      }
    } else {
      targets.push(t);
    }
  }

  for (const target of targets) {
    const atIndex = target.indexOf('@');
    const agentToken = (atIndex === -1 ? target : target.slice(0, atIndex)).trim();
    const versionToken = atIndex === -1 ? null : target.slice(atIndex + 1).trim();

    if (!agentToken) {
      continue;
    }

    if (atIndex !== -1 && !versionToken) {
      throw new Error(`Missing version in --agents entry '${target}'. Use agent@x.y.z, agent@default, or agent@all.`);
    }

    const agentId = resolveAgentName(agentToken);
    if (!agentId || !availableAgents.includes(agentId)) {
      throw new Error(formatAgentError(agentToken, [...availableAgents]));
    }

    if (!selectedAgents.includes(agentId)) {
      selectedAgents.push(agentId);
    }

    if (explicitSelections.has(agentId) && !versionToken) {
      continue;
    }

    const installedVersions = listInstalledVersions(agentId);
    const defaultVersion = getGlobalDefault(agentId);

    if (!versionToken) {
      if (installedVersions.length === 0) {
        continue;
      }

      versionSelections.set(
        agentId,
        options.allVersions
          ? [...installedVersions]
          : [defaultVersion || installedVersions[installedVersions.length - 1]]
      );
      continue;
    }

    if (installedVersions.length === 0) {
      throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
    }

    if (versionToken === 'default') {
      if (!defaultVersion) {
        throw new Error(`No default version set for ${AGENTS[agentId].name}. Run: agents use ${agentId}@<version>`);
      }

      const explicitVersions = explicitSelections.has(agentId)
        ? (versionSelections.get(agentId) || [])
        : [];

      if (!explicitVersions.includes(defaultVersion)) {
        explicitVersions.push(defaultVersion);
      }
      versionSelections.set(agentId, explicitVersions);
      explicitSelections.add(agentId);
      continue;
    }

    if (versionToken === 'all') {
      versionSelections.set(agentId, [...installedVersions]);
      explicitSelections.add(agentId);
      continue;
    }

    if (!installedVersions.includes(versionToken)) {
      throw new VersionNotInstalledError(agentId, versionToken, installedVersions);
    }

    const explicitVersions = explicitSelections.has(agentId)
      ? (versionSelections.get(agentId) || [])
      : [];

    if (!explicitVersions.includes(versionToken)) {
      explicitVersions.push(versionToken);
    }
    versionSelections.set(agentId, explicitVersions);
    explicitSelections.add(agentId);
  }

  return { selectedAgents, versionSelections };
}

/**
 * Resolve a comma-separated --agents list into install/apply targets.
 * Bare agents target the default version (or newest installed version) when managed,
 * and fall back to the agent's effective HOME when unmanaged.
 * Explicit agent@version targets only that installed version.
 */
export function resolveInstalledAgentTargets(
  value: string,
  availableAgents: readonly AgentId[],
  options: { allVersions?: boolean } = {}
): InstalledAgentTargetResult {
  const selectedAgents: AgentId[] = [];
  const directAgents: AgentId[] = [];
  const versionSelections = new Map<AgentId, string[]>();
  const rawTargets = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  // Expand literal `all` (with optional @all) into every available agent's all
  // installed versions. Skip agents with no installed versions so `all` is
  // lenient — only explicit `claude@all` errors when claude isn't installed.
  // Mirrors resolveAgentVersionTargets so every --agents flag site supports
  // the same selector syntax.
  const targets: string[] = [];
  for (const t of rawTargets) {
    if (t === 'all' || t === 'all@all') {
      for (const a of availableAgents) {
        if (listInstalledVersions(a).length > 0) {
          targets.push(`${a}@all`);
        }
      }
    } else {
      targets.push(t);
    }
  }

  const addVersionTarget = (agentId: AgentId, version: string) => {
    const versions = versionSelections.get(agentId) || [];
    if (!versions.includes(version)) {
      versions.push(version);
      versionSelections.set(agentId, versions);
    }

    const directIndex = directAgents.indexOf(agentId);
    if (directIndex !== -1) {
      directAgents.splice(directIndex, 1);
    }
  };

  for (const target of targets) {
    const atIndex = target.indexOf('@');
    const agentToken = (atIndex === -1 ? target : target.slice(0, atIndex)).trim();
    const versionToken = atIndex === -1 ? null : target.slice(atIndex + 1).trim();

    if (!agentToken) {
      continue;
    }

    if (atIndex !== -1 && !versionToken) {
      throw new Error(`Missing version in --agents entry '${target}'. Use agent@x.y.z, agent@default, or agent@all.`);
    }

    const agentId = resolveAgentName(agentToken);
    if (!agentId || !availableAgents.includes(agentId)) {
      throw new Error(formatAgentError(agentToken, [...availableAgents]));
    }

    if (!selectedAgents.includes(agentId)) {
      selectedAgents.push(agentId);
    }

    const installedVersions = listInstalledVersions(agentId);
    const defaultVersion = getGlobalDefault(agentId);

    if (!versionToken) {
      if (installedVersions.length === 0) {
        if (!directAgents.includes(agentId)) {
          directAgents.push(agentId);
        }
        continue;
      }

      const targetVersions = options.allVersions
        ? [...installedVersions]
        : [defaultVersion || installedVersions[installedVersions.length - 1]];

      for (const version of targetVersions) {
        addVersionTarget(agentId, version);
      }
      continue;
    }

    if (versionToken === 'default') {
      if (!defaultVersion) {
        throw new Error(`No default version set for ${AGENTS[agentId].name}. Run: agents use ${agentId}@<version>`);
      }
      addVersionTarget(agentId, defaultVersion);
      continue;
    }

    if (versionToken === 'all') {
      if (installedVersions.length === 0) {
        throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
      }
      for (const version of installedVersions) {
        addVersionTarget(agentId, version);
      }
      continue;
    }

    if (installedVersions.length === 0) {
      throw new Error(`No managed versions are installed for ${AGENTS[agentId].name}. Run: agents add ${agentId}@latest`);
    }

    if (!installedVersions.includes(versionToken)) {
      throw new VersionNotInstalledError(agentId, versionToken, installedVersions);
    }

    addVersionTarget(agentId, versionToken);
  }

  return { selectedAgents, directAgents, versionSelections };
}

/**
 * Resolve configured manifest targets into direct homes and managed versions.
 */
export function resolveConfiguredAgentTargets(
  agents: readonly AgentId[] | undefined,
  agentVersions: Partial<Record<AgentId, string[]>> | undefined,
  availableAgents: readonly AgentId[],
  options: { allVersions?: boolean } = {}
): InstalledAgentTargetResult {
  const targetSpecs: string[] = [];
  const broadTargets = agents ? [...agents] : [...availableAgents];

  for (const agentId of broadTargets) {
    if (availableAgents.includes(agentId)) {
      targetSpecs.push(agentId);
    }
  }

  if (agentVersions) {
    for (const [agentId, versions] of Object.entries(agentVersions) as Array<[AgentId, string[] | undefined]>) {
      if (!availableAgents.includes(agentId) || !versions) continue;
      for (const version of versions) {
        targetSpecs.push(`${agentId}@${version}`);
      }
    }
  }

  if (targetSpecs.length === 0) {
    return {
      selectedAgents: [],
      directAgents: [],
      versionSelections: new Map(),
    };
  }

  return resolveInstalledAgentTargets(targetSpecs.join(','), availableAgents, options);
}

/**
 * Prompt user to select agents and versions for resource installation.
 * Returns selected agents and their version selections.
 */
export async function promptAgentVersionSelection(
  availableAgents: AgentId[],
  options: { skipPrompts?: boolean } = {}
): Promise<VersionSelectionResult> {
  const versionSelections = new Map<AgentId, string[]>();

  // Filter to installed agents (only those with versions managed by agents CLI)
  const installedAgents = availableAgents.filter((id) => {
    const versions = listInstalledVersions(id);
    return versions.length > 0;
  });

  if (installedAgents.length === 0) {
    return { selectedAgents: [], versionSelections };
  }

  const formatAgentLabel = (agentId: AgentId): string => {
    const versions = listInstalledVersions(agentId);
    const defaultVer = getGlobalDefault(agentId);
    if (versions.length === 0) return `${AGENTS[agentId].name}  ${chalk.gray('(not installed)')}`;
    // Surface the version count when there's more than one — mirrors the new
    // `--agents <agent>@all` syntax so users can see at a glance how many
    // versions `@all` would target before the per-version prompt fires.
    const detail = versions.length > 1
      ? (defaultVer
        ? `active: ${defaultVer}, ${versions.length} versions installed`
        : `${versions.length} versions installed`)
      : (defaultVer ?? versions[0]);
    return `${AGENTS[agentId].name}  ${chalk.gray(`(${detail})`)}`;
  };

  let selectedAgents: AgentId[];

  if (options.skipPrompts) {
    // Auto-select all installed agents with default versions
    selectedAgents = [...installedAgents];
    for (const agentId of selectedAgents) {
      const versions = listInstalledVersions(agentId);
      if (versions.length > 0) {
        const defaultVer = getGlobalDefault(agentId);
        versionSelections.set(agentId, defaultVer ? [defaultVer] : [versions[versions.length - 1]]);
      }
    }
  } else {
    // Non-TTY without an explicit --agents value used to silently fall through
    // to default-picking inside the caller. That's surprising in scripts — fail
    // loud and point at the new `--agents` syntax instead.
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      throw new Error(
        'Non-interactive shell: cannot prompt for agent/version selection.\n' +
        'Pass --agents explicitly. Examples:\n' +
        '  --agents claude              (default version)\n' +
        '  --agents claude@all          (every installed Claude version)\n' +
        '  --agents claude@2.1.141      (a specific version)\n' +
        '  --agents all                 (every installed version of every capable agent)\n' +
        'Or pass --yes to auto-pick defaults.'
      );
    }
    // Prompt for agent selection
    const checkboxResult = await checkbox<string>({
      message: 'Which agents should receive these resources?',
      choices: [
        { name: chalk.bold('All'), value: 'all', checked: true },
        ...installedAgents.map((id) => ({
          name: `  ${formatAgentLabel(id)}`,
          value: id,
          checked: false,
        })),
      ],
    });

    if (checkboxResult.includes('all')) {
      selectedAgents = [...installedAgents];
    } else {
      selectedAgents = checkboxResult as AgentId[];
    }

    // Version selection per agent
    for (const agentId of selectedAgents) {
      const versions = listInstalledVersions(agentId);
      if (versions.length === 0) continue;
      if (versions.length === 1) {
        versionSelections.set(agentId, [versions[0]]);
        continue;
      }

      const defaultVer = getGlobalDefault(agentId);
      const versionEmails = await Promise.all(
        versions.map((v) =>
          getAccountEmail(agentId, getVersionHomePath(agentId, v)).then((email) => ({ v, email }))
        )
      );
      const versionEmailMap = new Map(versionEmails.map((e) => [e.v, e.email]));

      const maxLabelLen = Math.max(...versions.map((v) => (v === defaultVer ? `${v} (default)` : v).length));
      const versionResult = await checkbox<string>({
        message: `Which versions of ${AGENTS[agentId].name} should receive these resources?`,
        choices: [
          { name: chalk.bold(`All versions (${versions.length})`), value: 'all', checked: false },
          ...versions.map((v) => {
            const base = v === defaultVer ? `${v} (default)` : v;
            let label = base.padEnd(maxLabelLen);
            const email = versionEmailMap.get(v);
            if (email) label += chalk.cyan(`  ${email}`);
            return { name: label, value: v, checked: v === defaultVer };
          }),
        ],
      });

      if (versionResult.includes('all')) {
        versionSelections.set(agentId, [...versions]);
      } else {
        versionSelections.set(agentId, versionResult);
      }
    }
  }

  return { selectedAgents, versionSelections };
}
