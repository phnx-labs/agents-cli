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
import * as TOML from 'smol-toml';
import type { AgentId, Layer, ResolvedItem, ResourceHandler, ResourceKind } from './types.js';
import { capableAgents } from '../capabilities.js';
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
      return path.join(versionHome, '.opencode', 'opencode.jsonc');
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
    default:
      return null;
  }
}

/**
 * Strip JSON comments (for JSONC files).
 */
function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let escape = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (escape) {
      result += char;
      escape = false;
      i++;
      continue;
    }

    if (char === '\\' && inString) {
      result += char;
      escape = true;
      i++;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      if (char === '/' && next === '/') {
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
        continue;
      }
      if (char === '/' && next === '*') {
        i += 2;
        while (i < content.length && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Write MCP servers to Claude settings.json format.
 */
function syncToClaudeConfig(configPath: string, items: McpItem[]): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      config = {};
    }
  }

  const mcpServers: Record<string, unknown> = {};
  for (const item of items) {
    if (item.transport === 'stdio') {
      mcpServers[item.name] = {
        command: item.command,
        args: item.args || [],
        env: item.env || {},
      };
    } else {
      mcpServers[item.name] = {
        url: item.url,
        ...(item.headers && { headers: item.headers }),
      };
    }
  }

  config.mcpServers = mcpServers;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Write MCP servers to Codex config.toml format.
 */
function syncToCodexConfig(configPath: string, items: McpItem[]): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }

  const mcpServers: Record<string, unknown> = {};
  for (const item of items) {
    if (item.transport === 'stdio') {
      mcpServers[item.name] = {
        command: item.command,
        args: item.args || [],
        ...(item.env && { env: item.env }),
      };
    }
    // Codex may not support HTTP MCPs
  }

  config.mcp_servers = mcpServers;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, TOML.stringify(config), 'utf-8');
}

/**
 * Write MCP servers to Grok config.toml format ([mcp_servers] section).
 */
function syncToGrokConfig(configPath: string, items: McpItem[]): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = TOML.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }

  const mcpServers: Record<string, unknown> = {};
  for (const item of items) {
    if (item.transport === 'stdio') {
      mcpServers[item.name] = {
        command: item.command,
        args: item.args || [],
        ...(item.env && { env: item.env }),
      };
    } else if (item.transport === 'http' || item.transport === 'sse') {
      mcpServers[item.name] = {
        url: item.url,
        ...(item.headers && { headers: item.headers }),
      };
    }
  }

  config.mcp_servers = mcpServers;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, TOML.stringify(config), 'utf-8');
}

/**
 * Write MCP servers to OpenCode opencode.jsonc format.
 */
function syncToOpenCodeConfig(configPath: string, items: McpItem[]): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = stripJsonComments(fs.readFileSync(configPath, 'utf-8'));
      config = JSON.parse(content);
    } catch {
      config = {};
    }
  }

  const mcp: Record<string, unknown> = {};
  for (const item of items) {
    if (item.transport === 'stdio') {
      // OpenCode uses command as array
      const commandArray = [item.command, ...(item.args || [])];
      mcp[item.name] = {
        type: 'local',
        command: commandArray,
        ...(item.env && { env: item.env }),
      };
    } else {
      mcp[item.name] = {
        type: 'remote',
        url: item.url,
      };
    }
  }

  config.mcp = mcp;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Write MCP servers to Cursor mcp.json format.
 */
function syncToCursorConfig(configPath: string, items: McpItem[]): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      config = {};
    }
  }

  const mcpServers: Record<string, unknown> = {};
  for (const item of items) {
    if (item.transport === 'stdio') {
      mcpServers[item.name] = {
        command: item.command,
        args: item.args || [],
        env: item.env || {},
      };
    } else {
      mcpServers[item.name] = {
        url: item.url,
      };
    }
  }

  config.mcpServers = mcpServers;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Write MCP servers to Gemini settings.json format.
 */
function syncToGeminiConfig(configPath: string, items: McpItem[]): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      config = {};
    }
  }

  const mcpServers: Record<string, unknown> = {};
  for (const item of items) {
    if (item.transport === 'stdio') {
      mcpServers[item.name] = {
        command: item.command,
        args: item.args || [],
        env: item.env || {},
      };
    } else {
      mcpServers[item.name] = {
        url: item.url,
      };
    }
  }

  config.mcpServers = mcpServers;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Write MCP servers to OpenClaw openclaw.json format.
 */
function syncToOpenClawConfig(configPath: string, items: McpItem[]): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      config = {};
    }
  }

  if (!config.mcp || typeof config.mcp !== 'object') {
    config.mcp = {};
  }

  const servers: Record<string, unknown> = {};
  for (const item of items) {
    if (item.transport === 'stdio') {
      servers[item.name] = {
        command: item.command,
        args: item.args,
        env: item.env,
      };
    } else {
      servers[item.name] = {
        url: item.url,
        transport: item.transport,
      };
    }
  }

  (config.mcp as Record<string, unknown>).servers = servers;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
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

    const configPath = getMcpConfigPath(agent, versionHome);
    if (!configPath) {
      return;
    }

    const mcpItems = items.map((r) => r.item);

    switch (agent) {
      case 'claude':
        syncToClaudeConfig(configPath, mcpItems);
        break;
      case 'codex':
        syncToCodexConfig(configPath, mcpItems);
        break;
      case 'opencode':
        syncToOpenCodeConfig(configPath, mcpItems);
        break;
      case 'cursor':
        syncToCursorConfig(configPath, mcpItems);
        break;
      case 'gemini':
        syncToGeminiConfig(configPath, mcpItems);
        break;
      case 'openclaw':
        syncToOpenClawConfig(configPath, mcpItems);
        break;
      case 'grok':
        syncToGrokConfig(configPath, mcpItems);
        break;
    }
  },

  format(agent: AgentId): 'md' | 'toml' | 'json' | 'yaml' {
    switch (agent) {
      case 'codex':
      case 'grok':
        return 'toml';
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
