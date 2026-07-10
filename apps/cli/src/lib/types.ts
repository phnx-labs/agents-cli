/**
 * Core type definitions for agents-cli.
 *
 * Every data structure that flows between modules lives here: agent identity,
 * configuration schemas, resource tracking, registry types, and permission
 * formats for each supported agent.
 */

import type { CloudProviderId } from './cloud/types.js';

/** Unique identifier for a supported AI coding agent. */
export type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'openclaw' | 'copilot' | 'amp' | 'kiro' | 'goose' | 'antigravity' | 'grok' | 'kimi' | 'droid';

/** How `agents run <agent>` chooses an installed version when none is pinned. */
export type RunStrategy = 'pinned' | 'available' | 'balanced';

/** Per-agent run strategy config. */
export interface AgentRunConfig {
  strategy?: RunStrategy;
}

/** Default launch options applied by `agents run` when flags are omitted. */
export interface RunDefaults {
  mode?: Mode;
  model?: string;
}

/** `run:` section in agents.yaml. Agent keys keep strategy; `defaults` stores selector rules. */
export type RunConfig = Partial<Record<AgentId, AgentRunConfig>> & {
  defaults?: Record<string, RunDefaults>;
};

/**
 * What to do when a configured budget cap would be exceeded (issue #346).
 * `block` refuses to launch (or kills a running child) and exits non-zero so
 * CI/headless/teams/cloud all inherit the decision. `warn` prints the overrun
 * but proceeds — useful for soft rollout / observability-only.
 */
export type BudgetOnExceed = 'block' | 'warn';

/**
 * `budget:` block in agents.yaml — cross-vendor spend guardrails (issue #346).
 *
 * Resolution is project > user (same precedence as `run:`); see
 * `resolveBudgetConfig` in lib/budget/config.ts. Every cap is in USD. A cap is
 * "unset" when undefined — only set caps are enforced. `per_agent` caps apply
 * to one agent's spend; the top-level caps (`per_run`, `per_day`,
 * `per_project`) aggregate ACROSS every vendor the CLI dispatches, which is the
 * cross-vendor property no single-vendor control has.
 */
export interface BudgetConfig {
  /** Display currency. Only "USD" is priced today; carried for forward-compat. */
  currency?: string;
  /** Hard cap on the estimated/actual cost of a single run. */
  per_run?: number;
  /** Hard cap on total spend attributed to the current day (local date). */
  per_day?: number;
  /** Per-agent daily caps, keyed by agent id (e.g. { claude: 30, codex: 20 }). */
  per_agent?: Partial<Record<AgentId, number>>;
  /** Hard cap on cumulative spend attributed to the current project. */
  per_project?: number;
  /** block (refuse/kill) or warn (proceed). Defaults to block. */
  on_exceed?: BudgetOnExceed;
  /**
   * Interactive confirm threshold (USD). When a run's pre-flight estimate is at
   * or above this, prompt before launching (unless --yes). Does NOT gate a hard
   * block — a cap breach always blocks regardless of this value.
   */
  require_confirm_over?: number;
}

/** Preview features that users can opt into via `agents beta`. */
export type BetaFeatureName = 'drive' | 'factory' | 'session-sync';

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
  authFiles?: string[]; // Credential files inside configDir (relative to it) that must be carried across version-homes on switch so sign-in survives version changes (e.g., droid 'auth.v2.file'). Account-global, not version-specific.
  commandsDir: string;
  commandsSubdir: string;
  skillsDir: string;
  /**
   * Agent resolves slash-commands through its own runtime (e.g. openclaw's
   * Gateway), so agents-cli commands must NOT be converted into skills for it.
   * Skills-capable agents WITHOUT a native command-file dir convert commands to
   * skills by default; set this to opt such an agent out of that conversion.
   */
  nativeCommandRuntime?: boolean;
  hooksDir: string;
  /**
   * Directory (relative to a plugin's install dir) the agent reads its plugin
   * manifest from, when it differs from the canonical `.claude-plugin/`. Codex
   * uses `.codex-plugin`, Droid `.factory-plugin`. Set to `.` when the agent
   * reads the manifest from the plugin ROOT (Copilot). syncPluginToVersion
   * mirrors `.claude-plugin/plugin.json` into this dir.
   */
  pluginManifestDir?: string;
  instructionsFile: string;
  format: 'markdown' | 'toml';
  variableSyntax: string;
  supportsHooks: boolean;
  nativeAgentsSkillsDir?: boolean;
  /**
   * This agent's *own* cloud backend. `agents cloud run --agent <id>` routes
   * here when no `--provider` is given (precedence: --provider > this >
   * cloud.default_provider > rush). Undefined means the agent has no native
   * cloud and falls back to the configured default.
   */
  cloudProvider?: CloudProviderId;
  /**
   * Set when the upstream vendor has retired this agent's CLI. Presence marks
   * the agent deprecated (it is never blocked from use); `warnAgentDeprecated`
   * surfaces this in yellow whenever a user installs the agent or adds it to a
   * team. Point `replacement` at the successor agent so the warning can suggest
   * a migration path.
   */
  deprecated?: {
    /** Vendor that retired it, e.g. "Google". */
    by: string;
    /** Human date it stopped working / was retired, e.g. "June 18, 2026". */
    date: string;
    /** One-line explanation shown under the warning header. */
    reason: string;
    /** Successor agent id to suggest instead (e.g. 'antigravity'). */
    replacement?: AgentId;
    /** Announcement URL for the deprecation. */
    url?: string;
  };
  capabilities: {
    hooks: Capability;
    mcp: Capability;
    /**
     * Whether `mcp add --transport http` is supported. Only true for agents
     * whose CLI accepts an HTTP-transport MCP server registration; false for
     * agents that only accept stdio (registerMcp skips HTTP registration with
     * a clear reason).
     */
    mcpHttp: Capability;
    /**
     * Whether HTTP-MCP registration accepts `--header` args. Independent of
     * `mcpHttp`: only Claude's CLI takes headers today; Codex/Gemini accept
     * HTTP MCP but reject header args.
     */
    mcpHeaders: Capability;
    allowlist: Capability;
    skills: Capability;
    commands: Capability;
    plugins: Capability;
    subagents: Capability;
    rules: RulesCapability;
    workflows: Capability;
    /**
     * Permission modes this agent natively supports. Modes outside this set
     * are gated by buildExecCommand: `auto` silently degrades to `edit`,
     * `skip` errors with a clear message naming the supported modes.
     */
    modes: Mode[];
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

/** Rules sync writes one composed instructions file per supported agent. */
export type RulesCapability = false | { file: string };

/** Names of every gateable capability on AgentConfig. */
export type CapabilityName = 'hooks' | 'mcp' | 'mcpHttp' | 'mcpHeaders' | 'allowlist' | 'skills' | 'commands' | 'plugins' | 'subagents' | 'rules' | 'workflows';

/**
 * Permission modes controlling agent autonomy.
 *   plan  read-only investigation; no writes, no shell side-effects
 *   edit  may edit files; prompts for shell/risky operations
 *   auto  smart classifier auto-approves safe operations, prompts for risky ones
 *   skip  bypasses every permission prompt (dangerously-skip-permissions)
 *
 * `full` is accepted as a permanent silent alias for `skip` via normalizeMode().
 * Per-agent support is declared on AgentConfig.capabilities.modes.
 */
export type Mode = 'plan' | 'edit' | 'auto' | 'skip';

/** Every canonical mode in declaration order. Useful for iteration / validation. */
export const ALL_MODES: readonly Mode[] = ['plan', 'edit', 'auto', 'skip'] as const;

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

/**
 * Cache scoping. Determines which cache file a hook invocation reads/writes:
 *  - `global`      one file per hook, shared across cwds/sessions. Right for
 *                  SessionStart hooks pulling org-wide context (Linear sprint).
 *  - `per-cwd`     keyed on the working directory the hook fires from.
 *  - `per-session` keyed on the agent's session_id (read from stdin JSON).
 *  - `per-project` keyed on the nearest git repo root above cwd.
 */
export type HookCacheKey = 'global' | 'per-cwd' | 'per-session' | 'per-project';

/** Prefetch strategy when the cache is stale. */
export type HookCachePrefetch = 'none' | 'background';

/**
 * Full hook cache config. Authors usually use the shorthand string form
 * (`HookCache`) below. Shorthand examples in hooks.yaml:
 *
 *   cache: 5m          # → { ttl: 300, key: 'global', prefetch: 'none' }
 *   cache: 5m-bg       # → { ttl: 300, key: 'global', prefetch: 'background' }
 *   cache:             # full form
 *     ttl: 1h
 *     key: per-cwd
 *     prefetch: background
 */
export interface HookCacheConfig {
  /** TTL in seconds or duration string ("30s", "5m", "1h"). */
  ttl: number | string;
  key?: HookCacheKey;
  prefetch?: HookCachePrefetch;
}

/** Cache shorthand: duration string, optionally suffixed `-bg` for background prefetch. */
export type HookCache = string | HookCacheConfig;

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
  /** Set true on user hooks that intentionally shadow system-shipped hooks. */
  override?: boolean;
  /** Optional pre-filter predicates evaluated before invoking the script. */
  matches?: HookMatches;
  /**
   * Opt-in caching. When set, the registrar generates a per-hook shim
   * under the hook shims dir that handles cache lookup, stale-while-revalidate,
   * and per-invocation timing/logging, then registers that shim with the agent
   * instead of the raw script. The underlying script is unchanged.
   */
  cache?: HookCache;
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
  run?: RunConfig;
  /** Spend guardrails (issue #346). Project-local block overrides user. */
  budget?: BudgetConfig;
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

/** Git remote metadata for the ~/.agents/.system/ config repository. */
export interface RepoInfo {
  source: string;
  branch: string;
  commit: string;
  lastSync: string;
}

/** Canonical system repo cloned into ~/.agents/.system/. */
export const DEFAULT_SYSTEM_REPO = 'gh:phnx-labs/.agents-system';

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
 * Third-party registries pre-seeded on first install for discoverability.
 *
 * These ship into new users' agents.yaml once, but are not "defaults" — after
 * seeding they behave like any user-added registry (listable, disable-able,
 * removable). Removed users can `agents registry remove <name>` to opt out;
 * once removed they don't come back.
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
 *   "system:*"      — all resources from ~/.agents/.system/
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

/** A userConfig field declared in a plugin manifest. */
export interface PluginUserConfigField {
  key: string;
  description: string;
  required?: boolean;
  default?: string;
}

/** Manifest file (plugin.json) at the root of a plugin bundle. */
export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  agents?: AgentId[];
  /** Interactive config fields prompted at install time. Values stored in .user-config.json. */
  userConfig?: PluginUserConfigField[];
  /** Other plugin names this plugin depends on. Missing deps produce a warning. */
  dependencies?: string[];
}

/** A plugin found on disk with its parsed manifest and resource inventory. */
export interface DiscoveredPlugin {
  name: string;
  root: string;
  manifest: PluginManifest;
  skills: string[];
  hooks: string[];
  scripts: string[];
  /** Slash-command .md files in the plugin's commands/ directory (names without extension). */
  commands: string[];
  /** Subagent .md files in the plugin's agents/ directory (names without extension). */
  agentDefs: string[];
  /** Executable files in the plugin's bin/ directory. */
  bin: string[];
  /** MCP server names parsed from .mcp.json. */
  mcpServers: string[];
  /** LSP server keys parsed from .lsp.json. */
  lspServers: string[];
  /** Monitor names parsed from monitors/monitors.json. */
  monitors: string[];
  /** Whether the plugin root contains a .mcp.json file. */
  hasMcp: boolean;
  /** Whether the plugin root contains a settings.json with non-permission keys to merge. */
  hasSettings: boolean;
  /**
   * Marketplace this plugin was discovered in (from marketplaceNameFor() of the
   * owning MarketplaceSpec): "agents-cli" (user repo), "agents-<alias>" (extra
   * repo), or "agents-project" (project repo). Absent on hand-built plugins
   * (e.g. workflow-scoped) — those default to the user marketplace on sync.
   */
  marketplace?: string;
}

/**
 * Identifies one DotAgents repo that contributes a plugin marketplace. Each
 * repo synthesizes its own catalog and registers under its own name:
 *   user    — ~/.agents/plugins/         → "agents-cli"   (the canonical name)
 *   extra   — ~/.agents-<alias>/plugins/ → "agents-<alias>" (e.g. "agents-extras")
 *   project — <cwd>/.agents/plugins/     → "agents-project"
 *
 * `root` on the extra/project variants is the absolute path to that repo's
 * plugins/ directory (the source side). The user variant needs no path — it is
 * always ~/.agents/plugins/ via getPluginsDir().
 */
export type MarketplaceSpec =
  | { kind: 'user' }
  | { kind: 'extra'; alias: string; root: string }
  | { kind: 'project'; root: string }
  | { kind: 'system'; root: string };

/**
 * A marketplace found on the source side (before any per-version sync), with
 * its resolved name, source plugins directory, and catalog description.
 */
export interface DiscoveredMarketplace {
  spec: MarketplaceSpec;
  /** e.g. "agents-cli", "agents-extras", "agents-project". */
  name: string;
  /** Absolute path to the source plugins/ directory on disk. */
  pluginsRoot: string;
  /** Human description embedded in the synthesized catalog. */
  description: string;
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

/** Top-level structure of ~/.agents/.system/agents.yaml -- the CLI's persistent state. */
export interface Meta {
  agents?: Partial<Record<AgentId, string>>;
  run?: RunConfig;
  /** macOS secrets-agent config. `policy` is the default prompt policy for
   * bundles without an explicit per-bundle policy: `daily` (the default) asks
   * once per ~7 days, `always` asks every time. `auto` (default on) lets the
   * first real keychain read of a `daily` bundle populate the broker so
   * concurrent runs read silently — set it `false` to force a prompt on every read. */
  secrets?: {
    policy?: 'always' | 'daily';
    agent?: {
      auto?: boolean;
    };
  };
  /** Spend guardrails (issue #346). User-global caps; project agents.yaml overrides. */
  budget?: BudgetConfig;
  beta?: {
    enabled?: BetaFeatureName[];
  };
  registries?: Record<RegistryType, Record<string, RegistryConfig>>;
  // Per-version resource tracking
  versions?: Partial<Record<AgentId, Record<string, VersionResources>>>;
  // Git remote source URL (when ~/.agents/.system/ is a git repo)
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
  /**
   * Agent-host registry keyed by host name (`agents hosts`). Portable user
   * config synced with `agents repo push/pull`. For `ssh-config` hosts this is
   * just an overlay (caps/os) — the connection details stay in ~/.ssh/config and
   * are never copied. `inline` hosts carry their own address/user.
   */
  hosts?: Record<string, HostEntry>;
}

/** Persisted agent-host entry in agents.yaml (overlay or inline). */
export interface HostEntry {
  /** `ssh-config`: reach via the bare name (ssh resolves). `inline`: use address/user below. */
  source: 'ssh-config' | 'inline';
  /** SSH-reachable target — inline hosts only (ssh-config hosts omit it). */
  address?: string;
  /** SSH user — inline hosts only. */
  user?: string;
  /** Captured at enroll probe. */
  os?: string;
  /** Free-form capability tags for routing (e.g. ['gpu']). */
  caps?: string[];
  addedAt?: string;
}

/** Browser profile definition stored in agents.yaml. */
export interface BrowserProfileConfig {
  description?: string;
  browser: 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'custom';
  binary?: string;
  electron?: boolean;
  /**
   * Selects which CDP page target represents the visible UI when the
   * browser/app exposes more than one. Format: `url:<substring>` or
   * `title:<substring>`. Recommended for Electron apps that ship hidden
   * helper WebContents (background services, OAuth windows, file://
   * shells); without an explicit filter the connector falls back to a
   * skip-invisible heuristic before picking the first page target.
   * Only consulted when `electron` is true.
   */
  targetFilter?: string;
  /**
   * Endpoint presets. Accepts two shapes for backward compatibility:
   *   - Legacy: `string[]` of CDP URLs; first entry is the default.
   *   - New:    `{ [presetName]: { target, binary?, targetFilter? } }`.
   */
  endpoints: string[] | Record<string, { target: string; binary?: string; targetFilter?: string }>;
  /** Preset name to use when `--endpoint` is not passed to `start`. */
  defaultEndpoint?: string;
  chrome?: {
    headless?: boolean;
    args?: string[];
  };
  secrets?: string;
  viewport?: { width: number; height: number };
  /** Directory holding source-side JSONL logs (e.g. ~/.rush/logs). */
  logDir?: string;
  /** Optional SSH host where logDir lives, e.g. "user@remote-host". */
  logHost?: string;
}

/** Options controlling which agents and resources are synced during `agents repo refresh` / `agents use`. */
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
