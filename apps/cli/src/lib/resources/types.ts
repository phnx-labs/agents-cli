/**
 * Unified resource system types.
 *
 * Resources merge from three layers: system → user → project
 * - Union: All resources from all layers are combined
 * - Override on name conflict: Higher layer wins (project > user > system)
 */

export type AgentId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode' | 'openclaw' | 'kiro' | 'antigravity' | 'grok' | 'kimi' | 'droid' | 'hermes' | 'forge';
export type Layer = 'system' | 'user' | 'project';
export type ResourceKind = 'command' | 'hook' | 'skill' | 'rule' | 'mcp' | 'permission' | 'subagent' | 'workflow' | 'memory';

/** A resolved resource with its origin layer. */
export interface ResolvedItem<T> {
  name: string;
  item: T;
  layer: Layer;
  path: string;
}

/**
 * Resource handler interface.
 *
 * Each resource type (commands, hooks, skills, etc.) implements this interface
 * to provide consistent list/resolve/sync behavior across all agent types.
 */
export interface ResourceHandler<T> {
  readonly kind: ResourceKind;

  /**
   * List all resources across layers, with higher layer winning on name conflict.
   * Returns a union of all resources, deduplicated by name.
   */
  listAll(agent: AgentId, cwd?: string): ResolvedItem<T>[];

  /**
   * Resolve a single resource by name.
   * Returns the winning layer's version, or null if not found.
   */
  resolve(agent: AgentId, name: string, cwd?: string): ResolvedItem<T> | null;

  /**
   * Sync resolved resources to the agent's version home directory.
   * Copies/transforms resources as needed for the agent's expected format.
   */
  sync(agent: AgentId, versionHome: string, cwd?: string): void;

  /**
   * Get the file format this resource uses for a given agent.
   */
  format(agent: AgentId): 'md' | 'toml' | 'json' | 'yaml';

  /**
   * Get the target directory name in the agent's version home.
   */
  targetDir(agent: AgentId): string;

  /**
   * For resources that modify config files (MCP, permissions),
   * return the config file path. Returns null if not applicable.
   */
  configPath?(agent: AgentId, versionHome: string): string | null;

  /**
   * Compute content hash for a resource item (for change detection).
   * Used by diff() to detect modifications without full content comparison.
   * Optional — handlers that don't implement this fall back to full sync.
   */
  hash?(item: T): string;

  /**
   * Compare source layers vs synced target to detect drift.
   * Returns list of resources that differ (added, modified, removed).
   * Enables incremental sync and "X resources out of sync" status.
   * Optional — handlers that don't implement this always report "unknown".
   */
  diff?(agent: AgentId, versionHome: string, cwd?: string): ResourceDiff[];
}

/** Result of comparing source vs target for a single resource. */
export interface ResourceDiff {
  name: string;
  status: 'added' | 'modified' | 'removed';
  sourceLayer: Layer | null;
  sourceHash: string | null;
  targetHash: string | null;
}

/** Helper to get layer directories for resource resolution. */
export interface LayerDirs {
  system: string;
  user: string;
  project: string | null;
  extra: string[];
}
