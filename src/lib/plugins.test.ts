/**
 * Tests for the plugin sync, discovery, and install/update functions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  loadPluginManifest,
  discoverPluginCommands,
  discoverPluginAgentDefs,
  discoverPluginBin,
  expandPluginVars,
  loadUserConfig,
  saveUserConfig,
  checkPluginDependencies,
  parseInstallSpec,
} from './plugins.js';
import type { DiscoveredPlugin, PluginManifest } from './types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePluginRoot(tmpDir: string, manifest: Partial<PluginManifest> = {}): string {
  const root = path.join(tmpDir, 'test-plugin');
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.0.0', description: 'Test', ...manifest }),
    'utf-8'
  );
  return root;
}

function makeDiscoveredPlugin(root: string, manifest: PluginManifest): DiscoveredPlugin {
  return {
    name: manifest.name,
    root,
    manifest,
    skills: [],
    hooks: [],
    scripts: [],
    commands: [],
    agentDefs: [],
    bin: [],
    hasMcp: false,
    hasSettings: false,
  };
}

// ─── loadPluginManifest ───────────────────────────────────────────────────────

describe('loadPluginManifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when manifest does not exist', () => {
    const root = path.join(tmpDir, 'empty');
    fs.mkdirSync(root);
    expect(loadPluginManifest(root)).toBeNull();
  });

  it('returns null for manifest missing required fields', () => {
    const root = path.join(tmpDir, 'bad');
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x' }));
    expect(loadPluginManifest(root)).toBeNull();
  });

  it('returns null for plugin names with path traversal', () => {
    const root = path.join(tmpDir, 'bad');
    fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: '../evil', version: '1.0.0', description: 'x' })
    );
    expect(loadPluginManifest(root)).toBeNull();
  });

  it('returns manifest for a valid plugin.json', () => {
    const root = makePluginRoot(tmpDir);
    const manifest = loadPluginManifest(root);
    expect(manifest).not.toBeNull();
    expect(manifest?.name).toBe('test-plugin');
    expect(manifest?.version).toBe('1.0.0');
  });

  it('returns userConfig and dependencies when present', () => {
    const root = makePluginRoot(tmpDir, {
      userConfig: [{ key: 'api_key', description: 'API key', required: true }],
      dependencies: ['other-plugin'],
    });
    const manifest = loadPluginManifest(root);
    expect(manifest?.userConfig).toHaveLength(1);
    expect(manifest?.userConfig?.[0].key).toBe('api_key');
    expect(manifest?.dependencies).toEqual(['other-plugin']);
  });
});

// ─── discoverPluginCommands ───────────────────────────────────────────────────

describe('discoverPluginCommands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when commands/ does not exist', () => {
    expect(discoverPluginCommands(tmpDir)).toEqual([]);
  });

  it('returns .md file names without extension', () => {
    const commandsDir = path.join(tmpDir, 'commands');
    fs.mkdirSync(commandsDir);
    fs.writeFileSync(path.join(commandsDir, 'deploy.md'), '# Deploy');
    fs.writeFileSync(path.join(commandsDir, 'test.md'), '# Test');
    fs.writeFileSync(path.join(commandsDir, '.hidden.md'), '# Hidden');
    fs.writeFileSync(path.join(commandsDir, 'readme.txt'), 'txt');

    const commands = discoverPluginCommands(tmpDir);
    expect(commands).toContain('deploy');
    expect(commands).toContain('test');
    expect(commands).not.toContain('.hidden');
    expect(commands).not.toContain('readme.txt');
  });
});

// ─── discoverPluginAgentDefs ──────────────────────────────────────────────────

describe('discoverPluginAgentDefs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when agents/ does not exist', () => {
    expect(discoverPluginAgentDefs(tmpDir)).toEqual([]);
  });

  it('returns .md file names without extension', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, 'reviewer.md'), '# Reviewer');
    fs.writeFileSync(path.join(agentsDir, '.hidden.md'), '# Hidden');

    const defs = discoverPluginAgentDefs(tmpDir);
    expect(defs).toEqual(['reviewer']);
  });
});

// ─── discoverPluginBin ────────────────────────────────────────────────────────

describe('discoverPluginBin', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when bin/ does not exist', () => {
    expect(discoverPluginBin(tmpDir)).toEqual([]);
  });

  it('returns all non-hidden files in bin/', () => {
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'my-tool'), '#!/bin/bash\necho hi');
    fs.writeFileSync(path.join(binDir, '.gitkeep'), '');

    const bins = discoverPluginBin(tmpDir);
    expect(bins).toContain('my-tool');
    expect(bins).not.toContain('.gitkeep');
  });
});

// ─── expandPluginVars ─────────────────────────────────────────────────────────

describe('expandPluginVars', () => {
  const pluginRoot = '/home/user/.agents/.cache/plugins/my-plugin';
  const versionHome = '/home/user/.agents/versions/claude/1.0.0/home';

  it('expands CLAUDE_PLUGIN_ROOT', () => {
    const result = expandPluginVars('root=${CLAUDE_PLUGIN_ROOT}', pluginRoot, 'my-plugin', 'claude', versionHome);
    expect(result).toBe(`root=${pluginRoot}`);
  });

  it('expands CLAUDE_PLUGIN_DATA', () => {
    const result = expandPluginVars('data=${CLAUDE_PLUGIN_DATA}', pluginRoot, 'my-plugin', 'claude', versionHome);
    const expected = path.join(versionHome, '.claude', 'plugin-data', 'my-plugin');
    expect(result).toBe(`data=${expected}`);
  });

  it('expands user_config keys when provided', () => {
    const userConfig = { api_key: 'secret-key', region: 'us-east-1' };
    const result = expandPluginVars(
      'key=${user_config.api_key} region=${user_config.region}',
      pluginRoot, 'my-plugin', 'claude', versionHome, userConfig
    );
    expect(result).toBe('key=secret-key region=us-east-1');
  });

  it('replaces missing user_config keys with empty string', () => {
    const userConfig = { api_key: 'k' };
    const result = expandPluginVars('x=${user_config.missing}', pluginRoot, 'my-plugin', 'claude', versionHome, userConfig);
    expect(result).toBe('x=');
  });

  it('does not expand user_config vars when userConfig is undefined', () => {
    const result = expandPluginVars('x=${user_config.key}', pluginRoot, 'my-plugin', 'claude', versionHome);
    expect(result).toBe('x=${user_config.key}');
  });

  it('expands multiple occurrences of the same variable', () => {
    const result = expandPluginVars(
      '${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_ROOT}',
      pluginRoot, 'my-plugin', 'claude', versionHome
    );
    expect(result).toBe(`${pluginRoot} and ${pluginRoot}`);
  });
});

// ─── loadUserConfig / saveUserConfig ─────────────────────────────────────────

describe('loadUserConfig / saveUserConfig', () => {
  let tmpDir: string;
  let origPluginsDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadUserConfig returns {} when file does not exist', () => {
    // Can't easily mock getPluginsDir, but we test the contract:
    // when called for a plugin with no .user-config.json, returns {}
    // We trust that getPluginsDir returns a path on disk
    // (a non-existent plugin dir → empty config)
    const config = loadUserConfig('nonexistent-plugin-xzy987');
    expect(config).toEqual({});
  });

  it('saveUserConfig writes valid JSON, loadUserConfig reads it back', async () => {
    // Write directly to the expected path (using the real getPluginsDir would
    // touch real FS state, so we test the round-trip via save then load).
    // This is an integration test against the real FS path.
    const pluginName = `_test-plugin-${Date.now()}`;
    const testConfig = { api_key: 'abc123', region: 'eu-west-1' };

    saveUserConfig(pluginName, testConfig);
    const loaded = loadUserConfig(pluginName);
    expect(loaded).toEqual(testConfig);

    // Cleanup
    const { getPluginsDir } = await import('./state.js');
    const pluginDir = path.join(getPluginsDir(), pluginName);
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  });
});

// ─── checkPluginDependencies ──────────────────────────────────────────────────

describe('checkPluginDependencies', () => {
  it('returns empty array when no dependencies declared', () => {
    const manifest: PluginManifest = { name: 'x', description: '', version: '1.0.0' };
    expect(checkPluginDependencies(manifest)).toEqual([]);
  });

  it('returns empty array when dependencies list is empty', () => {
    const manifest: PluginManifest = { name: 'x', description: '', version: '1.0.0', dependencies: [] };
    expect(checkPluginDependencies(manifest)).toEqual([]);
  });

  it('returns missing plugin names that are not installed', () => {
    // This relies on the real plugin discovery — in a clean test env
    // no plugins are installed, so any declared dep is "missing".
    const manifest: PluginManifest = {
      name: 'x', description: '', version: '1.0.0',
      dependencies: ['nonexistent-dep-xzy987'],
    };
    const missing = checkPluginDependencies(manifest);
    expect(missing).toContain('nonexistent-dep-xzy987');
  });
});

// ─── parseInstallSpec ─────────────────────────────────────────────────────────

describe('parseInstallSpec', () => {
  it('parses name@source form', () => {
    const result = parseInstallSpec('my-plugin@https://github.com/user/repo.git');
    expect(result.name).toBe('my-plugin');
    expect(result.source).toBe('https://github.com/user/repo.git');
  });

  it('returns null name for bare source without @', () => {
    const result = parseInstallSpec('/path/to/plugin');
    expect(result.name).toBeNull();
    expect(result.source).toBe('/path/to/plugin');
  });

  it('handles git@ SSH URLs without treating @ as separator (no name prefix)', () => {
    // git@github.com:user/repo.git — the atIdx is > 0, so it would be split.
    // This is a known limitation: git SSH URLs with no name prefix get split.
    // When using SSH URLs, users should always provide a name: name@git@host...
    const result = parseInstallSpec('git@github.com:user/repo.git');
    expect(result.name).toBe('git');
    expect(result.source).toBe('github.com:user/repo.git');
  });

  it('handles name@local-path', () => {
    const result = parseInstallSpec('rush-toolkit@~/Projects/rush-toolkit');
    expect(result.name).toBe('rush-toolkit');
    expect(result.source).toBe('~/Projects/rush-toolkit');
  });
});

// ─── syncPluginMcp (integration) ─────────────────────────────────────────────

describe('syncPluginMcp (via syncPluginToVersion)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges .mcp.json servers into settings.json with plugin name prefix', async () => {
    const pluginRoot = path.join(tmpDir, 'plugin');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'myplugin', version: '1.0.0', description: 'test' })
    );
    fs.writeFileSync(
      path.join(pluginRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'my-server': {
            command: 'node',
            args: ['${CLAUDE_PLUGIN_ROOT}/server.js'],
          },
        },
      })
    );

    const versionHome = path.join(tmpDir, 'version-home');
    fs.mkdirSync(path.join(versionHome, '.claude'), { recursive: true });

    const { syncPluginToVersion: sync } = await import('./plugins.js');
    const plugin: DiscoveredPlugin = {
      name: 'myplugin',
      root: pluginRoot,
      manifest: { name: 'myplugin', version: '1.0.0', description: 'test' },
      skills: [],
      hooks: [],
      scripts: [],
      commands: [],
      agentDefs: [],
      bin: [],
      hasMcp: true,
      hasSettings: false,
    };

    sync(plugin, 'claude', versionHome);

    const settingsPath = path.join(versionHome, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.mcpServers).toBeDefined();
    expect(settings.mcpServers['myplugin--my-server']).toBeDefined();
    expect(settings.mcpServers['myplugin--my-server'].command).toBe('node');
    // Verify variable expansion happened
    expect(settings.mcpServers['myplugin--my-server'].args[0]).toBe(`${pluginRoot}/server.js`);
  });
});

// ─── syncPluginSettings (integration) ────────────────────────────────────────

describe('syncPluginSettings (via syncPluginToVersion)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges non-permission keys from plugin settings.json non-destructively', async () => {
    const pluginRoot = path.join(tmpDir, 'plugin');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'settingsplugin', version: '1.0.0', description: 'test' })
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'settings.json'),
      JSON.stringify({ theme: 'dark', fontSize: 14, permissions: { allow: [] } })
    );

    const versionHome = path.join(tmpDir, 'version-home');
    const claudeDir = path.join(versionHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // Pre-existing settings.json with conflicting and non-conflicting keys
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ theme: 'light', existingKey: 'keep-me' })
    );

    const { syncPluginToVersion: sync } = await import('./plugins.js');
    const plugin: DiscoveredPlugin = {
      name: 'settingsplugin',
      root: pluginRoot,
      manifest: { name: 'settingsplugin', version: '1.0.0', description: 'test' },
      skills: [],
      hooks: [],
      scripts: [],
      commands: [],
      agentDefs: [],
      bin: [],
      hasMcp: false,
      hasSettings: true,
    };

    sync(plugin, 'claude', versionHome);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    // theme: 'light' should NOT be overwritten (non-destructive)
    expect(settings.theme).toBe('light');
    // fontSize: 14 should be added (new key)
    expect(settings.fontSize).toBe(14);
    // existingKey should be preserved
    expect(settings.existingKey).toBe('keep-me');
    // permissions key should be excluded from settings merge (handled separately)
    // no extra permissions key from settings merge
  });
});

// ─── removePluginFromVersion (integration) ────────────────────────────────────

describe('removePluginFromVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes namespaced MCP servers from settings.json', async () => {
    const { removePluginFromVersion: remove } = await import('./plugins.js');
    const pluginRoot = path.join(tmpDir, 'plugin');
    const versionHome = path.join(tmpDir, 'home');
    const claudeDir = path.join(versionHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          'myplugin--server-a': { command: 'node', args: [] },
          'other-server': { command: 'node', args: [] },
        },
      })
    );

    const result = remove('myplugin', pluginRoot, 'claude', versionHome);
    expect(result.mcp).toBe(1);

    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.mcpServers['myplugin--server-a']).toBeUndefined();
    expect(settings.mcpServers['other-server']).toBeDefined();
  });

  it('removes namespaced command files from commands dir', async () => {
    const { removePluginFromVersion: remove } = await import('./plugins.js');
    const { AGENTS } = await import('./agents.js');

    const pluginRoot = path.join(tmpDir, 'plugin');
    const versionHome = path.join(tmpDir, 'home');
    const agentConfig = AGENTS['claude'];
    const commandsDir = path.join(versionHome, '.claude', agentConfig.commandsSubdir);
    fs.mkdirSync(commandsDir, { recursive: true });

    fs.writeFileSync(path.join(commandsDir, 'myplugin--deploy.md'), '# deploy');
    fs.writeFileSync(path.join(commandsDir, 'other-cmd.md'), '# other');

    const result = remove('myplugin', pluginRoot, 'claude', versionHome);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toBe('myplugin--deploy.md');
    expect(fs.existsSync(path.join(commandsDir, 'myplugin--deploy.md'))).toBe(false);
    expect(fs.existsSync(path.join(commandsDir, 'other-cmd.md'))).toBe(true);
  });
});
