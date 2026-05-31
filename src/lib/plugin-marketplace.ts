/**
 * Native plugin marketplace install path for Claude / OpenClaw.
 *
 * Plugins managed by agents-cli are exposed as a synthetic local marketplace
 * named "agents-cli" under each version's plugin directory:
 *
 *   <versionHome>/.{claude,openclaw}/plugins/
 *     known_marketplaces.json            # registers the "agents-cli" marketplace
 *     marketplaces/agents-cli/
 *       .claude-plugin/marketplace.json  # synthesized catalog
 *       plugins/<plugin>/                # copied plugin source
 *
 * Plus the version's settings.json gets `enabledPlugins["<plugin>@agents-cli"] = true`.
 *
 * This produces native `/plugin:skill` slash namespacing, visibility in `/plugins`,
 * and `/plugin enable|disable` support — matching the Claude Code spec at
 * https://code.claude.com/docs/en/plugins and /plugin-marketplaces.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, DiscoveredPlugin, PluginManifest } from './types.js';

export const MARKETPLACE_NAME = 'agents-cli';

interface KnownMarketplaceEntry {
  source: { source: 'directory'; path: string };
  installLocation: string;
  lastUpdated: string;
}

interface MarketplacePluginEntry {
  name: string;
  source: string;
  description?: string;
  version?: string;
  author?: { name: string; email?: string };
}

interface MarketplaceManifest {
  $schema?: string;
  name: string;
  description?: string;
  owner: { name: string; email?: string };
  plugins: MarketplacePluginEntry[];
}

function pluginsRootForVersion(agent: AgentId, versionHome: string): string {
  return path.join(versionHome, `.${agent}`, 'plugins');
}

export function marketplaceRoot(agent: AgentId, versionHome: string): string {
  return path.join(pluginsRootForVersion(agent, versionHome), 'marketplaces', MARKETPLACE_NAME);
}

export function marketplaceManifestPath(agent: AgentId, versionHome: string): string {
  return path.join(marketplaceRoot(agent, versionHome), '.claude-plugin', 'marketplace.json');
}

export function pluginInstallDir(plugin: DiscoveredPlugin, agent: AgentId, versionHome: string): string {
  return path.join(marketplaceRoot(agent, versionHome), 'plugins', plugin.name);
}

export function knownMarketplacesPath(agent: AgentId, versionHome: string): string {
  return path.join(pluginsRootForVersion(agent, versionHome), 'known_marketplaces.json');
}

function settingsPath(agent: AgentId, versionHome: string): string {
  return path.join(versionHome, `.${agent}`, 'settings.json');
}

/**
 * Copy plugin source into marketplace install dir.
 * Source of truth remains ~/.agents/plugins/<name>/ — this is a per-version snapshot.
 */
export function copyPluginToMarketplace(
  plugin: DiscoveredPlugin,
  agent: AgentId,
  versionHome: string
): string {
  const dest = pluginInstallDir(plugin, agent, versionHome);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(plugin.root, dest, { recursive: true, dereference: false });
  return dest;
}

/**
 * Re-synthesize <marketplace>/.claude-plugin/marketplace.json from the list of
 * plugins installed under <marketplace>/plugins/. Always run after add or remove
 * so the manifest stays in lockstep with on-disk contents.
 */
export function syncMarketplaceManifest(agent: AgentId, versionHome: string): MarketplaceManifest | null {
  const root = marketplaceRoot(agent, versionHome);
  const pluginsDir = path.join(root, 'plugins');
  if (!fs.existsSync(pluginsDir)) return null;

  const entries: MarketplacePluginEntry[] = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const manifestFile = path.join(pluginsDir, entry.name, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestFile)) continue;

    let manifest: PluginManifest & { author?: { name: string; email?: string } };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    } catch {
      continue;
    }

    entries.push({
      name: manifest.name,
      source: `./plugins/${manifest.name}`,
      description: manifest.description,
      version: manifest.version,
      ...(manifest.author ? { author: manifest.author } : {}),
    });
  }

  const manifest: MarketplaceManifest = {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: MARKETPLACE_NAME,
    description: 'Plugins managed by agents-cli',
    owner: { name: 'agents-cli' },
    plugins: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };

  const manifestPath = marketplaceManifestPath(agent, versionHome);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}

/**
 * Register the agents-cli marketplace in known_marketplaces.json so Claude Code
 * discovers it on startup. Idempotent: re-running just refreshes lastUpdated.
 */
export function registerMarketplace(agent: AgentId, versionHome: string): void {
  const root = marketplaceRoot(agent, versionHome);
  const knownPath = knownMarketplacesPath(agent, versionHome);

  let known: Record<string, KnownMarketplaceEntry> = {};
  if (fs.existsSync(knownPath)) {
    try {
      known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
    } catch {
      known = {};
    }
  }

  known[MARKETPLACE_NAME] = {
    source: { source: 'directory', path: root },
    installLocation: root,
    lastUpdated: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(knownPath), { recursive: true });
  fs.writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n', 'utf-8');
}

/**
 * Drop the agents-cli marketplace entry from known_marketplaces.json.
 * Called when the last plugin under it is removed.
 */
export function unregisterMarketplace(agent: AgentId, versionHome: string): void {
  const knownPath = knownMarketplacesPath(agent, versionHome);
  if (!fs.existsSync(knownPath)) return;

  let known: Record<string, KnownMarketplaceEntry>;
  try {
    known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
  } catch {
    return;
  }

  if (!(MARKETPLACE_NAME in known)) return;
  delete known[MARKETPLACE_NAME];

  if (Object.keys(known).length === 0) {
    try {
      fs.unlinkSync(knownPath);
    } catch { /* ignore */ }
  } else {
    fs.writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n', 'utf-8');
  }
}

/**
 * Mark a plugin as enabled in <versionHome>/.{agent}/settings.json under
 * enabledPlugins["<plugin>@agents-cli"]: true. Reads, mutates, writes —
 * preserving every other key.
 */
export function enablePluginInSettings(
  pluginName: string,
  agent: AgentId,
  versionHome: string,
  options: { allowExecSurfaces?: boolean } = {}
): void {
  if (!options.allowExecSurfaces && marketplacePluginHasExecSurfaces(pluginName, agent, versionHome)) {
    return;
  }

  const sPath = settingsPath(agent, versionHome);
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(sPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object') {
    settings.enabledPlugins = {};
  }
  const enabled = settings.enabledPlugins as Record<string, boolean>;
  const key = `${pluginName}@${MARKETPLACE_NAME}`;
  if (enabled[key] === true) return;
  enabled[key] = true;

  fs.mkdirSync(path.dirname(sPath), { recursive: true });
  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function marketplacePluginHasExecSurfaces(pluginName: string, agent: AgentId, versionHome: string): boolean {
  const root = path.join(marketplaceRoot(agent, versionHome), 'plugins', pluginName);
  if (fs.existsSync(path.join(root, '.mcp.json'))) return true;
  for (const dir of ['bin', 'scripts', 'permissions']) {
    if (fs.existsSync(path.join(root, dir))) return true;
  }
  const hooksFile = path.join(root, 'hooks', 'hooks.json');
  if (fs.existsSync(hooksFile)) return true;
  const hooksDir = path.join(root, 'hooks');
  if (fs.existsSync(hooksDir)) {
    try {
      if (fs.readdirSync(hooksDir).some((entry) => !entry.startsWith('.'))) return true;
    } catch {
      return true;
    }
  }
  const settingsFile = path.join(root, 'settings.json');
  if (!fs.existsSync(settingsFile)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as Record<string, unknown>;
    return Object.keys(settings).some((key) => key !== 'permissions') || 'permissions' in settings;
  } catch {
    return true;
  }
}

/**
 * Remove the enabledPlugins key for this plugin. Inverse of enablePluginInSettings.
 */
export function disablePluginInSettings(
  pluginName: string,
  agent: AgentId,
  versionHome: string
): void {
  const sPath = settingsPath(agent, versionHome);
  if (!fs.existsSync(sPath)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(sPath, 'utf-8'));
  } catch {
    return;
  }

  const enabled = settings.enabledPlugins as Record<string, boolean> | undefined;
  if (!enabled) return;

  const key = `${pluginName}@${MARKETPLACE_NAME}`;
  if (!(key in enabled)) return;
  delete enabled[key];

  if (Object.keys(enabled).length === 0) {
    delete settings.enabledPlugins;
  }

  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Remove a plugin's installed marketplace directory. Returns true if the dir
 * existed and was removed.
 */
export function removePluginFromMarketplace(
  pluginName: string,
  agent: AgentId,
  versionHome: string
): boolean {
  const installed = path.join(marketplaceRoot(agent, versionHome), 'plugins', pluginName);
  if (!fs.existsSync(installed)) return false;
  fs.rmSync(installed, { recursive: true, force: true });
  return true;
}

/**
 * Return true if the marketplace has no plugins left under it.
 */
export function marketplaceIsEmpty(agent: AgentId, versionHome: string): boolean {
  const pluginsDir = path.join(marketplaceRoot(agent, versionHome), 'plugins');
  if (!fs.existsSync(pluginsDir)) return true;
  const remaining = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));
  return remaining.length === 0;
}

/**
 * Drop the entire marketplace directory. Called after the last plugin removal.
 */
export function removeEmptyMarketplaceDir(agent: AgentId, versionHome: string): void {
  const root = marketplaceRoot(agent, versionHome);
  if (!fs.existsSync(root)) return;
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * Detect whether a plugin is installed via the native marketplace path.
 */
export function isInstalledInMarketplace(
  pluginName: string,
  agent: AgentId,
  versionHome: string
): boolean {
  const installed = path.join(marketplaceRoot(agent, versionHome), 'plugins', pluginName);
  return fs.existsSync(path.join(installed, '.claude-plugin', 'plugin.json'));
}
