/**
 * Subagents resource handler.
 *
 * Subagents are YAML files stored in subagents/ directories across layers.
 * Format is the same for all agents. Resolution order: project > user > system.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId, Layer, ResolvedItem, ResourceHandler, LayerDirs } from './types.js';
import {
  getProjectAgentsDir,
  getUserSubagentsDir,
  getSystemSubagentsDir,
  getEnabledExtraRepos,
} from '../state.js';

/** Parsed content of a subagent YAML file. */
export interface SubagentItem {
  name: string;
  description: string;
  model?: string;
  /** Hex color for UI display. */
  color?: string;
  /** Additional agent-specific config. */
  config?: Record<string, unknown>;
}

/** Get layer directories for subagent resolution. */
function getLayerDirs(cwd?: string): LayerDirs {
  const projectDir = getProjectAgentsDir(cwd);
  const extraRepos = getEnabledExtraRepos();

  return {
    system: path.join(getSystemSubagentsDir()),
    user: getUserSubagentsDir(),
    project: projectDir ? path.join(projectDir, 'subagents') : null,
    extra: extraRepos.map((e) => path.join(e.dir, 'subagents')),
  };
}

/** Map source directory to layer name. */
function dirToLayer(dir: string, dirs: LayerDirs): Layer {
  if (dirs.project && dir.startsWith(dirs.project)) return 'project';
  if (dir.startsWith(dirs.user)) return 'user';
  return 'system';
}

/** Parse a subagent YAML file and return parsed item. */
function parseSubagentYaml(filePath: string): SubagentItem | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    return {
      name: parsed.name || '',
      description: parsed.description || '',
      model: parsed.model,
      color: parsed.color,
      config: parsed.config,
    };
  } catch {
    return null;
  }
}

/** Extract name from filename (removes .yaml/.yml extension). */
function nameFromFile(filename: string): string {
  return filename.replace(/\.ya?ml$/, '');
}

export class SubagentsHandler implements ResourceHandler<SubagentItem> {
  readonly kind = 'subagent' as const;

  /**
   * List all subagents across layers, with higher layer winning on name conflict.
   * Returns a union of all subagents, deduplicated by name.
   */
  listAll(_agent: AgentId, cwd?: string): ResolvedItem<SubagentItem>[] {
    const dirs = getLayerDirs(cwd);
    const seen = new Set<string>();
    const results: ResolvedItem<SubagentItem>[] = [];

    // Order: project > user > system > extra (extra comes last after system)
    const layerDirs: Array<{ dir: string; layer: Layer }> = [];

    if (dirs.project && fs.existsSync(dirs.project)) {
      layerDirs.push({ dir: dirs.project, layer: 'project' });
    }
    if (fs.existsSync(dirs.user)) {
      layerDirs.push({ dir: dirs.user, layer: 'user' });
    }
    if (fs.existsSync(dirs.system)) {
      layerDirs.push({ dir: dirs.system, layer: 'system' });
    }
    for (const extraDir of dirs.extra) {
      if (fs.existsSync(extraDir)) {
        layerDirs.push({ dir: extraDir, layer: 'system' });
      }
    }

    for (const { dir, layer } of layerDirs) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
        if (entry.name.startsWith('.')) continue;

        const name = nameFromFile(entry.name);
        if (seen.has(name)) continue;

        const filePath = path.join(dir, entry.name);
        const item = parseSubagentYaml(filePath);
        if (!item) continue;

        seen.add(name);
        results.push({
          name,
          item,
          layer,
          path: filePath,
        });
      }
    }

    return results;
  }

  /**
   * Resolve a single subagent by name.
   * Returns the winning layer's version, or null if not found.
   */
  resolve(_agent: AgentId, name: string, cwd?: string): ResolvedItem<SubagentItem> | null {
    const dirs = getLayerDirs(cwd);

    // Order: project > user > system > extra
    const searchDirs: Array<{ dir: string; layer: Layer }> = [];

    if (dirs.project) {
      searchDirs.push({ dir: dirs.project, layer: 'project' });
    }
    searchDirs.push({ dir: dirs.user, layer: 'user' });
    searchDirs.push({ dir: dirs.system, layer: 'system' });
    for (const extraDir of dirs.extra) {
      searchDirs.push({ dir: extraDir, layer: 'system' });
    }

    for (const { dir, layer } of searchDirs) {
      if (!fs.existsSync(dir)) continue;

      // Try .yaml first, then .yml
      for (const ext of ['.yaml', '.yml']) {
        const filePath = path.join(dir, name + ext);
        if (fs.existsSync(filePath)) {
          const item = parseSubagentYaml(filePath);
          if (item) {
            return {
              name,
              item,
              layer,
              path: filePath,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Sync resolved subagents to the agent's version home directory.
   * Copies YAML files to the target directory.
   */
  sync(agent: AgentId, versionHome: string, cwd?: string): void {
    const targetDir = path.join(versionHome, this.targetDir(agent));

    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Clear existing subagents in target
    try {
      const existing = fs.readdirSync(targetDir);
      for (const file of existing) {
        if (file.endsWith('.yaml') || file.endsWith('.yml')) {
          fs.unlinkSync(path.join(targetDir, file));
        }
      }
    } catch {
      // Ignore errors during cleanup
    }

    // Copy all resolved subagents
    const resolved = this.listAll(agent, cwd);
    for (const { name, path: sourcePath } of resolved) {
      const ext = sourcePath.endsWith('.yml') ? '.yml' : '.yaml';
      const targetPath = path.join(targetDir, name + ext);
      fs.copyFileSync(sourcePath, targetPath);
    }
  }

  /**
   * Get the file format this resource uses for a given agent.
   * Subagents always use YAML format.
   */
  format(_agent: AgentId): 'md' | 'toml' | 'json' | 'yaml' {
    return 'yaml';
  }

  /**
   * Get the target directory name in the agent's version home.
   */
  targetDir(_agent: AgentId): string {
    return 'subagents';
  }
}

/** Singleton instance of the SubagentsHandler. */
export const subagentsHandler = new SubagentsHandler();
