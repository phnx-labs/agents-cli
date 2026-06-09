/**
 * PermissionsHandler - ResourceHandler implementation for permissions.
 *
 * Permissions are stored as YAML files in permissions/ directories at each layer.
 * Resolution: project > user > system (higher layer wins on name conflict).
 * Unlike other resources, permissions merge into agent-specific config files
 * (Claude: settings.json, Codex: config.toml, OpenCode: opencode.jsonc).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, Layer, ResolvedItem, ResourceHandler, LayerDirs } from './types.js';
import type { PermissionSet } from '../types.js';
import {
  getSystemAgentsDir,
  getUserAgentsDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../state.js';
import {
  parsePermissionSet,
  applyPermissionsToVersion,
  mergePermissionSets,
} from '../permissions.js';
import { isCapable } from '../capabilities.js';

export type PermissionItem = PermissionSet;

/**
 * Get the permissions directory for a given layer root.
 */
function getPermissionsDirForRoot(root: string): string {
  return path.join(root, 'permissions');
}

/**
 * Get layer directories for permission resolution.
 */
function getLayerDirs(cwd?: string): LayerDirs {
  return {
    system: getSystemAgentsDir(),
    user: getUserAgentsDir(),
    project: cwd ? getProjectAgentsDir(cwd) : null,
    extra: getEnabledExtraRepos().map((e) => e.dir),
  };
}

/**
 * List permission files in a directory.
 * Returns only YAML files, stripping the extension for the name.
 */
function listPermissionsInDir(dir: string): Array<{ name: string; path: string }> {
  if (!fs.existsSync(dir)) return [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const permissions: Array<{ name: string; path: string }> = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;

      if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        permissions.push({
          name: entry.name.replace(/\.(yaml|yml)$/, ''),
          path: path.join(dir, entry.name),
        });
      }
    }

    return permissions;
  } catch {
    return [];
  }
}

/**
 * Get the config file path for an agent's permissions.
 */
function getAgentConfigPath(agent: AgentId, versionHome: string): string | null {
  switch (agent) {
    case 'claude':
      return path.join(versionHome, '.claude', 'settings.json');
    case 'codex':
      return path.join(versionHome, '.codex', 'config.toml');
    case 'opencode':
      return path.join(versionHome, '.opencode', 'opencode.jsonc');
    case 'kimi':
      return path.join(versionHome, '.kimi-code', 'config.toml');
    default:
      return null;
  }
}

export const PermissionsHandler: ResourceHandler<PermissionItem> = {
  kind: 'permission',

  /**
   * List all permissions across layers, with higher layer winning on name conflict.
   * Returns a union of all permissions, deduplicated by name.
   */
  listAll(agent: AgentId, cwd?: string): ResolvedItem<PermissionItem>[] {
    const layers = getLayerDirs(cwd);
    const seen = new Set<string>();
    const results: ResolvedItem<PermissionItem>[] = [];

    // Build layer roots in precedence order: project > user > system > extras
    const roots: Array<{ dir: string; layer: Layer }> = [];

    if (layers.project) {
      roots.push({ dir: getPermissionsDirForRoot(layers.project), layer: 'project' });
    }
    roots.push({ dir: getPermissionsDirForRoot(layers.user), layer: 'user' });
    roots.push({ dir: getPermissionsDirForRoot(layers.system), layer: 'system' });

    for (const extraDir of layers.extra) {
      roots.push({ dir: getPermissionsDirForRoot(extraDir), layer: 'system' });
    }

    for (const { dir, layer } of roots) {
      const permissions = listPermissionsInDir(dir);

      for (const perm of permissions) {
        if (seen.has(perm.name)) continue;
        seen.add(perm.name);

        const item = parsePermissionSet(perm.path);
        if (item) {
          results.push({
            name: perm.name,
            item,
            layer,
            path: perm.path,
          });
        }
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Resolve a single permission by name.
   * Returns the winning layer's version, or null if not found.
   */
  resolve(agent: AgentId, name: string, cwd?: string): ResolvedItem<PermissionItem> | null {
    const layers = getLayerDirs(cwd);

    // Build candidate paths in precedence order: project > user > system > extras
    const candidates: Array<{ dir: string; layer: Layer }> = [];

    if (layers.project) {
      candidates.push({ dir: getPermissionsDirForRoot(layers.project), layer: 'project' });
    }
    candidates.push({ dir: getPermissionsDirForRoot(layers.user), layer: 'user' });
    candidates.push({ dir: getPermissionsDirForRoot(layers.system), layer: 'system' });

    for (const extraDir of layers.extra) {
      candidates.push({ dir: getPermissionsDirForRoot(extraDir), layer: 'system' });
    }

    for (const { dir, layer } of candidates) {
      // Try .yaml first, then .yml
      for (const ext of ['.yaml', '.yml']) {
        const filePath = path.join(dir, `${name}${ext}`);
        const item = parsePermissionSet(filePath);
        if (item) {
          return { name, item, layer, path: filePath };
        }
      }
    }

    return null;
  },

  /**
   * Sync resolved permissions to the agent's version home config file.
   * Merges all resolved permissions into a single set and applies to the agent's config.
   */
  sync(agent: AgentId, versionHome: string, cwd?: string): void {
    // Only sync to agents that support permissions
    if (!isCapable(agent, 'allowlist')) {
      return;
    }

    const resolved = this.listAll(agent, cwd);
    if (resolved.length === 0) return;

    // Merge all permission sets into one
    let merged: PermissionSet = {
      name: 'merged',
      description: 'Merged from all layers',
      allow: [],
      deny: [],
    };

    for (const r of resolved) {
      merged = mergePermissionSets(merged, r.item);
    }

    // Apply to the agent's config file
    applyPermissionsToVersion(agent, merged, versionHome, true);
  },

  /**
   * Permissions use YAML format.
   */
  format(_agent: AgentId): 'yaml' {
    return 'yaml';
  },

  /**
   * Permissions directory name.
   */
  targetDir(_agent: AgentId): string {
    return 'permissions';
  },

  /**
   * Return the config file path where permissions are merged.
   */
  configPath(agent: AgentId, versionHome: string): string | null {
    return getAgentConfigPath(agent, versionHome);
  },
};

export default PermissionsHandler;
