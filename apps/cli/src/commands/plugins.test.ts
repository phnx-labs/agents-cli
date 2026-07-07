import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectPluginCapabilities } from '../lib/plugins.js';
import { shouldRefusePluginInstall, collectMarketplaceRows } from './plugins.js';
import { discoverMarketplaces } from '../lib/plugin-marketplace.js';

const tempDirs: string[] = [];

function makePluginRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-plugin-cmd-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'risky-plugin', version: '1.0.0', description: 'test' })
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('plugins install trust gate', () => {
  it('refuses hook-bearing plugins unless --allow-exec-surfaces is set', () => {
    const root = makePluginRoot();
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'foo.sh'), '#!/bin/sh\nexit 0\n');
    const capabilities = inspectPluginCapabilities(root);

    expect(shouldRefusePluginInstall(capabilities, false)).toBe(true);
    expect(shouldRefusePluginInstall(capabilities, true)).toBe(false);
  });
});

describe('plugins marketplaces subcommand', () => {
  it('collectMarketplaceRows returns an array with the documented shape', () => {
    const rows = collectMarketplaceRows();
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) {
      expect(typeof r.name).toBe('string');
      expect(typeof r.source).toBe('string');
      expect(typeof r.plugins).toBe('number');
      expect(typeof r.enabled).toBe('number');
    }
  });

  it('row counts match discoverMarketplaces() for the user repo', () => {
    const rows = collectMarketplaceRows();
    const discovered = discoverMarketplaces();
    expect(rows.map((r) => r.name).sort()).toEqual(discovered.map((d) => d.name).sort());
  });
});

describe('discoverMarketplaces with project cwd', () => {
  let savedCwd: string;
  let projectDir: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-mkt-proj-'));
    tempDirs.push(projectDir);
  });

  afterEach(() => {
    try { process.chdir(savedCwd); } catch { /* ignore */ }
  });

  it('exposes a project marketplace when <cwd>/.agents/plugins/ exists', () => {
    fs.mkdirSync(path.join(projectDir, '.agents', 'plugins', 'sample', '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.agents', 'plugins', 'sample', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'sample', version: '0.0.1', description: 'd' })
    );

    const discovered = discoverMarketplaces({ cwd: projectDir });
    const names = discovered.map((d) => d.name);
    expect(names).toContain('agents-project');
  });
});
