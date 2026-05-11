/**
 * Core type definitions for agents-cli.
 *
 * Every data structure that flows between modules lives here: agent identity,
 * configuration schemas, resource tracking, registry types, and permission
 * formats for each supported agent.
 */

/** Unique identifier for a supported AI coding agent. */
export type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'openclaw' | 'copilot' | 'amp' | 'kiro' | 'goose' | 'roo';

/** How `agents run <agent>` chooses an installed version when none is pinned. */
export type RunStrategy = 'pinned' | 'available' | 'balanced';

/** Preview features that users can opt into via `agents beta`. */
export type BetaFeatureName = 'drive' | 'factory';

/** Subset of chalk color names used for agent-specific terminal output. */
export type ChalkColor = 'magenta' | 'green' | 'blue' | 'cyan' | 'yellowBright' | 'redBright' | 'whiteBright' | 'blueBright' | 'greenBright' | 'magentaBright' | 'cyanBright';

/** Static configuration for a single agent -- paths, capabilities, and format conventions. */
export interface AgentConfig {
  id: AgentId;
  name: string;
  color: ChalkColor;
  cliCommand: string;
  npmPackage: string;
  installScript?: string;
  configDir: string;
  homeFiles?: string[]; // Files at $HOME level that need per-version symlink switching (e.g., '.claude.json')
  commandsDir: string;
  commandsSubdir: string;
  skillsDir: string;
  hooksDir: string;
  instructionsFile: string;
  format: 'markdown' | 'toml';
  variableSyntax: string;
  supportsHooks: boolean;
  nativeAgentsSkillsDir?: boolean;
  capabilities: {
    hooks: Capability;
    mcp: Capability;
    allowlist: Capability;
    skills: Capability;
    commands: Capability;
    plugins: Capability;
    /**
     * Whether the agent natively resolves `@path/to/file` imports inside its
     * rules file at session start. If false, agents-cli must pre-compile the
     * rules file (inline all @-imports) when syncing it into the version home.
     */
    rulesImports?: boolean;
  };
}

/**
 * A capability flag for an agent feature. `true` means supported on every
 * installed version; `false` means never supported. The object form gates by
 * semver: `since` is the minimum version that ships the feature, `until` is
 * exclusive upper bound (set when a feature is removed in a later release).
 */
export type Capability = boolean | { since?: string; until?: string };

/** Names of every gateable capability on AgentConfig. */
export type CapabilityName = 'hooks' | 'mcp' | 'allowlist' | 'skills' | 'commands' | 'plugins';

/** Reason a capability check failed. */
export type CapabilityFailReason = 'unsupported' | 'too_old' | 'too_new';

/** Result of `supports(agent, cap, version?)`. */
export type CapabilityResult =
  | { ok: true }
  | { ok: false; reason: CapabilityFailReason; need?: string };

/** Configuration for a single MCP server as stored in ~/.agents/mcp/. */
export interface McpServerConfig {
  command?: string;
  url?: string;
  transport: 'stdio' | 'http' | 'sse';
  scope: 'user' | 'project';
  agents?: AgentId[];
  agentVersions?: Partial<Record<AgentId, string[]>>;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** User-facing hook definition (name + script path). */
export interface HookConfig {
  name: string;
  script: string;
  dataFile?: string;
}

/**
 * Predicate set for declaring when a hook should fire within its declared event.
 * All predicates AND together. Empty/missing matches: hook always fires.
 */
export interface HookMatches {
  prompt_contains?: string;          // substring of user prompt
  prompt_matches?: string;           // regex applied to user prompt
  tool_name?: string | string[];     // PreToolUse / PostToolUse only
  tool_args_match?: string;          // regex on serialized tool args
  git_dirty?: boolean;               // working tree has changes
  cwd_includes?: string | string[];  // cwd contains any of these substrings
  project_has?: string;              // project root contains this file
}

/** Hook entry as declared in a package manifest (agents.yaml). */
export interface ManifestHook {
  script: string;
  events: string[];
  timeout?: number;
  matcher?: string;
  /** @deprecated Use the agent capability table; field is ignored. */
  agents?: AgentId[];
  /** Set to false in user hooks.yaml to disable a system-shipped hook. */
  enabled?: boolean;
  /** Optional pre-filter predicates evaluated before invoking the script. */
  matches?: HookMatches;
}

/** Lightweight hook descriptor used in resource listings. */
export interface HookResourceEntry {
  name: string;
  events: string[];
  timeout?: number;
  matcher?: string;
}

/** A hook that has been synced into a specific agent version's config. */
export interface InstalledHook {
  name: string;
  path: string;
  dataFile?: string;
  scope: 'user' | 'project';
  agent: AgentId;
}

/** Package manifest (agents.yaml) found inside a cloned config repo or package. */
export interface Manifest {
  agents?: Partial<Record<AgentId, string>>;
  run?: Partial<Record<AgentId, { strategy?: RunStrategy }>>;
  beta?: {
    enabled?: BetaFeatureName[];
  };
  dependencies?: Record<string, string>;
  mcp?: Record<string, McpServerConfig>;
  defaults?: {
    method?: 'symlink' | 'copy';
    scope?: 'global' | 'project';
    agents?: AgentId[];
  };
}

/** Record of how a slash command was installed into an agent version. */
export interface CommandInstallation {
  path: string;
  method: 'symlink' | 'copy';
}

/** Metadata parsed from a SKILL.md frontmatter block. */
export interface SkillMetadata {
  name: string;
  description: string;
  author?: string;
  version?: string;
  license?: string;
  keywords?: string[];
}

/** Record of how a skill was installed into an agent version. */
export interface SkillInstallation {
  path: string;
  method: 'symlink' | 'copy';
}

/** Tracked state for a skill across all agent versions it's been synced to. */
export interface SkillState {
  source: string;
  ruleCount: number;
  installations: Partial<Record<AgentId, SkillInstallation>>;
}

/** A skill that has been synced into a specific agent version's config. */
export interface InstalledSkill {
  name: string;
  path: string;
  metadata: SkillMetadata;
  ruleCount: number;
  scope: 'user' | 'project';
  agent: AgentId;
}

/** Git remote metadata for the ~/.agents-system/ config repository. */
export interface RepoInfo {
  source: string;
  branch: string;
  commit: string;
  lastSync: string;
}

/** Canonical system repo cloned into ~/.agents-system/. */
export const DEFAULT_SYSTEM_REPO = 'gh:phnx-labs/.agents-system';
/** Legacy system repo — kept so existing installs still recognize their origin. */
export const MIRROR_SYSTEM_REPO = 'gh:muqsitnawaz/.agents-system';

/** Strip the `gh:` prefix and `.git` suffix to get a GitHub `owner/repo` slug. */
export function systemRepoSlug(repo: string = DEFAULT_SYSTEM_REPO): string {
  return repo.replace(/^gh:/, '').replace(/\.git$/, '');
}

/** Kind of package that can be searched and installed from a registry. */
export type RegistryType = 'mcp' | 'skill';

/** Connection details for a single package registry endpoint. */
export interface RegistryConfig {
  url: string;
  enabled: boolean;
  apiKey?: string;
}

/** Built-in registry endpoints shipped with agents-cli. */
export const DEFAULT_REGISTRIES: Record<RegistryType, Record<string, RegistryConfig>> = {
  mcp: {
    official: {
      url: 'https://registry.modelcontextprotocol.io/v0',
      enabled: true,
    },
  },
  skill: {},
};

/**
 * Registries that ship pre-seeded into new users' agents.yaml once, but are
 * not "defaults" — after seeding they behave like any user-added registry
 * (listable, disable-able, removable, and gone for good once removed).
 */
export const SEEDED_REGISTRIES: Record<RegistryType, Record<string, RegistryConfig>> = {
  mcp: {},
  skill: {
    // Hermes Agent (Nous Research) — flat JSON index of 1800+ skills aggregated
    // from official, github, lobehub, skills.sh, and claude-marketplace. No auth.
    hermes: {
      url: 'https://hermes-agent.nousresearch.com/docs/api/skills-index.json',
      enabled: true,
    },
  },
};

/** A single installable package within an MCP server entry. */
export interface McpPackage {
  registry_name: string;
  name: string;
  description?: string;
  runtime?: 'node' | 'python' | 'docker' | 'binary';
  transport?: 'stdio' | 'sse' | 'streamable-http';
  packageArguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** A server listing returned by the MCP registry API. */
export interface McpServerEntry {
  name: string;
  description?: string;
  repository?: {
    url: string;
    source?: string;
    directory?: string;
  };
  version_detail?: {
    version: string;
  };
  packages?: McpPackage[];
  _meta?: Record<string, unknown>;
}

/** Paginated response from the MCP registry search endpoint. */
export interface McpRegistryResponse {
  servers: Array<{ server: McpServerEntry }>;
  metadata?: {
    count: number;
    next_cursor?: string;
  };
}

/** A skill listing returned by a skill registry API. */
export interface SkillEntry {
  name: string;
  description?: string;
  /** Upstream catalog (e.g. 'official', 'github', 'lobehub', 'skills.sh'). */
  source: string;
  /** Stable unique id used by the registry (e.g. 'official/security/1password'). */
  identifier?: string;
  /** Origin repo in 'owner/repo' form. Empty for registry-hosted catalogs. */
  repo?: string;
  path?: string;
  author?: string;
  installs?: number;
  tags?: string[];
  /** Registry-specific trust signal (e.g. 'builtin', 'trusted', 'community'). */
  trustLevel?: string;
}

/** Paginated response from a skill registry search endpoint. */
export interface SkillRegistryResponse {
  skills: SkillEntry[];
  metadata?: {
    count: number;
    next_cursor?: string;
  };
}

/** Provider-agnostic search result that merges MCP and skill registries. */
export interface RegistrySearchResult {
  name: string;
  description?: string;
  type: 'mcp' | 'skill';
  source: string;
  registry: string;
  version?: string;
  installs?: number;
}

/** A package that has been resolved from a registry and is ready to install. */
export interface ResolvedPackage {
  type: 'mcp' | 'skill' | 'git';
  source: string;
  mcpEntry?: McpServerEntry;
  skillEntry?: SkillEntry;
}

/** Categories of resources that can be synced into an agent version home. */
export type ResourceType = 'commands' | 'skills' | 'hooks' | 'memory' | 'mcp' | 'permissions' | 'subagents' | 'plugins' | 'workflows';

/**
 * A resource selection pattern stored in agents.yaml versions:
 *   "system:*"      — all resources from ~/.agents-system/
 *   "user:*"        — all resources from ~/.agents/
 *   "rush:*"        — all resources from ~/.agents-rush/  (extra repo alias)
 *   "project:*"     — all resources from .agents/ in the project root
 *   "user:foo"      — specifically "foo" from ~/.agents/
 *   "!user:temp"    — exclude "temp" from the user repo
 */
export type ResourcePattern = string;

/** Sync specification for a specific agent@version, keyed by resource type. */
export interface VersionResources {
  /**
   * Active rule preset. Absent/null means "default".
   */
  rulesPreset?: string;
  skills?:      ResourcePattern[];
  commands?:    ResourcePattern[];
  hooks?:       ResourcePattern[];
  subagents?:   ResourcePattern[];
  plugins?:     ResourcePattern[];
  workflows?:   ResourcePattern[];
  permissions?: ResourcePattern[];
  mcp?:         ResourcePattern[];
}

/** Manifest file (plugin.yaml) at the root of a plugin bundle. */
export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  agents?: AgentId[];
}

/** A plugin found on disk with its parsed manifest and resource inventory. */
export interface DiscoveredPlugin {
  name: string;
  root: string;
  manifest: PluginManifest;
  skills: string[];
  hooks: string[];
  scripts: string[];
}

/** Frontmatter fields parsed from a subagent's agent.md file. */
export interface SubagentFrontmatter {
  name: string;
  description: string;
  model?: string;
  color?: string;
}

/** A subagent definition found in ~/.agents/subagents/. */
export interface DiscoveredSubagent {
  name: string;
  path: string;
  files: string[];
  agentMd: string;
  frontmatter: SubagentFrontmatter;
}

/** A subagent that has been synced into a specific agent version's config. */
export interface InstalledSubagent {
  name: string;
  path: string;
  files: string[];
  frontmatter: SubagentFrontmatter;
}

/**
 * Extra DotAgent repo registered as user-level config alongside ~/.agents/.
 * Managed clones default to ~/.agents-<alias>/ as peer dirs; user-owned repos
 * may live anywhere on disk via the `path` field. ~/.agents/ wins on name
 * collisions; extras are searched in insertion order after the user repo.
 */
export interface ExtraRepoConfig {
  url: string;
  path?: string;
  enabled: boolean;
}

/** Top-level structure of ~/.agents-system/agents.yaml -- the CLI's persistent state. */
export interface Meta {
  agents?: Partial<Record<AgentId, string>>;
  run?: Partial<Record<AgentId, { strategy?: RunStrategy }>>;
  beta?: {
    enabled?: BetaFeatureName[];
  };
  registries?: Record<RegistryType, Record<string, RegistryConfig>>;
  // Per-version resource tracking
  versions?: Partial<Record<AgentId, Record<string, VersionResources>>>;
  // Git remote source URL (when ~/.agents-system/ is a git repo)
  source?: string;
  /**
   * Extra DotAgent repos merged after ~/.agents/. Managed clones live as peer
   * dirs at ~/.agents-<alias>/; user-owned repos can point at arbitrary paths
   * via the `path` field.
   */
  extraRepos?: Record<string, ExtraRepoConfig>;
  /**
   * Keys like `skill.hermes` — registries seeded from SEEDED_REGISTRIES exactly
   * once. Tracked so a user `registry remove` won't silently re-seed.
   */
  seededPresets?: string[];
  /**
   * Hook manifest entries keyed by hook name. Folded into agents.yaml so the
   * user has a single file to sync. Each entry shape matches ManifestHook
   * (script, events, timeout, matches, enabled).
   */
  hooks?: Record<string, ManifestHook>;
  /**
   * Browser profile definitions keyed by profile name. Portable user config
   * that syncs with `agents repo push/pull`. Runtime state (chrome-data, pids)
   * lives separately in ~/.agents/.cache/browser/<profile>/.
   */
  browser?: Record<string, BrowserProfileConfig>;
}

/** Browser profile definition stored in agents.yaml. */
export interface BrowserProfileConfig {
  description?: string;
  browser: 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'custom';
  binary?: string;
  electron?: boolean;
  endpoints: string[];
  chrome?: {
    headless?: boolean;
    args?: string[];
  };
  secrets?: string;
  viewport?: { width: number; height: number };
}

/** Options controlling which agents and resources are synced during `agents pull` / `agents use`. */
export interface SyncOptions {
  agents?: AgentId[];
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  skipClis?: boolean;
  skipMcp?: boolean;
}

/** Agent-agnostic permission set (canonical format matches Claude's syntax). */
export interface PermissionSet {
  name: string;
  description?: string;
  allow: string[];
  deny?: string[];
  additionalDirectories?: string[];
}

/** A permission set that has been applied to a specific agent version. */
export interface InstalledPermission {
  name: string;
  path: string;
  set: PermissionSet;
}

/** Claude's native settings.json permission format. */
export interface ClaudePermissions {
  permissions: {
    allow: string[];
    deny: string[];
    additionalDirectories?: string[];
  };
}

/** OpenCode's native permission format (per-command allow/deny/ask). */
export interface OpenCodePermissions {
  permission: {
    bash: Record<string, 'allow' | 'deny' | 'ask'>;
  };
}

/** Codex's native permission format (approval policy + sandbox mode). */
export interface CodexPermissions {
  approval_policy?: 'on-request' | 'on-failure' | 'never';
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  sandbox_workspace_write?: {
    network_access?: boolean;
    writable_roots?: string[];
  };
}
