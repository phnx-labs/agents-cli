/**
 * Tests for PermissionsHandler.
 *
 * Uses real filesystem (temp dirs) per project conventions.
 * Tests union and override behavior across layers.
 * Uses subprocess isolation like commands.test.ts to control HOME env.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionsHandler } from './permissions.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-perms-handler-'));
  tempDirs.push(dir);
  return dir;
}

function writePermissionYaml(baseDir: string, subdir: string, name: string, content: object): void {
  const permDir = path.join(baseDir, subdir, 'permissions');
  fs.mkdirSync(permDir, { recursive: true });
  fs.writeFileSync(path.join(permDir, `${name}.yaml`), yaml.stringify(content), 'utf-8');
}

function runPermissionsExpression(home: string, expression: string, cwd?: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve('src/lib/resources/permissions.ts')).href;
  const tsxBin = path.resolve('node_modules/.bin/tsx');
  const child = spawnSync(tsxBin, ['-e', `
    import { PermissionsHandler } from ${JSON.stringify(moduleUrl)};
    const result = ${expression};
    console.log(JSON.stringify(result === undefined ? null : result));
  `], {
    env: { ...process.env, HOME: home },
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
  });

  if (child.status !== 0) {
    console.error('stderr:', child.stderr);
    throw new Error(`Subprocess failed with status ${child.status}: ${child.stderr}`);
  }
  return JSON.parse(child.stdout.trim());
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('PermissionsHandler', () => {
  describe('listAll', () => {
    it('unions permissions from system and user layers', () => {
      const home = makeTempHome();

      // Create system and user directories
      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

      // Create permissions in both layers
      writePermissionYaml(home, path.join('.agents', '.system'), 'base', {
        name: 'base',
        description: 'Base permissions',
        allow: ['Bash(git *)'],
      });

      writePermissionYaml(home, '.agents', 'custom', {
        name: 'custom',
        description: 'Custom permissions',
        allow: ['Bash(npm *)'],
      });

      const results = runPermissionsExpression(home, `PermissionsHandler.listAll('claude')`) as any[];

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name).sort()).toEqual(['base', 'custom']);

      const baseResult = results.find((r) => r.name === 'base');
      const customResult = results.find((r) => r.name === 'custom');

      expect(baseResult?.layer).toBe('system');
      expect(baseResult?.item.allow).toContain('Bash(git *)');

      expect(customResult?.layer).toBe('user');
      expect(customResult?.item.allow).toContain('Bash(npm *)');
    });

    it('user layer wins on name conflict', () => {
      const home = makeTempHome();

      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

      // Same name in both layers - user should win
      writePermissionYaml(home, path.join('.agents', '.system'), 'shared', {
        name: 'shared',
        description: 'System version',
        allow: ['Bash(git *)'],
      });

      writePermissionYaml(home, '.agents', 'shared', {
        name: 'shared',
        description: 'User version',
        allow: ['Bash(npm *)', 'Bash(yarn *)'],
      });

      const results = runPermissionsExpression(home, `PermissionsHandler.listAll('claude')`) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('shared');
      expect(results[0].layer).toBe('user');
      expect(results[0].item.description).toBe('User version');
      expect(results[0].item.allow).toContain('Bash(npm *)');
      expect(results[0].item.allow).not.toContain('Bash(git *)');
    });

    it('project layer overrides user and system', () => {
      const home = makeTempHome();
      const projectDir = makeTempHome();

      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, '.agents'), { recursive: true });

      writePermissionYaml(home, path.join('.agents', '.system'), 'perms', {
        name: 'perms',
        description: 'System',
        allow: ['Read(**)'],
      });

      writePermissionYaml(home, '.agents', 'perms', {
        name: 'perms',
        description: 'User',
        allow: ['Write(**)'],
      });

      writePermissionYaml(projectDir, '.agents', 'perms', {
        name: 'perms',
        description: 'Project',
        allow: ['Bash(*)'],
      });

      const results = runPermissionsExpression(
        home,
        `PermissionsHandler.listAll('claude', ${JSON.stringify(projectDir)})`,
        projectDir
      ) as any[];

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('perms');
      expect(results[0].layer).toBe('project');
      expect(results[0].item.description).toBe('Project');
      expect(results[0].item.allow).toContain('Bash(*)');
    });
  });

  describe('resolve', () => {
    it('returns null for non-existent permission', () => {
      const home = makeTempHome();

      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

      const result = runPermissionsExpression(home, `PermissionsHandler.resolve('claude', 'nonexistent')`);
      expect(result).toBeNull();
    });

    it('resolves from user layer when name exists in both', () => {
      const home = makeTempHome();

      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

      writePermissionYaml(home, path.join('.agents', '.system'), 'dev', {
        name: 'dev',
        description: 'System dev',
        allow: ['Bash(ls)'],
      });

      writePermissionYaml(home, '.agents', 'dev', {
        name: 'dev',
        description: 'User dev',
        allow: ['Bash(*)'],
      });

      const result = runPermissionsExpression(home, `PermissionsHandler.resolve('claude', 'dev')`) as any;

      expect(result).not.toBeNull();
      expect(result?.layer).toBe('user');
      expect(result?.item.description).toBe('User dev');
    });

    it('supports both .yaml and .yml extensions', () => {
      const home = makeTempHome();

      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

      // Write with .yml extension
      const permDir = path.join(home, '.agents', 'permissions');
      fs.mkdirSync(permDir, { recursive: true });
      fs.writeFileSync(
        path.join(permDir, 'test.yml'),
        yaml.stringify({ name: 'test', allow: ['Read(**)'] }),
        'utf-8'
      );

      const result = runPermissionsExpression(home, `PermissionsHandler.resolve('claude', 'test')`) as any;

      expect(result).not.toBeNull();
      expect(result?.item.allow).toContain('Read(**)');
    });
  });

  describe('sync', () => {
    it('merges all permissions and writes to Claude settings.json', () => {
      const home = makeTempHome();
      const versionHome = makeTempHome();

      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

      writePermissionYaml(home, path.join('.agents', '.system'), 'base', {
        name: 'base',
        allow: ['Read(**)', 'Bash(git *)'],
      });

      writePermissionYaml(home, '.agents', 'extra', {
        name: 'extra',
        allow: ['Bash(npm *)', 'Write(**)'],
        deny: ['Bash(rm -rf *)'],
      });

      runPermissionsExpression(home, `PermissionsHandler.sync('claude', ${JSON.stringify(versionHome)})`);

      // Check that settings.json was created with merged permissions
      const configPath = path.join(versionHome, '.claude', 'settings.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.permissions).toBeDefined();
      expect(config.permissions.allow).toContain('Read(**)');
      expect(config.permissions.allow).toContain('Bash(git *)');
      expect(config.permissions.allow).toContain('Bash(npm *)');
      expect(config.permissions.allow).toContain('Write(**)');
      expect(config.permissions.deny).toContain('Bash(rm -rf *)');
    });

    it('skips non-permission-capable agents', () => {
      const home = makeTempHome();
      const versionHome = makeTempHome();

      fs.mkdirSync(path.join(home, '.agents', '.system'), { recursive: true });
      fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

      writePermissionYaml(home, '.agents', 'test', {
        name: 'test',
        allow: ['Bash(*)'],
      });

      // Cursor doesn't support permissions (`allowlist: false` in the capability matrix).
      // Gemini was capable as of 236b4105 — pick an agent that's still on the
      // excluded list, otherwise this test silently flips when capability is
      // added.
      runPermissionsExpression(home, `PermissionsHandler.sync('cursor', ${JSON.stringify(versionHome)})`);

      // No config should be written for a non-capable agent. Probe both the
      // canonical settings file paths a capable agent would have used.
      expect(fs.existsSync(path.join(versionHome, '.cursor', 'settings.json'))).toBe(false);
      expect(fs.existsSync(path.join(versionHome, '.claude', 'settings.json'))).toBe(false);
    });
  });

  describe('configPath', () => {
    it('returns correct path for Claude', () => {
      const result = PermissionsHandler.configPath!('claude', '/test/home');
      expect(result).toBe('/test/home/.claude/settings.json');
    });

    it('returns correct path for Codex', () => {
      const result = PermissionsHandler.configPath!('codex', '/test/home');
      expect(result).toBe('/test/home/.codex/config.toml');
    });

    it('returns correct path for OpenCode', () => {
      const result = PermissionsHandler.configPath!('opencode', '/test/home');
      expect(result).toBe('/test/home/.opencode/opencode.jsonc');
    });

    it('returns correct path for Kimi', () => {
      const result = PermissionsHandler.configPath!('kimi', '/test/home');
      expect(result).toBe('/test/home/.kimi-code/config.toml');
    });

    it('returns null for unsupported agents', () => {
      const result = PermissionsHandler.configPath!('gemini', '/test/home');
      expect(result).toBeNull();
    });
  });

  describe('format and targetDir', () => {
    it('returns yaml format for all agents', () => {
      expect(PermissionsHandler.format('claude')).toBe('yaml');
      expect(PermissionsHandler.format('codex')).toBe('yaml');
      expect(PermissionsHandler.format('gemini')).toBe('yaml');
    });

    it('returns permissions as target directory', () => {
      expect(PermissionsHandler.targetDir('claude')).toBe('permissions');
      expect(PermissionsHandler.targetDir('codex')).toBe('permissions');
    });
  });
});
