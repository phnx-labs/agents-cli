/**
 * Filesystem layout and persistent state for agents-cli.
 *
 * Two roots:
 *  - ~/.agents-system/ — system repo (npm-shipped resources, versions, shims, backups, runs)
 *  - ~/.agents/        — user repo  (user-authored commands, skills, hooks, rules, mcp,
 *                                    permissions, subagents, profiles, secrets, agents.yaml)
 *
 * Resolution precedence for resources: project > user > system.
 * Every module that needs a path or reads/writes agents.yaml goes through here.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import type { Meta, RegistryType } from './types.js';
import { SEEDED_REGISTRIES } from './types.js';

const HOME = os.homedir();

// ─── Root directories ─────────────────────────────────────────────────────────

/** System repo — npm-shipped, read-only from user commands. */
const SYSTEM_AGENTS_DIR = path.join(HOME, '.agents-system');

/** User repo — user-authored resources and agents.yaml. Always-on. */
const USER_AGENTS_DIR = path.join(HOME, '.agents');

// ─── Meta file (agents.yaml lives in the user repo) ──────────────────────────

const META_FILE = path.join(USER_AGENTS_DIR, 'agents.yaml');
/** Legacy location — used only for one-shot migration in readMeta(). */
const SYSTEM_META_FILE = path.join(SYSTEM_AGENTS_DIR, 'agents.yaml');

// ─── System resource dirs ─────────────────────────────────────────────────────

const SYSTEM_COMMANDS_DIR = path.join(SYSTEM_AGENTS_DIR, 'commands');
const SYSTEM_HOOKS_DIR = path.join(SYSTEM_AGENTS_DIR, 'hooks');
const SYSTEM_SKILLS_DIR = path.join(SYSTEM_AGENTS_DIR, 'skills');
const SYSTEM_RULES_DIR = path.join(SYSTEM_AGENTS_DIR, 'rules');
const SYSTEM_LEGACY_MEMORY_DIR = path.join(SYSTEM_AGENTS_DIR, 'memory');
const SYSTEM_MCP_DIR = path.join(SYSTEM_AGENTS_DIR, 'mcp');
const SYSTEM_PERMISSIONS_DIR = path.join(SYSTEM_AGENTS_DIR, 'permissions');
const SYSTEM_SUBAGENTS_DIR = path.join(SYSTEM_AGENTS_DIR, 'subagents');
const SYSTEM_PROMPTCUTS_FILE = path.join(SYSTEM_AGENTS_DIR, 'hooks', 'promptcuts.yaml');
const SYSTEM_MCP_CONFIG_FILE = path.join(SYSTEM_AGENTS_DIR, 'mcp.json');
const SYSTEM_INSTRUCTIONS_FILE = path.join(SYSTEM_AGENTS_DIR, 'instructions.md');

// System-only paths (never duplicated in user repo)
const PACKAGES_DIR = path.join(SYSTEM_AGENTS_DIR, 'packages');
const ROUTINES_DIR = path.join(SYSTEM_AGENTS_DIR, 'routines');
const RUNS_DIR = path.join(SYSTEM_AGENTS_DIR, 'runs');
const VERSIONS_DIR = path.join(SYSTEM_AGENTS_DIR, 'versions');
const SHIMS_DIR = path.join(SYSTEM_AGENTS_DIR, 'shims');
const BACKUPS_DIR = path.join(SYSTEM_AGENTS_DIR, 'backups');
const PLUGINS_DIR = path.join(SYSTEM_AGENTS_DIR, 'plugins');
const DRIVE_DIR = path.join(SYSTEM_AGENTS_DIR, 'drive');

// ─── User resource dirs ───────────────────────────────────────────────────────

const USER_COMMANDS_DIR = path.join(USER_AGENTS_DIR, 'commands');
const USER_HOOKS_DIR = path.join(USER_AGENTS_DIR, 'hooks');
const USER_SKILLS_DIR = path.join(USER_AGENTS_DIR, 'skills');
const USER_RULES_DIR = path.join(USER_AGENTS_DIR, 'rules');
const USER_MCP_DIR = path.join(USER_AGENTS_DIR, 'mcp');
const USER_PERMISSIONS_DIR = path.join(USER_AGENTS_DIR, 'permissions');
const USER_SUBAGENTS_DIR = path.join(USER_AGENTS_DIR, 'subagents');
const USER_SECRETS_DIR = path.join(USER_AGENTS_DIR, 'secrets');
const USER_PROMPTCUTS_FILE = path.join(USER_AGENTS_DIR, 'hooks', 'promptcuts.yaml');

const META_HEADER = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agents-cli

`;

// ─── Root getters ─────────────────────────────────────────────────────────────

/** Root of the system data directory (~/.agents-system/). Legacy alias — prefer getSystemAgentsDir(). */
export function getAgentsDir(): string {
  return SYSTEM_AGENTS_DIR;
}

/** Root of the system data directory (~/.agents-system/). */
export function getSystemAgentsDir(): string {
  return SYSTEM_AGENTS_DIR;
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
      if (agentsPath !== SYSTEM_AGENTS_DIR && agentsPath !== USER_AGENTS_DIR) {
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

/** Back-compat export; resolves to system rules dir. */
export function getMemoryDir(): string { return SYSTEM_RULES_DIR; }

let legacyMemoryWarned = false;

/**
 * Read-side resolution for the canonical rules dir.
 *
 * Returns SYSTEM_RULES_DIR normally. Falls back to the legacy
 * SYSTEM_LEGACY_MEMORY_DIR (~/.agents-system/memory/) only when the upstream
 * still uses the old layout and the user hasn't pulled the rename yet —
 * detected by absence of rules/AGENTS.md and presence of memory/AGENTS.md.
 *
 * Prints a single warning per process the first time the fallback fires.
 * Per the read-only system-repo invariant, this never moves files; the rename
 * is applied when the user pulls upstream.
 */
export function getResolvedRulesDir(): string {
  const rulesAgents = path.join(SYSTEM_RULES_DIR, 'AGENTS.md');
  const legacyAgents = path.join(SYSTEM_LEGACY_MEMORY_DIR, 'AGENTS.md');
  if (fs.existsSync(rulesAgents)) return SYSTEM_RULES_DIR;
  if (fs.existsSync(legacyAgents)) {
    if (!legacyMemoryWarned) {
      legacyMemoryWarned = true;
      process.stderr.write(
        'agents-cli: Legacy memory/ directory detected — agents-cli still works, ' +
          "but run 'agents repo pull system' to migrate to rules/.\n",
      );
    }
    return SYSTEM_LEGACY_MEMORY_DIR;
  }
  return SYSTEM_RULES_DIR;
}

/** Path to MCP server YAML configs — system repo. */
export function getMcpDir(): string { return SYSTEM_MCP_DIR; }

/** Path to permission group YAML files — system repo. */
export function getPermissionsDir(): string { return SYSTEM_PERMISSIONS_DIR; }

/** Path to subagent definition directories — system repo. */
export function getSubagentsDir(): string { return SYSTEM_SUBAGENTS_DIR; }

/** Path to ~/.agents-system/promptcuts.yaml. */
export function getPromptcutsPath(): string { return SYSTEM_PROMPTCUTS_FILE; }

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
export function getUserSecretsDir(): string { return USER_SECRETS_DIR; }
export function getUserPromptcutsPath(): string { return USER_PROMPTCUTS_FILE; }

// ─── System-only path getters ─────────────────────────────────────────────────

/** Path to cloned packages (~/.agents-system/packages/). */
export function getPackagesDir(): string { return PACKAGES_DIR; }

/** Path to routine YAML definitions (~/.agents-system/routines/). */
export function getRoutinesDir(): string { return ROUTINES_DIR; }

/** Path to routine execution logs (~/.agents-system/runs/). */
export function getRunsDir(): string { return RUNS_DIR; }

/** Path to installed agent CLI binaries (~/.agents-system/versions/). */
export function getVersionsDir(): string { return VERSIONS_DIR; }

/** Path to version-switching shim scripts (~/.agents-system/shims/). */
export function getShimsDir(): string { return SHIMS_DIR; }

/** Path to config backups (~/.agents-system/backups/). */
export function getBackupsDir(): string { return BACKUPS_DIR; }

/** Path to plugin bundles (~/.agents-system/plugins/). */
export function getPluginsDir(): string { return PLUGINS_DIR; }

/** Path to synced remote session data (~/.agents-system/drive/). */
export function getDriveDir(): string { return DRIVE_DIR; }

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

  // System repo
  if (!fs.existsSync(SYSTEM_AGENTS_DIR)) {
    fs.mkdirSync(SYSTEM_AGENTS_DIR, opts);
  }
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
  if (!fs.existsSync(DRIVE_DIR)) fs.mkdirSync(DRIVE_DIR, opts);
  try { fs.chmodSync(SYSTEM_AGENTS_DIR, 0o700); } catch {}
}

// ─── Meta (agents.yaml) ────────────────────────────────────────────────────────

/** Return an empty Meta object used when no agents.yaml exists yet. */
export function createDefaultMeta(): Meta {
  return {};
}

let metaCache: { mtime: number; meta: Meta } | null = null;

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

/** Read and cache ~/.agents/agents.yaml, migrating from legacy locations if needed. */
export function readMeta(): Meta {
  ensureAgentsDir();

  // NOTE: agents.yaml migration from ~/.agents-system/ to ~/.agents/ is handled
  // exclusively by runMigration() in migrate.ts, called from postinstall and
  // explicit command-time fallbacks (agents view/use/pull). Calling it here
  // would mutate real-user filesystem state during test runs that import this
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
      return meta;
    } catch {
      /* meta.yaml migration failed */
    }
  }

  if (fs.existsSync(META_FILE)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(META_FILE).mtimeMs;
    } catch { /* file vanished */ }

    if (metaCache && metaCache.mtime === mtime) {
      return metaCache.meta;
    }

    try {
      const content = fs.readFileSync(META_FILE, 'utf-8');
      const parsed = yaml.parse(content) as Meta;
      const meta = parsed || createDefaultMeta();
      if (applyRegistrySeeds(meta)) {
        writeMeta(meta);
        return meta;
      }
      metaCache = { mtime, meta };
      return meta;
    } catch {
      return createDefaultMeta();
    }
  }

  const meta = createDefaultMeta();
  if (applyRegistrySeeds(meta)) {
    writeMeta(meta);
  }
  return meta;
}

/** Serialize and write agents.yaml to the user repo, invalidating the in-memory cache. */
export function writeMeta(meta: Meta): void {
  ensureAgentsDir();
  const content = META_HEADER + yaml.stringify(meta);
  fs.writeFileSync(META_FILE, content, 'utf-8');
  metaCache = null;
}

/** Shallow-merge updates into agents.yaml and return the new state. */
export function updateMeta(updates: Partial<Meta>): Meta {
  const meta = readMeta();
  const newMeta = { ...meta, ...updates };
  writeMeta(newMeta);
  return newMeta;
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

import type { AgentId, ResourceType, VersionResources } from './types.js';

export function recordVersionResources(
  agent: AgentId,
  version: string,
  resourceType: ResourceType,
  resources: string[]
): void {
  if (resources.length === 0) return;

  const meta = readMeta();
  if (!meta.versions) meta.versions = {};
  if (!meta.versions[agent]) meta.versions[agent] = {};
  if (!meta.versions[agent]![version]) meta.versions[agent]![version] = {};

  const existing = meta.versions[agent]![version][resourceType] || [];
  const merged = [...new Set([...existing, ...resources])];
  meta.versions[agent]![version][resourceType] = merged;

  writeMeta(meta);
}

export function getVersionResources(
  agent: AgentId,
  version: string
): VersionResources | null {
  const meta = readMeta();
  return meta.versions?.[agent]?.[version] || null;
}

export function clearVersionResources(
  agent: AgentId,
  version: string
): void {
  const meta = readMeta();
  if (meta.versions?.[agent]?.[version]) {
    delete meta.versions[agent]![version];
    if (Object.keys(meta.versions[agent]!).length === 0) {
      delete meta.versions[agent];
    }
    if (Object.keys(meta.versions).length === 0) {
      delete meta.versions;
    }
    writeMeta(meta);
  }
}
