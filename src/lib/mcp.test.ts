import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMcpServerConfig, buildWorkflowMcpConfig, type InstalledMcpServer } from './mcp.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-mcp-'));
  tempDirs.push(dir);
  return dir;
}

function writeVersionBinary(home: string, agent: string, version: string, command: string): string {
  const binary = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin', command);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    [
      '#!/bin/sh',
      'for arg do',
      '  printf "ARG:%s\\n" "$arg" >> "$LOG_PATH"',
      'done',
      '',
    ].join('\n'),
    'utf-8'
  );
  fs.chmodSync(binary, 0o755);
  return binary;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MCP sync execution', () => {
  it('rejects YAML configs whose args are not string arrays', () => {
    const home = makeTempHome();
    const configPath = path.join(home, 'bad.yaml');
    fs.writeFileSync(
      configPath,
      [
        'name: bad',
        'transport: stdio',
        'command: npx',
        'args: "-y bad"',
        '',
      ].join('\n'),
      'utf-8'
    );

    expect(() => parseMcpServerConfig(configPath)).toThrow('args must be a string array');
  });

  it('installs Codex MCP servers with argv, not a shell command string', async () => {
    const home = makeTempHome();
    const version = '0.1.0';
    const logPath = path.join(home, 'argv.log');
    const pwnedPath = path.join(home, 'pwned');
    writeVersionBinary(home, 'codex', version, 'codex');

    const mcpDir = path.join(home, '.agents', 'mcp');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(
      path.join(mcpDir, 'demo.yaml'),
      [
        'name: demo',
        'transport: stdio',
        'command: "/bin/echo; touch"',
        `args: ["${pwnedPath}"]`,
        '',
      ].join('\n'),
      'utf-8'
    );

    const moduleUrl = pathToFileURL(path.resolve('dist/lib/mcp.js')).href;
    const versionHome = path.join(home, '.agents', '.history', 'versions', 'codex', version, 'home');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { installMcpServers } from ${JSON.stringify(moduleUrl)};
      const result = installMcpServers('codex', ${JSON.stringify(version)}, ${JSON.stringify(versionHome)});
      console.log(JSON.stringify(result));
    `], {
      env: { ...process.env, HOME: home, LOG_PATH: logPath },
      encoding: 'utf-8',
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(result.success).toBe(true);
    expect(fs.existsSync(pwnedPath)).toBe(false);
    expect(log).toContain('ARG:mcp\nARG:add\nARG:demo');
    expect(log).toContain('ARG:/bin/echo; touch');
    expect(log).toContain(`ARG:${pwnedPath}`);
  });
});

describe('buildWorkflowMcpConfig', () => {
  const stdio = (name: string, extra: Partial<InstalledMcpServer['config']> = {}): InstalledMcpServer => ({
    name,
    path: `/x/${name}.yaml`,
    config: { name, transport: 'stdio', command: 'node', ...extra },
  });

  it('emits the { mcpServers: { name: { command, args, env } } } shape Claude expects', () => {
    const json = buildWorkflowMcpConfig([
      stdio('github', { args: ['server.js'], env: { TOKEN: 'x' } }),
    ]);
    expect(JSON.parse(json)).toEqual({
      mcpServers: { github: { command: 'node', args: ['server.js'], env: { TOKEN: 'x' } } },
    });
  });

  it('omits empty args/env and maps http transport to { url }', () => {
    const json = buildWorkflowMcpConfig([
      stdio('bare'),
      { name: 'remote', path: '/x/remote.yaml', config: { name: 'remote', transport: 'http', url: 'https://e.x/mcp' } },
    ]);
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        bare: { command: 'node' },
        remote: { url: 'https://e.x/mcp' },
      },
    });
  });

  it('returns an empty mcpServers map for no servers', () => {
    expect(JSON.parse(buildWorkflowMcpConfig([]))).toEqual({ mcpServers: {} });
  });
});
