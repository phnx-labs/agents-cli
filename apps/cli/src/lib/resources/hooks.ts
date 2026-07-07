/**
 * HooksHandler - ResourceHandler implementation for hooks.
 *
 * Hook declarations live in:
 *   - System: ~/.agents/.system/hooks.yaml (npm-shipped defaults)
 *   - User:   `hooks:` section of ~/.agents/agents.yaml
 *   - Project: <project>/.agents/hooks.yaml
 *
 * Resolution: project > user > system (higher layer wins on name conflict).
 * Non-conflicting hooks from all layers are unioned together.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId, Layer, ResolvedItem, ResourceHandler, LayerDirs } from './types.js';
import type { ManifestHook } from '../types.js';
import {
  getSystemAgentsDir,
  getUserAgentsDir,
  getProjectAgentsDir,
} from '../state.js';

export type HookItem = ManifestHook;

/**
 * Get the hook manifest path for a layer dir. The user layer reads from
 * agents.yaml (hooks: section) since that's where user hooks now live.
 * Other layers continue to use a standalone hooks.yaml.
 */
function getHooksYamlPath(layerDir: string): string {
  if (layerDir === getUserAgentsDir()) {
    return path.join(layerDir, 'agents.yaml');
  }
  return path.join(layerDir, 'hooks.yaml');
}

/**
 * Parse hooks for a layer directory.
 * - User layer: read `hooks:` section from agents.yaml.
 * - System / project layer: read top-level map from hooks.yaml.
 * Returns empty object if file doesn't exist or is invalid.
 */
function parseHooksYaml(dir: string): Record<string, ManifestHook> {
  const manifestPath = getHooksYamlPath(dir);
  if (!fs.existsSync(manifestPath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = yaml.parse(content) as Record<string, unknown> | null;
    if (!parsed) return {};
    if (dir === getUserAgentsDir()) {
      const hooks = parsed.hooks;
      return (hooks && typeof hooks === 'object') ? (hooks as Record<string, ManifestHook>) : {};
    }
    return parsed as Record<string, ManifestHook>;
  } catch {
    return {};
  }
}

/**
 * Get layer directories for hook resolution.
 */
function getLayerDirs(cwd?: string): LayerDirs {
  return {
    system: getSystemAgentsDir(),
    user: getUserAgentsDir(),
    project: cwd ? getProjectAgentsDir(cwd) : null,
    extra: [],
  };
}

export const HooksHandler: ResourceHandler<HookItem> = {
  kind: 'hook',

  /**
   * List all hooks across layers, with higher layer winning on name conflict.
   * Returns a union of all hooks, deduplicated by name.
   */
  listAll(agent: AgentId, cwd?: string): ResolvedItem<HookItem>[] {
    const layers = getLayerDirs(cwd);
    const result = new Map<string, ResolvedItem<HookItem>>();

    // Process in precedence order: system first (lowest), then user, then project (highest)
    const layerOrder: Array<{ layer: Layer; dir: string | null }> = [
      { layer: 'system', dir: layers.system },
      { layer: 'user', dir: layers.user },
      { layer: 'project', dir: layers.project },
    ];

    for (const { layer, dir } of layerOrder) {
      if (!dir) continue;

      const hooks = parseHooksYaml(dir);
      for (const [name, hook] of Object.entries(hooks)) {
        // Skip disabled hooks
        if (hook.enabled === false) {
          result.delete(name);
          continue;
        }

        result.set(name, {
          name,
          item: hook,
          layer,
          path: getHooksYamlPath(dir),
        });
      }
    }

    return Array.from(result.values()).sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Resolve a single hook by name.
   * Returns the winning layer's version, or null if not found.
   */
  resolve(agent: AgentId, name: string, cwd?: string): ResolvedItem<HookItem> | null {
    const layers = getLayerDirs(cwd);

    // Check in reverse precedence order: project first (highest), then user, then system
    const layerOrder: Array<{ layer: Layer; dir: string | null }> = [
      { layer: 'project', dir: layers.project },
      { layer: 'user', dir: layers.user },
      { layer: 'system', dir: layers.system },
    ];

    for (const { layer, dir } of layerOrder) {
      if (!dir) continue;

      const hooks = parseHooksYaml(dir);
      const hook = hooks[name];

      if (hook) {
        // If this layer disables the hook, return null (disabled trumps lower layers)
        if (hook.enabled === false) {
          return null;
        }

        return {
          name,
          item: hook,
          layer,
          path: getHooksYamlPath(dir),
        };
      }
    }

    return null;
  },

  /**
   * Sync resolved hooks to the agent's version home directory.
   * Note: Actual hook registration is handled by registerHooksToSettings in hooks.ts.
   * This method is a no-op placeholder for the interface contract.
   */
  sync(_agent: AgentId, _versionHome: string, _cwd?: string): void {
    // Hook syncing is done via registerHooksToSettings in the main hooks.ts module.
    // This handler only provides resolution; registration is a separate concern.
  },

  /**
   * Hooks use YAML format across all agents.
   */
  format(_agent: AgentId): 'yaml' {
    return 'yaml';
  },

  /**
   * Hooks are stored in the hooks directory.
   */
  targetDir(_agent: AgentId): string {
    return 'hooks';
  },
};

export default HooksHandler;
