import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string };

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-non-interactive-'));
  // System dir: update-check and versions live here.
  // Needs a .git dir so ensureInitialized() doesn't block commands.
  const systemDir = path.join(home, '.agents-system');
  fs.mkdirSync(systemDir, { recursive: true });
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION.version }),
  );
  // User dir: commands, agents.yaml live here
  const userDir = path.join(home, '.agents');
  fs.mkdirSync(userDir, { recursive: true });
  return home;
}

function writeCentralCommand(home: string, name: string, description = 'Test command'): void {
  const commandsDir = path.join(home, '.agents', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, `${name}.md`),
    `---\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function writeFakeManagedVersion(
  home: string,
  agent: string,
  version: string,
  cliName: string,
  script: string = '#!/bin/sh\nexit 0\n',
): void {
  const binaryDir = path.join(home, '.agents', '.history', 'versions', agent, version, 'node_modules', '.bin');
  fs.mkdirSync(binaryDir, { recursive: true });
  const binaryPath = path.join(binaryDir, cliName);
  fs.writeFileSync(binaryPath, script);
  fs.chmodSync(binaryPath, 0o755);
}

function writeLoggingManagedVersion(
  home: string,
  agent: string,
  version: string,
  cliName: string,
  logPath: string,
): void {
  writeFakeManagedVersion(
    home,
    agent,
    version,
    cliName,
    `#!/bin/sh\necho \"$HOME|$@\" >> \"${logPath}\"\nexit 0\n`,
  );
}

function writeLocalPackageRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-package-repo-'));
  fs.mkdirSync(path.join(repo, 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'commands', 'review.md'),
    '---\ndescription: Review changes\n---\n\n# review\n',
  );
  return repo;
}

function runAgents(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      SHELL: '/bin/zsh',
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
}

function seedNewerUpdateCache(home: string, futureVersion: string): void {
  const cacheDir = path.join(home, '.agents', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: futureVersion }),
  );
}

const tempHomes: string[] = [];
const tempRepos: string[] = [];

afterEach(() => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop()!;
    fs.rmSync(home, { recursive: true, force: true });
  }
  while (tempRepos.length > 0) {
    const repo = tempRepos.pop()!;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

describe('non-interactive CLI usage', () => {
  it('shows a plain hint instead of opening a picker', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');

    const result = runAgents(home, ['commands', 'view']);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(combined).toContain('Selecting a command to view requires an interactive terminal.');
    expect(combined).toContain('agents commands view README');
  });

  it('syncs central commands with --names in a non-interactive shell', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');

    const result = runAgents(home, ['commands', 'add', '--names', 'README', '--agents', 'codex']);
    const targetPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'README.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commands installed.');
    expect(fs.existsSync(targetPath)).toBe(true);
  });

  it('syncs only the requested explicit version target', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    writeFakeManagedVersion(home, 'codex', '0.2.0', 'codex');

    const result = runAgents(home, ['commands', 'add', '--names', 'README', '--agents', 'codex@0.2.0']);
    const requestedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.2.0',
      'home',
      '.codex',
      'prompts',
      'README.md',
    );
    const untouchedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'README.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Commands installed.');
    expect(fs.existsSync(requestedPath)).toBe(true);
    expect(fs.existsSync(untouchedPath)).toBe(false);
  });

  it('uses defaults automatically for version switching in a non-interactive shell', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    writeCentralCommand(home, 'README');
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');

    const result = runAgents(home, ['use', 'codex@0.1.0']);
    const agentsYaml = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    const codexSymlink = path.join(home, '.codex');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Set Codex@0.1.0 as global default');
    expect(agentsYaml).toContain('codex: 0.1.0');
    expect(fs.lstatSync(codexSymlink).isSymbolicLink()).toBe(true);
  });

  it('installs package repo contents only to the requested explicit version target', () => {
    const home = makeTempHome();
    const repo = writeLocalPackageRepo();
    tempHomes.push(home);
    tempRepos.push(repo);
    writeFakeManagedVersion(home, 'codex', '0.1.0', 'codex');
    writeFakeManagedVersion(home, 'codex', '0.2.0', 'codex');

    const result = runAgents(home, ['install', repo, '--agents', 'codex@0.2.0']);
    const requestedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.2.0',
      'home',
      '.codex',
      'prompts',
      'review.md',
    );
    const untouchedPath = path.join(
      home,
      '.agents',
      '.history',
      'versions',
      'codex',
      '0.1.0',
      'home',
      '.codex',
      'prompts',
      'review.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Package installed.');
    expect(fs.existsSync(requestedPath)).toBe(true);
    expect(fs.existsSync(untouchedPath)).toBe(false);
  });

  it('registers MCPs only against the requested explicit version target', () => {
    const home = makeTempHome();
    const logPath = path.join(home, 'mcp-register.log');
    tempHomes.push(home);
    writeLoggingManagedVersion(home, 'codex', '0.1.0', 'codex', logPath);
    writeLoggingManagedVersion(home, 'codex', '0.2.0', 'codex', logPath);

    const addResult = runAgents(home, ['mcp', 'add', 'demo', '--agents', 'codex@0.2.0', '--', 'demo-server']);
    const registerResult = runAgents(home, ['mcp', 'register', 'demo']);
    const manifest = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    const log = fs.readFileSync(logPath, 'utf-8');

    expect(addResult.status).toBe(0);
    expect(registerResult.status).toBe(0);
    expect(manifest).toContain('mcp:');
    expect(manifest).toContain('demo:');
    expect(manifest).toContain('codex:');
    expect(manifest).toContain('- 0.2.0');
    expect(log).toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home'));
    expect(log).toContain('mcp add demo -- demo-server');
    expect(log).not.toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home'));
  });

  it('removes MCPs only from the requested explicit version target', () => {
    const home = makeTempHome();
    const logPath = path.join(home, 'mcp-remove.log');
    tempHomes.push(home);
    writeLoggingManagedVersion(home, 'codex', '0.1.0', 'codex', logPath);
    writeLoggingManagedVersion(home, 'codex', '0.2.0', 'codex', logPath);

    // Pre-register 'demo' in codex 0.2.0's MCP config so mcp remove can find it.
    const versionHome02 = path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home');
    const codexConfigDir = path.join(versionHome02, '.codex');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexConfigDir, 'config.toml'),
      '[mcp_servers]\n[mcp_servers.demo]\ncommand = "demo-server"\nargs = []\n',
    );

    const result = runAgents(home, ['mcp', 'remove', 'demo', '--agents', 'codex@0.2.0']);
    const log = fs.readFileSync(logPath, 'utf-8');

    expect(result.status).toBe(0);
    expect(log).toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.2.0', 'home'));
    expect(log).toContain('mcp remove demo');
    expect(log).not.toContain(path.join(home, '.agents', '.history', 'versions', 'codex', '0.1.0', 'home'));
  });

  it('AGENTS_CLI_DISABLE_AUTO_UPDATE skips the update check when a newer version is cached', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    seedNewerUpdateCache(home, '99.0.0');

    const result = runAgents(home, ['view'], { AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' });
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(combined).not.toContain('Update available');
  });

  it('prints the non-TTY hint (not an interactive picker) when a newer version is cached', () => {
    const home = makeTempHome();
    tempHomes.push(home);
    seedNewerUpdateCache(home, '99.0.0');

    const result = runAgents(home, ['view']);
    const combined = `${result.stdout}\n${result.stderr}`;

    expect(combined).toContain(`Update available: ${PACKAGE_VERSION.version} -> 99.0.0`);
    expect(combined).not.toContain('Upgrade now');
  });
});
