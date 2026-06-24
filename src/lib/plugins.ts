/**
 * Plugin discovery, validation, and syncing.
 *
 * Plugins are bundles in ~/.agents/plugins/ that package skills, hooks,
 * commands, agents, bin scripts, MCP servers, and settings under a single
 * manifest (plugin.json). They are user-authored resources, sitting alongside
 * skills/, commands/, hooks/, etc. — git-tracked as source of truth. This
 * module discovers plugins, validates their manifests, and syncs their
 * contents into agent version homes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { AgentId, DiscoveredPlugin, PluginManifest, MarketplaceSpec } from './types.js';
import { getPluginsDir, getTrashPluginsDir, getExtraPluginsDir, getProjectPluginsDir } from './state.js';
import { IS_WINDOWS, isWindowsAbsolutePath, homeDir } from './platform/index.js';
import { assertSafeGitTransport } from './git.js';
import { listInstalledVersions, getVersionHomePath } from './versions.js';
import { AGENTS, agentConfigDirName } from './agents.js';
import { capableAgents, isCapable } from './capabilities.js';
import { shouldInstallCommandAsSkill, installCommandSkillToVersion } from './command-skills.js';
import {
  copyPluginToMarketplace,
  syncMarketplaceManifest,
  registerMarketplace,
  unregisterMarketplace,
  addPluginToSettings,
  removePluginFromSettings,
  removePluginFromMarketplace,
  marketplaceIsEmpty,
  removeEmptyMarketplaceDir,
  isInstalledInMarketplace,
  marketplaceRoot,
  discoverMarketplaces,
  marketplaceNameFor,
  MARKETPLACE_NAME,
  PROJECT_MARKETPLACE_NAME,
} from './plugin-marketplace.js';

const PLUGIN_MANIFEST_DIR = '.claude-plugin';
const PLUGIN_MANIFEST_FILE = 'plugin.json';
const USER_CONFIG_FILE = '.user-config.json';
const SOURCE_FILE = '.source';

export interface PluginCapabilities {
  hasHooks: boolean;
  hasMcp: boolean;
  hasBin: boolean;
  hasScripts: boolean;
  hasSettings: boolean;
  hasPermissions: boolean;
}

export const PLUGIN_EXEC_SURFACE_LABELS: Record<keyof PluginCapabilities, string> = {
  hasHooks: 'hooks/',
  hasMcp: '.mcp.json',
  hasBin: 'bin/',
  hasScripts: 'scripts/',
  hasSettings: 'settings.json',
  hasPermissions: 'permissions/',
};

function isPluginRootEntry(pluginsDir: string, entry: fs.Dirent): boolean {
  if (entry.name.startsWith('.')) return false;
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;

  try {
    return fs.statSync(path.join(pluginsDir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover all plugins in a given plugins directory (e.g. ~/.agents/plugins/,
 * ~/.agents/.system/plugins/, <cwd>/.agents/plugins/, ~/.agents-<alias>/plugins/).
 * A valid plugin has a .claude-plugin/plugin.json manifest.
 *
 * `spec` stamps marketplace provenance onto each discovered plugin. Callers that
 * scan a single source dir without a marketplace identity (e.g. project-launch)
 * may omit it; those plugins default to the user marketplace.
 */
export function discoverPluginsInDir(pluginsDir: string, spec: MarketplaceSpec = { kind: 'user' }): DiscoveredPlugin[] {
  if (!fs.existsSync(pluginsDir)) {
    return [];
  }

  const plugins: DiscoveredPlugin[] = [];
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!isPluginRootEntry(pluginsDir, entry)) continue;

    const pluginRoot = path.join(pluginsDir, entry.name);
    const manifest = loadPluginManifest(pluginRoot);
    if (!manifest) continue;

    plugins.push(buildDiscoveredPlugin(pluginRoot, manifest, spec));
  }

  return plugins;
}

/**
 * Discover every plugin across ALL marketplaces — the user repo (~/.agents/),
 * each enabled extra repo (~/.agents-<alias>/), and the project repo
 * (<cwd>/.agents/) — stamping marketplace provenance onto each.
 *
 * Plugin names are NOT deduplicated across marketplaces: a `code` plugin in both
 * the user repo and an extra repo yields two entries (`code@agents-cli` and
 * `code@agents-<alias>`), each installing into its own marketplace directory.
 */
export function discoverPlugins(opts: { cwd?: string } = {}): DiscoveredPlugin[] {
  const out: DiscoveredPlugin[] = [];
  for (const dm of discoverMarketplaces(opts)) {
    out.push(...discoverPluginsInDir(dm.pluginsRoot, dm.spec));
  }
  return out;
}

export function buildDiscoveredPlugin(
  pluginRoot: string,
  manifest: PluginManifest,
  spec: MarketplaceSpec = { kind: 'user' }
): DiscoveredPlugin {
  return {
    name: manifest.name,
    root: pluginRoot,
    manifest,
    marketplace: marketplaceNameFor(spec),
    skills: discoverPluginSkills(pluginRoot),
    hooks: discoverPluginHooks(pluginRoot),
    scripts: discoverPluginScripts(pluginRoot),
    commands: discoverPluginCommands(pluginRoot),
    agentDefs: discoverPluginAgentDefs(pluginRoot),
    bin: discoverPluginBin(pluginRoot),
    mcpServers: discoverPluginMcpServers(pluginRoot),
    lspServers: discoverPluginLspServers(pluginRoot),
    monitors: discoverPluginMonitors(pluginRoot),
    hasMcp: fs.existsSync(path.join(pluginRoot, '.mcp.json')),
    hasSettings: pluginHasNonPermissionSettings(pluginRoot),
  };
}

/** One category of resources a plugin packages, for display breakdowns. */
export interface PluginResourceGroup {
  /** Category key: 'skills' | 'commands' | 'subagents' | 'hooks' | 'mcp' | 'lsp' | 'monitors' | 'bin' | 'scripts' | 'settings'. */
  label: string;
  /** Display names — slash-prefixed for skills/commands (e.g. `/code:dispatch`), raw names otherwise. */
  items: string[];
}

/**
 * Ordered, non-empty resource groups a plugin packages. Single source of truth
 * for the breakdown shown by the plugin picker, `agents inspect --plugins`, and
 * its detail view. Empty categories are omitted; `settings` appears only when
 * the plugin merges non-permission settings.
 */
export function pluginResourceGroups(plugin: DiscoveredPlugin): PluginResourceGroup[] {
  const groups: PluginResourceGroup[] = [
    { label: 'skills', items: plugin.skills.map((s) => `/${plugin.name}:${s}`) },
    { label: 'commands', items: plugin.commands.map((c) => `/${plugin.name}:${c}`) },
    { label: 'subagents', items: plugin.agentDefs },
    { label: 'hooks', items: plugin.hooks },
    { label: 'mcp', items: plugin.mcpServers },
    { label: 'lsp', items: plugin.lspServers },
    { label: 'monitors', items: plugin.monitors },
    { label: 'bin', items: plugin.bin },
    { label: 'scripts', items: plugin.scripts },
  ];
  const out = groups.filter((g) => g.items.length > 0);
  if (plugin.hasSettings) out.push({ label: 'settings', items: ['settings.json'] });
  return out;
}

export function inspectPluginCapabilities(pluginRoot: string): PluginCapabilities {
  const manifest = loadPluginManifest(pluginRoot);
  const plugin = manifest ? buildDiscoveredPlugin(pluginRoot, manifest) : null;
  return {
    hasHooks: (plugin?.hooks.length || 0) > 0 || pluginHasDirectoryEntries(pluginRoot, 'hooks'),
    hasMcp: fs.existsSync(path.join(pluginRoot, '.mcp.json')),
    hasBin: (plugin?.bin.length || 0) > 0,
    hasScripts: (plugin?.scripts.length || 0) > 0,
    hasSettings: pluginHasNonPermissionSettings(pluginRoot),
    hasPermissions: pluginHasPermissionsPath(pluginRoot),
  };
}

export function hasPluginExecSurfaces(capabilities: PluginCapabilities): boolean {
  return Object.values(capabilities).some(Boolean);
}

export function pluginCapabilityLabels(capabilities: PluginCapabilities): string[] {
  return (Object.keys(PLUGIN_EXEC_SURFACE_LABELS) as Array<keyof PluginCapabilities>)
    .filter((key) => capabilities[key])
    .map((key) => PLUGIN_EXEC_SURFACE_LABELS[key]);
}

/**
 * Load a plugin manifest from a plugin directory.
 */
export function loadPluginManifest(pluginRoot: string): PluginManifest | null {
  const manifestPath = path.join(pluginRoot, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content) as PluginManifest;
    if (!parsed.name || !parsed.version) return null;
    if (!validatePluginName(parsed.name)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function validatePluginName(name: string): boolean {
  return name.length > 0
    && !/[/\\]/.test(name)
    && !name.includes('..')
    && !name.includes('\0');
}

export function assertPluginTargetContained(targetRoot: string, pluginsDir: string): void {
  const resolvedPluginsDir = path.resolve(pluginsDir);
  const resolvedTargetRoot = path.resolve(targetRoot);
  if (
    resolvedTargetRoot !== resolvedPluginsDir
    && !resolvedTargetRoot.startsWith(`${resolvedPluginsDir}${path.sep}`)
  ) {
    throw new Error(`Plugin install target escapes plugins directory: ${targetRoot}`);
  }
}

/**
 * Get a specific plugin by name.
 */
export function getPlugin(name: string): DiscoveredPlugin | null {
  const plugins = discoverPlugins();
  return plugins.find(p => p.name === name) || null;
}

/**
 * Check if an agent supports a specific plugin.
 * If the plugin specifies agents, only those are supported.
 * Otherwise defaults to all plugin-capable agents.
 */
export function pluginSupportsAgent(plugin: DiscoveredPlugin, agent: AgentId): boolean {
  if (!isCapable(agent, 'plugins')) return false;
  if (plugin.manifest.agents && plugin.manifest.agents.length > 0) {
    return plugin.manifest.agents.includes(agent);
  }
  return true;
}

// ─── Discovery helpers ────────────────────────────────────────────────────────

function discoverPluginSkills(pluginRoot: string): string[] {
  const skillsDir = path.join(pluginRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);
}

/**
 * The lifecycle events a plugin hooks into, read from hooks/hooks.json.
 *
 * The official plugin format wraps the event map under a `hooks` key
 * (`{ description, hooks: { SessionStart: [...], PreToolUse: [...] } }`), so the
 * meaningful keys are the events — NOT the top-level keys (`description`,
 * `hooks`). Older/flat files put the event names at the top level directly; we
 * read whichever object actually holds the event map.
 */
export function discoverPluginHooks(pluginRoot: string): string[] {
  const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksFile)) return [];

  try {
    const content = JSON.parse(fs.readFileSync(hooksFile, 'utf-8')) as Record<string, unknown>;
    const eventMap = content.hooks && typeof content.hooks === 'object' && !Array.isArray(content.hooks)
      ? content.hooks as Record<string, unknown>
      : content;
    return Object.keys(eventMap);
  } catch {
    return [];
  }
}

function discoverPluginScripts(pluginRoot: string): string[] {
  const scriptsDir = path.join(pluginRoot, 'scripts');
  if (!fs.existsSync(scriptsDir)) return [];

  return fs.readdirSync(scriptsDir).filter(f => !f.startsWith('.'));
}

/** Discover command .md files inside a plugin's commands/ directory. */
export function discoverPluginCommands(pluginRoot: string): string[] {
  const commandsDir = path.join(pluginRoot, 'commands');
  if (!fs.existsSync(commandsDir)) return [];

  return fs.readdirSync(commandsDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .map(f => f.slice(0, -3));
}

/** Discover agent definition .md files inside a plugin's agents/ directory. */
export function discoverPluginAgentDefs(pluginRoot: string): string[] {
  const agentsDir = path.join(pluginRoot, 'agents');
  if (!fs.existsSync(agentsDir)) return [];

  return fs.readdirSync(agentsDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .map(f => f.slice(0, -3));
}

/** Discover executable files in a plugin's bin/ directory. */
export function discoverPluginBin(pluginRoot: string): string[] {
  const binDir = path.join(pluginRoot, 'bin');
  if (!fs.existsSync(binDir)) return [];

  return fs.readdirSync(binDir).filter(f => !f.startsWith('.'));
}

/** Discover MCP server names from .mcp.json at the plugin root. */
export function discoverPluginMcpServers(pluginRoot: string): string[] {
  const mcpFile = path.join(pluginRoot, '.mcp.json');
  if (!fs.existsSync(mcpFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpFile, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    return parsed.mcpServers ? Object.keys(parsed.mcpServers) : [];
  } catch {
    return [];
  }
}

/** Discover LSP server keys from .lsp.json at the plugin root. */
export function discoverPluginLspServers(pluginRoot: string): string[] {
  const lspFile = path.join(pluginRoot, '.lsp.json');
  if (!fs.existsSync(lspFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(lspFile, 'utf-8')) as Record<string, unknown>;
    return Object.keys(parsed);
  } catch {
    return [];
  }
}

/** Discover monitor names from monitors/monitors.json. */
export function discoverPluginMonitors(pluginRoot: string): string[] {
  const monitorsFile = path.join(pluginRoot, 'monitors', 'monitors.json');
  if (!fs.existsSync(monitorsFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(monitorsFile, 'utf-8')) as Array<{ name?: string }>;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(m => m.name).filter((n): n is string => typeof n === 'string');
  } catch {
    return [];
  }
}

/** Return true if settings.json contains non-permission keys worth merging. */
function pluginHasNonPermissionSettings(pluginRoot: string): boolean {
  const settingsPath = path.join(pluginRoot, 'settings.json');
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    return Object.keys(parsed).some(k => k !== 'permissions');
  } catch {
    return false;
  }
}

// ─── Variable expansion ───────────────────────────────────────────────────────

/**
 * Expand plugin variables in a string.
 *
 * Variables:
 *   ${CLAUDE_PLUGIN_ROOT}      -> absolute path to plugin directory
 *   ${CLAUDE_PLUGIN_DATA}      -> per-version data directory for this plugin
 *   ${user_config.<key>}       -> value from plugin's .user-config.json
 */
export function expandPluginVars(
  str: string,
  pluginRoot: string,
  pluginName: string,
  agentId: AgentId,
  versionHome: string,
  userConfig?: Record<string, string>
): string {
  const dataDir = path.join(versionHome, agentConfigDirName(agentId), 'plugin-data', pluginName);
  let result = str
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, dataDir);

  if (userConfig && Object.keys(userConfig).length > 0) {
    result = result.replace(/\$\{user_config\.([^}]+)\}/g, (_, key) => {
      return userConfig[key] ?? '';
    });
  }

  return result;
}

// ─── userConfig storage ───────────────────────────────────────────────────────

/**
 * Load persisted user config for a plugin from .user-config.json.
 */
export function loadUserConfig(pluginName: string): Record<string, string> {
  const configPath = path.join(getPluginsDir(), pluginName, USER_CONFIG_FILE);
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Persist user config for a plugin to .user-config.json.
 */
export function saveUserConfig(pluginName: string, config: Record<string, string>): void {
  const configPath = path.join(getPluginsDir(), pluginName, USER_CONFIG_FILE);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ─── Dependency checking ──────────────────────────────────────────────────────

/**
 * Check plugin dependencies against installed plugins.
 * Returns names of missing dependencies (warning only — not a hard error).
 */
export function checkPluginDependencies(manifest: PluginManifest): string[] {
  if (!manifest.dependencies || manifest.dependencies.length === 0) return [];
  const installed = new Set(discoverPlugins().map(p => p.name));
  return manifest.dependencies.filter(dep => !installed.has(dep));
}

// ─── Marketplace routing ──────────────────────────────────────────────────────

/**
 * Reconstruct a MarketplaceSpec from a marketplace name. The inverse of
 * marketplaceNameFor(): "agents-cli" → user, "agents-project" → project,
 * "agents-<alias>" → extra. The per-version marketplace operations only key off
 * the name (never spec.root), but we resolve the real source root anyway so the
 * spec is honest for any caller that inspects it.
 */
function marketplaceSpecForName(name: string | undefined, cwd: string = process.cwd()): MarketplaceSpec {
  if (!name || name === MARKETPLACE_NAME) return { kind: 'user' };
  if (name === PROJECT_MARKETPLACE_NAME) {
    return { kind: 'project', root: getProjectPluginsDir(cwd) ?? '' };
  }
  const alias = name.slice('agents-'.length);
  return { kind: 'extra', alias, root: getExtraPluginsDir(alias) };
}

/**
 * List the marketplace names that have been synthesized under a version home
 * (i.e. the directories beneath .{agent}/plugins/marketplaces/). Used by
 * removal/orphan/diff passes that must touch every marketplace a version
 * carries, not just the user one.
 */
function listVersionMarketplaceNames(agent: AgentId, versionHome: string): string[] {
  const dir = path.join(versionHome, `.${agent}`, 'plugins', 'marketplaces');
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
  } catch {
    return [];
  }
}

// ─── Main sync entry point ────────────────────────────────────────────────────

/**
 * Sync a plugin to a specific agent version's home directory.
 *
 * For plugins-capable agents (claude, openclaw):
 *   1. Copy plugin source into <versionHome>/.<agent>/plugins/marketplaces/agents-cli/plugins/<name>/
 *   2. Pre-expand ${user_config.*} variables in copied text files (Claude doesn't know this var).
 *   3. (Re-)synthesize the marketplace.json catalog from the installed plugins.
 *   4. Register the synthetic marketplace in known_marketplaces.json.
 *   5. Mark <plugin>@agents-cli enabled in settings.json#enabledPlugins.
 *   6. Migrate (remove) legacy dual-dash skills/commands/agents/bin/hooks/mcp entries.
 *
 * Claude/OpenClaw natively handle the plugin's skills, commands, agents, hooks,
 * MCP servers, bin/, settings.json, and permissions once the plugin lives at the
 * native install path and is marked enabled — see
 * https://code.claude.com/docs/en/plugins.
 */
export function syncPluginToVersion(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string,
  options: { allowExecSurfaces?: boolean; version?: string } = {}
): {
  success: boolean;
  skills: string[];
  commands: string[];
  agentDefs: string[];
  bin: string[];
  hooks: string[];
  permissions: boolean;
  mcp: boolean;
  settings: boolean;
} {
  const result = {
    success: false,
    skills: [] as string[],
    commands: [] as string[],
    agentDefs: [] as string[],
    bin: [] as string[],
    hooks: [] as string[],
    permissions: false,
    mcp: false,
    settings: false,
  };

  if (!pluginSupportsAgent(plugin, agent)) {
    return result;
  }

  const userConfig = loadUserConfig(plugin.name);

  // Route every marketplace op through the plugin's own marketplace, so a plugin
  // discovered in an extra/project repo installs under its own
  // marketplaces/<name>/ tree — never the user marketplace.
  const spec = marketplaceSpecForName(plugin.marketplace);
  const marketplaceName = marketplaceNameFor(spec);

  // 1. Copy plugin to native marketplace install dir.
  const installDir = copyPluginToMarketplace(plugin, spec, agent, versionHome);

  // 2. Pre-expand ${user_config.*} in the copy. Leave ${CLAUDE_PLUGIN_ROOT} /
  //    ${CLAUDE_PLUGIN_DATA} alone — Claude expands those natively at runtime.
  if (Object.keys(userConfig).length > 0) {
    expandUserConfigInDir(installDir, userConfig);
  }

  // 2b. Write agent-native manifest dir alongside .claude-plugin/ when the agent
  //     expects a different directory name (e.g. Codex uses .codex-plugin/).
  const agentManifestDir = AGENTS[agent].pluginManifestDir;
  if (agentManifestDir && agentManifestDir !== PLUGIN_MANIFEST_DIR) {
    const srcManifest = path.join(installDir, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
    if (fs.existsSync(srcManifest)) {
      const destManifestDir = path.join(installDir, agentManifestDir);
      fs.mkdirSync(destManifestDir, { recursive: true });
      fs.copyFileSync(srcManifest, path.join(destManifestDir, PLUGIN_MANIFEST_FILE));
    }
  }

  // 3-5. Synthesize manifest, register marketplace, enable plugin.
  syncMarketplaceManifest(spec, agent, versionHome);
  registerMarketplace(spec, agent, versionHome);
  // Trust gate: plugins with executable surfaces (hooks/, bin/, scripts/,
  // .mcp.json, settings.json, permissions/) are only auto-enabled when the
  // caller explicitly opts in. addPluginToSettings does no gating — that moved
  // here, where plugin capabilities are inspected.
  if (options.allowExecSurfaces === true || !hasPluginExecSurfaces(inspectPluginCapabilities(plugin.root))) {
    addPluginToSettings(plugin.name, marketplaceName, agent, versionHome);
  }

  // 5b. Convert plugin commands/ to skills for agents that dropped command support
  //     (Codex >= 0.117.0). Skill name is prefixed with plugin name to avoid
  //     collision with standalone command skills.
  if (options.version && shouldInstallCommandAsSkill(agent, options.version) && plugin.commands.length > 0) {
    const agentDir = path.join(versionHome, agentConfigDirName(agent));
    const skillSourceDirs = [path.join(agentDir, 'skills')];
    for (const cmd of plugin.commands) {
      const srcPath = path.join(plugin.root, 'commands', `${cmd}.md`);
      if (fs.existsSync(srcPath)) {
        installCommandSkillToVersion(agentDir, `${plugin.name}-${cmd}`, srcPath, skillSourceDirs);
      }
    }
  }

  // 6. Migrate legacy dual-dash flat layout from previous versions of agents-cli.
  migrateLegacyFlatLayout(plugin, agent, versionHome);

  // Populate the result shape for backward-compatible callers/reporting.
  result.skills = plugin.skills.map(s => `${plugin.name}:${s}`);
  result.commands = plugin.commands.map(c => `${plugin.name}:${c}`);
  result.agentDefs = plugin.agentDefs.map(a => `${plugin.name}:${a}`);
  result.bin = plugin.bin;
  result.hooks = plugin.hooks;
  result.mcp = plugin.hasMcp;
  result.settings = plugin.hasSettings;
  result.permissions = pluginHasPermissions(plugin);
  result.success = true;

  return result;
}

function pluginHasPermissions(plugin: DiscoveredPlugin): boolean {
  return pluginHasPermissionsPath(plugin.root);
}

function pluginHasPermissionsPath(pluginRoot: string): boolean {
  const permissionsDir = path.join(pluginRoot, 'permissions');
  if (fs.existsSync(permissionsDir)) return true;
  const settingsPath = path.join(pluginRoot, 'settings.json');
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      permissions?: { allow?: string[]; deny?: string[] };
    };
    return !!(parsed.permissions?.allow?.length || parsed.permissions?.deny?.length);
  } catch {
    return false;
  }
}

function pluginHasDirectoryEntries(pluginRoot: string, dirName: string): boolean {
  const dir = path.join(pluginRoot, dirName);
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((entry) => !entry.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * Walk a directory and replace ${user_config.*} placeholders in text files.
 * Leaves all other variables (${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}) alone.
 */
function expandUserConfigInDir(dir: string, userConfig: Record<string, string>): void {
  const textExtensions = new Set(['.md', '.json', '.sh', '.py', '.js', '.ts', '.yaml', '.yml', '.toml', '.txt']);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      expandUserConfigInDir(full, userConfig);
      continue;
    }
    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const content = fs.readFileSync(full, 'utf-8');
      if (!content.includes('${user_config.')) continue;
      const expanded = content.replace(/\$\{user_config\.([^}]+)\}/g, (_, key) => userConfig[key] ?? '');
      if (expanded !== content) {
        fs.writeFileSync(full, expanded, 'utf-8');
      }
    } catch { /* skip unreadable */ }
  }
}

/**
 * Remove legacy <plugin>--* entries from a version home, left by the previous
 * flatten-based sync. Safe to call repeatedly — only deletes paths matching the
 * plugin's prefix.
 */
function migrateLegacyFlatLayout(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): void {
  const prefix = `${plugin.name}--`;
  const agentRoot = path.join(versionHome, agentConfigDirName(agent));

  // 1. skills
  const skillsDir = path.join(agentRoot, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        try { fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true }); } catch { /* skip */ }
      }
    }
  }

  // 2. commands
  if (agent === 'claude' || agent === 'openclaw') {
    const cmdsDir = path.join(agentRoot, AGENTS[agent]?.commandsSubdir ?? 'commands');
    if (fs.existsSync(cmdsDir)) {
      for (const entry of fs.readdirSync(cmdsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.md')) {
          try { fs.unlinkSync(path.join(cmdsDir, entry.name)); } catch { /* skip */ }
        }
      }
    }
  }

  // 3. agent definitions
  const agentsDir = path.join(agentRoot, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.md')) {
        try { fs.unlinkSync(path.join(agentsDir, entry.name)); } catch { /* skip */ }
      }
    }
  }

  // 4. plugin-bin
  const binDir = path.join(agentRoot, 'plugin-bin', plugin.name);
  if (fs.existsSync(binDir)) {
    try { fs.rmSync(binDir, { recursive: true, force: true }); } catch { /* skip */ }
  }

  // 5. settings.json — strip namespaced mcpServers, hooks referencing plugin
  //    root, permissions referencing plugin root, and pluginBinPaths entries.
  const settingsPath = path.join(agentRoot, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch { return; }

  let changed = false;
  const pluginRoot = plugin.root;

  const hooksCfg = settings.hooks as Record<string, unknown> | undefined;
  if (hooksCfg && typeof hooksCfg === 'object') {
    for (const [event, entries] of Object.entries(hooksCfg)) {
      if (!Array.isArray(entries)) continue;
      const groups = entries as Array<{ matcher?: string; hooks?: Array<{ command: string }> }>;
      for (const group of groups) {
        if (!Array.isArray(group.hooks)) continue;
        const orig = group.hooks.length;
        group.hooks = group.hooks.filter(h => !(typeof h.command === 'string' && h.command.includes(pluginRoot)));
        if (group.hooks.length !== orig) changed = true;
      }
      const kept = groups.filter(g => Array.isArray(g.hooks) && g.hooks.length > 0);
      if (kept.length !== groups.length) {
        hooksCfg[event] = kept;
        changed = true;
      }
      if (Array.isArray(hooksCfg[event]) && (hooksCfg[event] as unknown[]).length === 0) {
        delete hooksCfg[event];
        changed = true;
      }
    }
  }

  const perms = settings.permissions as { allow?: string[]; deny?: string[] } | undefined;
  if (perms && typeof perms === 'object') {
    for (const key of ['allow', 'deny'] as const) {
      const list = perms[key];
      if (!Array.isArray(list)) continue;
      const kept = list.filter(r => !(typeof r === 'string' && r.includes(pluginRoot)));
      if (kept.length !== list.length) {
        perms[key] = kept;
        changed = true;
      }
    }
  }

  const mcp = settings.mcpServers as Record<string, unknown> | undefined;
  if (mcp && typeof mcp === 'object') {
    for (const key of Object.keys(mcp)) {
      if (key.startsWith(prefix)) {
        delete mcp[key];
        changed = true;
      }
    }
  }

  if (Array.isArray(settings.pluginBinPaths)) {
    const targetBinDir = path.join(agentRoot, 'plugin-bin', plugin.name);
    const before = (settings.pluginBinPaths as string[]).length;
    settings.pluginBinPaths = (settings.pluginBinPaths as string[]).filter(p => p !== targetBinDir);
    if ((settings.pluginBinPaths as string[]).length !== before) changed = true;
    if ((settings.pluginBinPaths as string[]).length === 0) {
      delete settings.pluginBinPaths;
      changed = true;
    }
  }

  if (changed) {
    try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8'); } catch { /* ignore */ }
  }
}

// ─── Sync status ──────────────────────────────────────────────────────────────

/**
 * Check if a plugin is synced to a version. True when the plugin lives at the
 * native marketplace install path. Legacy dual-dash entries are not counted —
 * they're treated as stale and migrated away on the next sync.
 */
export function isPluginSynced(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): boolean {
  if (!isCapable(agent, 'plugins')) return false;
  return isInstalledInMarketplace(plugin.name, marketplaceSpecForName(plugin.marketplace), agent, versionHome);
}

// ─── Removal ─────────────────────────────────────────────────────────────────

/**
 * Remove a plugin from a specific agent version's home directory.
 * Inverse of syncPluginToVersion.
 *
 * Works whether or not the plugin source still exists on disk.
 */
export function removePluginFromVersion(
  pluginName: string,
  pluginRoot: string,
  agent: AgentId,
  versionHome: string
): {
  skills: string[];
  commands: string[];
  agentDefs: string[];
  bin: string[];
  hooks: string[];
  permissions: number;
  mcp: number;
} {
  const result = {
    skills: [] as string[],
    commands: [] as string[],
    agentDefs: [] as string[],
    bin: [] as string[],
    hooks: [] as string[],
    permissions: 0,
    mcp: 0,
  };

  // 1. Remove the plugin from every marketplace it's installed under. A name can
  //    appear in more than one (collision across repos), so we sweep them all.
  let removedAny = false;
  for (const name of listVersionMarketplaceNames(agent, versionHome)) {
    const spec = marketplaceSpecForName(name);
    if (removePluginFromMarketplace(pluginName, name, agent, versionHome)) {
      removedAny = true;
    }
    removePluginFromSettings(pluginName, name, agent, versionHome);

    // Refresh marketplace.json so it reflects what's left under plugins/.
    syncMarketplaceManifest(spec, agent, versionHome);

    // If we just removed the last plugin, drop the marketplace dir and the
    // known_marketplaces.json entry too.
    if (marketplaceIsEmpty(name, agent, versionHome)) {
      removeEmptyMarketplaceDir(name, agent, versionHome);
      unregisterMarketplace(name, agent, versionHome);
    }
  }
  if (removedAny) {
    result.skills.push(pluginName);
  }

  // 4. Strip any legacy dual-dash entries from prior agents-cli versions.
  cleanLegacyFlatLayout(pluginName, pluginRoot, agent, versionHome, result);

  return result;
}

/**
 * Strip dual-dash flat-layout entries left behind by older agents-cli sync runs.
 * Mutates `result` to record what was removed.
 */
function cleanLegacyFlatLayout(
  pluginName: string,
  pluginRoot: string,
  agent: AgentId,
  versionHome: string,
  result: { skills: string[]; commands: string[]; agentDefs: string[]; bin: string[]; hooks: string[]; permissions: number; mcp: number }
): void {
  const prefix = `${pluginName}--`;
  const agentRoot = path.join(versionHome, agentConfigDirName(agent));

  const skillsDir = path.join(agentRoot, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      try {
        fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
        result.skills.push(entry.name);
      } catch { /* skip */ }
    }
  }

  if (agent === 'claude' || agent === 'openclaw') {
    const commandsDir = path.join(agentRoot, AGENTS[agent]?.commandsSubdir ?? 'commands');
    if (fs.existsSync(commandsDir)) {
      for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue;
        try {
          fs.unlinkSync(path.join(commandsDir, entry.name));
          result.commands.push(entry.name);
        } catch { /* skip */ }
      }
    }
  }

  const agentsDir = path.join(agentRoot, 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue;
      try {
        fs.unlinkSync(path.join(agentsDir, entry.name));
        result.agentDefs.push(entry.name);
      } catch { /* skip */ }
    }
  }

  const binDir = path.join(agentRoot, 'plugin-bin', pluginName);
  if (fs.existsSync(binDir)) {
    try {
      fs.rmSync(binDir, { recursive: true, force: true });
      result.bin.push(binDir);
    } catch { /* skip */ }
  }

  const settingsPath = path.join(agentRoot, 'settings.json');
  if (!fs.existsSync(settingsPath)) return;

  let settings: Record<string, unknown>;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { return; }

  let changed = false;

  const hooksConfig = settings.hooks as Record<string, unknown> | undefined;
  if (hooksConfig && typeof hooksConfig === 'object') {
    for (const [event, entries] of Object.entries(hooksConfig)) {
      if (!Array.isArray(entries)) continue;
      const groups = entries as Array<{ matcher?: string; hooks?: Array<{ command: string }> }>;
      for (const group of groups) {
        if (!Array.isArray(group.hooks)) continue;
        const orig = group.hooks.length;
        group.hooks = group.hooks.filter(h => {
          const matches = typeof h.command === 'string' && h.command.includes(pluginRoot);
          if (matches) result.hooks.push(`${event}: ${h.command}`);
          return !matches;
        });
        if (group.hooks.length !== orig) changed = true;
      }
      const kept = groups.filter(g => Array.isArray(g.hooks) && g.hooks.length > 0);
      if (kept.length !== groups.length) {
        hooksConfig[event] = kept;
        changed = true;
      }
      if (Array.isArray(hooksConfig[event]) && (hooksConfig[event] as unknown[]).length === 0) {
        delete hooksConfig[event];
        changed = true;
      }
    }
  }

  const perms = settings.permissions as { allow?: string[]; deny?: string[] } | undefined;
  if (perms && typeof perms === 'object') {
    for (const key of ['allow', 'deny'] as const) {
      const list = perms[key];
      if (!Array.isArray(list)) continue;
      const kept = list.filter(r => {
        const matches = typeof r === 'string' && r.includes(pluginRoot);
        if (matches) result.permissions += 1;
        return !matches;
      });
      if (kept.length !== list.length) {
        perms[key] = kept;
        changed = true;
      }
    }
  }

  const mcp = settings.mcpServers as Record<string, unknown> | undefined;
  if (mcp && typeof mcp === 'object') {
    for (const key of Object.keys(mcp)) {
      if (key.startsWith(prefix)) {
        delete mcp[key];
        result.mcp += 1;
        changed = true;
      }
    }
  }

  if (Array.isArray(settings.pluginBinPaths)) {
    const targetBin = path.join(agentRoot, 'plugin-bin', pluginName);
    const before = (settings.pluginBinPaths as string[]).length;
    settings.pluginBinPaths = (settings.pluginBinPaths as string[]).filter(p => p !== targetBin);
    if ((settings.pluginBinPaths as string[]).length !== before) changed = true;
    if ((settings.pluginBinPaths as string[]).length === 0) {
      delete settings.pluginBinPaths;
      changed = true;
    }
  }

  if (changed) {
    try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8'); } catch { /* ignore */ }
  }
}

// ─── Orphan cleanup ───────────────────────────────────────────────────────────

/**
 * Remove orphaned plugin entries from a version home. An entry is "orphan" if
 * its plugin name is not in the active plugin set. Soft-deletes the affected
 * marketplace plugin dir to ~/.agents/.trash/plugins/. Also cleans up any
 * legacy dual-dash skills/ directories from older agents-cli versions.
 */
export function cleanOrphanedPluginSkills(
  agent: AgentId,
  versionHome: string,
  activePluginNames: Set<string>,
  version?: string
): string[] {
  const removed: string[] = [];

  // 1. Walk every marketplace's install dir and trash entries no longer active.
  for (const name of listVersionMarketplaceNames(agent, versionHome)) {
    const spec = marketplaceSpecForName(name);
    const mktPluginsDir = path.join(marketplaceRoot(name, agent, versionHome), 'plugins');
    if (!fs.existsSync(mktPluginsDir)) continue;
    let trashedHere = false;
    for (const entry of fs.readdirSync(mktPluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (activePluginNames.has(entry.name)) continue;
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashDir = path.join(getTrashPluginsDir(), agent, version || 'unknown', entry.name);
        const trashDest = path.join(trashDir, stamp);
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(mktPluginsDir, entry.name), trashDest);
        removePluginFromSettings(entry.name, name, agent, versionHome);
        removed.push(entry.name);
        trashedHere = true;
      } catch { /* skip on error */ }
    }
    // Keep manifest in sync with on-disk state and drop the marketplace if empty.
    if (trashedHere) {
      syncMarketplaceManifest(spec, agent, versionHome);
      if (marketplaceIsEmpty(name, agent, versionHome)) {
        removeEmptyMarketplaceDir(name, agent, versionHome);
        unregisterMarketplace(name, agent, versionHome);
      }
    }
  }

  // 2. Sweep legacy dual-dash skills directories from older agents-cli versions.
  const skillsDir = path.join(versionHome, agentConfigDirName(agent), 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dashIdx = entry.name.indexOf('--');
      if (dashIdx === -1) continue;
      const pluginName = entry.name.slice(0, dashIdx);
      if (activePluginNames.has(pluginName)) continue;
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const trashDir = path.join(getTrashPluginsDir(), agent, version || 'unknown', entry.name);
        const trashDest = path.join(trashDir, stamp);
        fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(skillsDir, entry.name), trashDest);
        removed.push(entry.name);
      } catch { /* skip on error */ }
    }
  }

  return removed;
}

// ─── Diff / iteration ─────────────────────────────────────────────────────────

export interface VersionPluginDiff {
  agent: AgentId;
  version: string;
  orphans: string[];
}

export function diffVersionPlugins(agent: AgentId, version: string): VersionPluginDiff {
  const versionHome = getVersionHomePath(agent, version);
  const activePlugins = new Set(discoverPlugins().map(p => p.name));
  const orphans: string[] = [];

  for (const name of listVersionMarketplaceNames(agent, versionHome)) {
    const mktPluginsDir = path.join(marketplaceRoot(name, agent, versionHome), 'plugins');
    if (!fs.existsSync(mktPluginsDir)) continue;
    for (const entry of fs.readdirSync(mktPluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (!activePlugins.has(entry.name)) {
        orphans.push(entry.name);
      }
    }
  }

  // Also surface legacy dual-dash skill dirs as orphans during migration period.
  const skillsDir = path.join(versionHome, agentConfigDirName(agent), 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dashIdx = entry.name.indexOf('--');
      if (dashIdx === -1) continue;
      const pluginName = entry.name.slice(0, dashIdx);
      if (!activePlugins.has(pluginName)) {
        orphans.push(entry.name);
      }
    }
  }

  return { agent, version, orphans: Array.from(new Set(orphans)).sort() };
}

export function iterPluginsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const agents = filter?.agent ? [filter.agent] : capableAgents('plugins');
  for (const agent of agents) {
    if (!isCapable(agent, 'plugins')) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      pairs.push({ agent, version });
    }
  }
  return pairs;
}

export function removePluginSkillFromVersion(
  agent: AgentId,
  version: string,
  skillName: string
): { success: boolean; error?: string } {
  const versionHome = getVersionHomePath(agent, version);
  const skillPath = path.join(versionHome, agentConfigDirName(agent), 'skills', skillName);

  if (!fs.existsSync(skillPath)) {
    return { success: true };
  }

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashDir = path.join(getTrashPluginsDir(), agent, version, skillName);
    const trashDest = path.join(trashDir, stamp);
    fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    fs.renameSync(skillPath, trashDest);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}

// ─── Install / Update ─────────────────────────────────────────────────────────

/**
 * Parse an install spec of the form `name@source` or just `source`.
 * Source can be a git URL or an absolute/relative local path.
 */
export function parseInstallSpec(spec: string): { name: string | null; source: string } {
  // Check for name@source form
  const atIdx = spec.indexOf('@');
  if (atIdx > 0) {
    const name = spec.slice(0, atIdx);
    const source = spec.slice(atIdx + 1);
    return { name, source };
  }
  return { name: null, source: spec };
}

/**
 * Install a plugin from a git URL or local path.
 * Clones/copies to ~/.agents/plugins/<name>/.
 * Returns the installed plugin name and root path.
 */
export async function installPlugin(spec: string): Promise<{ name: string; root: string; isNew: boolean; capabilities: PluginCapabilities }> {
  const { name: specName, source } = parseInstallSpec(spec);

  // Resolve local path (handle ~)
  const isLocalPath = source.startsWith('/') || source.startsWith('./') || source.startsWith('../') || source.startsWith('~')
    || (IS_WINDOWS && isWindowsAbsolutePath(source));
  const resolvedSource = isLocalPath
    ? source.replace(/^~/, homeDir())
    : source;

  const pluginsDir = getPluginsDir();
  fs.mkdirSync(pluginsDir, { recursive: true });

  // If local path, load manifest to get the name
  let targetName = specName;
  if (!targetName) {
    if (isLocalPath) {
      const manifest = loadPluginManifest(resolvedSource);
      if (!manifest) throw new Error(`No valid plugin.json found at ${resolvedSource}`);
      targetName = manifest.name;
    } else {
      // Derive from git URL: last path segment without .git
      targetName = path.basename(resolvedSource).replace(/\.git$/, '');
    }
  }
  if (!validatePluginName(targetName)) {
    throw new Error(`Invalid plugin name: ${targetName}`);
  }

  const targetRoot = path.join(pluginsDir, targetName);
  assertPluginTargetContained(targetRoot, pluginsDir);
  const isNew = !fs.existsSync(targetRoot);

  if (isLocalPath) {
    // Copy local directory
    if (fs.existsSync(targetRoot)) {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
    fs.cpSync(resolvedSource, targetRoot, { recursive: true });
  } else {
    // Git clone. Validate the transport (blocks ext::/file:///http:///leading-"-")
    // and pass "--" so the source can never be parsed as a git option.
    assertSafeGitTransport(resolvedSource);
    if (fs.existsSync(targetRoot)) {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
    execFileSync('git', ['clone', '--depth', '1', '--', resolvedSource, targetRoot], {
      stdio: 'pipe',
    });
  }

  // Validate manifest
  const manifest = loadPluginManifest(targetRoot);
  if (!manifest) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    throw new Error(`Installed source has no valid .claude-plugin/plugin.json`);
  }
  const capabilities = inspectPluginCapabilities(targetRoot);

  // Persist source for future updates
  fs.writeFileSync(path.join(targetRoot, SOURCE_FILE), JSON.stringify({ source, isGit: !isLocalPath }), 'utf-8');

  return { name: manifest.name, root: targetRoot, isNew, capabilities };
}

/**
 * Update an installed plugin by re-pulling from its original source.
 * Returns true if the update succeeded.
 */
export async function updatePlugin(name: string): Promise<{ success: boolean; error?: string }> {
  const plugin = getPlugin(name);
  if (!plugin) {
    return { success: false, error: `Plugin '${name}' not found` };
  }

  const sourceFile = path.join(plugin.root, SOURCE_FILE);
  if (!fs.existsSync(sourceFile)) {
    return { success: false, error: `No source recorded for '${name}' — was it installed with 'agents plugins install'?` };
  }

  let sourceInfo: { source: string; isGit: boolean };
  try {
    sourceInfo = JSON.parse(fs.readFileSync(sourceFile, 'utf-8')) as { source: string; isGit: boolean };
  } catch {
    return { success: false, error: `Could not read source info for '${name}'` };
  }

  try {
    if (sourceInfo.isGit) {
      execFileSync('git', ['-C', plugin.root, 'pull', '--ff-only'], { stdio: 'pipe' });
    } else {
      const resolvedSource = sourceInfo.source.replace(/^~/, homeDir());
      if (!fs.existsSync(resolvedSource)) {
        return { success: false, error: `Source path no longer exists: ${resolvedSource}` };
      }
      // Preserve .user-config.json and .source during re-copy
      const userConfigPath = path.join(plugin.root, USER_CONFIG_FILE);
      const userConfigBackup = fs.existsSync(userConfigPath)
        ? fs.readFileSync(userConfigPath, 'utf-8')
        : null;
      fs.rmSync(plugin.root, { recursive: true, force: true });
      fs.cpSync(resolvedSource, plugin.root, { recursive: true });
      fs.writeFileSync(path.join(plugin.root, SOURCE_FILE), JSON.stringify(sourceInfo), 'utf-8');
      if (userConfigBackup !== null) {
        fs.writeFileSync(userConfigPath, userConfigBackup, 'utf-8');
      }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  return { success: true };
}
