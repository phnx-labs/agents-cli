/**
 * Skills resource handler.
 *
 * Skills are directory bundles with a SKILL.md containing YAML frontmatter.
 * Format is the same for all agents. Resolution order: project > user > system.
 */

import * as fs from 'fs';
import { AGENTS, agentConfigDirName } from '../agents.js';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId, Layer, ResolvedItem, ResourceHandler } from './types.js';
import type { SkillMetadata } from '../types.js';
import {
  getSystemSkillsDir,
  getUserSkillsDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../state.js';

/**
 * Layer directory provider for dependency injection in tests.
 */
export interface LayerDirProvider {
  getSystemSkillsDir(): string;
  getUserSkillsDir(): string;
  getProjectAgentsDir(cwd?: string): string | null;
  getEnabledExtraRepos(): Array<{ alias: string; dir: string; url: string }>;
}

/** Default provider uses the real state module. */
const defaultProvider: LayerDirProvider = {
  getSystemSkillsDir,
  getUserSkillsDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
};

/** A resolved skill item with parsed metadata. */
export interface SkillItem {
  /** Parsed SKILL.md frontmatter metadata. */
  metadata: SkillMetadata;
  /** Number of rule files in the skill's rules/ subdirectory. */
  ruleCount: number;
  /** Number of additional bundled files (beyond SKILL.md). */
  fileCount: number;
}

/**
 * Parse SKILL.md frontmatter to extract skill metadata.
 * Returns null if the file doesn't exist or has no valid frontmatter.
 */
function parseSkillMetadata(skillDir: string): SkillMetadata | null {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const lines = content.split('\n');

    // Check for YAML frontmatter (required)
    if (lines[0] === '---') {
      const endIndex = lines.slice(1).findIndex((l) => l === '---');
      if (endIndex > 0) {
        const frontmatter = lines.slice(1, endIndex + 1).join('\n');
        const parsed = yaml.parse(frontmatter);
        return {
          name: parsed.name || '',
          description: parsed.description || '',
          author: parsed.author,
          version: parsed.version,
          license: parsed.license,
          keywords: parsed.keywords,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Count .md files in the skill's rules/ subdirectory.
 */
function countSkillRules(skillDir: string): number {
  const rulesDir = path.join(skillDir, 'rules');
  if (!fs.existsSync(rulesDir)) {
    return 0;
  }

  try {
    const files = fs.readdirSync(rulesDir);
    return files.filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/**
 * Count bundled resource files in a skill directory (everything except SKILL.md).
 */
function countSkillFiles(skillDir: string): number {
  if (!fs.existsSync(skillDir)) return 0;
  let count = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (dir === skillDir && entry.name === 'SKILL.md') continue;
        count++;
      }
    }
  };
  walk(skillDir);
  return count;
}

/**
 * List skill directories in a given base path.
 * Returns array of { name, fullPath } for directories containing SKILL.md.
 */
function listSkillsInDir(baseDir: string): Array<{ name: string; fullPath: string }> {
  if (!fs.existsSync(baseDir)) return [];

  const results: Array<{ name: string; fullPath: string }> = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(baseDir, entry.name);
      const skillMdPath = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        results.push({ name: entry.name, fullPath });
      }
    }
  } catch {
    // Ignore errors
  }
  return results;
}

/**
 * Get layer directories for skill resolution.
 */
function getLayerDirs(cwd?: string, provider: LayerDirProvider = defaultProvider): { layer: Layer; dir: string }[] {
  const layers: { layer: Layer; dir: string }[] = [];

  // Project layer
  const projectDir = cwd ? provider.getProjectAgentsDir(cwd) : null;
  if (projectDir) {
    layers.push({ layer: 'project', dir: path.join(projectDir, 'skills') });
  }

  // User layer
  layers.push({ layer: 'user', dir: provider.getUserSkillsDir() });

  // Extra repos (treated as user layer since they're user-configured)
  for (const extra of provider.getEnabledExtraRepos()) {
    layers.push({ layer: 'user', dir: path.join(extra.dir, 'skills') });
  }

  // System layer
  layers.push({ layer: 'system', dir: provider.getSystemSkillsDir() });

  return layers;
}

/**
 * Create a SkillsHandler with the given layer directory provider.
 * Useful for testing with custom directory structures.
 */
export function createSkillsHandler(provider: LayerDirProvider = defaultProvider): ResourceHandler<SkillItem> {
  return {
    kind: 'skill',

    listAll(_agent: AgentId, cwd?: string): ResolvedItem<SkillItem>[] {
      const seen = new Map<string, ResolvedItem<SkillItem>>();
      const layers = getLayerDirs(cwd, provider);

      // Process in order: project > user > system
      // First occurrence wins (higher layer takes precedence)
      for (const { layer, dir } of layers) {
        const skills = listSkillsInDir(dir);
        for (const { name, fullPath } of skills) {
          if (seen.has(name)) continue; // Higher layer already has this skill

          const metadata = parseSkillMetadata(fullPath);
          if (!metadata) continue; // Skip invalid skills

          seen.set(name, {
            name,
            item: {
              metadata,
              ruleCount: countSkillRules(fullPath),
              fileCount: countSkillFiles(fullPath),
            },
            layer,
            path: fullPath,
          });
        }
      }

      return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
    },

    resolve(_agent: AgentId, name: string, cwd?: string): ResolvedItem<SkillItem> | null {
      const layers = getLayerDirs(cwd, provider);

      for (const { layer, dir } of layers) {
        const skillPath = path.join(dir, name);
        const skillMdPath = path.join(skillPath, 'SKILL.md');

        if (fs.existsSync(skillMdPath)) {
          const metadata = parseSkillMetadata(skillPath);
          if (!metadata) continue;

          return {
            name,
            item: {
              metadata,
              ruleCount: countSkillRules(skillPath),
              fileCount: countSkillFiles(skillPath),
            },
            layer,
            path: skillPath,
          };
        }
      }

      return null;
    },

    sync(agent: AgentId, versionHome: string, cwd?: string): void {
      // Agents that read directly from central ~/.agents/skills/ (e.g. Gemini,
      // Goose via the Summon extension) should not get a per-version copy.
      if (AGENTS[agent]?.nativeAgentsSkillsDir) {
        return;
      }

      const targetDir = path.join(versionHome, agentConfigDirName(agent), 'skills');

      // Ensure target directory exists
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const resolved = this.listAll(agent, cwd);

      for (const skill of resolved) {
        const targetPath = path.join(targetDir, skill.name);

        // Remove existing if present
        if (fs.existsSync(targetPath) || fs.lstatSync(targetPath, { throwIfNoEntry: false })) {
          try {
            fs.rmSync(targetPath, { recursive: true, force: true });
          } catch {
            // Ignore removal errors
          }
        }

        // Copy skill directory
        try {
          fs.cpSync(skill.path, targetPath, { recursive: true });
        } catch {
          // Ignore copy errors
        }
      }
    },

    format(_agent: AgentId): 'md' {
      return 'md';
    },

    targetDir(agent: AgentId): string {
      return `${agentConfigDirName(agent)}/skills`;
    },
  };
}

/** Default handler using real state module paths. */
export const SkillsHandler = createSkillsHandler();
