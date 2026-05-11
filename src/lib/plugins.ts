/**
 * Plugin discovery, validation, and syncing.
 *
 * Plugins are bundles in ~/.agents/.cache/plugins/ that package skills, hooks,
 * commands, agents, bin scripts, MCP servers, and settings under a single
 * manifest (plugin.json). This module discovers plugins, validates their
 * manifests, and syncs their contents into agent version homes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { AgentId, DiscoveredPlugin, PluginManifest } from './types.js';
import { getPluginsDir, getTrashPluginsDir } from './state.js';
import { listInstalledVersions, getVersionHomePath } from './versions.js';
import { AGENTS, PLUGINS_CAPABLE_AGENTS } from './agents.js';

const PLUGIN_MANIFEST_DIR = '.claude-plugin';
const PLUGIN_MANIFEST_FILE = 'plugin.json';
const USER_CONFIG_FILE = '.user-config.json';
const SOURCE_FILE = '.source';

/**
 * Discover all plugins in ~/.agents/.cache/plugins/.
 * A valid plugin has a .claude-plugin/plugin.json manifest.
 */
export function discoverPlugins(): DiscoveredPlugin[] {
  const pluginsDir = getPluginsDir();
  if (!fs.existsSync(pluginsDir)) {
    return [];
  }

  const plugins: DiscoveredPlugin[] = [];
  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const pluginRoot = path.join(pluginsDir, entry.name);
    const manifest = loadPluginManifest(pluginRoot);
    if (!manifest) continue;

    plugins.push({
      name: manifest.name,
      root: pluginRoot,
      manifest,
      skills: discoverPluginSkills(pluginRoot),
      hooks: discoverPluginHooks(pluginRoot),
      scripts: discoverPluginScripts(pluginRoot),
      commands: discoverPluginCommands(pluginRoot),
      agentDefs: discoverPluginAgentDefs(pluginRoot),
      bin: discoverPluginBin(pluginRoot),
      hasMcp: fs.existsSync(path.join(pluginRoot, '.mcp.json')),
      hasSettings: pluginHasNonPermissionSettings(pluginRoot),
    });
  }

  return plugins;
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
    if (/[/\\]/.test(parsed.name) || parsed.name.includes('..') || parsed.name.includes('\0')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
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
  if (!PLUGINS_CAPABLE_AGENTS.includes(agent)) return false;
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

function discoverPluginHooks(pluginRoot: string): string[] {
  const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksFile)) return [];

  try {
    const content = JSON.parse(fs.readFileSync(hooksFile, 'utf-8')) as Record<string, unknown>;
    return Object.keys(content);
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
  const dataDir = path.join(versionHome, `.${agentId}`, 'plugin-data', pluginName);
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

// ─── Main sync entry point ────────────────────────────────────────────────────

/**
 * Sync a plugin to a specific agent version's home directory.
 *
 * For Claude:
 *   1. Copy plugin skills into version's skills dir (prefixed: pluginName--skillName)
 *   2. Copy plugin commands into version's commands dir (prefixed: pluginName--cmdName.md)
 *   3. Copy plugin agent defs into version's agents dir (prefixed: pluginName--agentName.md)
 *   4. Copy plugin bin/ into version home plugin-bin/<pluginName>/, note path in settings
 *   5. Read hooks/hooks.json, expand vars, merge into settings.json hooks
 *   6. Read .mcp.json, expand vars, merge mcpServers into settings.json
 *   7. Read settings.json, merge non-permission keys non-destructively into settings.json
 *   8. Read settings.json permissions, expand vars, merge into settings.json
 */
export function syncPluginToVersion(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
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

  // 1. Sync skills
  result.skills = syncPluginSkills(plugin, agent, versionHome, userConfig);

  // 2. Sync commands (Claude + compatible agents only)
  if (agent === 'claude' || agent === 'openclaw') {
    result.commands = syncPluginCommands(plugin, agent, versionHome, userConfig);
  }

  // 3. Sync agent defs (Claude only)
  if (agent === 'claude') {
    result.agentDefs = syncPluginAgentDefs(plugin, agent, versionHome, userConfig);
  }

  // 4. Sync bin executables (Claude only for now)
  if (agent === 'claude') {
    result.bin = syncPluginBin(plugin, agent, versionHome);
  }

  // 5. Sync hooks (Claude only - uses settings.json hook registration)
  if (agent === 'claude') {
    result.hooks = syncPluginHooks(plugin, agent, versionHome, userConfig);
  }

  // 6. Sync MCP servers (Claude only)
  if (agent === 'claude') {
    result.mcp = syncPluginMcp(plugin, agent, versionHome, userConfig);
  }

  // 7. Merge non-permission settings keys non-destructively (Claude only)
  if (agent === 'claude') {
    result.settings = syncPluginSettings(plugin, agent, versionHome);
  }

  // 8. Sync permissions (Claude only - uses settings.json permissions)
  if (agent === 'claude') {
    result.permissions = syncPluginPermissions(plugin, agent, versionHome, userConfig);
  }

  result.success =
    result.skills.length > 0 ||
    result.commands.length > 0 ||
    result.agentDefs.length > 0 ||
    result.bin.length > 0 ||
    result.hooks.length > 0 ||
    result.mcp ||
    result.settings ||
    result.permissions;

  return result;
}

// ─── Individual sync functions ────────────────────────────────────────────────

/**
 * Copy plugin skills into the version's skills directory.
 * Skills are prefixed with the plugin name: pluginName--skillName
 */
function syncPluginSkills(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string,
  userConfig: Record<string, string>
): string[] {
  const synced: string[] = [];
  const pluginSkillsDir = path.join(plugin.root, 'skills');
  if (!fs.existsSync(pluginSkillsDir)) return synced;

  const targetSkillsDir = path.join(versionHome, `.${agent}`, 'skills');
  fs.mkdirSync(targetSkillsDir, { recursive: true });

  for (const skillName of plugin.skills) {
    const srcDir = path.join(pluginSkillsDir, skillName);
    const fsSafeName = `${plugin.name}--${skillName}`;
    const destDir = path.join(targetSkillsDir, fsSafeName);

    try {
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      copyDirWithVarExpansion(srcDir, destDir, plugin.root, plugin.name, agent, versionHome, userConfig);
      synced.push(`${plugin.name}:${skillName}`);
    } catch {
      // Skip on error
    }
  }

  return synced;
}

/**
 * Copy plugin commands into the version's commands directory.
 * Commands are namespaced: pluginName--commandName.md
 */
function syncPluginCommands(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string,
  userConfig: Record<string, string>
): string[] {
  const synced: string[] = [];
  const pluginCommandsDir = path.join(plugin.root, 'commands');
  if (!fs.existsSync(pluginCommandsDir) || plugin.commands.length === 0) return synced;

  const agentConfig = AGENTS[agent];
  const commandsTarget = path.join(versionHome, `.${agent}`, agentConfig.commandsSubdir);
  fs.mkdirSync(commandsTarget, { recursive: true });

  for (const cmdName of plugin.commands) {
    const srcFile = path.join(pluginCommandsDir, `${cmdName}.md`);
    if (!fs.existsSync(srcFile)) continue;

    const destName = `${plugin.name}--${cmdName}.md`;
    const destFile = path.join(commandsTarget, destName);

    try {
      let content = fs.readFileSync(srcFile, 'utf-8');
      content = expandPluginVars(content, plugin.root, plugin.name, agent, versionHome, userConfig);
      fs.writeFileSync(destFile, content, 'utf-8');
      synced.push(`${plugin.name}:${cmdName}`);
    } catch {
      // Skip on error
    }
  }

  return synced;
}

/**
 * Copy plugin agent definitions into the version's agents directory.
 * Agent defs are namespaced: pluginName--agentName.md
 */
function syncPluginAgentDefs(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string,
  userConfig: Record<string, string>
): string[] {
  const synced: string[] = [];
  const pluginAgentsDir = path.join(plugin.root, 'agents');
  if (!fs.existsSync(pluginAgentsDir) || plugin.agentDefs.length === 0) return synced;

  const agentsTarget = path.join(versionHome, `.${agent}`, 'agents');
  fs.mkdirSync(agentsTarget, { recursive: true });

  for (const agentDefName of plugin.agentDefs) {
    const srcFile = path.join(pluginAgentsDir, `${agentDefName}.md`);
    if (!fs.existsSync(srcFile)) continue;

    const destName = `${plugin.name}--${agentDefName}.md`;
    const destFile = path.join(agentsTarget, destName);

    try {
      let content = fs.readFileSync(srcFile, 'utf-8');
      content = expandPluginVars(content, plugin.root, plugin.name, agent, versionHome, userConfig);
      fs.writeFileSync(destFile, content, 'utf-8');
      synced.push(`${plugin.name}:${agentDefName}`);
    } catch {
      // Skip on error
    }
  }

  return synced;
}

/**
 * Copy plugin bin executables into the version home plugin-bin/<pluginName>/ directory.
 * Records the bin path in settings.json under pluginBinPaths so callers can add it to PATH.
 */
function syncPluginBin(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): string[] {
  const synced: string[] = [];
  const pluginBinDir = path.join(plugin.root, 'bin');
  if (!fs.existsSync(pluginBinDir) || plugin.bin.length === 0) return synced;

  const targetBinDir = path.join(versionHome, `.${agent}`, 'plugin-bin', plugin.name);
  fs.mkdirSync(targetBinDir, { recursive: true });

  for (const binFile of plugin.bin) {
    const srcFile = path.join(pluginBinDir, binFile);
    if (!fs.existsSync(srcFile)) continue;

    const destFile = path.join(targetBinDir, binFile);
    try {
      fs.copyFileSync(srcFile, destFile);
      const stat = fs.statSync(srcFile);
      fs.chmodSync(destFile, stat.mode | 0o111);
      synced.push(binFile);
    } catch {
      // Skip on error
    }
  }

  if (synced.length === 0) return synced;

  // Note the bin path in settings.json so the calling shim can add it to PATH.
  const configDir = path.join(versionHome, `.${agent}`);
  const settingsPath = path.join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }
  }

  if (!Array.isArray(settings.pluginBinPaths)) {
    settings.pluginBinPaths = [];
  }
  const binPaths = settings.pluginBinPaths as string[];
  if (!binPaths.includes(targetBinDir)) {
    binPaths.push(targetBinDir);
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch { /* ignore write errors */ }

  return synced;
}

/**
 * Merge plugin hooks into Claude's settings.json.
 * Reads the plugin's hooks/hooks.json and merges each event's hooks
 * into the version's settings.json, expanding variables.
 */
function syncPluginHooks(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string,
  userConfig: Record<string, string>
): string[] {
  const synced: string[] = [];
  const hooksFile = path.join(plugin.root, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksFile)) return synced;

  let pluginHooks: Record<string, Array<{
    matcher?: string;
    hooks?: Array<{ type: string; command: string; timeout?: number }>;
  }>>;

  try {
    pluginHooks = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
  } catch {
    return synced;
  }

  const configDir = path.join(versionHome, `.${agent}`);
  const settingsPath = path.join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooksConfig = settings.hooks as Record<string, unknown[]>;

  for (const [event, matcherGroups] of Object.entries(pluginHooks)) {
    if (!hooksConfig[event]) {
      hooksConfig[event] = [];
    }
    const eventEntries = hooksConfig[event] as Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; timeout?: number }>;
    }>;

    for (const group of matcherGroups) {
      const matcher = group.matcher || '';
      const expandedHooks = (group.hooks || []).map(h => ({
        ...h,
        command: expandPluginVars(h.command, plugin.root, plugin.name, agent, versionHome, userConfig),
      }));

      let matcherGroup = eventEntries.find(e => (e.matcher || '') === matcher);
      if (!matcherGroup) {
        matcherGroup = { matcher, hooks: [] };
        eventEntries.push(matcherGroup);
      }
      if (!matcherGroup.hooks) {
        matcherGroup.hooks = [];
      }

      for (const hook of expandedHooks) {
        const exists = matcherGroup.hooks.some(h => h.command === hook.command);
        if (!exists) {
          matcherGroup.hooks.push(hook);
        }
      }
    }

    synced.push(event);
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch { /* ignore write errors */ }

  return synced;
}

/**
 * Merge plugin .mcp.json MCP server definitions into Claude's settings.json.
 * Server names are namespaced as pluginName--serverName to avoid collisions.
 * Expands ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}, ${user_config.*} in args and env.
 */
function syncPluginMcp(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string,
  userConfig: Record<string, string>
): boolean {
  const mcpFile = path.join(plugin.root, '.mcp.json');
  if (!fs.existsSync(mcpFile)) return false;

  let pluginMcp: { mcpServers?: Record<string, unknown> };
  try {
    pluginMcp = JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
  } catch {
    return false;
  }

  const servers = pluginMcp.mcpServers;
  if (!servers || Object.keys(servers).length === 0) return false;

  const configDir = path.join(versionHome, `.${agent}`);
  const settingsPath = path.join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }
  }

  if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
    settings.mcpServers = {};
  }
  const existing = settings.mcpServers as Record<string, unknown>;

  let merged = false;
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    const namespacedName = `${plugin.name}--${serverName}`;
    // Expand variables inside the server config
    const configStr = expandPluginVars(
      JSON.stringify(serverConfig),
      plugin.root,
      plugin.name,
      agent,
      versionHome,
      userConfig
    );
    existing[namespacedName] = JSON.parse(configStr) as unknown;
    merged = true;
  }

  if (merged) {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch {
      return false;
    }
  }

  return merged;
}

/**
 * Merge non-permission keys from plugin's settings.json non-destructively into agent settings.
 * Only adds keys that don't already exist — never overwrites user config.
 * Permission keys are handled separately by syncPluginPermissions.
 */
function syncPluginSettings(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): boolean {
  const pluginSettingsPath = path.join(plugin.root, 'settings.json');
  if (!fs.existsSync(pluginSettingsPath)) return false;

  let pluginSettings: Record<string, unknown>;
  try {
    pluginSettings = JSON.parse(fs.readFileSync(pluginSettingsPath, 'utf-8'));
  } catch {
    return false;
  }

  // Exclude permissions — those are handled by syncPluginPermissions
  const keysToMerge = Object.entries(pluginSettings).filter(([k]) => k !== 'permissions');
  if (keysToMerge.length === 0) return false;

  const configDir = path.join(versionHome, `.${agent}`);
  const settingsPath = path.join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }
  }

  let changed = false;
  for (const [key, value] of keysToMerge) {
    if (!(key in settings)) {
      settings[key] = value;
      changed = true;
    }
  }

  if (changed) {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch {
      return false;
    }
  }

  return changed;
}

/**
 * Merge plugin permissions into Claude's settings.json.
 * Reads the plugin's settings.json and merges permissions.allow / deny entries.
 */
function syncPluginPermissions(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string,
  userConfig: Record<string, string>
): boolean {
  const pluginSettingsPath = path.join(plugin.root, 'settings.json');
  if (!fs.existsSync(pluginSettingsPath)) return false;

  let pluginSettings: { permissions?: { allow?: string[]; deny?: string[] } };
  try {
    pluginSettings = JSON.parse(fs.readFileSync(pluginSettingsPath, 'utf-8'));
  } catch {
    return false;
  }

  const pluginAllow = pluginSettings.permissions?.allow || [];
  const pluginDeny = pluginSettings.permissions?.deny || [];
  if (pluginAllow.length === 0 && pluginDeny.length === 0) return false;

  const expandedAllow = pluginAllow.map(rule =>
    expandPluginVars(rule, plugin.root, plugin.name, agent, versionHome, userConfig)
  );
  const expandedDeny = pluginDeny.map(rule =>
    expandPluginVars(rule, plugin.root, plugin.name, agent, versionHome, userConfig)
  );

  const configDir = path.join(versionHome, `.${agent}`);
  const settingsPath = path.join(configDir, 'settings.json');
  let settings: Record<string, unknown> = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }
  }

  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = { allow: [], deny: [] };
  }
  const perms = settings.permissions as { allow: string[]; deny: string[] };
  if (!perms.allow) perms.allow = [];
  if (!perms.deny) perms.deny = [];

  for (const rule of expandedAllow) {
    if (!perms.allow.includes(rule)) {
      perms.allow.push(rule);
    }
  }
  for (const rule of expandedDeny) {
    if (!perms.deny.includes(rule)) {
      perms.deny.push(rule);
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Copy a directory recursively, expanding plugin variables in text file contents.
 * Only expands variables in text files (.md, .json, .sh, .py, .js, .ts, .yaml, .yml, .toml).
 */
function copyDirWithVarExpansion(
  src: string,
  dest: string,
  pluginRoot: string,
  pluginName: string,
  agent: AgentId,
  versionHome: string,
  userConfig?: Record<string, string>
): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  const textExtensions = new Set(['.md', '.json', '.sh', '.py', '.js', '.ts', '.yaml', '.yml', '.toml', '.txt']);

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirWithVarExpansion(srcPath, destPath, pluginRoot, pluginName, agent, versionHome, userConfig);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (textExtensions.has(ext)) {
        let content = fs.readFileSync(srcPath, 'utf-8');
        content = expandPluginVars(content, pluginRoot, pluginName, agent, versionHome, userConfig);
        fs.writeFileSync(destPath, content, 'utf-8');
      } else {
        fs.copyFileSync(srcPath, destPath);
      }

      const stat = fs.statSync(srcPath);
      if (stat.mode & 0o111) {
        fs.chmodSync(destPath, stat.mode);
      }
    }
  }
}

// ─── Sync status ──────────────────────────────────────────────────────────────

/**
 * Check if a plugin is synced to a version by inspecting the version home.
 * Checks skills, commands, agent defs, bin, hook commands, and permissions.
 */
export function isPluginSynced(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): boolean {
  const prefix = `${plugin.name}--`;

  // Check 1: plugin skill directories
  if (plugin.skills.length > 0) {
    const skillsDir = path.join(versionHome, `.${agent}`, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const skillName of plugin.skills) {
        if (fs.existsSync(path.join(skillsDir, `${prefix}${skillName}`))) {
          return true;
        }
      }
    }
  }

  // Check 2: plugin command files
  if (plugin.commands.length > 0 && (agent === 'claude' || agent === 'openclaw')) {
    const agentConfig = AGENTS[agent];
    const commandsDir = path.join(versionHome, `.${agent}`, agentConfig.commandsSubdir);
    if (fs.existsSync(commandsDir)) {
      for (const cmdName of plugin.commands) {
        if (fs.existsSync(path.join(commandsDir, `${prefix}${cmdName}.md`))) {
          return true;
        }
      }
    }
  }

  // Check 3: plugin agent definition files
  if (plugin.agentDefs.length > 0 && agent === 'claude') {
    const agentsDir = path.join(versionHome, `.${agent}`, 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const agentDefName of plugin.agentDefs) {
        if (fs.existsSync(path.join(agentsDir, `${prefix}${agentDefName}.md`))) {
          return true;
        }
      }
    }
  }

  // Check 4: plugin bin directory
  if (plugin.bin.length > 0 && agent === 'claude') {
    const binDir = path.join(versionHome, `.${agent}`, 'plugin-bin', plugin.name);
    if (fs.existsSync(binDir)) {
      return true;
    }
  }

  // Check 5: plugin hooks registered in settings.json (commands referencing plugin root)
  if (plugin.hooks.length > 0 && agent === 'claude') {
    const settingsPath = path.join(versionHome, `.${agent}`, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        if (content.includes(plugin.root)) {
          return true;
        }
      } catch { /* ignore */ }
    }
  }

  // Check 6: plugin permissions in settings.json
  if (agent === 'claude') {
    const settingsPath = path.join(versionHome, `.${agent}`, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const allow = settings.permissions?.allow || [];
        if (allow.some((rule: string) => rule.includes(plugin.root))) {
          return true;
        }
        // Check MCP servers
        const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
        if (mcpServers) {
          const hasNamespacedServer = Object.keys(mcpServers).some(k => k.startsWith(prefix));
          if (hasNamespacedServer) return true;
        }
      } catch { /* ignore */ }
    }
  }

  return false;
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

  const prefix = `${pluginName}--`;

  // 1. Remove synced skill dirs
  const skillsDir = path.join(versionHome, `.${agent}`, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      try {
        fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
        result.skills.push(entry.name);
      } catch { /* skip on error */ }
    }
  }

  // 2. Remove synced command files
  if (agent === 'claude' || agent === 'openclaw') {
    const agentConfig = AGENTS[agent];
    const commandsDir = path.join(versionHome, `.${agent}`, agentConfig.commandsSubdir);
    if (fs.existsSync(commandsDir)) {
      for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue;
        try {
          fs.unlinkSync(path.join(commandsDir, entry.name));
          result.commands.push(entry.name);
        } catch { /* skip on error */ }
      }
    }
  }

  // 3. Remove synced agent def files
  if (agent === 'claude') {
    const agentsDir = path.join(versionHome, `.${agent}`, 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.md')) continue;
        try {
          fs.unlinkSync(path.join(agentsDir, entry.name));
          result.agentDefs.push(entry.name);
        } catch { /* skip on error */ }
      }
    }
  }

  // 4. Remove plugin-bin directory
  if (agent === 'claude') {
    const binDir = path.join(versionHome, `.${agent}`, 'plugin-bin', pluginName);
    if (fs.existsSync(binDir)) {
      try {
        fs.rmSync(binDir, { recursive: true, force: true });
        result.bin.push(binDir);
      } catch { /* skip on error */ }
    }
  }

  if (agent !== 'claude') {
    return result;
  }

  // 5 + 6 + 7: edit settings.json — strip hooks, permissions, mcpServers matching plugin
  const settingsPath = path.join(versionHome, `.${agent}`, 'settings.json');
  if (!fs.existsSync(settingsPath)) return result;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return result;
  }

  let changed = false;

  // Strip hooks referencing plugin root
  const hooksConfig = settings.hooks as Record<string, unknown> | undefined;
  if (hooksConfig && typeof hooksConfig === 'object') {
    for (const [event, entries] of Object.entries(hooksConfig)) {
      if (!Array.isArray(entries)) continue;
      const eventEntries = entries as Array<{
        matcher?: string;
        hooks?: Array<{ type: string; command: string; timeout?: number }>;
      }>;

      for (const group of eventEntries) {
        if (!Array.isArray(group.hooks)) continue;
        const originalLen = group.hooks.length;
        group.hooks = group.hooks.filter(h => {
          const matches = typeof h.command === 'string' && h.command.includes(pluginRoot);
          if (matches) result.hooks.push(`${event}: ${h.command}`);
          return !matches;
        });
        if (group.hooks.length !== originalLen) changed = true;
      }

      const kept = eventEntries.filter(g => Array.isArray(g.hooks) && g.hooks.length > 0);
      if (kept.length !== eventEntries.length) {
        hooksConfig[event] = kept;
        changed = true;
      }

      if (Array.isArray(hooksConfig[event]) && (hooksConfig[event] as unknown[]).length === 0) {
        delete hooksConfig[event];
        changed = true;
      }
    }
  }

  // Strip permissions referencing plugin root
  const perms = settings.permissions as { allow?: string[]; deny?: string[] } | undefined;
  if (perms && typeof perms === 'object') {
    for (const key of ['allow', 'deny'] as const) {
      const list = perms[key];
      if (!Array.isArray(list)) continue;
      const kept = list.filter(rule => {
        const matches = typeof rule === 'string' && rule.includes(pluginRoot);
        if (matches) result.permissions += 1;
        return !matches;
      });
      if (kept.length !== list.length) {
        perms[key] = kept;
        changed = true;
      }
    }
  }

  // Strip namespaced MCP servers added by this plugin
  const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
  if (mcpServers && typeof mcpServers === 'object') {
    for (const serverName of Object.keys(mcpServers)) {
      if (serverName.startsWith(prefix)) {
        delete mcpServers[serverName];
        result.mcp += 1;
        changed = true;
      }
    }
  }

  // Strip bin path from pluginBinPaths
  if (Array.isArray(settings.pluginBinPaths)) {
    const binDir = path.join(versionHome, `.${agent}`, 'plugin-bin', pluginName);
    const before = settings.pluginBinPaths.length;
    settings.pluginBinPaths = (settings.pluginBinPaths as string[]).filter(p => p !== binDir);
    if ((settings.pluginBinPaths as string[]).length !== before) changed = true;
  }

  if (changed) {
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch { /* ignore write errors */ }
  }

  return result;
}

// ─── Orphan cleanup ───────────────────────────────────────────────────────────

/**
 * Remove orphaned plugin skill directories from a version home.
 * Soft-deletes to ~/.agents/.trash/plugins/.
 */
export function cleanOrphanedPluginSkills(
  agent: AgentId,
  versionHome: string,
  activePluginNames: Set<string>,
  version?: string
): string[] {
  const removed: string[] = [];
  const skillsDir = path.join(versionHome, `.${agent}`, 'skills');
  if (!fs.existsSync(skillsDir)) return removed;

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dashIdx = entry.name.indexOf('--');
    if (dashIdx === -1) continue;

    const pluginName = entry.name.slice(0, dashIdx);
    if (!activePluginNames.has(pluginName)) {
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
  const skillsDir = path.join(versionHome, `.${agent}`, 'skills');
  const orphans: string[] = [];

  if (!fs.existsSync(skillsDir)) {
    return { agent, version, orphans };
  }

  const activePlugins = new Set(discoverPlugins().map(p => p.name));
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dashIdx = entry.name.indexOf('--');
    if (dashIdx === -1) continue;

    const pluginName = entry.name.slice(0, dashIdx);
    if (!activePlugins.has(pluginName)) {
      orphans.push(entry.name);
    }
  }

  return { agent, version, orphans: orphans.sort() };
}

export function iterPluginsCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const agents = filter?.agent ? [filter.agent] : PLUGINS_CAPABLE_AGENTS;
  for (const agent of agents) {
    if (!PLUGINS_CAPABLE_AGENTS.includes(agent)) continue;
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
  const skillPath = path.join(versionHome, `.${agent}`, 'skills', skillName);

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
 * Clones/copies to ~/.agents/.cache/plugins/<name>/.
 * Returns the installed plugin name and root path.
 */
export async function installPlugin(spec: string): Promise<{ name: string; root: string; isNew: boolean }> {
  const { name: specName, source } = parseInstallSpec(spec);

  // Resolve local path (handle ~)
  const isLocalPath = source.startsWith('/') || source.startsWith('./') || source.startsWith('../') || source.startsWith('~');
  const resolvedSource = isLocalPath
    ? source.replace(/^~/, process.env.HOME || '~')
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

  const targetRoot = path.join(pluginsDir, targetName);
  const isNew = !fs.existsSync(targetRoot);

  if (isLocalPath) {
    // Copy local directory
    if (fs.existsSync(targetRoot)) {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
    fs.cpSync(resolvedSource, targetRoot, { recursive: true });
  } else {
    // Git clone
    if (fs.existsSync(targetRoot)) {
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
    execSync(`git clone --depth 1 ${JSON.stringify(resolvedSource)} ${JSON.stringify(targetRoot)}`, {
      stdio: 'pipe',
    });
  }

  // Validate manifest
  const manifest = loadPluginManifest(targetRoot);
  if (!manifest) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    throw new Error(`Installed source has no valid .claude-plugin/plugin.json`);
  }

  // Persist source for future updates
  fs.writeFileSync(path.join(targetRoot, SOURCE_FILE), JSON.stringify({ source, isGit: !isLocalPath }), 'utf-8');

  return { name: manifest.name, root: targetRoot, isNew };
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
      execSync(`git -C ${JSON.stringify(plugin.root)} pull --ff-only`, { stdio: 'pipe' });
    } else {
      const resolvedSource = sourceInfo.source.replace(/^~/, process.env.HOME || '~');
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
