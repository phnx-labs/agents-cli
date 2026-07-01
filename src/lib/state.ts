/**
 * Filesystem layout and persistent state for agents-cli.
 *
 * Single root at ~/.agents/ with three internal buckets:
 *
 *   ~/.agents/           — user repo: user-authored resources + agents.yaml
 *                          (git-tracked via `agents repo push`).
 *   ~/.agents/.system/   — system repo: npm-shipped resources, regenerable.
 *                          Don't hand-edit; maintained by npm install /
 *                          `agents repo pull system`.
 *   ~/.agents/.history/  — durable runtime data (sessions, versions, runs,
 *                          teams/agents, trash, backups). Backed up by
 *                          `agents repo push`.
 *   ~/.agents/.cache/    — regenerable runtime data (shims, packages, helpers
 *                          for daemon/pty, terminals, cloud, drive, browser
 *                          chrome-data, logs, companion). Gitignored.
 *
 * Resolution precedence for resources: project > user > system.
 * Every module that needs a path or reads/writes agents.yaml goes through here.
 *
 * Legacy layout (pre-fold): system repo lived at ~/.agents-system/ as a peer
 * of ~/.agents/. runMigration() folds it into ~/.agents/.system/ on first run
 * and leaves a back-compat symlink at the old path.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { ensureLockTarget, atomicWriteFileSync, withFileLock } from './fs-atomic.js';
import type { Meta, RegistryType } from './types.js';
import { SEEDED_REGISTRIES } from './types.js';

const HOME = process.env.HOME ?? os.homedir();

/**
 * Compare two filesystem paths for identity, resolving symlinks and (on
 * Windows) 8.3 short-name vs long-name divergence via the OS realpath.
 * Falls back to a case-folded normalize when a path doesn't exist on disk.
 */
function isSamePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    const norm = (p: string) =>
      process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    return norm(a) === norm(b);
  }
}

// ─── Root directories ─────────────────────────────────────────────────────────

/** User repo — user-authored resources and agents.yaml. Always-on. */
const USER_AGENTS_DIR = path.join(HOME, '.agents');

/** System repo — npm-shipped, read-only from user commands. Lives inside the user repo. */
const SYSTEM_AGENTS_DIR = path.join(USER_AGENTS_DIR, '.system');

/**
 * Legacy system-repo location (pre-fold). Exported so the migrator can fold
 * it into SYSTEM_AGENTS_DIR. No runtime code outside the migrator should
 * reference this — use SYSTEM_AGENTS_DIR.
 */
const LEGACY_SYSTEM_AGENTS_DIR = path.join(HOME, '.agents-system');

// ─── Meta file (agents.yaml lives in the user repo) ──────────────────────────

const META_FILE = path.join(USER_AGENTS_DIR, 'agents.yaml');
/** Legacy location — used only for one-shot migration in readMeta(). */
const SYSTEM_META_FILE = path.join(SYSTEM_AGENTS_DIR, 'agents.yaml');

// ─── System resource dirs ─────────────────────────────────────────────────────

const SYSTEM_COMMANDS_DIR = path.join(SYSTEM_AGENTS_DIR, 'commands');
const SYSTEM_HOOKS_DIR = path.join(SYSTEM_AGENTS_DIR, 'hooks');
const SYSTEM_SKILLS_DIR = path.join(SYSTEM_AGENTS_DIR, 'skills');
const SYSTEM_RULES_DIR = path.join(SYSTEM_AGENTS_DIR, 'rules');
const SYSTEM_MCP_DIR = path.join(SYSTEM_AGENTS_DIR, 'mcp');
const SYSTEM_PERMISSIONS_DIR = path.join(SYSTEM_AGENTS_DIR, 'permissions');
const SYSTEM_SUBAGENTS_DIR = path.join(SYSTEM_AGENTS_DIR, 'subagents');
const SYSTEM_WORKFLOWS_DIR = path.join(SYSTEM_AGENTS_DIR, 'workflows');
const SYSTEM_PLUGINS_DIR = path.join(SYSTEM_AGENTS_DIR, 'plugins');
const SYSTEM_PROMPTCUTS_FILE = path.join(SYSTEM_AGENTS_DIR, 'hooks', 'promptcuts.yaml');
const SYSTEM_MCP_CONFIG_FILE = path.join(SYSTEM_AGENTS_DIR, 'mcp.json');
const SYSTEM_INSTRUCTIONS_FILE = path.join(SYSTEM_AGENTS_DIR, 'instructions.md');

// ─── User repo operational buckets ────────────────────────────────────────────

/** Durable runtime data (sessions, versions, runs, teams history, trash, backups). */
const HISTORY_DIR = path.join(USER_AGENTS_DIR, '.history');

/** Regenerable runtime data (shims, packages, helpers, terminals, cloud, drive, logs, browser). */
const CACHE_DIR = path.join(USER_AGENTS_DIR, '.cache');

// Top-level user dirs (config/definitions only — runtime moves into .history/.cache).
const ROUTINES_DIR = path.join(USER_AGENTS_DIR, 'routines');
const TEAMS_DIR = path.join(USER_AGENTS_DIR, 'teams');

// History bucket (durable).
const SESSIONS_DIR = path.join(HISTORY_DIR, 'sessions');
const SESSIONS_DB_PATH = path.join(SESSIONS_DIR, 'sessions.db');
const VERSIONS_DIR = path.join(HISTORY_DIR, 'versions');
const RUNS_DIR = path.join(HISTORY_DIR, 'runs');
const TEAMS_AGENTS_DIR = path.join(HISTORY_DIR, 'teams', 'agents');
const BACKUPS_DIR = path.join(HISTORY_DIR, 'backups');
const TRASH_DIR = path.join(HISTORY_DIR, 'trash');

// Cache bucket (regenerable).
const SHIMS_DIR = path.join(CACHE_DIR, 'shims');
const HOOK_SHIMS_DIR = path.join(SHIMS_DIR, 'hooks');
const HOOK_CACHE_DIR = path.join(CACHE_DIR, 'state', 'hooks');
const BIN_DIR = path.join(CACHE_DIR, 'bin');
const PACKAGES_DIR = path.join(CACHE_DIR, 'packages');
// Plugins are user-authored resources, alongside skills/, commands/, hooks/.
// They live at the user-root so they're git-tracked as source of truth.
const PLUGINS_DIR = path.join(USER_AGENTS_DIR, 'plugins');
const CLOUD_DIR = path.join(CACHE_DIR, 'cloud');
const DRIVE_DIR = path.join(CACHE_DIR, 'drive');
const TERMINALS_DIR = path.join(CACHE_DIR, 'terminals');
const LOGS_DIR = path.join(CACHE_DIR, 'logs');
const RUNTIME_STATE_DIR = path.join(CACHE_DIR, 'state');
const COMPANION_CACHE_DIR = path.join(CACHE_DIR, 'companion');
const BROWSER_RUNTIME_DIR = path.join(CACHE_DIR, 'browser');
const HELPERS_DIR = path.join(CACHE_DIR, 'helpers');
const DAEMON_DIR = path.join(HELPERS_DIR, 'daemon');
const PTY_DIR = path.join(HELPERS_DIR, 'pty');
const TMUX_DIR = path.join(HELPERS_DIR, 'tmux');
const FETCH_CACHE_DIR = path.join(CACHE_DIR, '.fetch');
const CLI_VERSION_CACHE_FILE = path.join(CACHE_DIR, '.cli-version-cache.json');
const MODELS_CACHE_FILE = path.join(CACHE_DIR, '.models-cache.json');
const UPDATE_CHECK_FILE = path.join(CACHE_DIR, '.update-check');
const MIGRATED_SENTINEL_FILE = path.join(CACHE_DIR, '.migrated');

// ─── User resource dirs ───────────────────────────────────────────────────────

const USER_COMMANDS_DIR = path.join(USER_AGENTS_DIR, 'commands');
const USER_HOOKS_DIR = path.join(USER_AGENTS_DIR, 'hooks');
const USER_SKILLS_DIR = path.join(USER_AGENTS_DIR, 'skills');
const USER_RULES_DIR = path.join(USER_AGENTS_DIR, 'rules');
const USER_MCP_DIR = path.join(USER_AGENTS_DIR, 'mcp');
const USER_PERMISSIONS_DIR = path.join(USER_AGENTS_DIR, 'permissions');
const USER_SUBAGENTS_DIR = path.join(USER_AGENTS_DIR, 'subagents');
const USER_WORKFLOWS_DIR = path.join(USER_AGENTS_DIR, 'workflows');
const USER_SECRETS_DIR = path.join(USER_AGENTS_DIR, 'secrets');
const USER_PROMPTCUTS_FILE = path.join(USER_AGENTS_DIR, 'hooks', 'promptcuts.yaml');

const META_HEADER = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agents-cli

`;

// ─── Root getters ─────────────────────────────────────────────────────────────

/** Root of the system data directory (~/.agents/.system/). */
export function getAgentsDir(): string {
  return SYSTEM_AGENTS_DIR;
}

/** Root of the system data directory (~/.agents/.system/). */
export function getSystemAgentsDir(): string {
  return SYSTEM_AGENTS_DIR;
}

/** Legacy system-repo location (~/.agents-system/). Exported for migration only. */
export function getLegacySystemAgentsDir(): string {
  return LEGACY_SYSTEM_AGENTS_DIR;
}

/** Root of the user repo (~/.agents/). Always present after ensureAgentsDir(). */
export function getUserAgentsDir(): string {
  return USER_AGENTS_DIR;
}

/**
 * Backward-compat shim. Returns null when ~/.agents/ is a symlink to the
 * system dir; otherwise returns USER_AGENTS_DIR.
 *
 * @deprecated Use getUserAgentsDir() directly.
 */
export function getOptionalUserAgentsDir(): string | null {
  if (fs.existsSync(USER_AGENTS_DIR)) {
    try {
      const stat = fs.lstatSync(USER_AGENTS_DIR);
      if (stat.isSymbolicLink()) {
        try {
          if (fs.realpathSync(USER_AGENTS_DIR) === fs.realpathSync(SYSTEM_AGENTS_DIR)) return null;
        } catch { return null; }
      }
    } catch { /* dir may not exist yet */ }
  }
  return USER_AGENTS_DIR;
}

/** Walk up from startPath to find a project-scoped .agents/ directory (skipping both roots). */
export function getProjectAgentsDir(startPath: string = process.cwd()): string | null {
  let dir = path.resolve(startPath);

  while (true) {
    const agentsPath = path.join(dir, '.agents');
    if (fs.existsSync(agentsPath) && fs.statSync(agentsPath).isDirectory()) {
      if (!isSamePath(agentsPath, SYSTEM_AGENTS_DIR) && !isSamePath(agentsPath, USER_AGENTS_DIR)) {
        return agentsPath;
      }
    }

    const isProjectBoundary = fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'agents.yaml'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (isProjectBoundary) break;
    dir = parent;
  }

  return null;
}

/** Return all .agents/ directories in scope: project, user, then system. */
export function getScopedAgentsDirs(startPath: string = process.cwd()): Array<{ scope: 'project' | 'user' | 'system'; path: string }> {
  const dirs: Array<{ scope: 'project' | 'user' | 'system'; path: string }> = [];
  const projectDir = getProjectAgentsDir(startPath);
  if (projectDir) {
    dirs.push({ scope: 'project', path: projectDir });
  }
  dirs.push({ scope: 'user', path: USER_AGENTS_DIR });
  dirs.push({ scope: 'system', path: SYSTEM_AGENTS_DIR });
  return dirs;
}

// ─── System resource getters (legacy aliases for read/sync paths) ─────────────

/** Path to slash command markdown files — system repo. */
export function getCommandsDir(): string { return SYSTEM_COMMANDS_DIR; }

/** Path to hook script directories — system repo. */
export function getHooksDir(): string { return SYSTEM_HOOKS_DIR; }

/** Path to skill bundles — system repo. */
export function getSkillsDir(): string { return SYSTEM_SKILLS_DIR; }

/** Path to the canonical rules directory — system repo. */
export function getRulesDir(): string { return SYSTEM_RULES_DIR; }

/** Read-side resolution for the canonical rules dir — system repo. */
export function getResolvedRulesDir(): string { return SYSTEM_RULES_DIR; }

/** Path to MCP server YAML configs — system repo. */
export function getMcpDir(): string { return SYSTEM_MCP_DIR; }

/** Path to permission group YAML files — system repo. */
export function getPermissionsDir(): string { return SYSTEM_PERMISSIONS_DIR; }

/** Path to subagent definition directories — system repo. */
export function getSubagentsDir(): string { return SYSTEM_SUBAGENTS_DIR; }

/** Path to ~/.agents/.system/hooks/promptcuts.yaml (system defaults). */
export function getPromptcutsPath(): string { return SYSTEM_PROMPTCUTS_FILE; }

/**
 * Resolve the effective promptcuts file: user file if it exists, otherwise
 * the system file. Use this for callers that need a single path (doctor
 * diff, displaying which file is in play). Callers that need the merged
 * shortcut set should use readMergedPromptcuts() instead.
 */
export function getEffectivePromptcutsPath(): string {
  if (fs.existsSync(USER_PROMPTCUTS_FILE)) return USER_PROMPTCUTS_FILE;
  return SYSTEM_PROMPTCUTS_FILE;
}

/**
 * Read promptcuts from system + user with user precedence. Returns the
 * merged `shortcuts` map. Same layering model as parseHookManifest().
 * Returns an empty object when neither file exists or both fail to parse.
 */
export function readMergedPromptcuts(): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const filePath of [SYSTEM_PROMPTCUTS_FILE, USER_PROMPTCUTS_FILE]) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = yaml.parse(fs.readFileSync(filePath, 'utf-8')) as
        | { shortcuts?: Record<string, unknown> }
        | null;
      if (!parsed?.shortcuts) continue;
      for (const [key, value] of Object.entries(parsed.shortcuts)) {
        merged[key] = value;
      }
    } catch {
      // Skip unreadable file, keep going
    }
  }
  return merged;
}

/** Path to the legacy MCP config JSON. */
export function getMcpConfigPath(): string { return SYSTEM_MCP_CONFIG_FILE; }

/** Path to the global instructions file. */
export function getInstructionsPath(): string { return SYSTEM_INSTRUCTIONS_FILE; }

// ─── System-specific getters ───────────────────────────────────────────────────

export function getSystemCommandsDir(): string { return SYSTEM_COMMANDS_DIR; }
export function getSystemHooksDir(): string { return SYSTEM_HOOKS_DIR; }
export function getSystemSkillsDir(): string { return SYSTEM_SKILLS_DIR; }
export function getSystemRulesDir(): string { return SYSTEM_RULES_DIR; }
export function getSystemMcpDir(): string { return SYSTEM_MCP_DIR; }
export function getSystemPermissionsDir(): string { return SYSTEM_PERMISSIONS_DIR; }
export function getSystemSubagentsDir(): string { return SYSTEM_SUBAGENTS_DIR; }
export function getSystemPromptcutsPath(): string { return SYSTEM_PROMPTCUTS_FILE; }

// ─── User resource getters ────────────────────────────────────────────────────

export function getUserCommandsDir(): string { return USER_COMMANDS_DIR; }
export function getUserHooksDir(): string { return USER_HOOKS_DIR; }
export function getUserSkillsDir(): string { return USER_SKILLS_DIR; }
export function getUserRulesDir(): string { return USER_RULES_DIR; }
export function getUserMcpDir(): string { return USER_MCP_DIR; }
export function getUserPermissionsDir(): string { return USER_PERMISSIONS_DIR; }
export function getUserSubagentsDir(): string { return USER_SUBAGENTS_DIR; }

export function getSystemWorkflowsDir(): string { return SYSTEM_WORKFLOWS_DIR; }
export function getUserWorkflowsDir(): string { return USER_WORKFLOWS_DIR; }
export function getUserSecretsDir(): string { return USER_SECRETS_DIR; }
export function getUserPromptcutsPath(): string { return USER_PROMPTCUTS_FILE; }

// ─── User operational path getters ────────────────────────────────────────────
//
// Top-level dirs hold definitions/configs only; runtime data lives under
// .history/ (durable) or .cache/ (regenerable). See file header.

/** Canonical home anchor (HOME env override or os.homedir()). */
export function getHomeDir(): string { return HOME; }

/** Bucket root for durable runtime data (~/.agents/.history/). */
export function getHistoryDir(): string { return HISTORY_DIR; }

/** Bucket root for regenerable runtime data (~/.agents/.cache/). */
export function getCacheDir(): string { return CACHE_DIR; }

/** Path to cloned packages (~/.agents/.cache/packages/). */
export function getPackagesDir(): string { return PACKAGES_DIR; }

/** Path to routine YAML definitions (~/.agents/routines/). */
export function getRoutinesDir(): string { return ROUTINES_DIR; }

/**
 * Path to a project-scoped routines directory (`<project>/.agents/routines/`),
 * or null when no project `.agents/` is found by walking up from cwd.
 *
 * Project routines participate in `list`/`view`/`run` for inspection but are
 * NOT fired by the daemon (which runs from $HOME and only loads user routines).
 * Opt-in firing for project routines is tracked as a follow-up.
 */
export function getProjectRoutinesDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'routines');
}

/** Path to routine execution logs (~/.agents/.history/runs/). */
export function getRunsDir(): string { return RUNS_DIR; }

/** Path to installed agent CLI binaries (~/.agents/.history/versions/). */
export function getVersionsDir(): string { return VERSIONS_DIR; }

/** Path to version-switching shim scripts (~/.agents/.cache/shims/). */
export function getShimsDir(): string { return SHIMS_DIR; }

/** Path to generated per-hook caching/timing shims (~/.agents/.cache/shims/hooks/). */
export function getHookShimsDir(): string { return HOOK_SHIMS_DIR; }

/** Path to per-hook stdout cache files (~/.agents/.cache/state/hooks/). */
export function getHookCacheDir(): string { return HOOK_CACHE_DIR; }

/** Path to per-agent installed CLI binaries (~/.agents/.cache/bin/). */
export function getBinDir(): string { return BIN_DIR; }

/** Path to config backups (~/.agents/.history/backups/). */
export function getBackupsDir(): string { return BACKUPS_DIR; }

/** Path to plugin bundles (~/.agents/plugins/) — user-authored resource. */
export function getPluginsDir(): string { return PLUGINS_DIR; }

/** Path to system plugin bundles (~/.agents/.system/plugins/) — npm-shipped, read-only defaults. */
export function getSystemPluginsDir(): string { return SYSTEM_PLUGINS_DIR; }

/** Path to an extra repo's plugin bundles (~/.agents-<alias>/plugins/). */
export function getExtraPluginsDir(alias: string): string {
  return path.join(getExtraRepoDir(alias), 'plugins');
}

/** Path to a project-scoped plugins directory (<project>/.agents/plugins/), or null when none. */
export function getProjectPluginsDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'plugins');
}

/** Path to synced remote session data (~/.agents/.cache/drive/). */
export function getDriveDir(): string { return DRIVE_DIR; }

/** Path to soft-deleted resources (~/.agents/.history/trash/). */
export function getTrashDir(): string { return TRASH_DIR; }

/** Path to local session indexer storage (~/.agents/.history/sessions/). */
export function getSessionsDir(): string { return SESSIONS_DIR; }

/** Path to the session index database (~/.agents/.history/sessions.db). */
export function getSessionsDbPath(): string { return SESSIONS_DB_PATH; }

/** Path to teams config + registry (~/.agents/teams/). */
export function getTeamsDir(): string { return TEAMS_DIR; }

/** Path to teams execution history (~/.agents/.history/teams/agents/). */
export function getTeamsAgentsDir(): string { return TEAMS_AGENTS_DIR; }

/** Path to the team registry — list of named teams with timestamps. Durable runtime, per-machine. */
export function getTeamsRegistryPath(): string { return path.join(HISTORY_DIR, 'teams', 'registry.json'); }

/** Path to the device registry — SSH device profiles with platform/auth metadata. Durable runtime, per-machine (host list + addresses are NOT pulled by `agents repo push`). */
export function getDevicesRegistryPath(): string { return path.join(HISTORY_DIR, 'devices', 'registry.json'); }

/** Path to the device ignore-list — tailscale node names the user dismissed, so auto-discovery never re-suggests them. Per-machine, same dir as the registry. */
export function getDevicesIgnoredPath(): string { return path.join(HISTORY_DIR, 'devices', 'ignored.json'); }

/** Dir of "pending device" sentinels (~/.agents/.cache/state/devices-pending/) — one empty-ish file per newly-discovered, not-yet-approved tailnet node. Written by the daemon probe, read by the menu-bar helper (mirrors the attention sentinel dir). */
export function getDevicesPendingDir(): string { return path.join(RUNTIME_STATE_DIR, 'devices-pending'); }

/** Path to cloud dispatch cache (~/.agents/.cache/cloud/). */
export function getCloudDir(): string { return CLOUD_DIR; }

/** Path to terminal session metadata (~/.agents/.cache/terminals/). */
export function getTerminalsDir(): string { return TERMINALS_DIR; }

/** Path to runtime logs (~/.agents/.cache/logs/). */
export function getLogsDir(): string { return LOGS_DIR; }

/** Path to per-process runtime state (~/.agents/.cache/state/). */
export function getRuntimeStateDir(): string { return RUNTIME_STATE_DIR; }

/** Path to companion-extension scratch (~/.agents/.cache/companion/). */
export function getCompanionDir(): string { return COMPANION_CACHE_DIR; }

/** Path to browser runtime data — chrome-data, pids (~/.agents/.cache/browser/). */
export function getBrowserRuntimeDir(): string { return BROWSER_RUNTIME_DIR; }

/** Path to helper subprocess scratch (~/.agents/.cache/helpers/). */
export function getHelpersDir(): string { return HELPERS_DIR; }

/** Path to scheduler daemon scratch (~/.agents/.cache/helpers/daemon/). */
export function getDaemonDir(): string { return DAEMON_DIR; }

/** Path to PTY server scratch (~/.agents/.cache/helpers/pty/). */
export function getPtyDir(): string { return PTY_DIR; }

/** Path to tmux scratch (~/.agents/.cache/helpers/tmux/) — shared server socket + per-session meta JSONs. */
export function getTmuxDir(): string { return TMUX_DIR; }

/** Path to remote-resource auto-pull cache (~/.agents/.cache/.fetch/). */
export function getFetchCacheDir(): string { return FETCH_CACHE_DIR; }

/** Path to the CLI version cache file (~/.agents/.cache/.cli-version-cache.json). */
export function getCliVersionCachePath(): string { return CLI_VERSION_CACHE_FILE; }

/** Path to the models cache file (~/.agents/.cache/.models-cache.json). */
export function getModelsCachePath(): string { return MODELS_CACHE_FILE; }

/** Path to the daily update-check sentinel (~/.agents/.cache/.update-check). */
export function getUpdateCheckPath(): string { return UPDATE_CHECK_FILE; }

/** Path to the migration sentinel (~/.agents/.cache/.migrated). */
export function getMigratedSentinelPath(): string { return MIGRATED_SENTINEL_FILE; }

/** Path to soft-deleted version dirs (~/.agents/trash/versions/). */
export function getTrashVersionsDir(): string { return path.join(TRASH_DIR, 'versions'); }

/** Path to soft-deleted skills (~/.agents/trash/skills/). */
export function getTrashSkillsDir(): string { return path.join(TRASH_DIR, 'skills'); }

/** Path to soft-deleted commands (~/.agents/trash/commands/). */
export function getTrashCommandsDir(): string { return path.join(TRASH_DIR, 'commands'); }

/** Path to soft-deleted hooks (~/.agents/trash/hooks/). */
export function getTrashHooksDir(): string { return path.join(TRASH_DIR, 'hooks'); }

/** Path to soft-deleted plugins (~/.agents/trash/plugins/). */
export function getTrashPluginsDir(): string { return path.join(TRASH_DIR, 'plugins'); }

/** Path to soft-deleted subagents (~/.agents/trash/subagents/). */
export function getTrashSubagentsDir(): string { return path.join(TRASH_DIR, 'subagents'); }
export function getTrashWorkflowsDir(): string { return path.join(TRASH_DIR, 'workflows'); }

/**
 * Path to a single user-level extra DotAgent repo clone (~/.agents-<alias>/).
 *
 * Extra repos are user-defined config — they live as peer dirs to ~/.agents/,
 * not under the system repo. `agents repo add` clones here by default.
 */
export function getExtraRepoDir(alias: string): string {
  return path.join(HOME, `.agents-${alias}`);
}

/** Resolve the on-disk path for an extra repo, whether managed or user-owned. */
export function resolveExtraRepoDir(alias: string, config?: { path?: string }): string {
  if (config?.path) {
    return path.resolve(config.path);
  }
  return getExtraRepoDir(alias);
}

/**
 * Return enabled extra repos that exist on disk, in insertion order.
 */
export function getEnabledExtraRepos(): Array<{ alias: string; dir: string; url: string }> {
  const meta = readMeta();
  const extras = meta.extraRepos || {};
  const out: Array<{ alias: string; dir: string; url: string }> = [];
  for (const [alias, config] of Object.entries(extras)) {
    if (!config.enabled) continue;
    const dir = resolveExtraRepoDir(alias, config);
    if (!fs.existsSync(dir)) continue;
    out.push({ alias, dir, url: config.url });
  }
  return out;
}

// ─── Directory setup ───────────────────────────────────────────────────────────

/** Create both the system and user directory trees if any subdirectories are missing. */
export function ensureAgentsDir(): void {
  const opts = { recursive: true, mode: 0o700 } as const;

  // User repo — minimal scaffold (sub-dirs created on first write)
  if (!fs.existsSync(USER_AGENTS_DIR)) {
    fs.mkdirSync(USER_AGENTS_DIR, opts);
  }
  try { fs.chmodSync(USER_AGENTS_DIR, 0o700); } catch {}

  // System repo plus user-level operational state
  if (!fs.existsSync(SYSTEM_AGENTS_DIR)) {
    fs.mkdirSync(SYSTEM_AGENTS_DIR, opts);
  }
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, opts);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, opts);
  if (!fs.existsSync(PACKAGES_DIR)) fs.mkdirSync(PACKAGES_DIR, opts);
  if (!fs.existsSync(ROUTINES_DIR)) fs.mkdirSync(ROUTINES_DIR, opts);
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, opts);
  if (!fs.existsSync(VERSIONS_DIR)) fs.mkdirSync(VERSIONS_DIR, opts);
  if (!fs.existsSync(SHIMS_DIR)) fs.mkdirSync(SHIMS_DIR, opts);
  if (!fs.existsSync(SYSTEM_COMMANDS_DIR)) fs.mkdirSync(SYSTEM_COMMANDS_DIR, opts);
  if (!fs.existsSync(SYSTEM_HOOKS_DIR)) fs.mkdirSync(SYSTEM_HOOKS_DIR, opts);
  if (!fs.existsSync(SYSTEM_SKILLS_DIR)) fs.mkdirSync(SYSTEM_SKILLS_DIR, opts);
  if (!fs.existsSync(SYSTEM_RULES_DIR)) fs.mkdirSync(SYSTEM_RULES_DIR, opts);
  if (!fs.existsSync(SYSTEM_PERMISSIONS_DIR)) fs.mkdirSync(SYSTEM_PERMISSIONS_DIR, opts);
  if (!fs.existsSync(SYSTEM_SUBAGENTS_DIR)) fs.mkdirSync(SYSTEM_SUBAGENTS_DIR, opts);
  try { fs.chmodSync(SYSTEM_AGENTS_DIR, 0o700); } catch {}
}

// ─── Meta (agents.yaml) ────────────────────────────────────────────────────────

/** Return an empty Meta object used when no agents.yaml exists yet. */
export function createDefaultMeta(): Meta {
  return {};
}

let metaCache: { mtime: number; meta: Meta } | null = null;
let metaLockDepth = 0;

/** Return mtimeMs for a file path, or 0 if the file is absent or unreadable. */
function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Compute the combined cache stamp for the user + system agents.yaml files. */
function currentMetaStamp(): number {
  return safeMtimeMs(META_FILE) + safeMtimeMs(SYSTEM_META_FILE) * 1e-3;
}

/** Memoize a parsed Meta against the current file mtimes. */
function rememberMeta(meta: Meta): Meta {
  metaCache = { mtime: currentMetaStamp(), meta };
  return meta;
}

function withMetaLock<T>(fn: () => T): T {
  ensureAgentsDir();
  if (metaLockDepth > 0) {
    metaLockDepth++;
    try {
      return fn();
    } finally {
      metaLockDepth--;
    }
  }
  ensureLockTarget(META_FILE, META_HEADER + yaml.stringify(createDefaultMeta()), 0o700);
  return withFileLock(META_FILE, () => {
    metaLockDepth = 1;
    try {
      return fn();
    } finally {
      metaLockDepth = 0;
    }
  });
}

function writeMetaUnlocked(meta: Meta): void {
  const content = META_HEADER + yaml.stringify(meta);
  atomicWriteFileSync(META_FILE, content);
  metaCache = null;
}

function applyRegistrySeeds(meta: Meta): boolean {
  const seeded = new Set(meta.seededPresets || []);
  let changed = false;

  for (const [type, presets] of Object.entries(SEEDED_REGISTRIES) as Array<[RegistryType, Record<string, any>]>) {
    for (const [name, config] of Object.entries(presets)) {
      const key = `${type}.${name}`;
      if (seeded.has(key)) continue;

      if (!meta.registries) meta.registries = { mcp: {}, skill: {} };
      if (!meta.registries[type]) meta.registries[type] = {};
      if (!meta.registries[type][name]) {
        meta.registries[type][name] = { ...config };
      }
      seeded.add(key);
      changed = true;
    }
  }

  if (changed) meta.seededPresets = [...seeded];
  return changed;
}

/**
 * One-shot migration: move agents.yaml from system repo to user repo.
 * Idempotent — no-ops if user file already exists or system file absent.
 */
function migrateSystemMetaToUser(): void {
  if (fs.existsSync(META_FILE)) return;
  if (!fs.existsSync(SYSTEM_META_FILE)) return;
  try {
    if (!fs.existsSync(USER_AGENTS_DIR)) {
      fs.mkdirSync(USER_AGENTS_DIR, { recursive: true, mode: 0o700 });
    }
    fs.renameSync(SYSTEM_META_FILE, META_FILE);
    console.log('Migrated agents.yaml to ~/.agents/');
  } catch {
    // Best-effort; proceed with fresh state if it fails.
  }
}

/**
 * Read and cache ~/.agents/agents.yaml, migrating from legacy locations if needed.
 *
 * Cache invariants:
 * - Cache key is the mtime of the user agents.yaml.
 * - `writeMetaUnlocked` clears the cache; in-process callers always see fresh state.
 * - If the file is mutated by ANOTHER process while we hold a stale cache, the
 *   mtime check below catches it on the next read (assuming the mtime advanced).
 * - The cache stores the merged system+user meta; both files' mtimes contribute.
 */
export function readMeta(): Meta {
  ensureAgentsDir();

  // Fast path: serve from cache when both source files are byte-identical to
  // what we last parsed. Reduces N readMeta calls per CLI invocation to ~2 stat
  // syscalls plus an in-memory object spread.
  if (metaCache) {
    const userMtime = safeMtimeMs(META_FILE);
    const systemMtime = safeMtimeMs(SYSTEM_META_FILE);
    const stamp = userMtime + systemMtime * 1e-3;
    if (stamp === metaCache.mtime) {
      return metaCache.meta;
    }
  }

  // NOTE: agents.yaml migration from ~/.agents-system/ to ~/.agents/ is handled
  // exclusively by runMigration() in migrate.ts, called from postinstall and
  // from a one-shot bootstrap step in src/index.ts. Calling it here would
  // mutate real-user filesystem state during test runs that import this
  // module, causing cross-test pollution.

  // Legacy migration: check for old meta.yaml in system dir
  const oldMetaFile = path.join(SYSTEM_AGENTS_DIR, 'meta.yaml');
  if (fs.existsSync(oldMetaFile) && !fs.existsSync(META_FILE)) {
    try {
      const content = fs.readFileSync(oldMetaFile, 'utf-8');
      const parsed = yaml.parse(content) as any;
      const meta: Meta = {};

      if (parsed.versions) {
        meta.agents = {};
        for (const [agent, state] of Object.entries(parsed.versions)) {
          const s = state as any;
          if (s?.default) {
            (meta.agents as Record<string, string>)[agent] = s.default;
          }
        }
      }

      if (parsed.registries) {
        meta.registries = parsed.registries;
      }

      writeMeta(meta);
      try { fs.unlinkSync(oldMetaFile); } catch { /* non-critical */ }
      return rememberMeta(meta);
    } catch {
      /* meta.yaml migration failed */
    }
  }

  // Merge agents.yaml from both system and user repos. User repo wins on conflicts.
  let systemMeta: Meta | null = null;
  let userMeta: Meta | null = null;

  if (fs.existsSync(SYSTEM_META_FILE)) {
    try {
      const content = fs.readFileSync(SYSTEM_META_FILE, 'utf-8');
      systemMeta = yaml.parse(content) as Meta;
    } catch { /* ignore */ }
  }

  if (fs.existsSync(META_FILE)) {
    try {
      const content = fs.readFileSync(META_FILE, 'utf-8');
      userMeta = yaml.parse(content) as Meta;
    } catch { /* ignore */ }
  }

  if (systemMeta || userMeta) {
    // Merge: system as base, user overwrites
    const base = createDefaultMeta();
    const meta: Meta = {
      ...base,
      ...systemMeta,
      ...userMeta,
      agents: { ...systemMeta?.agents, ...userMeta?.agents },
    };
    // Merge registries carefully to preserve type
    if (systemMeta?.registries || userMeta?.registries) {
      meta.registries = {
        ...base.registries,
        ...systemMeta?.registries,
        ...userMeta?.registries,
      } as Meta['registries'];
    }

    if (applyRegistrySeeds(meta)) {
      writeMeta(meta);
      return rememberMeta(meta);
    }
    return rememberMeta(meta);
  }

  const meta = createDefaultMeta();
  if (applyRegistrySeeds(meta)) {
    writeMeta(meta);
  }
  return rememberMeta(meta);
}

/** Serialize and write agents.yaml to the user repo, invalidating the in-memory cache. */
export function writeMeta(meta: Meta): void {
  withMetaLock(() => writeMetaUnlocked(meta));
}

/** Update agents.yaml under lock and return the new state. */
export function updateMeta(updates: Partial<Meta> | ((meta: Meta) => Meta)): Meta {
  return withMetaLock(() => {
    const meta = readMeta();
    const newMeta = typeof updates === 'function'
      ? updates(meta)
      : { ...meta, ...updates };
    writeMetaUnlocked(newMeta);
    return newMeta;
  });
}

/** Derive a filesystem-safe local clone path for a package source URL. */
export function getPackageLocalPath(source: string): string {
  const sanitized = source
    .replace(/^gh:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\//g, '-');
  return path.join(PACKAGES_DIR, sanitized);
}

// ─── Version resource tracking ────────────────────────────────────────────────

import type { AgentId, ResourceType, VersionResources, ResourcePattern } from './types.js';

/**
 * @deprecated No-op. Use ensureVersionResourcePatterns instead.
 * Kept for backward compat with command files that still call it.
 */
export function recordVersionResources(
  _agent: AgentId,
  _version: string,
  _resourceType: ResourceType,
  _resources: string[]
): void {
  // intentional no-op — tracking moved to pattern-based ensureVersionResourcePatterns
}

/**
 * Write default resource selection patterns for an agent@version.
 * Only writes each field when it is not already set, preserving user customization.
 * Pass all resource types you want to initialize in one call to batch the write.
 */
export function ensureVersionResourcePatterns(
  agent: AgentId,
  version: string,
  updates: Partial<Record<Exclude<keyof VersionResources, 'rulesPreset'>, ResourcePattern[]>>
): void {
  const meta = readMeta();
  if (!meta.versions) meta.versions = {};
  if (!meta.versions[agent]) meta.versions[agent] = {};
  if (!meta.versions[agent]![version]) meta.versions[agent]![version] = {};

  const vr = meta.versions[agent]![version];
  let changed = false;
  for (const [type, patterns] of Object.entries(updates) as [Exclude<keyof VersionResources, 'rulesPreset'>, ResourcePattern[]][]) {
    if (!vr[type] || (vr[type] as ResourcePattern[]).length === 0) {
      (vr as Record<string, unknown>)[type] = patterns;
      changed = true;
    }
  }
  if (changed) writeMeta(meta);
}

/**
 * Resource types that resolve across the extra-repo layer. Mirrors
 * `defaultPatterns()`: extras feed commands/skills/hooks/subagents/plugins/
 * workflows, but never permissions (`system:*`) or mcp (`user:*`).
 */
const EXTRA_ELIGIBLE_TYPES: readonly (keyof VersionResources)[] = [
  'commands', 'skills', 'hooks', 'subagents', 'plugins', 'workflows',
];

/**
 * Insert `<alias>:*` at the canonical position (after the system/user/other-extra
 * includes, before `project:*`), unless the alias is already referenced — as an
 * include (`alias:...`) or an exclude (`!alias:...`). Returns a new array when it
 * changes, otherwise the same reference (so callers can detect no-ops cheaply).
 */
export function withAlias(list: ResourcePattern[], alias: string): ResourcePattern[] {
  const prefix = `${alias}:`;
  if (list.some(p => p === `${alias}:*` || p.startsWith(prefix) || p.startsWith(`!${prefix}`))) {
    return list;
  }
  const next = [...list];
  const projIdx = next.findIndex(p => p === 'project:*' || p.startsWith('project:'));
  if (projIdx >= 0) next.splice(projIdx, 0, `${alias}:*`);
  else next.push(`${alias}:*`);
  return next;
}

/** Strip every reference to `<alias>:...` / `!<alias>:...` from a selector list. */
export function withoutAlias(list: ResourcePattern[], alias: string): ResourcePattern[] {
  const prefix = `${alias}:`;
  const next = list.filter(p => !(p.startsWith(prefix) || p.startsWith(`!${prefix}`)));
  return next.length === list.length ? list : next;
}

/**
 * Backfill (add=true) or strip (add=false) an extra-repo alias across every
 * already-installed version's selectors. New versions get the alias via
 * `defaultPatterns()` at scaffold time; this keeps existing versions in sync
 * when an extra repo is registered/enabled or removed. Only touches selector
 * lists that are already set — an unset list is left for `defaultPatterns()`.
 * Returns the number of (agent, version) pairs changed.
 */
export function applyExtraAliasToVersions(alias: string, add: boolean): number {
  const meta = readMeta();
  if (!meta.versions) return 0;
  let changed = false;
  let count = 0;
  for (const versions of Object.values(meta.versions)) {
    if (!versions) continue;
    for (const vr of Object.values(versions)) {
      if (!vr) continue;
      let touched = false;
      for (const type of EXTRA_ELIGIBLE_TYPES) {
        const cur = (vr as Record<string, ResourcePattern[] | undefined>)[type];
        if (!Array.isArray(cur) || cur.length === 0) continue;
        const next = add ? withAlias(cur, alias) : withoutAlias(cur, alias);
        if (next !== cur) {
          (vr as Record<string, ResourcePattern[]>)[type] = next;
          touched = true;
          changed = true;
        }
      }
      if (touched) count++;
    }
  }
  if (changed) writeMeta(meta);
  return count;
}

export function getVersionResources(
  agent: AgentId,
  version: string
): VersionResources | null {
  const meta = readMeta();
  return meta.versions?.[agent]?.[version] || null;
}

/** Active rules preset for an agent@version. Defaults to "default" when unset. */
export function getActiveRulesPreset(agent: AgentId, version: string): string {
  const meta = readMeta();
  return meta.versions?.[agent]?.[version]?.rulesPreset || 'default';
}

/** Persist the active rules preset for an agent@version. */
export function setActiveRulesPreset(
  agent: AgentId,
  version: string,
  preset: string
): void {
  const meta = readMeta();
  if (!meta.versions) meta.versions = {};
  if (!meta.versions[agent]) meta.versions[agent] = {};
  if (!meta.versions[agent]![version]) meta.versions[agent]![version] = {};
  meta.versions[agent]![version].rulesPreset = preset;
  writeMeta(meta);
}
