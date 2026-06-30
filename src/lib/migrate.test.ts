import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { migrateExtrasExtrasToAgentsExtras, repairSelfReferentialBinShims } from './migrate.js';
import { toPosix } from './platform/index.js';

const tempDirs: string[] = [];

function makeTempHistoryDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migrate-ee-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function seedVersionHome(historyDir: string, agentId: string, ver: string): {
  pluginsDir: string;
  configDir: string;
  marketplacesDir: string;
} {
  const configDir = path.join(historyDir, 'versions', agentId, ver, 'home', `.${agentId}`);
  const pluginsDir = path.join(configDir, 'plugins');
  const marketplacesDir = path.join(pluginsDir, 'marketplaces');
  fs.mkdirSync(marketplacesDir, { recursive: true });
  return { pluginsDir, configDir, marketplacesDir };
}

function seedExtrasExtras(marketplacesDir: string, pluginsDir: string, agentId: string, ver: string, historyDir: string): void {
  const ee = path.join(marketplacesDir, 'extras-extras');
  fs.mkdirSync(path.join(ee, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(ee, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: 'extras-extras',
      description: 'Plugins from extras repo "extras"',
      owner: { name: 'agents-cli' },
      plugins: [{ name: 'code', source: './plugins/code' }],
    }, null, 2),
  );
  const eePath = path.join(historyDir, 'versions', agentId, ver, 'home', `.${agentId}`, 'plugins', 'marketplaces', 'extras-extras');
  fs.writeFileSync(
    path.join(pluginsDir, 'known_marketplaces.json'),
    JSON.stringify({
      'extras-extras': {
        source: { source: 'directory', path: eePath },
        installLocation: eePath,
        lastUpdated: '2026-06-08T05:27:15.261Z',
      },
      'agents-cli': {
        source: { source: 'directory', path: '/some/other/path' },
        installLocation: '/some/other/path',
        lastUpdated: '2026-06-08T20:07:38.485Z',
      },
    }, null, 2),
  );
  const configDir = path.dirname(pluginsDir);
  fs.writeFileSync(
    path.join(configDir, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      enabledPlugins: {
        'code@extras-extras': true,
        'creative@extras-extras': true,
        'git@extras-extras': false,
        'unrelated@agents-cli': true,
      },
    }, null, 2),
  );
}

describe('migrateExtrasExtrasToAgentsExtras', () => {
  it('is a no-op when nothing extras-extras exists', () => {
    const historyDir = makeTempHistoryDir();
    const { pluginsDir, configDir } = seedVersionHome(historyDir, 'claude', '2.1.143');
    fs.writeFileSync(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({ 'agents-cli': { source: { source: 'directory', path: '/x' } } }, null, 2),
    );
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'foo@agents-cli': true } }, null, 2));

    expect(() => migrateExtrasExtrasToAgentsExtras(historyDir)).not.toThrow();

    const known = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'known_marketplaces.json'), 'utf-8'));
    expect(known['agents-cli']).toBeDefined();
    expect(Object.keys(known)).not.toContain('extras-extras');
  });

  it('renames the marketplace dir, key, paths, and settings keys', () => {
    const historyDir = makeTempHistoryDir();
    const { pluginsDir, configDir, marketplacesDir } = seedVersionHome(historyDir, 'claude', '2.1.143');
    seedExtrasExtras(marketplacesDir, pluginsDir, 'claude', '2.1.143', historyDir);

    migrateExtrasExtrasToAgentsExtras(historyDir);

    // Dir renamed.
    expect(fs.existsSync(path.join(marketplacesDir, 'extras-extras'))).toBe(false);
    expect(fs.existsSync(path.join(marketplacesDir, 'agents-extras'))).toBe(true);

    // marketplace.json name updated.
    const mj = JSON.parse(fs.readFileSync(path.join(marketplacesDir, 'agents-extras', '.claude-plugin', 'marketplace.json'), 'utf-8'));
    expect(mj.name).toBe('agents-extras');

    // known_marketplaces.json key + paths renamed.
    const known = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'known_marketplaces.json'), 'utf-8'));
    expect(Object.keys(known)).not.toContain('extras-extras');
    expect(known['agents-extras']).toBeDefined();
    expect(toPosix(known['agents-extras'].source.path)).toContain('/marketplaces/agents-extras');
    expect(known['agents-extras'].source.path).not.toContain('extras-extras');
    expect(toPosix(known['agents-extras'].installLocation)).toContain('/marketplaces/agents-extras');
    expect(known['agents-extras'].lastUpdated).toBe('2026-06-08T05:27:15.261Z');

    // settings.json enabledPlugins keys renamed with values preserved.
    const settings = JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'));
    expect(settings.enabledPlugins['code@extras-extras']).toBeUndefined();
    expect(settings.enabledPlugins['creative@extras-extras']).toBeUndefined();
    expect(settings.enabledPlugins['git@extras-extras']).toBeUndefined();
    expect(settings.enabledPlugins['code@agents-extras']).toBe(true);
    expect(settings.enabledPlugins['creative@agents-extras']).toBe(true);
    expect(settings.enabledPlugins['git@agents-extras']).toBe(false);
    expect(settings.enabledPlugins['unrelated@agents-cli']).toBe(true);
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  it('is idempotent — running twice is a no-op the second time', () => {
    const historyDir = makeTempHistoryDir();
    const { pluginsDir, marketplacesDir } = seedVersionHome(historyDir, 'claude', '2.1.143');
    seedExtrasExtras(marketplacesDir, pluginsDir, 'claude', '2.1.143', historyDir);

    migrateExtrasExtrasToAgentsExtras(historyDir);
    const knownAfterFirst = fs.readFileSync(path.join(pluginsDir, 'known_marketplaces.json'), 'utf-8');
    migrateExtrasExtrasToAgentsExtras(historyDir);
    const knownAfterSecond = fs.readFileSync(path.join(pluginsDir, 'known_marketplaces.json'), 'utf-8');

    expect(knownAfterSecond).toBe(knownAfterFirst);
    expect(fs.existsSync(path.join(marketplacesDir, 'agents-extras'))).toBe(true);
    expect(fs.existsSync(path.join(marketplacesDir, 'extras-extras'))).toBe(false);
  });

  it('drops the stale extras-extras dir when agents-extras already exists', () => {
    const historyDir = makeTempHistoryDir();
    const { pluginsDir, marketplacesDir } = seedVersionHome(historyDir, 'claude', '2.1.143');
    seedExtrasExtras(marketplacesDir, pluginsDir, 'claude', '2.1.143', historyDir);

    // Pre-populate agents-extras with the canonical content.
    const ae = path.join(marketplacesDir, 'agents-extras');
    fs.mkdirSync(path.join(ae, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(ae, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'agents-extras', description: 'canonical', plugins: [] }, null, 2),
    );

    migrateExtrasExtrasToAgentsExtras(historyDir);

    expect(fs.existsSync(path.join(marketplacesDir, 'extras-extras'))).toBe(false);
    expect(fs.existsSync(ae)).toBe(true);
    const mj = JSON.parse(fs.readFileSync(path.join(ae, '.claude-plugin', 'marketplace.json'), 'utf-8'));
    expect(mj.description).toBe('canonical');
  });

  it('walks all agents and versions', () => {
    const historyDir = makeTempHistoryDir();
    for (const [agentId, ver] of [['claude', '2.1.143'], ['codex', '0.117.0'], ['gemini', '0.26.0']] as const) {
      const { pluginsDir, marketplacesDir } = seedVersionHome(historyDir, agentId, ver);
      seedExtrasExtras(marketplacesDir, pluginsDir, agentId, ver, historyDir);
    }
    migrateExtrasExtrasToAgentsExtras(historyDir);
    for (const [agentId, ver] of [['claude', '2.1.143'], ['codex', '0.117.0'], ['gemini', '0.26.0']] as const) {
      const marketplacesDir = path.join(historyDir, 'versions', agentId, ver, 'home', `.${agentId}`, 'plugins', 'marketplaces');
      expect(fs.existsSync(path.join(marketplacesDir, 'extras-extras'))).toBe(false);
      expect(fs.existsSync(path.join(marketplacesDir, 'agents-extras'))).toBe(true);
    }
  });
});

describe('repairSelfReferentialBinShims', () => {
  function makeTempRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-binshim-'));
    tempDirs.push(dir);
    return dir;
  }

  // Build a fixture: a versions tree whose node_modules/.bin/<cli> symlink
  // points back into a fake shims dir (the self-referential loop), plus a
  // fake dispatcher shim to be the loop target.
  function seedSelfRefLoop(root: string, agent: string, cli: string): {
    versionsRoot: string;
    shimsDir: string;
    binLink: string;
  } {
    const versionsRoot = path.join(root, 'versions');
    const shimsDir = path.join(root, 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });
    const shim = path.join(shimsDir, cli);
    fs.writeFileSync(shim, '#!/bin/sh\n# fake dispatcher\n');
    fs.chmodSync(shim, 0o755);

    const binDir = path.join(versionsRoot, agent, 'latest', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binLink = path.join(binDir, cli);
    fs.symlinkSync(shim, binLink); // <-- the loop
    return { versionsRoot, shimsDir, binLink };
  }

  function withPath<T>(dirs: string[], fn: () => T): T {
    const prev = process.env.PATH;
    process.env.PATH = dirs.join(path.delimiter);
    try {
      return fn();
    } finally {
      process.env.PATH = prev;
    }
  }

  it('re-points a self-referential .bin symlink at the real PATH binary', () => {
    const root = makeTempRoot();
    // Use a real agent id ('droid' -> cliCommand 'droid') to exercise the
    // AGENTS cliCommand lookup path.
    const { versionsRoot, shimsDir, binLink } = seedSelfRefLoop(root, 'droid', 'droid');

    // A genuine binary on PATH, in a dir that is NOT the shims dir.
    const realBinDir = makeTempRoot();
    const realBin = path.join(realBinDir, 'droid');
    fs.writeFileSync(realBin, '#!/bin/sh\n# real droid\n');
    fs.chmodSync(realBin, 0o755);

    // Sanity: before repair the link resolves into the shims dir (the loop).
    expect(fs.realpathSync(binLink)).toBe(fs.realpathSync(path.join(shimsDir, 'droid')));

    withPath([realBinDir], () => repairSelfReferentialBinShims(versionsRoot, shimsDir));

    // After repair it resolves to the real binary, not the shim.
    expect(fs.realpathSync(binLink)).toBe(fs.realpathSync(realBin));
  });

  it('removes the self-referential symlink when no real binary is on PATH', () => {
    const root = makeTempRoot();
    // Unknown agent id -> cli falls back to the dir name; guaranteed absent from PATH.
    const cli = 'zzz-no-such-cli';
    const { versionsRoot, shimsDir, binLink } = seedSelfRefLoop(root, cli, cli);
    const emptyDir = makeTempRoot();

    withPath([emptyDir], () => repairSelfReferentialBinShims(versionsRoot, shimsDir));

    // No real binary to point at -> the loop link is removed entirely.
    let exists = true;
    try { fs.lstatSync(binLink); } catch { exists = false; }
    expect(exists).toBe(false);
  });

  it('leaves a correctly-pointed symlink untouched', () => {
    const root = makeTempRoot();
    const versionsRoot = path.join(root, 'versions');
    const shimsDir = path.join(root, 'shims');
    fs.mkdirSync(shimsDir, { recursive: true });

    const realBinDir = makeTempRoot();
    const realBin = path.join(realBinDir, 'droid');
    fs.writeFileSync(realBin, '#!/bin/sh\n');
    fs.chmodSync(realBin, 0o755);

    const binDir = path.join(versionsRoot, 'droid', 'latest', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const binLink = path.join(binDir, 'droid');
    fs.symlinkSync(realBin, binLink); // already correct — points at a real binary

    withPath([realBinDir], () => repairSelfReferentialBinShims(versionsRoot, shimsDir));

    // Untouched: still the same symlink target.
    expect(fs.readlinkSync(binLink)).toBe(realBin);
  });
});
