/**
 * Hook management -- discovery, registration, and syncing of event hooks.
 *
 * Hooks are shell scripts in ~/.agents/hooks/ that fire on agent events
 * (tool calls, session start, etc.). Each hook directory contains a manifest
 * (agents.yaml) declaring events, matchers, and timeout. This module handles
 * parsing those manifests, registering hooks into agent-native settings files,
 * and syncing them across version switches.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import { AGENTS, ALL_AGENT_IDS, agentConfigDirName } from './agents.js';
import { supports, explainSkip, capableAgents } from './capabilities.js';
import { setGeminiAutoUpdateDisabled, updateGeminiSettings } from './gemini-settings.js';
import { getAgentsDir, getHooksDir as getSystemHooksDir, getUserHooksDir, getUserAgentsDir, getSystemAgentsDir, getProjectAgentsDir, getTrashHooksDir, getEnabledExtraRepos, getResolvedRulesDir, getUserRulesDir } from './state.js';
import { collectSubruleHooksFromState } from './rules/compose.js';

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
    // Subrule-dir hook scripts register by their absolute source path under a
    // rules `subrules/` tree. Cover those trees so a removed subrule/hook's
    // stale settings entry gets garbage-collected like any other managed hook.
    path.join(getUserRulesDir(), 'subrules') + path.sep,
    ...extraDirs.map(d => path.join(d, 'rules', 'subrules') + path.sep),
    path.join(getResolvedRulesDir(), 'subrules') + path.sep,
  ];
}

/**
 * Convert an absolute path under HOME to a portable ~/... form with forward
 * slashes. Hook commands stored this way work on both macOS and Windows:
 * absolute Windows paths break in bash because backslashes are stripped as
 * escape characters, whereas ~/... paths expand correctly via the ~/.claude
 * symlink/junction on both platforms.
 *
 * `home` and `sep` are injectable so the Windows behavior (backslash sep,
 * drive-letter home) is unit-testable on a POSIX CI host — pass sep='\\' to
 * simulate Windows. With the defaults this is byte-identical to reading
 * os.homedir()/path.sep at the call site.
 */
export function toPortableCommand(
  absPath: string,
  home: string = os.homedir(),
  sep: string = path.sep
): string {
  const normalized = absPath.split(sep).join('/');
  const homeNorm = home.split(sep).join('/');
  if (normalized.startsWith(homeNorm + '/')) {
    return '~/' + normalized.slice(homeNorm.length + 1);
  }
  return normalized;
}

function isManagedHookCommand(command: string, prefixes: string[]): boolean {
  // Expand ~/... so tilde-form portable commands can be matched against
  // absolute managed prefixes.
  let expanded = command;
  if (command.startsWith('~/')) {
    expanded = path.join(os.homedir(), command.slice(2));
  }
  // Resolve the directory through symlinks/junctions (e.g. ~/.claude on
  // Windows is a junction to the versioned home dir where prefixes live).
  // Resolve the dir, not the full path — the file may not exist after removal.
  const dir = path.dirname(expanded);
  let resolvedDir = dir;
  try { resolvedDir = fs.realpathSync(dir); } catch { /* absent or broken link */ }
  const resolved = path.join(resolvedDir, path.basename(expanded));

  for (const prefix of prefixes) {
    if (resolved.startsWith(prefix)) return true;
    // The command dir above is realpath-resolved, but a raw prefix may still
    // point through a symlink (macOS TMPDIR /var -> /private/var, or a
    // symlinked ~/.agents). Compare against a realpath-normalized prefix too
    // so the two sides match. Strip the trailing sep, resolve the dir, re-add.
    const rawPrefixDir = prefix.endsWith(path.sep) ? prefix.slice(0, -path.sep.length) : prefix;
    let resolvedPrefix = prefix;
    try { resolvedPrefix = fs.realpathSync(rawPrefixDir) + path.sep; } catch { /* absent or broken link */ }
    if (resolvedPrefix !== prefix && resolved.startsWith(resolvedPrefix)) return true;
  }
  return false;
}

/**
 * Per-version-home command detection. Sync copies each hook script into the
 * active version's home and registers the command by that version-scoped path
 * (`~/.agents/.history/versions/<agent>/<version>/home/…`). Because the path
 * embeds the version number, a later version's sync appends a fresh set whose
 * paths never string-match (and thus never prune) the prior version's entries —
 * so entries for every version installed over time pile up in one settings
 * file, and once a version is removed its entries become dead hooks that error
 * on every tool call. `versionHomeIdentity` extracts the `<agent>/<version>` a
 * command (or home path) belongs to so stale sibling-version entries can be
 * pruned. Returns null for any path outside a per-version home (system hooks,
 * the user's own custom hooks) — those are never a prune target.
 */
const VERSION_HOME_SEGMENT_RE = /\.history\/versions\/([^/]+)\/([^/]+)\/home(?:\/|$)/;
function versionHomeIdentity(commandOrPath: string): { agent: string; version: string } | null {
  const norm = commandOrPath.split(/[\\/]/).join('/');
  const m = VERSION_HOME_SEGMENT_RE.exec(norm);
  return m ? { agent: m[1], version: m[2] } : null;
}

/**
 * True when `command` points into a DIFFERENT version home of the same agent as
 * `current` — i.e. a stale entry left behind by an earlier version's sync.
 * Non-version-home commands (system + user-custom hooks) always return false.
 */
function isStaleSiblingVersionCommand(
  command: string,
  current: { agent: string; version: string } | null
): boolean {
  if (!current) return false;
  const id = versionHomeIdentity(command);
  return id !== null && id.agent === current.agent && id.version !== current.version;
}

import { getEffectiveHome, getVersionHomePath, listInstalledVersions } from './versions.js';
import type { AgentId, InstalledHook, ManifestHook } from './types.js';
import { generateHookShim, isValidHookShimName, parseCacheConfig, removeHookShim } from './hooks/cache.js';
import { getHookShimsDir } from './state.js';

export type HookEntry = { name: string; scriptPath: string; dataFile?: string };

/**
 * Resolve the command path to register for a hook.
 *
 * Returns either the raw script path (neither `cache:` nor `matches:` set,
 * legacy behavior) or the path to a generated wrapper shim. The shim is written
 * as a side effect when `cache:` and/or `matches:` is configured — it enforces
 * the `matches:` gate at fire time and layers the caching/timing machinery when
 * `cache:` is set. The agent-native settings file gets the same shape either
 * way — just a different command path.
 */
function resolveHookCommand(
  name: string,
  hookDef: ManifestHook,
  resolveScript: (script: string) => string | null
): string | null {
  const scriptPath = resolveScript(hookDef.script);
  if (!scriptPath) return null;
  if (!isValidHookShimName(name)) return null;
  const cache = parseCacheConfig(hookDef.cache);
  const matches = hookDef.matches;
  const hasMatches = matches != null && Object.keys(matches).length > 0;
  if (!cache && !hasMatches) {
    // No caching and no matches: gate opted in — make sure a previously
    // generated shim from an earlier `cache:`/`matches:` config is gone so the
    // JSONL doesn't keep claiming hits.
    removeHookShim(name);
    return toPortableCommand(scriptPath);
  }
  // A shim is generated when the hook opts into caching and/or declares
  // `matches:` predicates. The shim enforces the `matches:` gate at fire time
  // (skipping the script when predicates don't hold) and, when `cache:` is set,
  // layers the cache/timing machinery on top.
  return toPortableCommand(generateHookShim({ name, scriptPath, cache, matches }));
}

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

// Documentation siblings of a hook (e.g. `git-guard.md` next to `git-guard.sh`)
// are human-readable docs the hook never reads at runtime — NOT a data sidecar.
// Treating them as the hook's `dataFile` made the installer's correct omission
// of docs look like perpetual drift in `agents doctor` that no sync could fix.
// Structured siblings (.yaml/.json/.toml/...) remain valid data files.
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.rst']);

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

/**
 * Ensure a script file carries an exec bit. Subrule-dir hook scripts are
 * registered by their source path (not copied), so they must be executable in
 * place. Best-effort: a chmod failure (read-only fs, foreign owner) is ignored.
 */
function ensureExecutable(scriptPath: string): void {
  try {
    const mode = fs.statSync(scriptPath).mode;
    if (!isExecutable(mode)) fs.chmodSync(scriptPath, mode | 0o755);
  } catch { /* best effort */ }
}

function getHooksDir(agentId: AgentId): string {
  const agent = AGENTS[agentId];
  const home = getEffectiveHome(agentId);
  return path.join(home, agentConfigDirName(agentId), agent.hooksDir);
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
    const data = group.find((f) => f !== script && !DOC_EXTENSIONS.has(f.ext.toLowerCase()));
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
  const userDir = path.join(home, agentConfigDirName(agentId), agent.hooksDir);
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
  return path.join(home, agentConfigDirName(agent), AGENTS[agent].hooksDir);
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
  const hookAgents: AgentId[] = capableAgents('hooks');
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
 * List hooks from user (~/.agents/hooks/) and system (~/.agents/.system/hooks/) dirs.
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
 * Parse hook manifests. Reads system hooks from ~/.agents/.system/hooks.yaml
 * (npm-shipped defaults) and user hooks from the `hooks:` section of
 * ~/.agents/agents.yaml. Merges with user-wins-on-key-collision precedence.
 * A user entry with `enabled: false` disables the system-shipped hook of
 * the same name without forking the system file.
 *
 * Hooks marked `enabled: false` are dropped from the returned map.
 */
export function parseHookManifest(opts: { warn?: boolean } = {}): Record<string, ManifestHook> {
  const warn = opts.warn !== false;
  const merged: Record<string, ManifestHook> = {};
  const systemHooks: Record<string, ManifestHook> = {};

  // Lowest-precedence layer: hooks declared inside active subrule directories.
  // Seeded first so any same-key entry from system/user agents.yaml wins.
  // Gated so a malformed hooks.yaml never breaks rule sync.
  try {
    const subruleHooks = collectSubruleHooksFromState();
    for (const [name, def] of Object.entries(subruleHooks)) merged[name] = def;
  } catch { /* subrule hook collection is best-effort */ }

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

  // Extra-repo layer: hooks: section of each enabled extra repo's agents.yaml.
  // Sits above system but below user, mirroring resolveHookScriptPath's
  // first-found order (user > extra > system). Without this layer the script
  // path of an extra-repo hook resolves but its events never register (#602).
  // Earlier extras win over later ones, so iterate in reverse: the last write
  // for a given name comes from the earliest-registered repo.
  for (const { dir } of [...getEnabledExtraRepos()].reverse()) {
    const extraMetaPath = path.join(dir, 'agents.yaml');
    if (!fs.existsSync(extraMetaPath)) continue;
    try {
      const meta = yaml.parse(fs.readFileSync(extraMetaPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) merged[name] = def;
    } catch { /* skip unreadable extra-repo manifest */ }
  }

  // User layer: hooks: section of agents.yaml.
  const userMetaPath = path.join(getUserAgentsDir(), 'agents.yaml');
  if (fs.existsSync(userMetaPath)) {
    try {
      const meta = yaml.parse(fs.readFileSync(userMetaPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
      if (meta?.hooks) for (const [name, def] of Object.entries(meta.hooks)) {
        if (warn && systemHooks[name] && def.override !== true) {
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

/**
 * Hook script files present on disk that no manifest entry declares — "dead"
 * hooks. The registrar only wires manifest-declared hooks into an agent's
 * native config (settings.json / config.toml), matching the installed file to a
 * manifest entry by script basename. So a file whose basename matches no
 * manifest `script:` is never registered: it occupies the hooks dir and shows
 * up in listings, but no lifecycle event ever fires it.
 *
 * Pure on purpose (no disk reads) so it is trivially testable; callers pass the
 * installed hook names and the manifest's script paths.
 */
export function unmanagedHookNames(installedHookNames: string[], manifestScripts: string[]): string[] {
  const managed = new Set(manifestScripts.map((s) => path.basename(s).replace(/\.[^.]+$/, '')));
  return installedHookNames.filter((name) => !managed.has(name)).sort();
}

/**
 * The dead hooks (see {@link unmanagedHookNames}) sitting in one version home.
 * Reads the merged hook manifest silently — a diagnostic must not emit the
 * shadow/override warnings the registrar path prints.
 */
export function listUnmanagedHooksInVersionHome(agent: AgentId, version: string): string[] {
  if (!AGENTS[agent].supportsHooks) return [];
  const scripts = Object.values(parseHookManifest({ warn: false }))
    .map((h) => h.script)
    .filter((s): s is string => typeof s === 'string');
  const installed = listHooksInVersionHome(agent, version).map((e) => e.name);
  return unmanagedHookNames(installed, scripts);
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

// Maps PascalCase hook event names (as written in hooks.json) to the
// snake_case labels Codex uses in its persisted [hooks.state] keys.
// Mirrors hook_event_key_label() in codex-rs/hooks/src/lib.rs.
const CODEX_EVENT_KEY_LABELS: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
};

// Recursively sort object keys alphabetically at every level, mirroring
// canonical_json() in codex-rs/config/src/fingerprint.rs. Codex hashes the
// canonical JSON form so trust survives key-order differences.
function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeForHash);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeForHash((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute the trust hash Codex expects for a single command hook handler, so
 * agents-cli can pre-trust the hooks it registers. Without a matching
 * trusted_hash in [hooks.state], Codex classifies the hook Untrusted and
 * silently drops it in non-interactive (`codex exec`) mode where there is no
 * TUI prompt to approve it.
 *
 * Mirrors command_hook_hash() in codex-rs/hooks/src/engine/discovery.rs +
 * version_for_toml() in codex-rs/config/src/fingerprint.rs:
 *   sha256( canonicalJson( NormalizedHookIdentity ) ) prefixed with "sha256:".
 *
 * The identity passes through TOML on the Codex side, which drops None fields
 * (commandWindows, statusMessage, and matcher when absent). `async` is always
 * false (async hooks are not yet supported) and is always present. `timeout`
 * is normalized to >= 1 (Codex: unwrap_or(600).max(1)).
 */
export function computeCodexHookTrustHash(
  eventKeyLabel: string,
  command: string,
  timeout: number,
  matcher: string | undefined
): string {
  const handler: Record<string, unknown> = {
    type: 'command',
    command,
    timeout: Math.max(timeout, 1),
    async: false,
  };
  const identity: Record<string, unknown> = {
    event_name: eventKeyLabel,
    hooks: [handler],
  };
  if (matcher !== undefined && matcher !== '') {
    identity.matcher = matcher;
  }
  const canonical = canonicalizeForHash(identity);
  const hex = crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf-8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Register hooks as lifecycle events in an agent's config.
 * Reads hooks.yaml manifest, merges into the agent's config file(s).
 * Only manages hooks whose command paths are under ~/.agents/hooks/ or
 * ~/.agents/.system/hooks/. Does not remove user-added hooks.
 *
 * @param agentsDirOverride - When provided, treats this single dir as the
 *   only managed hook root. Used by tests to inject a temp path. In normal
 *   operation, both user and system roots are consulted with user precedence.
 */
/**
 * Delete shim files for hooks that no longer exist in the manifest.
 * managedPrefixes already GCs the settings.json entries pointing at orphaned
 * shims, but the .sh files on disk would otherwise persist forever. Called
 * once per registerHooksToSettings invocation — cheap (a single readdir).
 */
function sweepOrphanShims(manifest: Record<string, ManifestHook>): void {
  const shimsDir = getHookShimsDir();
  if (!fs.existsSync(shimsDir)) return;
  const activeNames = new Set(Object.keys(manifest));
  for (const file of fs.readdirSync(shimsDir)) {
    if (!file.endsWith('.sh')) continue;
    const name = file.slice(0, -3);
    if (activeNames.has(name)) continue;
    try { fs.unlinkSync(path.join(shimsDir, file)); } catch { /* best effort */ }
  }
}

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
  sweepOrphanShims(manifest);

  const overrideRoots = agentsDirOverride ? [agentsDirOverride] : null;
  // Scripts are copied into the version home during sync — prefer that stable
  // local path so registered commands don't break when source dirs change.
  const localHooksDir = !overrideRoots
    ? path.join(versionHome, agentConfigDirName(agentId), AGENTS[agentId].hooksDir)
    : null;
  const resolveScript = (script: string): string | null => {
    // Subrule-dir hooks declare an already-absolute script path. Use it
    // directly (made executable) — these are not copied into the version home.
    if (path.isAbsolute(script) && fs.existsSync(script)) {
      ensureExecutable(script);
      return script;
    }
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
        // Generated cache/timing shims live here; needs GC coverage so that a
        // hook whose `cache:` field is removed gets its stale shim path purged
        // from the agent's settings file (see resolveHookCommand).
        getHookShimsDir() + path.sep,
      ];

  if (agentId === 'claude') {
    return registerHooksForClaude(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'droid') {
    // Droid's settings.json hooks schema is identical to Claude's (top-level
    // `hooks` object → event → matcher-group array), so reuse the Claude
    // registrar targeting `.factory/settings.json` (agentConfigDirName('droid')).
    return registerHooksForClaude(
      versionHome,
      manifest,
      resolveScript,
      managedPrefixes,
      agentConfigDirName('droid')
    );
  }
  if (agentId === 'codex') {
    return registerHooksForCodex(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'gemini') {
    return registerHooksForGemini(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'antigravity') {
    return registerHooksForAntigravity(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'grok') {
    return registerHooksForGrok(versionHome, manifest, resolveScript, managedPrefixes);
  }
  if (agentId === 'kimi') {
    return registerHooksForKimi(versionHome, manifest, resolveScript, managedPrefixes);
  }
  return { registered: [], errors: [] };
}

/**
 * Antigravity (agy) event names differ from agents-cli manifest names. The
 * mapping below is the documented agy schema. PostToolUse has no exact
 * agy equivalent — agy fires `after_model_call` after the model finishes a
 * turn (which includes any tool calls in that turn), so it's the closest
 * lifecycle phase but not a 1:1 match. Manifest events not in this map are
 * skipped silently (the manifest may declare events for other agents).
 */
const ANTIGRAVITY_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'before_tool_call',
  // Imperfect mapping: agy has no per-tool post-event. after_model_call
  // fires once at the end of the turn, after all tool calls completed.
  PostToolUse: 'after_model_call',
  Stop: 'on_loop_stop',
  OnError: 'on_error',
};

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
  managedPrefixes: string[],
  configDirName = '.claude'
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, configDirName);
  const settingsPath = path.join(configDir, 'settings.json');

  let config: Record<string, unknown> = {};
  let existingRaw: string | undefined;
  if (fs.existsSync(settingsPath)) {
    try {
      existingRaw = fs.readFileSync(settingsPath, 'utf-8');
      config = JSON.parse(existingRaw);
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
  // Used to garbage-collect stale entries left behind after hook renames
  // or after a `cache:` field is added/removed (raw script vs shim path).
  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (resolved) currentManifestPaths.add(resolved);
  }

  // Identity of the version home being synced. Used to prune entries that point
  // at a DIFFERENT version home of the same agent (see isStaleSiblingVersionCommand).
  const currentVh = versionHomeIdentity(versionHome);

  // Remove stale entries: any hook command under a managed root that isn't in
  // the current manifest is a leftover from a renamed/deleted hook script; any
  // command pointing at a sibling version's home is a leftover from that
  // version's sync (its version-scoped path never matches the current set).
  for (const eventEntries of Object.values(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    for (const group of eventEntries as Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; timeout?: number }>;
    }>) {
      if (!group.hooks) continue;
      group.hooks = group.hooks.filter(
        (h) =>
          (!isManagedHookCommand(h.command, managedPrefixes) || currentManifestPaths.has(h.command)) &&
          !isStaleSiblingVersionCommand(h.command, currentVh)
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

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
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
    const nextRaw = JSON.stringify(config, null, 2);
    if (existingRaw !== nextRaw) {
      fs.writeFileSync(settingsPath, nextRaw, 'utf-8');
    }
  } catch (err) {
    errors.push(`Failed to write settings.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}

/**
 * Prune every Claude-family (`settings.json`) hook entry whose command lives
 * under a removed version's home
 * (`~/.agents/.history/versions/<agent>/<removedVersion>/home/…`).
 *
 * `agents remove <agent>@<version>` soft-deletes the version's files but leaves
 * the hook entries other version homes registered against it — dead hooks that
 * error on every tool call ("No such file or directory") until the next sync.
 * This clears them from a remaining version's settings immediately. Only the
 * removed version's entries are touched; the current version's entries, system
 * hooks, and the user's own custom hooks are left intact. Returns the number of
 * entries removed.
 */
export function pruneVersionHomeHookEntriesFromSettings(
  settingsPath: string,
  agent: AgentId,
  removedVersion: string
): number {
  if (!fs.existsSync(settingsPath)) return 0;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return 0;
  }
  if (!config.hooks || typeof config.hooks !== 'object') return 0;
  const hooks = config.hooks as Record<string, unknown[]>;

  let removed = 0;
  for (const eventEntries of Object.values(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    for (const group of eventEntries as Array<{ hooks?: Array<{ command: string }> }>) {
      if (!group.hooks) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => {
        const id = versionHomeIdentity(h.command);
        return !(id !== null && id.agent === agent && id.version === removedVersion);
      });
      removed += before - group.hooks.length;
    }
  }
  if (removed === 0) return 0;

  // Drop matcher groups left empty by the prune.
  for (const [event, eventEntries] of Object.entries(hooks)) {
    if (!Array.isArray(eventEntries)) continue;
    hooks[event] = (eventEntries as Array<{ hooks?: unknown[] }>).filter(
      (g) => g.hooks && g.hooks.length > 0
    );
  }

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch {
    // Best-effort cleanup: a write failure leaves the dead entry to be pruned
    // on the next sync (see isStaleSiblingVersionCommand).
    return 0;
  }
  return removed;
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

  // Build set of current manifest command paths for codex to GC stale entries.
  // Uses resolveHookCommand so cached hooks resolve to their shim path.
  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
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

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
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

  // Ensure [features] hooks = true and pre-trust every registered hook in
  // config.toml. Codex only runs hooks that are enabled AND trusted; in
  // non-interactive (`codex exec`) mode there is no TUI prompt to approve
  // them, so an untrusted hook is silently dropped. We compute the same
  // trust hash Codex would and persist it under [hooks.state].
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
    // Codex 0.116+ feature flag is `hooks` (the legacy `codex_hooks` name is
    // an unrecognized key that triggers a deprecation error and is ignored).
    const features = tomlConfig.features as Record<string, unknown>;
    delete features.codex_hooks;
    features.hooks = true;

    // Pre-trust hooks. The [hooks.state] key is keyed by the hooks.json path
    // exactly as Codex resolves it (the absolute CODEX_HOME path), the
    // snake_case event label, and the per-event group/handler indices — which
    // must match Codex's parse order, so we iterate the just-written
    // hooksFile structure in array order.
    if (!tomlConfig.hooks || typeof tomlConfig.hooks !== 'object') {
      tomlConfig.hooks = {};
    }
    const hooksTable = tomlConfig.hooks as Record<string, unknown>;
    const existingState =
      hooksTable.state && typeof hooksTable.state === 'object'
        ? (hooksTable.state as Record<string, { enabled?: boolean; trusted_hash?: string }>)
        : {};
    const hookState: Record<string, { enabled?: boolean; trusted_hash?: string }> = {};

    for (const [event, eventGroups] of Object.entries(hooksFile.hooks)) {
      const eventKeyLabel = CODEX_EVENT_KEY_LABELS[event];
      if (!eventKeyLabel) continue;
      eventGroups.forEach((group, groupIdx) => {
        if (!group.hooks) return;
        group.hooks.forEach((handler, handlerIdx) => {
          if (handler.type !== 'command') return;
          const key = `${hooksPath}:${eventKeyLabel}:${groupIdx}:${handlerIdx}`;
          const trustedHash = computeCodexHookTrustHash(
            eventKeyLabel,
            handler.command,
            handler.timeout,
            group.matcher
          );
          // Preserve a user's explicit `enabled = false` for this exact hook;
          // only (re)write the trust hash.
          const prior = existingState[key];
          const entry: { enabled?: boolean; trusted_hash?: string } = { trusted_hash: trustedHash };
          if (prior && prior.enabled === false) {
            entry.enabled = false;
          }
          hookState[key] = entry;
        });
      });
    }

    // Carry forward trust state for any hooks we did not (re)register this
    // pass — e.g. user-added hooks under a different command path.
    for (const [key, entry] of Object.entries(existingState)) {
      if (!(key in hookState)) {
        hookState[key] = entry;
      }
    }

    hooksTable.state = hookState;

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
      for (const [hookName, hookDef] of Object.entries(manifest)) {
        if (!hookDef.events || hookDef.events.length === 0) continue;
        const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
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

        const commandPath = resolveHookCommand(name, hookDef, resolveScript);
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

/**
 * Register hooks into antigravity's (agy) settings.json. Unlike gemini, agy uses
 * a flat per-event array of `{ command }` entries (no matcher groups). Events
 * are renamed via ANTIGRAVITY_EVENT_MAP; unmapped manifest events are skipped.
 *
 * settings.json lives at `${versionHome}/.gemini/antigravity-cli/settings.json`
 * because agy nests its config under the shared `.gemini` parent dir.
 */
function registerHooksForAntigravity(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configDir = path.join(versionHome, '.gemini', 'antigravity-cli');
  const settingsPath = path.join(configDir, 'settings.json');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      errors.push('Failed to parse antigravity settings.json');
      return { registered, errors };
    }
  }

  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) {
    config.hooks = {};
  }
  const hooks = config.hooks as Record<string, unknown[]>;

  // Build set of all command paths the current manifest will register, so we
  // can garbage-collect stale managed entries left over from renamed/deleted
  // hooks. Only managed paths are considered for removal — user-added entries
  // outside managedPrefixes are preserved.
  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    // Only paths whose events map to a known agy event would actually be
    // registered, so only those should survive GC.
    const anyMapped = hookDef.events.some((e) => ANTIGRAVITY_EVENT_MAP[e]);
    if (!anyMapped) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (resolved) currentManifestPaths.add(resolved);
  }

  for (const eventKey of Object.keys(hooks)) {
    const entries = hooks[eventKey];
    if (!Array.isArray(entries)) continue;
    hooks[eventKey] = entries.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const cmd = (entry as { command?: unknown }).command;
      if (typeof cmd !== 'string') return true;
      if (!isManagedHookCommand(cmd, managedPrefixes)) return true;
      return currentManifestPaths.has(cmd);
    });
    if ((hooks[eventKey] as unknown[]).length === 0) {
      delete hooks[eventKey];
    }
  }

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    for (const event of hookDef.events) {
      const agyEvent = ANTIGRAVITY_EVENT_MAP[event];
      if (!agyEvent) continue; // unmapped event — silently skip

      if (!hooks[agyEvent]) {
        hooks[agyEvent] = [];
      }
      const list = hooks[agyEvent] as Array<{ command: string }>;

      const existingIdx = list.findIndex(
        (e) => e && typeof e === 'object' && e.command === commandPath
      );
      const entry = { command: commandPath };
      if (existingIdx >= 0) {
        list[existingIdx] = entry;
      } else {
        list.push(entry);
      }

      registered.push(`${name} -> ${agyEvent}`);
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    errors.push(`Failed to write antigravity settings.json: ${(err as Error).message}`);
  }

  return { registered, errors };
}

/**
 * Register hooks for Grok Build.
 * Grok uses per-event JSON files under .grok/hooks/ (e.g. session-start.json).
 */
function registerHooksForGrok(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const grokHooksDir = path.join(versionHome, '.grok', 'hooks');
  fs.mkdirSync(grokHooksDir, { recursive: true });

  const eventMap: Record<string, string> = {
    SessionStart: 'SessionStart',
    SessionEnd: 'SessionEnd',
    UserPromptSubmit: 'UserPromptSubmit',
    PreToolUse: 'PreToolUse',
    PostToolUse: 'PostToolUse',
    PreCompact: 'PreCompact',
    Stop: 'Stop',
    Notification: 'Notification',
  };

  const grokHooks: Record<string, any> = { hooks: {} };

  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found`);
      continue;
    }

    const timeout = hookDef.timeout ?? 30;

    for (const ev of hookDef.events) {
      const grokEvent = eventMap[ev] || ev;

      if (!grokHooks.hooks[grokEvent]) {
        grokHooks.hooks[grokEvent] = [];
      }

      grokHooks.hooks[grokEvent].push({
        hooks: [{ type: 'command' as const, command: commandPath, timeout }],
      });

      registered.push(`${name} -> ${grokEvent}`);
    }
  }

  const mainHooksPath = path.join(grokHooksDir, 'hooks.json');
  try {
    fs.writeFileSync(mainHooksPath, JSON.stringify(grokHooks, null, 2));
  } catch (e) {
    errors.push(`Failed to write hooks.json: ${(e as Error).message}`);
  }

  for (const [eventName, groups] of Object.entries(grokHooks.hooks)) {
    const fileName = eventName.toLowerCase().replace(/([a-z])([A-Z])/g, '$1-$2') + '.json';
    const eventFile = path.join(grokHooksDir, fileName);
    try {
      fs.writeFileSync(eventFile, JSON.stringify({ hooks: { [eventName]: groups } }, null, 2));
    } catch (e) {
      errors.push(`Failed to write ${fileName}: ${(e as Error).message}`);
    }
  }

  return { registered, errors };
}

function registerHooksForKimi(
  versionHome: string,
  manifest: Record<string, ManifestHook>,
  resolveScript: (script: string) => string | null,
  managedPrefixes: string[]
): { registered: string[]; errors: string[] } {
  const registered: string[] = [];
  const errors: string[] = [];

  const configPath = path.join(versionHome, '.kimi-code', 'config.toml');

  // Read existing config.toml
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      errors.push('Failed to parse config.toml');
      return { registered, errors };
    }
  }

  // Build set of current manifest command paths for GC
  const currentManifestPaths = new Set<string>();
  for (const [hookName, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;
    const resolved = resolveHookCommand(hookName, hookDef, resolveScript);
    if (resolved) currentManifestPaths.add(resolved);
  }

  // Remove stale managed hooks from existing hooks array
  let hooksArray: Array<Record<string, unknown>> = [];
  if (Array.isArray(config.hooks)) {
    hooksArray = config.hooks as Array<Record<string, unknown>>;
  }

  const filteredHooks = hooksArray.filter((h) => {
    const cmd = typeof h.command === 'string' ? h.command : '';
    if (!cmd) return true;
    if (!isManagedHookCommand(cmd, managedPrefixes)) return true;
    return currentManifestPaths.has(cmd);
  });

  // Add/update hooks from manifest
  for (const [name, hookDef] of Object.entries(manifest)) {
    if (!hookDef.events || hookDef.events.length === 0) continue;

    const commandPath = resolveHookCommand(name, hookDef, resolveScript);
    if (!commandPath) {
      errors.push(`${name}: script not found in user or system hooks dir`);
      continue;
    }

    const timeout = hookDef.timeout ?? 30;

    for (const event of hookDef.events) {
      const matcher = hookDef.matcher;

      // Find existing hook with same event, command, and matcher
      const existingIdx = filteredHooks.findIndex((h) => {
        const sameEvent = h.event === event;
        const sameCmd = h.command === commandPath;
        const sameMatcher = (h.matcher ?? '') === (matcher ?? '');
        return sameEvent && sameCmd && sameMatcher;
      });

      const hookEntry: Record<string, unknown> = {
        event,
        command: commandPath,
        timeout,
      };
      if (matcher) {
        hookEntry.matcher = matcher;
      }

      if (existingIdx >= 0) {
        filteredHooks[existingIdx] = hookEntry;
      } else {
        filteredHooks.push(hookEntry);
      }

      registered.push(`${name} -> ${event}`);
    }
  }

  config.hooks = filteredHooks;

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, TOML.stringify(config as Parameters<typeof TOML.stringify>[0]), 'utf-8');
  } catch (err) {
    errors.push(`Failed to write config.toml: ${(err as Error).message}`);
  }

  return { registered, errors };
}
