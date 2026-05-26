/**
 * Hook management -- discovery, registration, and syncing of event hooks.
 *
 * Hooks are shell scripts in ~/.agents/hooks/ that fire on agent events
 * (tool calls, session start, etc.). Each hook directory contains a manifest
 * (agents.yaml) declaring events, matchers, and timeout. This module handles
 * parsing those manifests, registering hooks into agent-native settings files,
 * and syncing them across version switches.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import { AGENTS, ALL_AGENT_IDS, HOOKS_CAPABLE_AGENTS } from './agents.js';
import { supports, explainSkip } from './capabilities.js';
import { setGeminiAutoUpdateDisabled, updateGeminiSettings } from './gemini-settings.js';
import { getAgentsDir, getHooksDir as getSystemHooksDir, getUserHooksDir, getUserAgentsDir, getSystemAgentsDir, getProjectAgentsDir, getTrashHooksDir, getEnabledExtraRepos } from './state.js';

function getCentralHooksDir(): string { return getUserHooksDir(); }

/**
 * Resolve a hook script's absolute path. Checks user dir first, then enabled
 * extra repos in insertion order, then system dir. Returns null if not found.
 */
function resolveContainedHookPath(hooksRoot: string, script: string): string | null {
  const resolvedRoot = path.resolve(hooksRoot);
  const candidate = path.join(hooksRoot, script);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(resolvedRoot + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

export function resolveHookScriptPath(script: string): string | null {
  const extraDirs = getEnabledExtraRepos().map(e => e.dir);
  for (const root of [getUserAgentsDir(), ...extraDirs, getSystemAgentsDir()]) {
    const resolved = resolveContainedHookPath(path.join(root, 'hooks'), script);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Prefixes used for stale-entry cleanup in agent settings files. A registered
 * hook command is considered "managed" if it lives under any known hooks dir
 * (user, extra repos, or system). Entries from removed extra repos are also
 * garbage-collected because they won't appear in this list any more.
 */
function getManagedHookPrefixes(): string[] {
  const extraDirs = getEnabledExtraRepos().map(e => e.dir);
  return [
    path.join(getUserAgentsDir(), 'hooks') + path.sep,
    ...extraDirs.map(d => path.join(d, 'hooks') + path.sep),
    path.join(getSystemAgentsDir(), 'hooks') + path.sep,
  ];
}

function isManagedHookCommand(command: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (command.startsWith(prefix)) return true;
  }
  return false;
}
import { getEffectiveHome, getVersionHomePath, listInstalledVersions } from './versions.js';
import type { AgentId, InstalledHook, ManifestHook } from './types.js';

export type HookEntry = { name: string; scriptPath: string; dataFile?: string };

/**
 * Extensions that are NEVER hooks — docs, configuration, plain data. A file
 * in hooks/ with one of these extensions is auxiliary content (e.g., the
 * `promptcuts.yaml` data file read directly by the expand-promptcuts
 * script, or the `README.md` that documents the hooks directory). They
 * sometimes carry an exec bit by accident (older sync runs chmod 0o755'd
 * everything) but they are not scripts.
 */
const NON_SCRIPT_EXTENSIONS = new Set([
  '.md', '.markdown', '.rst', '.txt',
  '.yaml', '.yml', '.json', '.toml', '.ini', '.conf',
]);

const SCRIPT_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.ts',
  '.mjs',
  '.cjs',
  '.rb',
  '.pl',
  '.ps1',
  '.cmd',
  '.bat',
]);

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function getHooksDir(agentId: AgentId): string {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  return path.join(home, `.${agentId}`, agent.hooksDir);
}

function getProjectHooksDirs(agentId: AgentId, cwd: string): string[] {
  const agent = AGENTS[agentId];
  const dirs: string[] = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    dirs.push(path.join(projectAgentsDir, 'hooks'));
  }
  dirs.push(path.join(cwd, `.${agentId}`, agent.hooksDir));
  return dirs;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function removeHookFiles(dir: string, name: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    if (base === name) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        fs.unlinkSync(fullPath);
      }
    }
  }
}

/**
 * List hook entries in a single directory, grouping script + data files by
 * basename. Exported so doctor-diff can reuse the same grouping the sync path
 * applies; without this, doctor would double-count `foo.sh` and `foo.yaml`.
 */
export function listHookEntriesFromDir(dir: string): HookEntry[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files: {
    name: string;
    base: string;
    ext: string;
    fullPath: string;
    isExec: boolean;
  }[] = [];

  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    files.push({
      name: file,
      base,
      ext,
      fullPath,
      isExec: isExecutable(stat.mode),
    });
  }

  const grouped = new Map<string, typeof files>();
  for (const file of files) {
    const list = grouped.get(file.base) || [];
    list.push(file);
    grouped.set(file.base, list);
  }

  const entries: HookEntry[] = [];
  for (const [base, group] of grouped) {
    group.sort((a, b) => a.name.localeCompare(b.name));
    // A group is a hook only if it has an actual script: a script extension,
    // OR an executable bit on a file whose extension is not a known data /
    // docs type. Files like `README.md` (docs) or `promptcuts.yaml` (data
    // the expand-promptcuts hook reads directly) sit alongside hooks but
    // are NOT hooks themselves and must not surface in the hooks list
    // anywhere — doctor, sync, view, or otherwise. Older sync runs may have
    // chmod 0o755'd these files; an exec bit alone is not enough.
    const script =
      group.find((f) => SCRIPT_EXTENSIONS.has(f.ext.toLowerCase())) ||
      group.find((f) => f.isExec && !NON_SCRIPT_EXTENSIONS.has(f.ext.toLowerCase()));
    if (!script) continue;
    const data = group.find((f) => f !== script);
    entries.push({
      name: base,
      scriptPath: script.fullPath,
      dataFile: data ? data.fullPath : undefined,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function buildHookMap(entries: HookEntry[]): Map<string, HookEntry> {
  const map = new Map<string, HookEntry>();
  for (const entry of entries) {
    map.set(entry.name, entry);
  }
  return map;
}

function copyHook(entry: HookEntry, targetDir: string): void {
  ensureDir(targetDir);
  removeHookFiles(targetDir, entry.name);

  const scriptTarget = path.join(targetDir, path.basename(entry.scriptPath));
  fs.copyFileSync(entry.scriptPath, scriptTarget);
  const scriptStat = fs.statSync(entry.scriptPath);
  fs.chmodSync(scriptTarget, scriptStat.mode);

  if (entry.dataFile) {
    const dataTarget = path.join(targetDir, path.basename(entry.dataFile));
    fs.copyFileSync(entry.dataFile, dataTarget);
  }
}

/**
 * Check if a hook exists for an agent.
 */
export function hookExists(agentId: AgentId, hookName: string): boolean {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return false;
  }
  const hooksDir = getHooksDir(agentId);
  if (!fs.existsSync(hooksDir)) {
    return false;
  }
  const files = fs.readdirSync(hooksDir);
  return files.some((file) => {
    const ext = path.extname(file);
    const baseName = path.basename(file, ext);
    return baseName === hookName && SCRIPT_EXTENSIONS.has(ext);
  });
}

/**
 * Normalize content for comparison (trim, normalize line endings).
 */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

/**
 * Get the installed hook entry for an agent.
 */
function getInstalledHookEntry(agentId: AgentId, hookName: string): HookEntry | null {
  const hooksDir = getHooksDir(agentId);
  const entries = listHookEntriesFromDir(hooksDir);
  return entries.find((e) => e.name === hookName) || null;
}

/**
 * Check if installed hook content matches source hook content.
 * Compares both script file and data file (if present).
 */
export function hookContentMatches(
  agentId: AgentId,
  hookName: string,
  sourceEntry: HookEntry
): boolean {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return false;
  }

  const installedEntry = getInstalledHookEntry(agentId, hookName);
  if (!installedEntry) {
    return false;
  }

  try {
    const installedScript = fs.readFileSync(installedEntry.scriptPath, 'utf-8');
    const sourceScript = fs.readFileSync(sourceEntry.scriptPath, 'utf-8');

    if (normalizeContent(installedScript) !== normalizeContent(sourceScript)) {
      return false;
    }

    const hasInstalledData = !!installedEntry.dataFile;
    const hasSourceData = !!sourceEntry.dataFile;

    if (hasInstalledData !== hasSourceData) {
      return false;
    }

    if (hasInstalledData && hasSourceData) {
      const installedData = fs.readFileSync(installedEntry.dataFile!, 'utf-8');
      const sourceData = fs.readFileSync(sourceEntry.dataFile!, 'utf-8');
      if (normalizeContent(installedData) !== normalizeContent(sourceData)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function listInstalledHooksWithScope(
  agentId: AgentId,
  cwd: string = process.cwd(),
  options?: { home?: string }
): InstalledHook[] {
  const agent = AGENTS[agentId];
  if (!agent.supportsHooks) {
    return [];
  }

  const results: InstalledHook[] = [];
  const seen = new Set<string>();

  const addHook = (hook: HookEntry, scope: 'user' | 'project', agentId: AgentId) => {
    if (seen.has(hook.name)) return;
    results.push({
      name: hook.name,
      path: hook.scriptPath,
      dataFile: hook.dataFile,
      scope,
      agent: agentId,
    });
    seen.add(hook.name);
  };

  // Project-scoped hooks (project .agents overrides agent-specific dirs)
  const projectDirs = getProjectHooksDirs(agentId, cwd);
  for (const dir of projectDirs) {
    const projectHooks = listHookEntriesFromDir(dir);
    for (const hook of projectHooks) {
      addHook(hook, 'project', agentId);
    }
  }

  // User-scoped hooks (version-aware when home is provided)
  const home = options?.home || getEffectiveHome(agentId);
  const userDir = path.join(home, `.${agentId}`, agent.hooksDir);
  const userHooks = listHookEntriesFromDir(userDir);
  for (const hook of userHooks) {
    addHook(hook, 'user', agentId);
  }

  return results;
}

export async function installHooks(
  source: string,
  agents: AgentId[],
  options: { scope?: 'user' | 'project' } = {}
): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = [];
  const errors: string[] = [];
  const scope = options.scope || 'user';
  const cwd = process.cwd();

  const hooksDir = path.join(source, 'hooks');
  const hooks = listHookEntriesFromDir(hooksDir);

  const uniqueAgents = Array.from(new Set(agents));
  for (const agentId of uniqueAgents) {
    const agent = AGENTS[agentId];
    if (!agent || !agent.supportsHooks) {
      errors.push(`${agentId}:Agent does not support hooks`);
      continue;
    }

    const targetDir =
      scope === 'project' ? getProjectHooksDirs(agentId, cwd)[0] : getHooksDir(agentId);

    for (const entry of hooks) {
      try {
        copyHook(entry, targetDir);
        installed.push(`${entry.name}:${agentId}`);
      } catch (err) {
        errors.push(`${entry.name}:${agentId}:${(err as Error).message}`);
      }
    }
  }

  return { installed, errors };
}

/**
 * Path to the hooks dir of a specific version home (not the active one).
 */
export function getVersionHooksDir(agent: AgentId, version: string): string {
  const home = getVersionHomePath(agent, version);
  return path.join(home, `.${agent}`, AGENTS[agent].hooksDir);
}

/**
 * List hook entries in a specific version home.
 */
export function listHooksInVersionHome(agent: AgentId, version: string): HookEntry[] {
  return listHookEntriesFromDir(getVersionHooksDir(agent, version));
}

/**
 * Check if a hook installed in a specific version matches central content.
 */
function versionHookMatches(agent: AgentId, version: string, hookName: string): boolean {
  const central = listHookEntriesFromDir(getCentralHooksDir()).find((e) => e.name === hookName);
  if (!central) return false;
  const installed = listHooksInVersionHome(agent, version).find((e) => e.name === hookName);
  if (!installed) return false;

  try {
    if (normalizeContent(fs.readFileSync(installed.scriptPath, 'utf-8')) !==
        normalizeContent(fs.readFileSync(central.scriptPath, 'utf-8'))) {
      return false;
    }
    if (!!installed.dataFile !== !!central.dataFile) return false;
    if (installed.dataFile && central.dataFile) {
      if (normalizeContent(fs.readFileSync(installed.dataFile, 'utf-8')) !==
          normalizeContent(fs.readFileSync(central.dataFile, 'utf-8'))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export interface VersionHookDiff {
  agent: AgentId;
  version: string;
  toAdd: string[];
  toUpdate: string[];
  matched: string[];
  orphans: string[];
}

/**
 * Compare a version home's hooks against central. Returns the reconciliation diff.
 */
export function diffVersionHooks(agent: AgentId, version: string): VersionHookDiff {
  const central = new Set(listHookEntriesFromDir(getCentralHooksDir()).map((e) => e.name));
  const installed = new Set(listHooksInVersionHome(agent, version).map((e) => e.name));

  const toAdd: string[] = [];
  const toUpdate: string[] = [];
  const matched: string[] = [];
  const orphans: string[] = [];

  for (const name of central) {
    if (!installed.has(name)) {
      toAdd.push(name);
    } else if (!versionHookMatches(agent, version, name)) {
      toUpdate.push(name);
    } else {
      matched.push(name);
    }
  }

  for (const name of installed) {
    if (!central.has(name)) orphans.push(name);
  }

  return { agent, version, toAdd: toAdd.sort(), toUpdate: toUpdate.sort(), matched, orphans: orphans.sort() };
}

/**
 * Install a single hook from central into a specific version home.
 */
export function installHookToVersion(
  agent: AgentId,
  version: string,
  hookName: string
): { success: boolean; error?: string } {
  const gate = supports(agent, 'hooks', version);
  if (!gate.ok) {
    return { success: false, error: explainSkip(agent, 'hooks', gate, version) };
  }

  const central = listHookEntriesFromDir(getCentralHooksDir()).find((e) => e.name === hookName);
  if (!central) {
    return { success: false, error: `Hook '${hookName}' not found in central` };
  }

  const targetDir = getVersionHooksDir(agent, version);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    copyHook(central, targetDir);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}

/**
 * Remove a single hook (script + data file) from a specific version home.
 * Soft-deletes to ~/.agents/.trash/hooks/.
 */
export function removeHookFromVersion(
  agent: AgentId,
  version: string,
  hookName: string
): { success: boolean; error?: string } {
  try {
    const hooksDir = getVersionHooksDir(agent, version);
    if (!fs.existsSync(hooksDir)) return { success: true };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashDir = path.join(getTrashHooksDir(), agent, version, hookName, stamp);
    let moved = false;

    const files = fs.readdirSync(hooksDir);
    for (const file of files) {
      const ext = path.extname(file);
      const base = path.basename(file, ext);
      if (base === hookName) {
        const fullPath = path.join(hooksDir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          if (!moved) {
            fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
            moved = true;
          }
          fs.renameSync(fullPath, path.join(trashDir, file));
        }
      }
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
  return { success: true };
}

/**
 * Iterate all (agent, version) pairs that support hooks and are installed,
 * optionally scoped to a single agent/version.
 */
export function iterHooksCapableVersions(filter?: { agent?: AgentId; version?: string }): Array<{ agent: AgentId; version: string }> {
  const pairs: Array<{ agent: AgentId; version: string }> = [];
  const hookAgents: AgentId[] = HOOKS_CAPABLE_AGENTS as unknown as AgentId[];
  const agents = filter?.agent ? [filter.agent] : hookAgents;
  for (const agent of agents) {
    if (!hookAgents.includes(agent)) continue;
    const versions = listInstalledVersions(agent);
    for (const version of versions) {
      if (filter?.version && filter.version !== version) continue;
      pairs.push({ agent, version });
    }
  }
  return pairs;
}

export async function removeHook(
  name: string,
  agents: AgentId[]
): Promise<{ removed: string[]; errors: string[] }> {
  const removed: string[] = [];
  const errors: string[] = [];

  const uniqueAgents = Array.from(new Set(agents));
  for (const agentId of uniqueAgents) {
    const agent = AGENTS[agentId];
    if (!agent || !agent.supportsHooks) {
      errors.push(`${agentId}:Agent does not support hooks`);
      continue;
    }

    try {
      const dir = getHooksDir(agentId);
      const filesBefore = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      removeHookFiles(dir, name);
      const filesAfter = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      if (filesBefore.length !== filesAfter.length) {
        removed.push(`${name}:${agentId}`);
      }
    } catch (err) {
      errors.push(`${name}:${agentId}:${(err as Error).message}`);
    }
  }

  return { removed, errors };
}

/**
 * Get detailed info about a hook from central storage.
 */
export function getHookInfo(name: string): {
  name: string;
  path: string;
  content: string;
} | null {
  const centralDir = getCentralHooksDir();
  const hookPath = path.join(centralDir, name);

  if (!fs.existsSync(hookPath)) {
    return null;
  }

  // Read hook content - it could be a file or directory
  let content = '';
  const stat = fs.statSync(hookPath);
  if (stat.isFile()) {
    content = fs.readFileSync(hookPath, 'utf-8');
  } else if (stat.isDirectory()) {
    // For directory hooks, list the files
    const files = fs.readdirSync(hookPath);
    content = `Directory hook containing:\n${files.map((f) => `  - ${f}`).join('\n')}`;
  }

  return {
    name,
    path: hookPath,
    content,
  };
}

export function discoverHooksFromRepo(repoPath: string): string[] {
  const hooksDir = path.join(repoPath, 'hooks');
  return listHookEntriesFromDir(hooksDir).map((h) => h.name);
}

/**
 * Get the source hook entry from repo.
 */
export function getSourceHookEntry(
  repoPath: string,
  hookName: string
): HookEntry | null {
  const hooksDir = path.join(repoPath, 'hooks');
  const entries = listHookEntriesFromDir(hooksDir);
  return entries.find((e) => e.name === hookName) || null;
}

/**
 * Install hooks to central ~/.agents/hooks/ directory.
 * Shims will symlink this to per-agent directories for synced agents.
 */
export async function installHooksCentrally(
  source: string
): Promise<{ installed: string[]; errors: string[] }> {
  const installed: string[] = [];
  const errors: string[] = [];

  const centralDir = getCentralHooksDir();
  if (!fs.existsSync(centralDir)) {
    fs.mkdirSync(centralDir, { recursive: true });
  }

  // Collect all hooks from shared directory
  const sharedDir = path.join(source, 'hooks');
  const sharedHooks = listHookEntriesFromDir(sharedDir);

  for (const entry of sharedHooks) {
    try {
      copyHook(entry, centralDir);
      installed.push(entry.name);
    } catch (err) {
      errors.push(`${entry.name}: ${(err as Error).message}`);
    }
  }

  return { installed, errors };
}

/**
 * List hooks from user (~/.agents/hooks/) and system (~/.agents-system/hooks/) dirs.
 * User dir takes priority; deduplication preserves first occurrence.
 */
export function listCentralHooks(): HookEntry[] {
  const seen = new Set<string>();
  const results: HookEntry[] = [];
  for (const dir of [getUserHooksDir(), getSystemHooksDir()]) {
    for (const entry of listHookEntriesFromDir(dir)) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        results.push(entry);
      }
    }
  }
  return results;
}

/**
 * Parse hook manifests. Reads system hooks from ~/.agents-system/hooks.yaml
 * (npm-shipped defaults) and user hooks from the `hooks:` section of
 * ~/.agents/agents.yaml. Merges with user-wins-on-key-collision precedence.
 * A user entry with `enabled: false` disables the system-shipped hook of
 * the same name without forking the system file.
 *
 * Hooks marked `enabled: false` are dropped from the returned map.
 */
export function parseHookManifest(): Record<string, ManifestHook> {
  const merged: Record<string, ManifestHook> = {};
  const systemHooks: Record<string, ManifestHook> = {};

  // System layer: hooks: section of agents.yaml (npm-shipped, separate repo).
  const systemPath = path.join(getSystemAgentsDir(), 'agents.yaml');
  if (fs.existsSync(systemPath)) {
    try {
      const meta = yaml.parse(fs.readFileSync(systemPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) {
        systemHooks[name] = def;
        merged[name] = def;
      }
    } catch { /* skip unreadable manifest */ }
  }

  // User layer: hooks: section of agents.yaml.
  const userMetaPath = path.join(getUserAgentsDir(), 'agents.yaml');
  if (fs.existsSync(userMetaPath)) {
    try {
      const meta = yaml.parse(fs.readFileSync(userMetaPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) {
        if (systemHooks[name] && def.override !== true) {
          const action = def.enabled === false ? 'disables' : 'shadows';
          console.warn(
            `[agents hooks] User-layer hook '${name}' ${action} system-shipped hook. Set 'override: true' to silence this warning.`,
          );
        }
        merged[name] = def;
      }
    } catch { /* skip unreadable meta */ }
  }

  // Strip disabled hooks so they never reach the registrar.
  for (const [name, def] of Object.entries(merged)) {
    if (def.enabled === false) delete merged[name];
  }
  return merged;
}

// Codex events that support a matcher field (matches tool name or session type).
// UserPromptSubmit and Stop never include a matcher.
const CODEX_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'SessionStart']);

type CodexMatcherGroup = {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout: number }>;
};

type CodexHooksFile = {
  hooks: Record<string, CodexMatcherGroup[]>;
};

/**
 * Register hooks as lifecycle events in an agent's config.
 * Reads hooks.yaml manifest, merges into the agent's config file(s).
 * Only manages hooks whose command paths are under ~/.agents/hooks/ or
 * ~/.agents-system/hooks/. Does not remove user-added hooks.
 *
 * @param agentsDirOverride - When provided, treats this single dir as the
 *   only managed hook root. Used by tests to inject a temp path. In normal
 *   operation, both user and system roots are consulted with user precedence.
 */
export function registerHooksToSettings(
  agentId: AgentId,
  versionHome: string,
  hookManifest?: Record<string, ManifestHook>,
  agentsDirOverride?: string
): { registered: string[]; errors: string[] } {
  const manifest = hookManifest || parseHookManifest();
  if (Object.keys(manifest).length === 0) {
    return { registered: [], errors: [] };
  }

  const overrideRoots = agentsDirOverride ? [agentsDirOverride] : null;
  // Scripts are copied into the version home during sync — prefer that stable
  // local path so registered commands don't break when source dirs change.
  const localHooksDir = !overrideRoots
    ? path.join(versionHome, `.${agentId}`, AGENTS[agentId].hooksDir)
    : null;
  const resolveScript = (script: string): string | null => {
    if (overrideRoots) {
      return resolveContainedHookPath(path.join(overrideRoots[0], 'hooks'), script);
    }
    if (localHooksDir) {
      const local = resolveContainedHookPath(localHooksDir, script);
      if (local) return local;
    }
    return resolveHookScriptPath(script);
  };
  const managedPrefixes = overrideRoots
    ? [path.join(overrideRoots[0], 'hooks') + path.sep]
    : [
        ...getManagedHookPrefixes(),
        ...(localHooksDir ? [localHooksDir + path.sep] : []),
      ];

  if (agentId === 'claude') {
    return registerHooksForClaude(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'codex') {
    return registerHooksForCodex(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'gemini') {
    return registerHooksForGemini(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'grok') {
    // Grok has a rich native hooks system (~/.grok/hooks/*.json + project .grok/hooks/).
    // Full bidirectional sync (agents hooks -> grok JSON) can be added in a follow-up.
    // For now we rely on the general file copy in syncResourcesToVersion + GROK_HOME.
    return { registered: [], errors: [] };
  }
  return { registered: [], errors: [] };
}

/**
 * Gemini has no native UserPromptSubmit event — map it to BeforeAgent,
 * the closest lifecycle phase that fires before the model sees the prompt.
 * Note: gemini's BeforeAgent can only APPEND via additionalContext — it
 * cannot replace the prompt. The hook script branches on caller to emit
 * the correct protocol.
 */
const GEMINI_EVENT_MAP: Record<string, string> = {
  UserPromptSubmit: 'BeforeAgent',
};

function registerHooksForClaude(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.claude');
  const settingsPath = path.join(configDir, 'settings.json');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      errors.push('Failed to parse settings.json');
      return { registered, errors };
    }
  }

  if (!config.hooks || typeof config.hooks !== 'object') {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown[]>;

  // Build set of all command paths the current manifest will register.
  // Used to garbage-collect stale entries left behind after hook renames.
  const currentManifestPaths = new Set<string>();
  for (const hookDef of Object.values(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveScript(hookDef.script);
    if (resolved) currentManifestPaths.add(resolved);
  }

  // Remove stale entries: any hook command under a managed root that isn't
  // in the current manifest is a leftover from a renamed/deleted hook script.
  for (const eventEntries of Object.values(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    for (const group of eventEntries as Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; timeout?: number }>;
    }>) {
      if (!group.hooks) continue;
      group.hooks = group.hooks.filter(
        (h) => !isManagedHookCommand(h.command, managedPrefixes) || currentManifestPaths.has(h.command)
      );
    }
  }

  // Remove empty matcher groups left after cleanup
  for (const [event, eventEntries] of Object.entries(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    hooks[event] = (eventEntries as Array<{ hooks?: unknown[] }>).filter(
      (g) => g.hooks && g.hooks.length > 0
    );
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveScript(hookDef.script);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    for (const event of hookDef.events) {
      if (!hooks[event]) {
        hooks[event] = [];
      }

      const eventEntries = hooks[event] as Array<{
        matcher?: string;
        hooks?: Array<{ type: string; command: string; timeout?: number }>;
      }>;

      const matcher = hookDef.matcher || '';
      const timeout = hookDef.timeout || 600;

      let matcherGroup = eventEntries.find((e) => (e.matcher || '') === matcher);
      if (!matcherGroup) {
        matcherGroup = { matcher, hooks: [] };
        eventEntries.push(matcherGroup);
      }

      if (!matcherGroup.hooks) {
        matcherGroup.hooks = [];
      }

      const existingIdx = matcherGroup.hooks.findIndex((h) => h.command === commandPath);
      const hookEntry = { type: 'command' as const, command: commandPath, timeout };

      if (existingIdx >= 0) {
        matcherGroup.hooks[existingIdx] = hookEntry;
      } else {
        matcherGroup.hooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write settings.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}

function registerHooksForCodex(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.codex');
  const hooksPath = path.join(configDir, 'hooks.json');
  const configPath = path.join(configDir, 'config.toml');

  // Read existing hooks.json — must have top-level "hooks" wrapper key
  let hooksFile: CodexHooksFile = { hooks: {} };
  if (fs.existsSync(hooksPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
      if (
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        existing.hooks &&
        typeof existing.hooks === 'object'
      ) {
        hooksFile = existing as CodexHooksFile;
      }
    } catch {
      errors.push('Failed to parse hooks.json');
      return { registered, errors };
    }
  }

  // Build set of current manifest command paths for codex to GC stale entries
  const currentManifestPaths = new Set<string>();
  for (const hookDef of Object.values(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveScript(hookDef.script);
    if (resolved) currentManifestPaths.add(resolved);
  }

  // Remove stale entries from all event groups
  for (const eventGroups of Object.values(hooksFile.hooks)) {
    for (const group of eventGroups) {
      if (!group.hooks) continue;
      group.hooks = group.hooks.filter(
        (h) => !isManagedHookCommand(h.command, managedPrefixes) || currentManifestPaths.has(h.command)
      );
    }
  }
  for (const [event, eventGroups] of Object.entries(hooksFile.hooks)) {
    hooksFile.hooks[event] = eventGroups.filter((g) => g.hooks && g.hooks.length > 0);
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveScript(hookDef.script);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout || 600;

    for (const event of hookDef.events) {
      if (!hooksFile.hooks[event]) {
        hooksFile.hooks[event] = [];
      }

      const eventGroups = hooksFile.hooks[event];

      // PreToolUse / PostToolUse / SessionStart use a matcher field.
      // UserPromptSubmit / Stop never include a matcher.
      const usesMatcher = CODEX_MATCHER_EVENTS.has(event);
      const matcherValue = usesMatcher ? (hookDef.matcher ?? '') : undefined;

      // Find the group for this matcher (or the sole no-matcher group)
      let group: CodexMatcherGroup | undefined;
      if (matcherValue !== undefined) {
        group = eventGroups.find((g) => (g.matcher ?? '') === matcherValue);
        if (!group) {
          group = matcherValue ? { matcher: matcherValue, hooks: [] } : { hooks: [] };
          eventGroups.push(group);
        }
      } else {
        group = eventGroups.find((g) => g.matcher === undefined);
        if (!group) {
          group = { hooks: [] };
          eventGroups.push(group);
        }
      }

      if (!group.hooks) {
        group.hooks = [];
      }

      const existingIdx = group.hooks.findIndex((h) => h.command === commandPath);
      const hookEntry = { type: 'command', command: commandPath, timeout };

      if (existingIdx >= 0) {
        group.hooks[existingIdx] = hookEntry;
      } else {
        group.hooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  if (registered.length === 0) {
    return { registered, errors };
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify(hooksFile, null, 2), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write hooks.json: ${(err as Error).message}`);
    return { registered, errors };
  }

  // Ensure [features] codex_hooks = true in config.toml
  try {
    let tomlConfig: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        tomlConfig = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      } catch { /* start fresh if corrupt */ }
    }

    if (!tomlConfig.features || typeof tomlConfig.features !== 'object') {
      tomlConfig.features = {};
    }
    (tomlConfig.features as Record<string, unknown>).codex_hooks = true;

    fs.writeFileSync(configPath, TOML.stringify(tomlConfig as Parameters<typeof TOML.stringify>[0]), 'utf-8');
  } catch (err) {
    errors.push(`Failed to update config.toml: ${(err as Error).message}`);
  }

  return { registered, errors };
}

function registerHooksForGemini(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const settingsPath = path.join(versionHome, '.gemini', 'settings.json');
  try {
    updateGeminiSettings(settingsPath, (config) => {
      setGeminiAutoUpdateDisabled(config);

      if (!config.hooks || typeof config.hooks !== 'object') {
        config.hooks = {};
      }
      const hooks = config.hooks as Record<string, unknown[]>;

      const currentManifestPaths = new Set<string>();
      for (const hookDef of Object.values(manifest)) {
        if (!hookDef.events || hookDef.events.length === 0) continue;
        const resolved = resolveScript(hookDef.script);
        if (resolved) currentManifestPaths.add(resolved);
      }

      for (const eventEntries of Object.values(hooks)) {
        if (!Array.isArray(eventEntries)) continue;
        for (const group of eventEntries as Array<{
          hooks?: Array<{ type: string; command: string; timeout?: number }>;
        }>) {
          if (!group.hooks) continue;
          group.hooks = group.hooks.filter(
            (h) => !isManagedHookCommand(h.command, managedPrefixes) || currentManifestPaths.has(h.command)
          );
        }
      }
      for (const [event, eventEntries] of Object.entries(hooks)) {
        if (!Array.isArray(eventEntries)) continue;
        hooks[event] = (eventEntries as Array<{ hooks?: unknown[] }>).filter(
          (g) => g.hooks && g.hooks.length > 0
        );
      }

      for (const [name, hookDef] of Object.entries(manifest)) {
        if (!hookDef.events || hookDef.events.length === 0) continue;

        const commandPath = resolveScript(hookDef.script);
        if (!commandPath) {
          errors.push(`${name}: script not found in user or system hooks dir`);
          continue;
        }

        const timeoutMs = (hookDef.timeout || 600) * 1000;

        for (const event of hookDef.events) {
          const geminiEvent = GEMINI_EVENT_MAP[event] ?? event;

          if (!hooks[geminiEvent]) {
            hooks[geminiEvent] = [];
          }

          const eventEntries = hooks[geminiEvent] as Array<{
            matcher?: string;
            hooks?: Array<{ name?: string; type: string; command: string; timeout?: number }>;
          }>;

          const matcher = hookDef.matcher || '';
          let matcherGroup = eventEntries.find((e) => (e.matcher || '') === matcher);
          if (!matcherGroup) {
            matcherGroup = { matcher, hooks: [] };
            eventEntries.push(matcherGroup);
          }
          if (!matcherGroup.hooks) {
            matcherGroup.hooks = [];
          }

          const existingIdx = matcherGroup.hooks.findIndex((h) => h.command === commandPath);
          const hookEntry = { name, type: 'command' as const, command: commandPath, timeout: timeoutMs };

          if (existingIdx >= 0) {
            matcherGroup.hooks[existingIdx] = hookEntry;
          } else {
            matcherGroup.hooks.push(hookEntry);
          }

          registered.push(`${name} -> ${geminiEvent}`);
        }
      }
    });
  } catch (err) {
    errors.push(`Failed to write gemini settings.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}
