/**
 * MCP resource handler - lists, resolves, and syncs MCP server configs across layers.
 *
 * MCP servers are stored as YAML files in mcp/ directories:
 *   ~/.agents/.system/mcp/   (system)
 *   ~/.agents/mcp/          (user)
 *   .agents/mcp/            (project)
 *
 * Resolution: project > user > system (higher layer wins on name conflict).
 * Sync writes into agent-specific config files (settings.json, config.toml, etc).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import type { AgentId, Layer, ResolvedItem, ResourceHandler, ResourceKind } from './types.js';
import { capableAgents } from '../capabilities.js';
import { getProjectMcpConfigPath } from '../agents.js';
import { writeMcpConfig } from '../mcp.js';
import {
  getSystemMcpDir,
  getUserMcpDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../state.js';

/**
 * MCP server item as stored in mcp/*.yaml files.
 */
export interface McpItem {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Parse an MCP YAML file into an McpItem.
 */
function parseMcpYaml(filePath: string): McpItem | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    // Validate required fields
    if (!parsed.name || !parsed.transport) {
      return null;
    }

    // Validate transport-specific fields
    if (parsed.transport === 'stdio' && !parsed.command) {
      return null;
    }
    if ((parsed.transport === 'http' || parsed.transport === 'sse') && !parsed.url) {
      return null;
    }

    return {
      name: parsed.name,
      transport: parsed.transport,
      command: parsed.command,
      args: parsed.args,
      env: parsed.env,
      url: parsed.url,
      headers: parsed.headers,
    };
  } catch {
    return null;
  }
}

/**
 * Get layer directories for MCP resolution.
 */
function getLayerDirs(cwd?: string): { layer: Layer; dir: string }[] {
  const dirs: { layer: Layer; dir: string }[] = [];

  // Project layer (highest priority)
  const projectDir = getProjectAgentsDir(cwd || process.cwd());
  if (projectDir) {
    dirs.push({ layer: 'project', dir: path.join(projectDir, 'mcp') });
  }

  // User layer
  dirs.push({ layer: 'user', dir: getUserMcpDir() });

  // Extra repos (between user and system)
  for (const { dir } of getEnabledExtraRepos()) {
    dirs.push({ layer: 'user', dir: path.join(dir, 'mcp') });
  }

  // System layer (lowest priority)
  dirs.push({ layer: 'system', dir: getSystemMcpDir() });

  return dirs;
}

/**
 * Scan a directory for MCP YAML files.
 */
function scanMcpDir(dir: string): { name: string; path: string; item: McpItem }[] {
  const results: { name: string; path: string; item: McpItem }[] = [];

  if (!fs.existsSync(dir)) {
    return results;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

      const filePath = path.join(dir, entry.name);
      const item = parseMcpYaml(filePath);
      if (item) {
        results.push({ name: item.name, path: filePath, item });
      }
    }
  } catch {
    // Directory read failed
  }

  return results;
}

/**
 * Get the config file path for MCP for a given agent.
 * Different agents use different config formats and locations.
 */
export function getMcpConfigPath(agent: AgentId, versionHome: string): string | null {
  switch (agent) {
    case 'claude':
      return path.join(versionHome, '.claude', 'settings.json');
    case 'codex':
      return path.join(versionHome, '.codex', 'config.toml');
    case 'opencode':
      return path.join(versionHome, '.config', 'opencode', 'opencode.jsonc');
    case 'cursor':
      return path.join(versionHome, '.cursor', 'mcp.json');
    case 'gemini':
      return path.join(versionHome, '.gemini', 'settings.json');
    case 'openclaw':
      return path.join(versionHome, '.openclaw', 'openclaw.json');
    case 'antigravity':
      // agy nests under ~/.gemini/antigravity-cli/ (shared parent with Gemini, distinct subdir).
      return path.join(versionHome, '.gemini', 'antigravity-cli', 'mcp_config.json');
    case 'grok':
      return path.join(versionHome, '.grok', 'mcp.json');
    case 'hermes':
      return path.join(versionHome, '.hermes', 'config.yaml');
    case 'forge':
      return path.join(versionHome, '.forge', '.mcp.json');
    default:
      return null;
  }
}

/**
 * Dispatch MCP items to the agent-specific config writer.
 */
function syncToAgentConfig(
  agent: AgentId,
  configPath: string,
  items: McpItem[],
  mode: 'overwrite' | 'merge' = 'overwrite'
): void {
  writeMcpConfig(agent, configPath, items as import('../mcp.js').WritableMcpServer[], mode);
}

/**
 * MCP resource handler implementing ResourceHandler<McpItem>.
 */
export const McpHandler: ResourceHandler<McpItem> = {
  kind: 'mcp' as ResourceKind,

  listAll(agent: AgentId, cwd?: string): ResolvedItem<McpItem>[] {
    if (!capableAgents('mcp').includes(agent)) {
      return [];
    }

    const results = new Map<string, ResolvedItem<McpItem>>();
    const layerDirs = getLayerDirs(cwd);

    // Process in reverse order (system first) so higher layers override
    for (let i = layerDirs.length - 1; i >= 0; i--) {
      const { layer, dir } = layerDirs[i];
      const items = scanMcpDir(dir);

      for (const { name, path: itemPath, item } of items) {
        results.set(name, {
          name,
          item,
          layer,
          path: itemPath,
        });
      }
    }

    return Array.from(results.values());
  },

  resolve(agent: AgentId, name: string, cwd?: string): ResolvedItem<McpItem> | null {
    if (!capableAgents('mcp').includes(agent)) {
      return null;
    }

    const layerDirs = getLayerDirs(cwd);

    // Check in priority order (project first)
    for (const { layer, dir } of layerDirs) {
      if (!fs.existsSync(dir)) continue;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

          const filePath = path.join(dir, entry.name);
          const item = parseMcpYaml(filePath);
          if (item && item.name === name) {
            return {
              name,
              item,
              layer,
              path: filePath,
            };
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  },

  sync(agent: AgentId, versionHome: string, cwd?: string): void {
    if (!capableAgents('mcp').includes(agent)) {
      return;
    }

    const items = this.listAll(agent, cwd);
    if (items.length === 0) {
      return;
    }

    // Sync resolved MCPs to the version home (user-level agent config).
    const configPath = getMcpConfigPath(agent, versionHome);
    if (configPath) {
      const mcpItems = items.map((r) => r.item);
      syncToAgentConfig(agent, configPath, mcpItems, 'overwrite');
    }

    // Sync project-layer MCPs to the agent's project-level config path so each
    // agent CLI can discover them alongside its user-level config. Merge so we
    // do not clobber entries added manually or by the agent's own CLI.
    const projectAgentsDir = cwd ? getProjectAgentsDir(cwd) : null;
    if (projectAgentsDir) {
      const projectItems = items.filter((r) => r.layer === 'project').map((r) => r.item);
      if (projectItems.length > 0) {
        const projectConfigPath = getProjectMcpConfigPath(agent, path.dirname(projectAgentsDir));
        syncToAgentConfig(agent, projectConfigPath, projectItems, 'merge');
      }
    }
  },

  format(agent: AgentId): 'md' | 'toml' | 'json' | 'yaml' {
    switch (agent) {
      case 'codex':
      case 'grok':
        return 'toml';
      case 'hermes':
        return 'yaml';
      default:
        return 'json';
    }
  },

  targetDir(_agent: AgentId): string {
    // MCP doesn't have a target directory - it modifies config files
    return 'mcp';
  },

  configPath(agent: AgentId, versionHome: string): string | null {
    return getMcpConfigPath(agent, versionHome);
  },
};

export default McpHandler;
