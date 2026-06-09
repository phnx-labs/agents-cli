/**
 * Native plugin marketplaces for Claude / OpenClaw — one per DotAgents repo.
 *
 * Every DotAgents repo that holds plugins synthesizes its OWN synthetic local
 * marketplace under each version's plugin directory, named after the repo:
 *
 *   <versionHome>/.{claude,openclaw}/plugins/
 *     known_marketplaces.json                    # registers each repo's marketplace
 *     marketplaces/agents-cli/                    # ~/.agents/plugins/*        (user repo)
 *     marketplaces/agents-<alias>/                # ~/.agents-<alias>/plugins/* (extra repo)
 *     marketplaces/agents-project/                # <cwd>/.agents/plugins/*    (project repo)
 *       .claude-plugin/marketplace.json           # synthesized catalog
 *       plugins/<plugin>/                         # copied plugin source
 *
 * Plus the version's settings.json gets
 *   `enabledPlugins["<plugin>@<marketplace>"] = true`.
 *
 * This produces native `/plugin:skill` slash namespacing, visibility in
 * `/plugins`, `/plugin enable|disable` support, AND honest attribution (the
 * user can see which repo each plugin came from) — matching the Claude Code
 * spec at https://code.claude.com/docs/en/plugins and /plugin-marketplaces.
 *
 * The naming policy lives in one place — marketplaceNameFor(). Source-side
 * discovery (discoverMarketplaces) and per-version synthesis (syncMarketplaceManifest
 * / registerMarketplace / syncAllMarketplaces) all key off a MarketplaceSpec so
 * the catalog name and on-disk layout are derived, never hard-coded per call.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, DiscoveredPlugin, PluginManifest, MarketplaceSpec, DiscoveredMarketplace } from './types.js';
import { getPluginsDir, getEnabledExtraRepos, getProjectPluginsDir } from './state.js';
import { agentConfigDirName } from './agents.js';

/**
 * Canonical name for the user-repo marketplace (~/.agents/plugins/). Kept as an
 * exported constant for callers that operate on the user repo directly and for
 * the `marketplaces/agents-cli/` on-disk path that existing installs already have.
 */
export const MARKETPLACE_NAME = 'agents-cli';
export const SYSTEM_MARKETPLACE_NAME = 'agents-system';

/** Marketplace name for <cwd>/.agents/plugins/*. */
export const PROJECT_MARKETPLACE_NAME = 'agents-project';

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

export interface MarketplaceManifest {
  $schema?: string;
  name: string;
  description?: string;
  owner: { name: string; email?: string };
  plugins: MarketplacePluginEntry[];
}

/** Result of synthesizing + registering one marketplace via syncAllMarketplaces. */
export interface SyncAllResult {
  spec: MarketplaceSpec;
  name: string;
  plugins: number;
}

// ─── Naming policy (single source of truth) ──────────────────────────────────

/**
 * Map a MarketplaceSpec to its catalog name. This is the ONLY place that
 * encodes the repo → name policy; every other function derives the name here.
 */
export function marketplaceNameFor(spec: MarketplaceSpec): string {
  switch (spec.kind) {
    case 'user':    return MARKETPLACE_NAME;          // "agents-cli"
    case 'extra':   return `agents-${spec.alias}`;    // e.g. "agents-extras"
    case 'project': return PROJECT_MARKETPLACE_NAME;  // "agents-project"
    case 'system':  return SYSTEM_MARKETPLACE_NAME;   // "agents-system"
  }
}

/** Resolve a spec-or-name argument to the bare marketplace name string. */
function nameOf(specOrName: MarketplaceSpec | string): string {
  return typeof specOrName === 'string' ? specOrName : marketplaceNameFor(specOrName);
}

function descriptionFor(spec: MarketplaceSpec): string {
  switch (spec.kind) {
    case 'user':    return 'Plugins from the user repo (~/.agents/plugins/)';
    case 'extra':   return `Plugins from extra repo "${spec.alias}" (~/.agents-${spec.alias}/plugins/)`;
    case 'project': return 'Project-scoped plugins from <cwd>/.agents/plugins/';
    case 'system':  return 'Plugins from the system repo (~/.agents/.system/plugins/)';
  }
}

// ─── Source-side discovery ────────────────────────────────────────────────────

/**
 * Discover every DotAgents repo that contributes plugins, in precedence order
 * (user, then each enabled extra repo, then the project repo when cwd has one).
 * No agent / version is involved — this walks source-side plugin roots only.
 *
 * A repo is included when its plugins/ directory exists on disk. The user repo
 * is always probed; extras come from getEnabledExtraRepos() (already filtered to
 * enabled + on-disk repos); the project repo is included only when
 * <cwd>/.agents/plugins/ exists.
 */
export function discoverMarketplaces(opts: { cwd?: string } = {}): DiscoveredMarketplace[] {
  const out: DiscoveredMarketplace[] = [];

  // User repo — always the canonical "agents-cli" marketplace.
  const userRoot = getPluginsDir();
  if (dirExists(userRoot)) {
    const spec: MarketplaceSpec = { kind: 'user' };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot: userRoot, description: descriptionFor(spec) });
  }

  // Extra repos — peer ~/.agents-<alias>/ clones (and user-owned path:-repos).
  for (const extra of getEnabledExtraRepos()) {
    const pluginsRoot = path.join(extra.dir, 'plugins');
    if (!dirExists(pluginsRoot)) continue;
    const spec: MarketplaceSpec = { kind: 'extra', alias: extra.alias, root: pluginsRoot };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot, description: descriptionFor(spec) });
  }

  // Project repo — <cwd>/.agents/plugins/.
  const projectRoot = getProjectPluginsDir(opts.cwd ?? process.cwd());
  if (projectRoot && dirExists(projectRoot)) {
    const spec: MarketplaceSpec = { kind: 'project', root: projectRoot };
    out.push({ spec, name: marketplaceNameFor(spec), pluginsRoot: projectRoot, description: descriptionFor(spec) });
  }

  return out;
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ─── Per-version paths ────────────────────────────────────────────────────────

function pluginsRootForVersion(agent: AgentId, versionHome: string): string {
  return path.join(versionHome, agentConfigDirName(agent), 'plugins');
}

export function marketplaceRoot(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): string {
  return path.join(pluginsRootForVersion(agent, versionHome), 'marketplaces', nameOf(specOrName));
}

export function marketplaceManifestPath(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): string {
  return path.join(marketplaceRoot(specOrName, agent, versionHome), '.claude-plugin', 'marketplace.json');
}

export function pluginInstallDir(plugin: DiscoveredPlugin, specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): string {
  return path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins', plugin.name);
}

export function knownMarketplacesPath(agent: AgentId, versionHome: string): string {
  return path.join(pluginsRootForVersion(agent, versionHome), 'known_marketplaces.json');
}

function settingsPath(agent: AgentId, versionHome: string): string {
  return path.join(versionHome, agentConfigDirName(agent), 'settings.json');
}

// ─── Copy plugin source into a marketplace ────────────────────────────────────

/**
 * Copy plugin source into the marketplace install dir for the given spec.
 * Source of truth remains the plugin's source dir — this is a per-version snapshot.
 *
 * Symlinks pointing OUTSIDE the plugin source root are dropped. They show up
 * when plugin authors (legitimately) link prompt-side references to sibling
 * codebases — e.g. the rush plugin's `app -> ../../../rush/app` for @app/...
 * autocomplete in user prompts. Faithfully copying those symlinks pollutes
 * the marketplace with gigabytes of node_modules / .next / brand-asset video
 * that the consumer (Claude Code, OpenClaw) then walks during plugin
 * discovery — which is the documented cause of multi-minute startup hangs.
 *
 * Internal symlinks (target stays inside the plugin root) are preserved.
 */
export function copyPluginToMarketplace(
  plugin: DiscoveredPlugin,
  spec: MarketplaceSpec | string,
  agent: AgentId,
  versionHome: string
): string {
  const dest = pluginInstallDir(plugin, spec, agent, versionHome);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }

  const sourceRealRoot = (() => {
    try { return fs.realpathSync(plugin.root); }
    catch { return plugin.root; }
  })();
  const skipped: string[] = [];

  fs.cpSync(plugin.root, dest, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      try {
        const stat = fs.lstatSync(src);
        if (!stat.isSymbolicLink()) return true;
        const target = fs.realpathSync(src);
        if (target === sourceRealRoot || target.startsWith(sourceRealRoot + path.sep)) {
          return true;
        }
        skipped.push(path.relative(plugin.root, src) || path.basename(src));
        return false;
      } catch {
        // Dangling symlink or stat failure — drop it; it can't be useful in
        // the marketplace and would error the consumer's walk anyway.
        skipped.push(path.relative(plugin.root, src) || path.basename(src));
        return false;
      }
    },
  });

  if (skipped.length > 0) {
    process.stderr.write(
      `agents-cli: plugin '${plugin.name}' has ${skipped.length} symlink(s) ` +
      `pointing outside its source root; not copied to marketplace ` +
      `(would bloat consumer startup): ${skipped.join(', ')}\n`
    );
  }

  return dest;
}

// ─── Catalog synthesis ──────────────────────────────────────────────────────

/**
 * Re-synthesize <marketplace>/.claude-plugin/marketplace.json from the plugins
 * already installed under <marketplace>/plugins/. Always run after add or remove
 * so the manifest stays in lockstep with on-disk contents. Returns the manifest
 * it wrote, or null when the marketplace has no plugins dir yet.
 */
export function syncMarketplaceManifest(spec: MarketplaceSpec, agent: AgentId, versionHome: string): MarketplaceManifest | null {
  const name = marketplaceNameFor(spec);
  const root = marketplaceRoot(spec, agent, versionHome);
  const pluginsDir = path.join(root, 'plugins');
  if (!fs.existsSync(pluginsDir)) return null;

  const entries: MarketplacePluginEntry[] = [];
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    // Follow symlinks: Dirent.isDirectory() is false for a symlink even when the
    // target is a directory. statSync follows the link.
    const entryPath = path.join(pluginsDir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = fs.statSync(entryPath).isDirectory(); } catch { isDir = false; }
    }
    if (!isDir) continue;

    const manifestFile = path.join(entryPath, '.claude-plugin', 'plugin.json');
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
    name,
    description: descriptionFor(spec),
    owner: { name: 'agents-cli' },
    plugins: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };

  const manifestPath = marketplaceManifestPath(spec, agent, versionHome);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}

// ─── Registration in known_marketplaces.json ──────────────────────────────────

/**
 * Register a marketplace in known_marketplaces.json so Claude Code discovers
 * it on startup. Idempotent: re-running just refreshes lastUpdated. Other
 * marketplaces' entries are preserved untouched.
 */
export function registerMarketplace(spec: MarketplaceSpec, agent: AgentId, versionHome: string): void {
  const name = marketplaceNameFor(spec);
  const root = marketplaceRoot(spec, agent, versionHome);
  const knownPath = knownMarketplacesPath(agent, versionHome);

  let known: Record<string, KnownMarketplaceEntry> = {};
  if (fs.existsSync(knownPath)) {
    try {
      known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
    } catch {
      known = {};
    }
  }

  known[name] = {
    source: { source: 'directory', path: root },
    installLocation: root,
    lastUpdated: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(knownPath), { recursive: true });
  fs.writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n', 'utf-8');
}

/**
 * Drop a marketplace entry from known_marketplaces.json. Called when the last
 * plugin under it is removed. Removes only its own entry; deletes the file only
 * when no entries remain.
 */
export function unregisterMarketplace(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): void {
  const name = nameOf(specOrName);
  const knownPath = knownMarketplacesPath(agent, versionHome);
  if (!fs.existsSync(knownPath)) return;

  let known: Record<string, KnownMarketplaceEntry>;
  try {
    known = JSON.parse(fs.readFileSync(knownPath, 'utf-8'));
  } catch {
    return;
  }

  if (!(name in known)) return;
  delete known[name];

  if (Object.keys(known).length === 0) {
    try {
      fs.unlinkSync(knownPath);
    } catch { /* ignore */ }
  } else {
    fs.writeFileSync(knownPath, JSON.stringify(known, null, 2) + '\n', 'utf-8');
  }
}

// ─── Top-level orchestration ──────────────────────────────────────────────────

/**
 * Discover every source-side marketplace, then for each one re-synthesize its
 * catalog from the plugins already copied under the version home and register
 * it in known_marketplaces.json. Returns one result per marketplace that has at
 * least one plugin installed.
 *
 * Copying plugin source into a marketplace is the caller's responsibility
 * (copyPluginToMarketplace / syncPluginToVersion) — this reconciles catalogs +
 * registrations across all repos once the copies are in place. Marketplaces
 * whose version-home plugins dir is empty or absent are skipped, so we never
 * register a known_marketplace pointing at a directory with no catalog.
 */
export function syncAllMarketplaces(agent: AgentId, versionHome: string, opts: { cwd?: string } = {}): SyncAllResult[] {
  const results: SyncAllResult[] = [];
  for (const dm of discoverMarketplaces(opts)) {
    const manifest = syncMarketplaceManifest(dm.spec, agent, versionHome);
    if (!manifest || manifest.plugins.length === 0) continue;
    registerMarketplace(dm.spec, agent, versionHome);
    results.push({ spec: dm.spec, name: dm.name, plugins: manifest.plugins.length });
  }
  return results;
}

// ─── Per-plugin settings ops ──────────────────────────────────────────────────

/**
 * Mark a plugin as enabled in <versionHome>/.{agent}/settings.json under
 * enabledPlugins["<plugin>@<marketplace>"]: true. Reads, mutates, writes —
 * preserving every other key. Trust/exec-surface gating is the caller's
 * responsibility (plugins.ts owns plugin capability inspection).
 */
export function addPluginToSettings(pluginName: string, marketplaceName: string, agent: AgentId, versionHome: string): void {
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
  const key = `${pluginName}@${marketplaceName}`;
  if (enabled[key] === true) return;
  enabled[key] = true;

  fs.mkdirSync(path.dirname(sPath), { recursive: true });
  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

/**
 * Remove the enabledPlugins key for this plugin. Inverse of addPluginToSettings.
 */
export function removePluginFromSettings(pluginName: string, marketplaceName: string, agent: AgentId, versionHome: string): void {
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

  const key = `${pluginName}@${marketplaceName}`;
  if (!(key in enabled)) return;
  delete enabled[key];

  if (Object.keys(enabled).length === 0) {
    delete settings.enabledPlugins;
  }

  fs.writeFileSync(sPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

// ─── Marketplace teardown helpers ─────────────────────────────────────────────

/**
 * Remove a plugin's installed marketplace directory. Returns true if the dir
 * existed and was removed.
 */
export function removePluginFromMarketplace(
  pluginName: string,
  specOrName: MarketplaceSpec | string,
  agent: AgentId,
  versionHome: string
): boolean {
  const installed = path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins', pluginName);
  if (!fs.existsSync(installed)) return false;
  fs.rmSync(installed, { recursive: true, force: true });
  return true;
}

/**
 * Return true if the marketplace has no plugins left under it.
 */
export function marketplaceIsEmpty(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): boolean {
  const pluginsDir = path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins');
  if (!fs.existsSync(pluginsDir)) return true;
  const remaining = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'));
  return remaining.length === 0;
}

/**
 * Drop the entire marketplace directory. Called after the last plugin removal.
 */
export function removeEmptyMarketplaceDir(specOrName: MarketplaceSpec | string, agent: AgentId, versionHome: string): void {
  const root = marketplaceRoot(specOrName, agent, versionHome);
  if (!fs.existsSync(root)) return;
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * Detect whether a plugin is installed via the native marketplace path.
 */
export function isInstalledInMarketplace(
  pluginName: string,
  specOrName: MarketplaceSpec | string,
  agent: AgentId,
  versionHome: string
): boolean {
  const installed = path.join(marketplaceRoot(specOrName, agent, versionHome), 'plugins', pluginName);
  return fs.existsSync(path.join(installed, '.claude-plugin', 'plugin.json'));
}
