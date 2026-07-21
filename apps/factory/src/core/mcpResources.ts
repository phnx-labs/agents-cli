import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import * as yaml from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Resource, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerEntry {
  name: string;
  path: string;
  scope: 'project' | 'user' | 'system';
  config: McpServerConfig;
}

export interface McpResourceItem {
  serverName: string;
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceServerStatus {
  name: string;
  scope: 'project' | 'user' | 'system';
  connected: boolean;
  error?: string;
}

export interface McpResourceListResult {
  servers: McpResourceServerStatus[];
  resources: McpResourceItem[];
}

export interface McpResourceReadResult {
  serverName: string;
  uri: string;
  contents: ReadResourceResult['contents'];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

function mergeEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return { ...env, ...(overrides ?? {}) };
}

function parseMcpServerConfig(filePath: string): McpServerConfig | null {
  let parsed: unknown;
  try {
    parsed = yaml.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) return null;
  if (raw.transport !== 'stdio' && raw.transport !== 'http' && raw.transport !== 'sse') return null;

  const config: McpServerConfig = { name: raw.name, transport: raw.transport };
  if (raw.transport === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.trim().length === 0) return null;
    config.command = raw.command;
    if (Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === 'string')) config.args = raw.args;
    if (isStringRecord(raw.env)) config.env = raw.env;
  } else {
    if (typeof raw.url !== 'string' || raw.url.trim().length === 0) return null;
    config.url = raw.url;
    if (isStringRecord(raw.headers)) config.headers = raw.headers;
  }
  return config;
}

function listYamlConfigs(dir: string, scope: McpServerEntry['scope']): McpServerEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: McpServerEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml'))) continue;
    const filePath = path.join(dir, entry.name);
    const config = parseMcpServerConfig(filePath);
    if (config) results.push({ name: config.name, path: filePath, scope, config });
  }
  return results;
}

export function listMcpServerEntries(workspacePath?: string): McpServerEntry[] {
  const dirs: Array<{ dir: string; scope: McpServerEntry['scope'] }> = [];
  if (workspacePath) dirs.push({ dir: path.join(workspacePath, '.agents', 'mcp'), scope: 'project' });
  dirs.push({ dir: path.join(homedir(), '.agents', 'mcp'), scope: 'user' });
  dirs.push({ dir: path.join(homedir(), '.agents', '.system', 'mcp'), scope: 'system' });

  const byName = new Map<string, McpServerEntry>();
  for (const { dir, scope } of dirs) {
    for (const server of listYamlConfigs(dir, scope)) {
      if (!byName.has(server.name)) byName.set(server.name, server);
    }
  }
  return Array.from(byName.values());
}

async function withMcpClient<T>(server: McpServerEntry, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'factory-resources', version: '0.1.0' });
  const headers = server.config.headers ? { headers: server.config.headers } : undefined;
  const transport = server.config.transport === 'stdio'
    ? new StdioClientTransport({
        command: server.config.command!,
        args: server.config.args ?? [],
        env: mergeEnv(server.config.env),
        stderr: 'pipe',
      })
    : server.config.transport === 'sse'
      ? new SSEClientTransport(new URL(server.config.url!), { requestInit: headers })
      : new StreamableHTTPClientTransport(new URL(server.config.url!), { requestInit: headers });

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function toResourceItem(serverName: string, resource: Resource): McpResourceItem {
  return {
    serverName,
    uri: resource.uri,
    name: resource.name,
    title: resource.title,
    description: resource.description,
    mimeType: resource.mimeType,
    size: resource.size,
  };
}

export async function listMcpResources(workspacePath?: string): Promise<McpResourceListResult> {
  const servers = listMcpServerEntries(workspacePath);
  const statuses: McpResourceServerStatus[] = [];
  const resources: McpResourceItem[] = [];

  await Promise.all(servers.map(async (server) => {
    try {
      const listed = await withMcpClient(server, (client) => client.listResources({}, { timeout: 10_000 }));
      resources.push(...listed.resources.map((resource) => toResourceItem(server.name, resource)));
      statuses.push({ name: server.name, scope: server.scope, connected: true });
    } catch (error) {
      statuses.push({
        name: server.name,
        scope: server.scope,
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  resources.sort((a, b) => `${a.serverName}:${a.name}`.localeCompare(`${b.serverName}:${b.name}`));
  statuses.sort((a, b) => a.name.localeCompare(b.name));
  return { servers: statuses, resources };
}

export async function readMcpResource(
  serverName: string,
  uri: string,
  workspacePath?: string,
): Promise<McpResourceReadResult> {
  const server = listMcpServerEntries(workspacePath).find((entry) => entry.name === serverName);
  if (!server) throw new Error(`MCP server not found: ${serverName}`);
  const result = await withMcpClient(server, (client) => client.readResource({ uri }, { timeout: 10_000 }));
  return { serverName, uri, contents: result.contents };
}
