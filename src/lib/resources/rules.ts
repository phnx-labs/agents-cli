/**
 * Rules resource handler.
 *
 * Rules are .md files in `<repo>/rules/subrules/` directories that get composed
 * into the agent's instructions file (AGENTS.md -> CLAUDE.md/GEMINI.md/etc).
 *
 * Layer resolution: project > user > extras > system
 * - Same-named subrule at higher layer wins (override)
 * - All unique subrules across layers are unioned
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentId, Layer, ResolvedItem, ResourceHandler } from './types.js';
import {
  getSystemRulesDir,
  getUserRulesDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../state.js';
import { agentConfigDirName } from '../agents.js';

const SUBRULES_DIR = 'subrules';
const SUBRULES_README = 'README.md';

/** A rule item is a subrule markdown fragment. */
export interface RuleItem {
  /** The subrule name (without .md extension). */
  name: string;
  /** The full content of the rule file. */
  content: string;
}

/** Layer directory entry for rules resolution. */
export interface RulesLayerDir {
  layer: Layer;
  dir: string;
}

/**
 * List subrule markdown files in a directory.
 * Returns names without the .md extension.
 */
export function listSubrulesInDir(subrulesDir: string): string[] {
  if (!fs.existsSync(subrulesDir)) return [];
  try {
    return fs
      .readdirSync(subrulesDir)
      .filter((f) => f.endsWith('.md') && f !== SUBRULES_README)
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Get layer directories for rules resolution using production paths.
 */
export function getLayerDirs(cwd?: string): RulesLayerDir[] {
  const dirs: RulesLayerDir[] = [];

  // Project layer (highest priority)
  const projectDir = getProjectAgentsDir(cwd);
  if (projectDir) {
    const rulesDir = path.join(projectDir, 'rules');
    if (fs.existsSync(rulesDir)) {
      dirs.push({ layer: 'project', dir: rulesDir });
    }
  }

  // User layer
  const userDir = getUserRulesDir();
  if (fs.existsSync(userDir)) {
    dirs.push({ layer: 'user', dir: userDir });
  }

  // Extra repos (treated as user-level in layering)
  for (const extra of getEnabledExtraRepos()) {
    const rulesDir = path.join(extra.dir, 'rules');
    if (fs.existsSync(rulesDir)) {
      dirs.push({ layer: 'user', dir: rulesDir });
    }
  }

  // System layer (lowest priority)
  const systemDir = getSystemRulesDir();
  if (fs.existsSync(systemDir)) {
    dirs.push({ layer: 'system', dir: systemDir });
  }

  return dirs;
}

/**
 * List all rules from the given layer directories.
 * Higher layers win on name collision.
 */
export function listAllRules(layers: RulesLayerDir[]): ResolvedItem<RuleItem>[] {
  const seen = new Set<string>();
  const results: ResolvedItem<RuleItem>[] = [];

  for (const { layer, dir } of layers) {
    const subrulesDir = path.join(dir, SUBRULES_DIR);
    for (const name of listSubrulesInDir(subrulesDir)) {
      if (seen.has(name)) continue;
      seen.add(name);

      const filePath = path.join(subrulesDir, `${name}.md`);
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      results.push({
        name,
        item: { name, content },
        layer,
        path: filePath,
      });
    }
  }

  return results;
}

/**
 * Resolve a single rule by name from the given layer directories.
 * Higher layers win.
 */
export function resolveRule(name: string, layers: RulesLayerDir[]): ResolvedItem<RuleItem> | null {
  for (const { layer, dir } of layers) {
    const filePath = path.join(dir, SUBRULES_DIR, `${name}.md`);
    if (fs.existsSync(filePath)) {
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      return {
        name,
        item: { name, content },
        layer,
        path: filePath,
      };
    }
  }
  return null;
}

export const RulesHandler: ResourceHandler<RuleItem> = {
  kind: 'rule',

  listAll(_agent: AgentId, cwd?: string): ResolvedItem<RuleItem>[] {
    return listAllRules(getLayerDirs(cwd));
  },

  resolve(_agent: AgentId, name: string, cwd?: string): ResolvedItem<RuleItem> | null {
    return resolveRule(name, getLayerDirs(cwd));
  },

  sync(agent: AgentId, versionHome: string, _cwd?: string): void {
    // Rules sync is handled by the compose module and syncResourcesToVersion.
    // This method ensures the agent config directory exists.
    // The actual composition and write happens in versions.ts via composeRulesFromState().
    const targetDir = path.join(versionHome, agentConfigDirName(agent));

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  },

  format(_agent: AgentId): 'md' | 'toml' | 'json' | 'yaml' {
    return 'md';
  },

  targetDir(agent: AgentId): string {
    // Rules don't have a target subdirectory - they're written to the instructions file
    return agentConfigDirName(agent);
  },
};
