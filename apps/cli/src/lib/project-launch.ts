/**
 * Launch-time project compile. Invoked by the agent shim's hot path (via
 * `agents sync --launch`) between version resolve and binary exec.
 *
 * Three responsibilities, all skip-fast when there's nothing to do:
 *
 * 1. Compile project rules from `<cwd>/.agents/rules/` into `<cwd>/AGENTS.md`
 *    (+ per-agent symlinks). Delegates to compileRulesForProject, which is
 *    the same helper management-side `agents sync` uses.
 *
 * 2. Mirror project resources from `<cwd>/.agents/{subagents,commands,skills}`
 *    into the agent's workspace-local discovery dirs (`<cwd>/.claude/agents/`,
 *    `<cwd>/.claude/commands/`, `<cwd>/.claude/skills/`). File-level symlinks
 *    so edits in the source dir are live without re-sync. Skips any dest
 *    entry that already exists and isn't one of our symlinks (don't-clobber).
 *    v1: claude-only. Other agents have varying workspace conventions (amp
 *    uses `~/.config/amp`, antigravity uses `~/.gemini/antigravity-cli`,
 *    codex/gemini/cursor lack subagent support entirely) — they're follow-up
 *    material. NOTE: `.mcp.json` is intentionally NOT auto-symlinked from
 *    the launch path — that's a supply-chain surface (cloning a hostile
 *    repo would auto-register an attacker MCP server). Belongs to full
 *    `agents sync` with explicit opt-in, not the hot path.
 *
 * 3. Synthesize four scope-grouped plugin marketplaces under the version's
 *    `<versionHome>/.{agent}/plugins/marketplaces/` (for plugin-capable agents):
 *      - agents-cli         ← ~/.agents/plugins/*           (user scope, legacy name)
 *      - agents-system      ← ~/.agents/.system/plugins/*
 *      - extras-<alias>     ← ~/.agents-<alias>/plugins/*   (per enabled extra)
 *      - agents-project     ← <cwd>/.agents/plugins/*
 *    Each plugin is copied in (skip-fast via mtime cache), the marketplace
 *    catalog is rewritten only when contents change, and the marketplace is
 *    registered in known_marketplaces.json. Upstream marketplaces like
 *    "claude-plugins-official" are left untouched. Project- and extras-
 *    scope plugins do NOT auto-enable exec surfaces (.mcp.json, hooks, bin/,
 *    scripts/) — user must explicitly `agents plugins enable` them.
 *
 * Heavy work (version-home reconciliation, hook registration, MCP merging)
 * stays in `agents sync` without --launch and is NOT touched here. The
 * launch path is filesystem-only and skip-fast: sub-50ms when no source
 * has changed, scales linearly only with newly-modified plugins on the
 * change path.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentId, MarketplaceSpec } from './types.js';
import { supports } from './capabilities.js';
import {
  getEnabledExtraRepos,
  getExtraPluginsDir,
  getPluginsDir,
  getProjectAgentsDir,
  getProjectPluginsDir,
  getSystemPluginsDir,
} from './state.js';
import { getVersionHomePath } from './versions.js';
import { toPortableKey } from './platform/index.js';
import { transformSubagentForClaude } from './subagents.js';
import { compileRulesForProject } from './rules/compile.js';
import { discoverPluginsInDir, hasPluginExecSurfaces, inspectPluginCapabilities } from './plugins.js';
import type { DiscoveredPlugin } from './types.js';
import {
  MARKETPLACE_NAME,
  PROJECT_MARKETPLACE_NAME,
  SYSTEM_MARKETPLACE_NAME,
  addPluginToSettings,
  copyPluginToMarketplace,
  marketplaceNameFor,
  marketplaceRoot,
  pluginInstallDir,
  registerMarketplace,
  removePluginFromSettings,
  syncMarketplaceManifest,
} from './plugin-marketplace.js';

export interface LaunchSyncOptions {
  agent: AgentId;
  version: string;
  cwd: string;
}

export interface LaunchSyncResult {
  /** Project rules were re-compiled into cwd/AGENTS.md (+ per-agent symlinks). */
  rulesCompiled: boolean;
  /** Number of workspace resource symlinks created or refreshed. */
  workspaceLinks: number;
  /** Workspace resource paths we left alone because they exist and aren't ours. */
  workspaceSkipped: string[];
  /** Map of marketplace name → plugin names installed under it. */
  marketplaces: Record<string, string[]>;
}

/**
 * Run the launch-time project compile. Safe to call on every agent launch:
 * each step is idempotent and skips when its inputs are missing.
 *
 * After a successful run, touches the shim-side skip-fast sentinel at
 * `~/.agents/.cache/launch-sync/<agent>@<version>@<projectslug>` so the next
 * shim invocation can skip the node spawn entirely when no source dir is
 * newer than the sentinel (shim schema v17+).
 */
export function runLaunchSync(opts: LaunchSyncOptions): LaunchSyncResult {
  const result: LaunchSyncResult = {
    rulesCompiled: false,
    workspaceLinks: 0,
    workspaceSkipped: [],
    marketplaces: {},
  };

  // Step 1: project rules
  try {
    const r = compileRulesForProject(opts.cwd);
    result.rulesCompiled = r.compiled;
  } catch {
    // Don't fail launch on a malformed project rules.yaml.
  }

  // Step 2: workspace resource mirror
  const mirror = mirrorWorkspaceResources(opts.cwd, opts.agent);
  result.workspaceLinks = mirror.links;
  result.workspaceSkipped = mirror.skipped;

  // Step 3: scoped plugin marketplaces
  result.marketplaces = synthesizeScopedMarketplaces(opts.agent, opts.version, opts.cwd);

  // Touch the shim's skip-fast sentinel. Best-effort — if this fails the
  // shim just won't skip on the next launch, which is correct fallback.
  touchLaunchSentinel(opts.agent, opts.version, opts.cwd);

  return result;
}

/**
 * Path of the shim's skip-fast sentinel for this (agent, version, cwd) tuple.
 * Must match the SHIM-SIDE format in src/lib/shims.ts (PROJECT_SLUG derivation),
 * which is the canonical `toPortableKey` mapping: drop the Windows drive colon
 * and fold `\`, `/`, and ` ` → `_`. On POSIX this is byte-identical to the old
 * `/` and ` ` → `_` slug; on Windows it yields a legal filename (no `C:\`).
 *
 * Cache leak note: this dir accumulates one zero-byte file per
 * (agent, version, project) tuple ever launched. Disk impact is negligible
 * (inodes only). A periodic GC belongs in `agents prune` — follow-up.
 */
function launchSentinelPath(agent: AgentId, version: string, cwd: string): string {
  const slug = toPortableKey(cwd);
  // Prefer $HOME (respects test overrides + matches bash's $HOME expansion in
  // the shim), fall back to os.homedir() so the lookup never resolves to '/'
  // if HOME is somehow unset.
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.agents', '.cache', 'launch-sync', `${agent}@${version}@${slug}`);
}

function touchLaunchSentinel(agent: AgentId, version: string, cwd: string): void {
  try {
    const sentinel = launchSentinelPath(agent, version, cwd);
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    // Empty content — purely an mtime carrier for the shim's `[ -nt ]` compare.
    fs.writeFileSync(sentinel, '');
  } catch {
    // best-effort
  }
}

// ─── Step 2: workspace resource mirror ────────────────────────────────────────

interface MirrorPlan {
  /** Source dir under `<cwd>/.agents/`. */
  srcSubdir: string;
  /** Dest subdir under `<cwd>/.{agent}/`. */
  destSubdir: string;
  /**
   * How each source entry becomes a dest entry:
   *  - 'file-symlink':   each *.md FILE is symlinked 1:1 (commands).
   *  - 'dir-symlink':    each DIRECTORY is symlinked 1:1 (skills — a skill IS a dir).
   *  - 'subagent-write': each subagent DIRECTORY (containing AGENT.md plus
   *    optional sibling .md files) is FLATTENED into a single written .md file.
   *    A subagent has no single file to point a symlink at, so we write the
   *    transform output instead — see writeProjectSubagents.
   */
  mode: 'file-symlink' | 'dir-symlink' | 'subagent-write';
}

const CLAUDE_MIRROR_PLANS: MirrorPlan[] = [
  { srcSubdir: 'subagents', destSubdir: 'agents',   mode: 'subagent-write' },
  { srcSubdir: 'commands',  destSubdir: 'commands', mode: 'file-symlink' },
  { srcSubdir: 'skills',    destSubdir: 'skills',   mode: 'dir-symlink' },
];

/**
 * Marker prepended-as-trailing-comment to every subagent file WE generate.
 * It's an HTML comment — invisible to the markdown the agent reads — placed on
 * the last line so it never disturbs the leading `---` frontmatter block.
 *
 * Ownership rule (the one don't-clobber decision for written, non-symlink
 * files): we only overwrite a `.claude/agents/<name>.md` whose content carries
 * this marker. A user-authored file (no marker) or a symlink at the dest is
 * left untouched. A marker beats an mtime/sidecar sentinel because it travels
 * with the file across copies and git, and needs no out-of-band state.
 */
const GENERATED_SUBAGENT_MARKER = '<!-- agents-cli:generated-subagent';

function mirrorWorkspaceResources(cwd: string, agent: AgentId): { links: number; skipped: string[] } {
  // v1: claude-only. Other agents have workspace conventions we haven't
  // mapped (amp: ~/.config/amp; antigravity: ~/.gemini/antigravity-cli;
  // codex/gemini/cursor: no subagent support per capabilities). Adding them
  // requires per-agent workspaceDirName + capability gates — follow-up.
  if (agent !== 'claude') return { links: 0, skipped: [] };

  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return { links: 0, skipped: [] };

  const agentWorkspaceDir = path.join(cwd, '.claude');
  const projectAgentsResolved = (() => {
    try { return fs.realpathSync(projectAgentsDir); }
    catch { return path.resolve(projectAgentsDir); }
  })();

  let links = 0;
  const skipped: string[] = [];

  // Mirror subagents / commands / skills. mcp.json is intentionally excluded
  // — see header doc, it's a supply-chain surface.
  for (const plan of CLAUDE_MIRROR_PLANS) {
    const srcDir = path.join(projectAgentsDir, plan.srcSubdir);
    if (!fs.existsSync(srcDir)) continue;

    const destDir = path.join(agentWorkspaceDir, plan.destSubdir);
    fs.mkdirSync(destDir, { recursive: true });

    // Subagents flatten N source files into one written .md — not a symlink.
    if (plan.mode === 'subagent-write') {
      const r = writeProjectSubagents(srcDir, destDir, cwd);
      links += r.links;
      skipped.push(...r.skipped);
      continue;
    }

    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (plan.mode === 'dir-symlink' && !entry.isDirectory()) continue;
      if (plan.mode === 'file-symlink' && !entry.isFile() && !entry.isSymbolicLink()) continue;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (replaceWithSymlinkIfOwned(srcPath, destPath, projectAgentsResolved)) {
        links += 1;
      } else {
        skipped.push(path.relative(cwd, destPath));
      }
    }
  }

  return { links, skipped };
}

/**
 * Mirror project subagents into `<cwd>/.claude/agents/`. The canonical source
 * shape is a DIRECTORY containing AGENT.md (e.g. `.agents/subagents/probe/AGENT.md`)
 * — confirmed by the detector (versions.ts) and lister (subagents.ts). Each
 * such directory is flattened via transformSubagentForClaude (the exact writer
 * the version-home sync uses) into a single `<name>.md`, then written under an
 * ownership marker so a re-launch refreshes our file but never clobbers a
 * user-authored one.
 *
 * Returns the same {links, skipped} shape the symlink path reports, so the
 * caller's accounting is uniform across resource kinds.
 */
function writeProjectSubagents(srcDir: string, destDir: string, cwd: string): { links: number; skipped: string[] } {
  let links = 0;
  const skipped: string[] = [];

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory()) continue;

    const subagentDir = path.join(srcDir, entry.name);
    if (!fs.existsSync(path.join(subagentDir, 'AGENT.md'))) continue;

    const destPath = path.join(destDir, `${entry.name}.md`);
    if (writeSubagentIfOwned(subagentDir, destPath)) {
      links += 1;
    } else {
      skipped.push(path.relative(cwd, destPath));
    }
  }

  return { links, skipped };
}

/**
 * Write a flattened subagent file at `destPath`, refusing to clobber user state.
 *
 *   - dest missing            → write fresh.
 *   - dest is our generation  → overwrite (refresh; carries GENERATED_SUBAGENT_MARKER).
 *   - dest is a symlink / any
 *     non-regular file         → SKIP (user state we don't own).
 *   - dest is a regular file
 *     without our marker        → SKIP (hand-authored .claude/agents/<name>.md).
 *
 * Returns true when our file is present (written now or already current),
 * false when we left a user-owned dest alone.
 */
function writeSubagentIfOwned(subagentDir: string, destPath: string): boolean {
  let existing: string | null = null;
  let destLstat: fs.Stats | null = null;
  try { destLstat = fs.lstatSync(destPath); } catch { /* missing — write fresh */ }

  if (destLstat) {
    if (!destLstat.isFile()) return false; // symlink/dir/etc. — user state
    try { existing = fs.readFileSync(destPath, 'utf-8'); } catch { return false; }
    if (!existing.includes(GENERATED_SUBAGENT_MARKER)) return false; // hand-authored
  }

  let body: string;
  try {
    body = transformSubagentForClaude(subagentDir);
  } catch {
    return false; // malformed AGENT.md — don't write a broken file
  }
  const content = `${body}\n\n${GENERATED_SUBAGENT_MARKER} — edit .agents/subagents/${path.basename(subagentDir)}/ instead -->\n`;

  // Skip-fast: identical content already on disk → no write (keeps mtime stable).
  if (existing === content) return true;

  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content);
  } catch {
    return false;
  }
  return true;
}

/**
 * Create or refresh a symlink at `destPath` pointing at `srcPath`. Returns
 * true if we wrote (or already had) the link, false if we skipped because
 * the destination is user-owned (regular file, directory, or symlink pointing
 * outside the project's `.agents/` tree, or a dangling symlink — treated as
 * user state we don't yet understand).
 *
 * Skip-fast: if the destination is already a symlink resolving to the
 * project-agents tree AND its target matches srcPath, no write happens.
 */
function replaceWithSymlinkIfOwned(srcPath: string, destPath: string, projectAgentsResolved: string): boolean {
  let destLstat: fs.Stats | null = null;
  try { destLstat = fs.lstatSync(destPath); } catch { /* missing — write fresh */ }

  if (destLstat) {
    if (!destLstat.isSymbolicLink()) {
      return false;
    }
    let destTargetReal: string | null = null;
    try { destTargetReal = fs.realpathSync(destPath); } catch { /* dangling */ }
    // Dangling symlink → user-owned in-progress state; do not clobber.
    if (destTargetReal === null) {
      return false;
    }
    if (destTargetReal !== projectAgentsResolved && !destTargetReal.startsWith(projectAgentsResolved + path.sep)) {
      return false;
    }
    let srcReal: string | null = null;
    try { srcReal = fs.realpathSync(srcPath); } catch { /* src vanished mid-launch */ }
    if (srcReal !== null && destTargetReal === srcReal) {
      return true; // already correct
    }
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
  }

  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.symlinkSync(srcPath, destPath);
  } catch {
    return false;
  }
  return true;
}

// ─── Step 3: scoped plugin marketplaces ───────────────────────────────────────

interface PluginScope {
  spec: MarketplaceSpec;
  marketplaceName: string;
  pluginsDir: string;
  /**
   * When false, plugins with exec surfaces (.mcp.json, hooks, bin/, scripts/,
   * non-trivial settings.json) are copied but NOT auto-enabled. User must
   * explicitly `agents plugins enable` them. Protects against hostile
   * `git clone` registering an attacker MCP server via project plugins.
   */
  autoEnableExecSurfaces: boolean;
  /** Precedence rank used to resolve cross-scope plugin name collisions. Higher wins. */
  precedence: number;
}

function makeScope(
  spec: MarketplaceSpec,
  pluginsDir: string,
  autoEnableExecSurfaces: boolean,
  precedence: number,
): PluginScope {
  return { spec, marketplaceName: marketplaceNameFor(spec), pluginsDir, autoEnableExecSurfaces, precedence };
}

function collectPluginScopes(cwd: string): PluginScope[] {
  const scopes: PluginScope[] = [];

  // Precedence: project > extras > user > system. Same direction the rules
  // composition uses (project layer shadows base layers).
  scopes.push(makeScope({ kind: 'system', root: getSystemPluginsDir() }, getSystemPluginsDir(), true, 0));
  scopes.push(makeScope({ kind: 'user' }, getPluginsDir(), true, 1));

  for (const extra of getEnabledExtraRepos()) {
    const root = getExtraPluginsDir(extra.alias);
    scopes.push(makeScope({ kind: 'extra', alias: extra.alias, root }, root, false, 2));
  }

  const projectPluginsDir = getProjectPluginsDir(cwd);
  if (projectPluginsDir) {
    scopes.push(makeScope({ kind: 'project', root: projectPluginsDir }, projectPluginsDir, false, 3));
  }

  return scopes;
}

function synthesizeScopedMarketplaces(agent: AgentId, version: string, cwd: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  if (!supports(agent, 'plugins', version).ok) return result;

  let versionHome: string;
  try {
    versionHome = getVersionHomePath(agent, version);
  } catch {
    return result;
  }
  if (!fs.existsSync(versionHome)) return result;

  // First pass: resolve cross-scope plugin name collisions by precedence.
  // For each plugin name, the scope with the highest precedence wins; the
  // plugin is installed only into that scope's marketplace.
  const winner = new Map<string, { scope: PluginScope; plugin: DiscoveredPlugin }>();
  for (const scope of collectPluginScopes(cwd)) {
    if (!fs.existsSync(scope.pluginsDir)) continue;
    for (const plugin of discoverPluginsInDir(scope.pluginsDir)) {
      const existing = winner.get(plugin.name);
      if (!existing || scope.precedence > existing.scope.precedence) {
        winner.set(plugin.name, { scope, plugin });
      }
    }
  }
  if (winner.size === 0) return result;

  // Group winners by their winning scope and synthesize one marketplace per
  // scope. Skip-fast: scope hash sentinel short-circuits unchanged scopes.
  const byScope = new Map<string, { scope: PluginScope; plugins: DiscoveredPlugin[] }>();
  for (const { scope, plugin } of winner.values()) {
    let bucket = byScope.get(scope.marketplaceName);
    if (!bucket) {
      bucket = { scope, plugins: [] };
      byScope.set(scope.marketplaceName, bucket);
    }
    bucket.plugins.push(plugin);
  }

  for (const { scope, plugins } of byScope.values()) {
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    const installed = installScope(agent, versionHome, scope, plugins);
    if (installed.length > 0) result[scope.marketplaceName] = installed;
  }

  // Sweep any orphaned `<plugin>@*` keys whose plugin name is now owned by a
  // different scope (e.g. plugin moved from user to project). Without this,
  // the OLD scope's enabledPlugins key stays set forever, double-enabling.
  pruneLosingScopeEnables(agent, versionHome, winner);

  return result;
}

function installScope(
  agent: AgentId,
  versionHome: string,
  scope: PluginScope,
  plugins: DiscoveredPlugin[],
): string[] {
  const newHash = computeScopeHash(plugins);
  const sentinelPath = path.join(marketplaceRoot(scope.spec, agent, versionHome), '.agents-launch-sync');
  const existingHash = readScopeHash(sentinelPath);

  if (existingHash === newHash) {
    // Nothing changed since last launch — fast path. Verify the manifest
    // dir still exists; if a user blew it away, force a re-sync.
    if (fs.existsSync(path.dirname(sentinelPath))) {
      return plugins.map((p) => p.name);
    }
  }

  const installed: string[] = [];
  for (const plugin of plugins) {
    try {
      copyPluginToMarketplace(plugin, scope.spec, agent, versionHome);
      installed.push(plugin.name);
    } catch {
      // Individual plugin copy failure — keep going on the others.
    }
  }
  if (installed.length === 0) return [];

  syncMarketplaceManifest(scope.spec, agent, versionHome);
  registerMarketplace(scope.spec, agent, versionHome);

  // Enable each plugin in settings unless the scope withholds auto-enable for
  // exec surfaces (project + extras) AND the plugin actually ships any.
  for (const plugin of plugins) {
    if (!installed.includes(plugin.name)) continue;
    if (!scope.autoEnableExecSurfaces && hasPluginExecSurfaces(inspectPluginCapabilities(plugin.root))) continue;
    addPluginToSettings(plugin.name, scope.marketplaceName, agent, versionHome);
  }

  writeScopeHash(sentinelPath, newHash);
  return installed;
}

function pruneLosingScopeEnables(
  agent: AgentId,
  versionHome: string,
  winner: Map<string, { scope: PluginScope; plugin: DiscoveredPlugin }>,
): void {
  const ourScopeNames = new Set([
    SYSTEM_MARKETPLACE_NAME,
    MARKETPLACE_NAME,
    PROJECT_MARKETPLACE_NAME,
    ...getEnabledExtraRepos().map((e) => marketplaceNameFor({ kind: 'extra', alias: e.alias, root: getExtraPluginsDir(e.alias) })),
  ]);

  for (const [name, { scope: winningScope }] of winner) {
    for (const candidateScope of ourScopeNames) {
      if (candidateScope === winningScope.marketplaceName) continue;
      removePluginFromSettings(name, candidateScope, agent, versionHome);
    }
  }
}

/**
 * Hash the plugin set so we can skip-fast when nothing changed since the
 * last launch. Includes the source path (catches moves), the .claude-plugin/
 * plugin.json content (catches metadata edits), and the file-mtime+size
 * fingerprint of every file in the plugin (catches code edits).
 */
function computeScopeHash(plugins: DiscoveredPlugin[]): string {
  const hash = crypto.createHash('sha256');
  for (const plugin of [...plugins].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(`${plugin.name}\0${plugin.root}\0`);
    fingerprintDir(plugin.root, hash);
    hash.update('\0SEP\0');
  }
  return hash.digest('hex');
}

function fingerprintDir(dir: string, hash: crypto.Hash): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hash.update(`D ${entry.name}\n`);
      fingerprintDir(abs, hash);
    } else {
      try {
        const stat = fs.lstatSync(abs);
        hash.update(`F ${entry.name} ${stat.size} ${stat.mtimeMs}\n`);
      } catch { /* race during launch — skip */ }
    }
  }
}

function readScopeHash(sentinelPath: string): string | null {
  try { return fs.readFileSync(sentinelPath, 'utf-8').trim(); }
  catch { return null; }
}

function writeScopeHash(sentinelPath: string, hash: string): void {
  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, hash + '\n');
  } catch { /* best-effort; missing sentinel just means next launch does full work */ }
}

// Re-export for the test's structural assertions; not used internally.
export { pluginInstallDir };
