/**
 * Public types for the staleness library. The on-disk manifest shape stays
 * at `v: 1` for backward compatibility — see `src/lib/sync-manifest.ts` for
 * the loader/saver that consumes these.
 */

import type { Fingerprint } from './fingerprint.js';

export const MANIFEST_VERSION = 1 as const;

/** A single-file resource (commands, hooks, MCP server YAML, permission groups). */
export interface FileEntry {
  source: Fingerprint;
}

/** A directory resource (skills, subagents, workflows). */
export interface DirEntry {
  /** Winning source dir, absolute. */
  dirPath: string;
  /** All files inside the dir, sorted by absolute path. */
  files: Fingerprint[];
}

/** Rules section — fingerprints of every source file (rules.yaml + active subrules). */
export interface RulesEntry {
  files: Record<string, FileEntry>;
}

/**
 * Permissions section — merged across layers (every group across every scope
 * contributes; same name first-wins user > system). Plus the active preset
 * env value, since preset selection changes which groups are applied.
 */
export interface PermEntry {
  groups: Record<string, FileEntry>;
  permissionPreset: string | null;
}

/**
 * Plugin entry. Plugins have a complex layout (`.claude-plugin/plugin.json`
 * plus optional `skills/`, `commands/`, ...). We fingerprint the entire
 * plugin root, same shape as a DirEntry.
 */
export type PluginEntry = DirEntry;

/**
 * Full manifest. `workflows` and `plugins` are optional so older v1 files
 * stay loadable; missing fields are treated as empty maps — name-set diff
 * then triggers a single re-sync that fills them in.
 */
export interface SyncManifest {
  v:          typeof MANIFEST_VERSION;
  syncedAt:   string;
  commands:   Record<string, FileEntry>;
  skills:     Record<string, DirEntry>;
  hooks:      Record<string, FileEntry>;
  rules:      RulesEntry;
  mcp:        Record<string, FileEntry>;
  permissions: PermEntry;
  subagents:  Record<string, DirEntry>;
  workflows?: Record<string, DirEntry>;
  plugins?:   Record<string, PluginEntry>;
}
