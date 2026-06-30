/**
 * MCP server management - reading from ~/.agents/mcp/ and applying to agent configs.
 *
 * MCP servers are stored as YAML files in ~/.agents/mcp/:
 *   ~/.agents/mcp/swarm.yaml
 *   ~/.agents/mcp/figma.yaml
 *
 * Each file defines a server that gets applied (merged) into agent configs during sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import { execFileSync } from 'child_process';
import * as os from 'os';
import type { AgentId } from './types.js';
import { getMcpDir, getUserMcpDir, getProjectAgentsDir, getVersionsDir } from './state.js';
import { getBinaryPath, getVersionHomePath } from './versions.js';
import { IS_WINDOWS, needsWindowsShell } from './platform/index.js';
import { AGENTS } from './agents.js';
import { isCapable } from './capabilities.js';
import { setGeminiAutoUpdateDisabled, updateGeminiSettings } from './gemini-settings.js';

/**
 * MCP server config as stored in ~/.agents/mcp/*.yaml
 */
export interface McpYamlConfig {
  name: string;
  transport: 'stdio' | 'http';
  // For stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // For http transport
  url?: string;
}

export interface InstalledMcpServer {
  name: string;
  path: string;
  config: McpYamlConfig;
  scope?: 'user' | 'project';
}

export interface McpCommandSpec {
  command: string;
  args: string[];
}

export interface McpTargetOperationResult {
  agentId: AgentId;
  version?: string;
  success: boolean;
  error?: string;
}

/**
 * Parse an MCP server config from a YAML file.
 */
export function parseMcpServerConfig(filePath: string): McpYamlConfig | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  let parsed: unknown;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    parsed = yaml.parse(content);
  } catch {
    return null;
  }

  return validateMcpYamlConfig(parsed);
}

function validateMcpYamlConfig(parsed: unknown): McpYamlConfig | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const config = parsed as Record<string, unknown>;
  if (typeof config.name !== 'string' || config.name.length === 0) return null;
  if (config.transport !== 'stdio' && config.transport !== 'http') return null;

  const result: McpYamlConfig = {
    name: config.name,
    transport: config.transport,
  };

  if (config.transport === 'stdio') {
    if (config.command === undefined || config.command === '') return null;
    if (typeof config.command !== 'string') {
      throw new Error(`Invalid MCP config '${config.name}': command must be a string`);
    }
    result.command = config.command;
    if (config.args !== undefined) {
      if (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === 'string')) {
        throw new Error(`Invalid MCP config '${config.name}': args must be a string array`);
      }
      result.args = config.args;
    }
    if (config.env !== undefined) {
      if (!isStringRecord(config.env)) {
        throw new Error(`Invalid MCP config '${config.name}': env must be a string map`);
      }
      result.env = config.env;
    }
  } else {
    if (typeof config.url !== 'string' || config.url.length === 0) return null;
    result.url = config.url;
  }

  return result;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

/**
 * List all MCP server configs from ~/.agents/mcp/.
 */
export function listMcpServerConfigs(cwd: string = process.cwd()): InstalledMcpServer[] {
  const dirs: Array<{ scope: 'project' | 'user'; dir: string }> = [];
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (projectAgentsDir) {
    dirs.push({ scope: 'project', dir: path.join(projectAgentsDir, 'mcp') });
  }
  // User dir first (wins on name collision), then system
  dirs.push({ scope: 'user', dir: getUserMcpDir() });
  dirs.push({ scope: 'user', dir: getMcpDir() });

  const results = new Map<string, InstalledMcpServer>();

  for (const { scope, dir } of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

      const filePath = path.join(dir, entry.name);
      const config = parseMcpServerConfig(filePath);
      if (config && !results.has(config.name)) {
        results.set(config.name, {
          name: config.name,
          path: filePath,
          config,
          scope,
        });
      }
    }
  }

  return Array.from(results.values());
}

/**
 * Scan a repository for MCP server YAML configs.
 * Looks under <repoPath>/mcp/*.yaml — same on-disk layout as ~/.agents/mcp/.
 */
export function discoverMcpConfigsFromRepo(repoPath: string): InstalledMcpServer[] {
  const dir = path.join(repoPath, 'mcp');
  if (!fs.existsSync(dir)) return [];

  const results: InstalledMcpServer[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;

    const filePath = path.join(dir, entry.name);
    const config = parseMcpServerConfig(filePath);
    if (config) {
      results.push({ name: config.name, path: filePath, config, scope: 'user' });
    }
  }
  return results;
}

/**
 * Install an MCP YAML config from a source file into ~/.agents/mcp/.
 * Re-serializes via writeMcpServerConfig so the on-disk filename is
 * deterministic (sanitized from the server name).
 */
export function installMcpConfigCentrally(
  sourcePath: string
): { success: boolean; error?: string; path?: string } {
  try {
    const config = parseMcpServerConfig(sourcePath);
    if (!config) {
      return { success: false, error: `Invalid MCP config at ${sourcePath}` };
    }
    const written = writeMcpServerConfig(config);
    return { success: true, path: written };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Get MCP servers by name.
 * If names is provided, returns only those servers.
 * Otherwise returns all servers.
 */
export function getMcpServersByName(names?: string[], options: { cwd?: string } = {}): InstalledMcpServer[] {
  const allServers = listMcpServerConfigs(options.cwd);
  if (!names || names.length === 0) {
    return allServers;
  }
  return allServers.filter((server) => names.includes(server.name));
}

/**
 * Assemble the JSON payload Claude's `--mcp-config` flag expects from a set of
 * installed MCP servers: `{ "mcpServers": { "<name>": { command, args, env } | { url } } }`.
 * Pure — takes servers, returns a JSON string. The caller writes it to an
 * ephemeral file and passes the path to buildExecCommand.
 */
export function buildWorkflowMcpConfig(servers: InstalledMcpServer[]): string {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    const cfg = server.config;
    if (cfg.transport === 'http') {
      mcpServers[server.name] = { url: cfg.url };
    } else {
      const entry: Record<string, unknown> = { command: cfg.command };
      if (cfg.args && cfg.args.length > 0) entry.args = cfg.args;
      if (cfg.env && Object.keys(cfg.env).length > 0) entry.env = cfg.env;
      mcpServers[server.name] = entry;
    }
  }
  return JSON.stringify({ mcpServers });
}

/**
 * Install MCP server using Claude CLI.
 * Uses: claude mcp add --scope user --transport <type> <name> [--env K=V]... -- <cmd> [args...]
 */
function installMcpViaClaude(binaryPath: string, server: InstalledMcpServer, versionHome: string): void {
  const execEnv = { ...process.env, HOME: versionHome };

  if (server.config.transport === 'stdio') {
    // Build env args
    const envArgs: string[] = [];
    if (server.config.env) {
      for (const [key, value] of Object.entries(server.config.env)) {
        envArgs.push('--env', `${key}=${value}`);
      }
    }

    // claude mcp add --scope user --transport stdio <name> [--env K=V]... -- <cmd> [args...]
    const args = [
      'mcp', 'add', '--scope', 'user', '--transport', 'stdio',
      server.name,
      ...envArgs,
      '--',
      server.config.command!,
      ...(server.config.args || [])
    ];

    execFileSync(binaryPath, args, {
      stdio: 'pipe',
      timeout: 30000,
      env: execEnv,
      shell: needsWindowsShell(binaryPath),
    });
  } else {
    // claude mcp add --scope user --transport http <name> <url>
    execFileSync(binaryPath, ['mcp', 'add', '--scope', 'user', '--transport', 'http', server.name, server.config.url!], {
      stdio: 'pipe',
      timeout: 30000,
      env: execEnv,
      shell: needsWindowsShell(binaryPath),
    });
  }
}

/**
 * Install MCP server using Codex CLI.
 * Uses: codex mcp add <name> -- <cmd> [args...]
 */
function installMcpViaCodex(binaryPath: string, server: InstalledMcpServer, versionHome: string): void {
  if (server.config.transport === 'stdio') {
    // codex mcp add <name> -- <cmd> [args...]
    const args = [
      'mcp', 'add', server.name,
      '--',
      server.config.command!,
      ...(server.config.args || [])
    ];

    execFileSync(binaryPath, args, {
      stdio: 'pipe',
      timeout: 30000,
      env: { ...process.env, HOME: versionHome },
      shell: needsWindowsShell(binaryPath),
    });
  }
  // Note: Codex may not support HTTP MCPs
}

export async function registerMcpCommandToTargets(
  targets: { directAgents: AgentId[]; versionSelections: Map<AgentId, string[]> },
  name: string,
  commandSpec: McpCommandSpec,
  scope: 'user' | 'project' = 'user',
  transport: string = 'stdio'
): Promise<McpTargetOperationResult[]> {
  const results: McpTargetOperationResult[] = [];

  for (const agentId of targets.directAgents) {
    const result = registerMcpCommand(agentId, name, commandSpec, scope, transport);
    results.push({ agentId, success: result.success, error: result.error });
  }

  for (const [agentId, versions] of targets.versionSelections) {
    for (const version of versions) {
      const result = registerMcpCommand(agentId, name, commandSpec, scope, transport, {
        home: getVersionHomePath(agentId, version),
        binary: getBinaryPath(agentId, version),
      });
      results.push({ agentId, version, success: result.success, error: result.error });
    }
  }

  return results;
}

function registerMcpCommand(
  agentId: AgentId,
  name: string,
  commandSpec: McpCommandSpec,
  scope: 'user' | 'project',
  transport: string,
  options: { home?: string; binary?: string } = {}
): { success: boolean; error?: string } {
  try {
    const bin = options.binary || AGENTS[agentId].cliCommand;
    const commandArgs = [commandSpec.command, ...commandSpec.args];
    const args = agentId === 'claude'
      ? ['mcp', 'add', '--transport', transport, '--scope', scope, name, '--', ...commandArgs]
      : ['mcp', 'add', name, '--', ...commandArgs];
    const env = options.home ? { ...process.env, HOME: options.home } : process.env;
    execFileSync(bin, args, { stdio: 'pipe', timeout: 30000, env, shell: needsWindowsShell(bin) });
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Install MCP server to Gemini config file.
 */
function installMcpToGeminiConfig(server: InstalledMcpServer, versionHome: string): void {
  const configPath = path.join(versionHome, '.gemini', 'settings.json');
  updateGeminiSettings(configPath, (config) => {
    setGeminiAutoUpdateDisabled(config);

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, unknown>;

    if (server.config.transport === 'stdio') {
      mcpServers[server.name] = {
        command: server.config.command,
        args: server.config.args || [],
        env: server.config.env || {},
      };
    } else {
      mcpServers[server.name] = {
        url: server.config.url,
      };
    }
  });
}

/**
 * Install MCP server to Cursor config file.
 */
function installMcpToCursorConfig(server: InstalledMcpServer, versionHome: string): void {
  const configPath = path.join(versionHome, '.cursor', 'mcp.json');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const mcpServers = config.mcpServers as Record<string, unknown>;

  if (server.config.transport === 'stdio') {
    mcpServers[server.name] = {
      command: server.config.command,
      args: server.config.args || [],
      env: server.config.env || {},
    };
  } else {
    mcpServers[server.name] = {
      url: server.config.url,
    };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Install MCP server to OpenCode config file.
 */
function installMcpToKimiConfig(server: InstalledMcpServer, versionHome: string): void {
  const configPath = path.join(versionHome, '.kimi-code', 'mcp.json');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const mcpServers = config.mcpServers as Record<string, unknown>;

  if (server.config.transport === 'stdio') {
    mcpServers[server.name] = {
      command: server.config.command,
      args: server.config.args || [],
      env: server.config.env || {},
    };
  } else {
    mcpServers[server.name] = {
      url: server.config.url,
    };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Install MCP server to Factory AI Droid config (`~/.factory/mcp.json`).
 * Droid uses the standard `mcpServers` JSON shape, same as Kimi/Claude.
 */
function installMcpToFactoryConfig(server: InstalledMcpServer, versionHome: string): void {
  const configPath = path.join(versionHome, '.factory', 'mcp.json');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const mcpServers = config.mcpServers as Record<string, unknown>;

  if (server.config.transport === 'stdio') {
    mcpServers[server.name] = {
      command: server.config.command,
      args: server.config.args || [],
      env: server.config.env || {},
    };
  } else {
    mcpServers[server.name] = {
      url: server.config.url,
    };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

function installMcpToOpenCodeConfig(server: InstalledMcpServer, versionHome: string): void {
  const configPath = path.join(versionHome, '.opencode', 'opencode.jsonc');

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    // Strip JSONC comments
    const jsonContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    try {
      config = JSON.parse(jsonContent);
    } catch {
      config = {};
    }
  }

  if (!config.mcp || typeof config.mcp !== 'object') {
    config.mcp = {};
  }

  const mcpServers = config.mcp as Record<string, unknown>;

  if (server.config.transport === 'stdio') {
    // OpenCode uses command as array
    const commandArray = [server.config.command, ...(server.config.args || [])];
    mcpServers[server.name] = {
      type: 'local',
      command: commandArray,
      ...(server.config.env && { env: server.config.env }),
    };
  } else {
    mcpServers[server.name] = {
      type: 'remote',
      url: server.config.url,
    };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Install MCP servers to an agent.
 * For Claude/Codex: uses CLI commands (claude mcp add, codex mcp add)
 * For others: edits config files directly
 */
export function installMcpServers(
  agentId: AgentId,
  version: string,
  versionHome: string,
  mcpNames?: string[],
  options: { cwd?: string } = {}
): { success: boolean; applied: string[]; errors: string[] } {
  if (!isCapable(agentId, 'mcp')) {
    return { success: true, applied: [], errors: [] };
  }

  const servers = getMcpServersByName(mcpNames, { cwd: options.cwd });
  if (servers.length === 0) {
    return { success: true, applied: [], errors: [] };
  }

  const applied: string[] = [];
  const errors: string[] = [];

  // Get binary path for CLI-based agents. On Windows npm drops a `.cmd` launcher
  // next to the extensionless POSIX wrapper in node_modules/.bin; prefer it so
  // the CLI is actually executable (the bare wrapper is a shell script).
  const cliCommand = AGENTS[agentId].cliCommand;
  let binaryPath = path.join(getVersionsDir(), agentId, version, 'node_modules', '.bin', cliCommand);
  if (IS_WINDOWS && fs.existsSync(binaryPath + '.cmd')) {
    binaryPath += '.cmd';
  }

  for (const server of servers) {
    try {
      if (agentId === 'claude') {
        installMcpViaClaude(binaryPath, server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'codex') {
        installMcpViaCodex(binaryPath, server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'gemini') {
        installMcpToGeminiConfig(server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'cursor') {
        installMcpToCursorConfig(server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'opencode') {
        installMcpToOpenCodeConfig(server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'grok') {
        // Grok primarily uses [mcp_servers] in ~/.grok/config.toml (or project .grok/config.toml).
        // We have the path helper; full writer can be added (reuse codex toml pattern).
        // For now the general sync + toml editing via agents mcp works via the path helpers.
        applied.push(server.name);
      } else if (agentId === 'kimi') {
        installMcpToKimiConfig(server, versionHome);
        applied.push(server.name);
      } else if (agentId === 'droid') {
        installMcpToFactoryConfig(server, versionHome);
        applied.push(server.name);
      }
    } catch (err) {
      const message = (err as Error).message;
      // Check if it's an "already exists" error - that's not a real error
      if (message.includes('already exists') || message.includes('already configured')) {
        applied.push(server.name); // Count as applied since it's already there
      } else {
        errors.push(`${server.name}: ${message}`);
      }
    }
  }

  return { success: errors.length === 0, applied, errors };
}

/**
 * Write an MCP server config to ~/.agents/mcp/.
 */
export function writeMcpServerConfig(config: McpYamlConfig): string {
  const mcpDir = getUserMcpDir();
  fs.mkdirSync(mcpDir, { recursive: true });

  const fileName = `${config.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}.yaml`;
  const filePath = path.join(mcpDir, fileName);

  const content = yaml.stringify(config);
  fs.writeFileSync(filePath, content, 'utf-8');

  return filePath;
}

/**
 * Remove an MCP server config from ~/.agents/mcp/.
 */
export function removeMcpServerConfig(name: string): boolean {
  const servers = listMcpServerConfigs();
  const server = servers.find((s) => s.name === name);
  if (!server) {
    return false;
  }

  fs.unlinkSync(server.path);
  return true;
}
