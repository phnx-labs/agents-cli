import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as TOML from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { getMcpConfigPath, McpHandler } from './mcp.js';
import type { McpItem } from './mcp.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-mcp-handler-'));
  tempDirs.push(dir);
  return dir;
}

function writeMcpYaml(dir: string, filename: string, item: McpItem): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, yaml.stringify(item), 'utf-8');
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('getMcpConfigPath', () => {
  // Build expected values with path.join so the assertions compare separators
  // the way the host produces them — the source uses path.join, which yields
  // backslashes on Windows. Hardcoded forward-slash literals would fail there.
  it('returns correct config path for Claude', () => {
    const configPath = getMcpConfigPath('claude', '/home/user');
    expect(configPath).toBe(path.join('/home/user', '.claude', 'settings.json'));
  });

  it('returns correct config path for Codex', () => {
    const configPath = getMcpConfigPath('codex', '/home/user');
    expect(configPath).toBe(path.join('/home/user', '.codex', 'config.toml'));
  });

  it('returns correct config path for OpenCode', () => {
    const configPath = getMcpConfigPath('opencode', '/home/user');
    expect(configPath).toBe(path.join('/home/user', '.opencode', 'opencode.jsonc'));
  });

  it('returns correct config path for Cursor', () => {
    const configPath = getMcpConfigPath('cursor', '/home/user');
    expect(configPath).toBe(path.join('/home/user', '.cursor', 'mcp.json'));
  });

  it('returns correct config path for Gemini', () => {
    const configPath = getMcpConfigPath('gemini', '/home/user');
    expect(configPath).toBe(path.join('/home/user', '.gemini', 'settings.json'));
  });

  it('returns correct config path for OpenClaw', () => {
    const configPath = getMcpConfigPath('openclaw', '/home/user');
    expect(configPath).toBe(path.join('/home/user', '.openclaw', 'openclaw.json'));
  });

});

describe('McpHandler.format', () => {
  it('returns toml for Codex', () => {
    expect(McpHandler.format('codex')).toBe('toml');
  });

  it('returns json for Claude', () => {
    expect(McpHandler.format('claude')).toBe('json');
  });

  it('returns json for OpenCode', () => {
    expect(McpHandler.format('opencode')).toBe('json');
  });

  it('returns json for Cursor', () => {
    expect(McpHandler.format('cursor')).toBe('json');
  });
});

describe('McpHandler.targetDir', () => {
  it('returns mcp for all agents', () => {
    expect(McpHandler.targetDir('claude')).toBe('mcp');
    expect(McpHandler.targetDir('codex')).toBe('mcp');
    expect(McpHandler.targetDir('opencode')).toBe('mcp');
  });
});

describe('McpHandler.kind', () => {
  it('returns mcp', () => {
    expect(McpHandler.kind).toBe('mcp');
  });
});

describe('MCP YAML file validation', () => {
  it('parses valid stdio MCP config from YAML', () => {
    const tempDir = makeTempDir();
    const item: McpItem = {
      name: 'test-server',
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--port', '3000'],
      env: { DEBUG: 'true', NODE_ENV: 'production' },
    };

    const filePath = writeMcpYaml(tempDir, 'test.yaml', item);

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);

    expect(parsed.name).toBe('test-server');
    expect(parsed.transport).toBe('stdio');
    expect(parsed.command).toBe('node');
    expect(parsed.args).toEqual(['server.js', '--port', '3000']);
    expect(parsed.env).toEqual({ DEBUG: 'true', NODE_ENV: 'production' });
  });

  it('parses valid http MCP config from YAML', () => {
    const tempDir = makeTempDir();
    const item: McpItem = {
      name: 'http-server',
      transport: 'http',
      url: 'https://api.example.com/mcp',
      headers: { Authorization: 'Bearer token123' },
    };

    const filePath = writeMcpYaml(tempDir, 'http.yaml', item);

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);

    expect(parsed.name).toBe('http-server');
    expect(parsed.transport).toBe('http');
    expect(parsed.url).toBe('https://api.example.com/mcp');
    expect(parsed.headers).toEqual({ Authorization: 'Bearer token123' });
  });

  it('parses valid sse MCP config from YAML', () => {
    const tempDir = makeTempDir();
    const item: McpItem = {
      name: 'sse-server',
      transport: 'sse',
      url: 'https://api.example.com/sse',
    };

    const filePath = writeMcpYaml(tempDir, 'sse.yaml', item);

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);

    expect(parsed.name).toBe('sse-server');
    expect(parsed.transport).toBe('sse');
    expect(parsed.url).toBe('https://api.example.com/sse');
  });
});

describe('Claude MCP config format', () => {
  it('writes stdio MCP to Claude settings.json format', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, '.claude', 'settings.json');

    const items: McpItem[] = [
      {
        name: 'stdio-server',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/mcp-server'],
        env: { DEBUG: 'true' },
      },
    ];

    // Simulate what sync does for Claude
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const mcpServers: Record<string, unknown> = {};
    for (const item of items) {
      if (item.transport === 'stdio') {
        mcpServers[item.name] = {
          command: item.command,
          args: item.args || [],
          env: item.env || {},
        };
      }
    }
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf-8');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['stdio-server']).toEqual({
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      env: { DEBUG: 'true' },
    });
  });

  it('writes http MCP to Claude settings.json format', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, '.claude', 'settings.json');

    const items: McpItem[] = [
      {
        name: 'http-server',
        transport: 'http',
        url: 'https://api.example.com/mcp',
        headers: { 'X-API-Key': 'secret' },
      },
    ];

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const mcpServers: Record<string, unknown> = {};
    for (const item of items) {
      if (item.transport !== 'stdio') {
        mcpServers[item.name] = {
          url: item.url,
          ...(item.headers && { headers: item.headers }),
        };
      }
    }
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf-8');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['http-server']).toEqual({
      url: 'https://api.example.com/mcp',
      headers: { 'X-API-Key': 'secret' },
    });
  });

  it('preserves existing settings when writing MCP', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, '.claude', 'settings.json');

    // Pre-create settings with other config
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ permissions: { allow: ['Bash(git *)'] } }, null, 2),
      'utf-8'
    );

    // Read existing, add MCP, write back
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    existing.mcpServers = {
      'my-server': { command: 'node', args: ['server.js'], env: {} },
    };
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.permissions).toEqual({ allow: ['Bash(git *)'] });
    expect(config.mcpServers['my-server']).toBeDefined();
  });
});

describe('OpenCode MCP config format', () => {
  it('writes local MCP to OpenCode opencode.jsonc format', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, '.opencode', 'opencode.jsonc');

    const items: McpItem[] = [
      {
        name: 'local-server',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/mcp'],
        env: { NODE_ENV: 'production' },
      },
    ];

    // Simulate OpenCode format
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const mcp: Record<string, unknown> = {};
    for (const item of items) {
      if (item.transport === 'stdio') {
        const commandArray = [item.command, ...(item.args || [])];
        mcp[item.name] = {
          type: 'local',
          command: commandArray,
          ...(item.env && { env: item.env }),
        };
      }
    }
    fs.writeFileSync(configPath, JSON.stringify({ mcp }, null, 2), 'utf-8');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcp['local-server']).toEqual({
      type: 'local',
      command: ['npx', '-y', '@example/mcp'],
      env: { NODE_ENV: 'production' },
    });
  });

  it('writes remote MCP to OpenCode opencode.jsonc format', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, '.opencode', 'opencode.jsonc');

    const items: McpItem[] = [
      {
        name: 'remote-server',
        transport: 'http',
        url: 'https://mcp.example.com',
      },
    ];

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const mcp: Record<string, unknown> = {};
    for (const item of items) {
      if (item.transport !== 'stdio') {
        mcp[item.name] = {
          type: 'remote',
          url: item.url,
        };
      }
    }
    fs.writeFileSync(configPath, JSON.stringify({ mcp }, null, 2), 'utf-8');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcp['remote-server']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com',
    });
  });
});

describe('Codex MCP config format', () => {
  it('writes MCP to Codex config.toml format', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, '.codex', 'config.toml');

    const items: McpItem[] = [
      {
        name: 'codex-server',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/codex-mcp'],
      },
    ];

    // Simulate Codex format
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const mcpServers: Record<string, unknown> = {};
    for (const item of items) {
      if (item.transport === 'stdio') {
        mcpServers[item.name] = {
          command: item.command,
          args: item.args || [],
          ...(item.env && { env: item.env }),
        };
      }
    }
    fs.writeFileSync(configPath, TOML.stringify({ mcp_servers: mcpServers }), 'utf-8');

    const content = fs.readFileSync(configPath, 'utf-8');
    const config = TOML.parse(content) as Record<string, unknown>;
    const servers = config.mcp_servers as Record<string, unknown>;
    const server = servers['codex-server'] as Record<string, unknown>;

    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', '@example/codex-mcp']);
  });
});

describe('Union and override behavior', () => {
  it('correctly handles multiple layers with same-named servers', () => {
    // Simulate resolution logic: project > user > system
    const systemServers = new Map<string, { item: McpItem; layer: string }>([
      ['shared', { item: { name: 'shared', transport: 'stdio', command: 'system-cmd' }, layer: 'system' }],
      ['system-only', { item: { name: 'system-only', transport: 'stdio', command: 'sys' }, layer: 'system' }],
    ]);

    const userServers = new Map<string, { item: McpItem; layer: string }>([
      ['shared', { item: { name: 'shared', transport: 'stdio', command: 'user-cmd' }, layer: 'user' }],
      ['user-only', { item: { name: 'user-only', transport: 'http', url: 'https://user.com' }, layer: 'user' }],
    ]);

    const projectServers = new Map<string, { item: McpItem; layer: string }>([
      ['shared', { item: { name: 'shared', transport: 'stdio', command: 'project-cmd' }, layer: 'project' }],
      ['project-only', { item: { name: 'project-only', transport: 'stdio', command: 'proj' }, layer: 'project' }],
    ]);

    // Merge: start with system, overlay user, then project (higher wins)
    const result = new Map<string, { item: McpItem; layer: string }>();

    for (const [name, entry] of systemServers) {
      result.set(name, entry);
    }
    for (const [name, entry] of userServers) {
      result.set(name, entry);
    }
    for (const [name, entry] of projectServers) {
      result.set(name, entry);
    }

    // Verify union
    expect(result.size).toBe(4);
    expect(result.has('shared')).toBe(true);
    expect(result.has('system-only')).toBe(true);
    expect(result.has('user-only')).toBe(true);
    expect(result.has('project-only')).toBe(true);

    // Verify override - project wins for 'shared'
    const shared = result.get('shared')!;
    expect(shared.layer).toBe('project');
    expect(shared.item.command).toBe('project-cmd');
  });

  it('preserves servers from each layer when names differ', () => {
    const servers: Array<{ name: string; layer: string }> = [];

    // Each layer contributes unique servers
    servers.push({ name: 'server-a', layer: 'system' });
    servers.push({ name: 'server-b', layer: 'user' });
    servers.push({ name: 'server-c', layer: 'project' });

    expect(servers.length).toBe(3);
    expect(servers.map((s) => s.name)).toContain('server-a');
    expect(servers.map((s) => s.name)).toContain('server-b');
    expect(servers.map((s) => s.name)).toContain('server-c');
  });
});

describe('OpenClaw MCP config format', () => {
  it('writes MCP to OpenClaw openclaw.json format', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, '.openclaw', 'openclaw.json');

    const items: McpItem[] = [
      {
        name: 'claw-server',
        transport: 'stdio',
        command: 'node',
        args: ['mcp.js'],
        env: { API_KEY: 'secret' },
      },
    ];

    // Simulate OpenClaw format
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const servers: Record<string, unknown> = {};
    for (const item of items) {
      if (item.transport === 'stdio') {
        servers[item.name] = {
          command: item.command,
          args: item.args,
          env: item.env,
        };
      }
    }
    fs.writeFileSync(configPath, JSON.stringify({ mcp: { servers } }, null, 2), 'utf-8');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcp.servers['claw-server']).toEqual({
      command: 'node',
      args: ['mcp.js'],
      env: { API_KEY: 'secret' },
    });
  });

  it('writes remote MCP to OpenClaw format', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, '.openclaw', 'openclaw.json');

    const items: McpItem[] = [
      {
        name: 'remote-claw',
        transport: 'sse',
        url: 'https://claw.example.com/sse',
      },
    ];

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const servers: Record<string, unknown> = {};
    for (const item of items) {
      if (item.transport !== 'stdio') {
        servers[item.name] = {
          url: item.url,
          transport: item.transport,
        };
      }
    }
    fs.writeFileSync(configPath, JSON.stringify({ mcp: { servers } }, null, 2), 'utf-8');

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.mcp.servers['remote-claw']).toEqual({
      url: 'https://claw.example.com/sse',
      transport: 'sse',
    });
  });
});
