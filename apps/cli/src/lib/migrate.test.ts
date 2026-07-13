import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, spawn } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';

import { migrateExtrasExtrasToAgentsExtras, migrateRoutineDeviceToDevices, repairSelfReferentialBinShims } from './migrate.js';
import { toPosix } from './platform/index.js';
import * as yaml from 'yaml';

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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
    const exeExt = process.platform === 'win32' ? '.cmd' : '';
    const realBin = path.join(realBinDir, 'droid' + exeExt);
    fs.writeFileSync(realBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n# real droid\n');
    fs.chmodSync(realBin, 0o755);

    // Sanity: before repair the link resolves into the shims dir (the loop).
    expect(fs.realpathSync(binLink)).toBe(fs.realpathSync(path.join(shimsDir, 'droid')));

    withPath([realBinDir], () => repairSelfReferentialBinShims(versionsRoot, shimsDir));

    // After repair the loop is broken and the .bin entry yields the real binary.
    // On Windows without the symlink privilege createLink copies (a copy's
    // realpath is itself, not the target), so assert the functional contract —
    // same bytes as the real binary, and no longer resolving back into the
    // shims dir — rather than symlink-target identity.
    expect(fs.readFileSync(binLink)).toEqual(fs.readFileSync(realBin));
    expect(fs.realpathSync(binLink).startsWith(fs.realpathSync(shimsDir) + path.sep)).toBe(false);
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
    const exeExt = process.platform === 'win32' ? '.cmd' : '';
    const realBin = path.join(realBinDir, 'droid' + exeExt);
    fs.writeFileSync(realBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
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

describe('migrateRoutineDeviceToDevices', () => {
  function makeRoutinesDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migrate-dev-'));
    tempDirs.push(dir);
    return dir;
  }

  it('rewrites device: value to devices: [value]', () => {
    const dir = makeRoutinesDir();
    fs.writeFileSync(path.join(dir, 'a.yml'), yaml.stringify({
      name: 'a', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: 'yosemite-s0',
    }));
    migrateRoutineDeviceToDevices(dir);
    const result = yaml.parse(fs.readFileSync(path.join(dir, 'a.yml'), 'utf-8'));
    expect(result.devices).toEqual(['yosemite-s0']);
    expect(result.device).toBeUndefined();
  });

  it('is idempotent — no change on re-run', () => {
    const dir = makeRoutinesDir();
    fs.writeFileSync(path.join(dir, 'b.yml'), yaml.stringify({
      name: 'b', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: 'mac-mini',
    }));
    migrateRoutineDeviceToDevices(dir);
    const after1 = fs.readFileSync(path.join(dir, 'b.yml'), 'utf-8');
    migrateRoutineDeviceToDevices(dir);
    const after2 = fs.readFileSync(path.join(dir, 'b.yml'), 'utf-8');
    expect(after1).toBe(after2);
  });

  it('leaves a routine that already has devices untouched', () => {
    const dir = makeRoutinesDir();
    const original = { name: 'c', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', devices: ['a', 'b'] };
    fs.writeFileSync(path.join(dir, 'c.yml'), yaml.stringify(original));
    migrateRoutineDeviceToDevices(dir);
    const result = yaml.parse(fs.readFileSync(path.join(dir, 'c.yml'), 'utf-8'));
    expect(result.devices).toEqual(['a', 'b']);
    expect(result.device).toBeUndefined();
  });

  it('drops device when devices already present (both-field collision)', () => {
    const dir = makeRoutinesDir();
    const original = { name: 'd', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: 'old', devices: ['new'] };
    fs.writeFileSync(path.join(dir, 'd.yml'), yaml.stringify(original));
    migrateRoutineDeviceToDevices(dir);
    const result = yaml.parse(fs.readFileSync(path.join(dir, 'd.yml'), 'utf-8'));
    expect(result.devices).toEqual(['new']);
    expect(result.device).toBeUndefined();
  });

  it('preserves other YAML fields', () => {
    const dir = makeRoutinesDir();
    fs.writeFileSync(path.join(dir, 'e.yml'), yaml.stringify({
      name: 'e', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: 'zion', timeout: '2h', enabled: false,
    }));
    migrateRoutineDeviceToDevices(dir);
    const result = yaml.parse(fs.readFileSync(path.join(dir, 'e.yml'), 'utf-8'));
    expect(result.devices).toEqual(['zion']);
    expect(result.timeout).toBe('2h');
    expect(result.enabled).toBe(false);
    expect(result.agent).toBe('claude');
  });

  it('is a no-op for routines without device field', () => {
    const dir = makeRoutinesDir();
    const raw = yaml.stringify({ name: 'f', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi' });
    fs.writeFileSync(path.join(dir, 'f.yml'), raw);
    migrateRoutineDeviceToDevices(dir);
    expect(fs.readFileSync(path.join(dir, 'f.yml'), 'utf-8')).toBe(raw);
  });

  it('propagates a write failure (POSIX)', () => {
    // Windows read-only directory semantics do not reliably block writes, so
    // this test is scoped to POSIX platforms where chmod(0o555) is effective.
    if (process.platform === 'win32') {
      return;
    }
    const dir = makeRoutinesDir();
    fs.writeFileSync(path.join(dir, 'g.yml'), yaml.stringify({
      name: 'g', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: 'zion',
    }));
    // Make the directory read-only so the atomic write (temp file + rename) fails.
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => migrateRoutineDeviceToDevices(dir)).toThrow();
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('throws on malformed legacy device value (not a nonempty string)', () => {
    const dir = makeRoutinesDir();
    fs.writeFileSync(path.join(dir, 'h.yml'), yaml.stringify({
      name: 'h', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: '',
    }));
    expect(() => migrateRoutineDeviceToDevices(dir)).toThrow(/not a valid device name/);
    const result = yaml.parse(fs.readFileSync(path.join(dir, 'h.yml'), 'utf-8'));
    expect(result.device).toBe('');
  });

  it('throws on non-string legacy device value (number)', () => {
    const dir = makeRoutinesDir();
    fs.writeFileSync(path.join(dir, 'i.yml'), yaml.stringify({
      name: 'i', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: 42,
    }));
    expect(() => migrateRoutineDeviceToDevices(dir)).toThrow(/not a valid device name/);
    const result = yaml.parse(fs.readFileSync(path.join(dir, 'i.yml'), 'utf-8'));
    expect(result.device).toBe(42);
  });

  it('propagates a read error for a directory masquerading as a YAML file', () => {
    const dir = makeRoutinesDir();
    // A directory named with a .yml suffix causes fs.readFileSync to throw
    // (EISDIR / EACCES) on every platform — no permission-dependent chmod needed.
    fs.mkdirSync(path.join(dir, 'j.yml'), { recursive: true });
    expect(() => migrateRoutineDeviceToDevices(dir)).toThrow();
  });

  it('successful migration rewrites device to devices atomically with no temp files left behind', () => {
    const dir = makeRoutinesDir();
    fs.writeFileSync(path.join(dir, 'k.yml'), yaml.stringify({
      name: 'k', schedule: '0 3 * * *', agent: 'claude', prompt: 'hi', device: 'zion',
    }));

    migrateRoutineDeviceToDevices(dir);

    const result = yaml.parse(fs.readFileSync(path.join(dir, 'k.yml'), 'utf-8'));
    expect(result.devices).toEqual(['zion']);
    expect(result.device).toBeUndefined();
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('v12 device migration CLI startup failure (POSIX)', () => {
  function makeLegacyHome(schedule: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migrate-startup-'));
    tempDirs.push(home);
    const agentsDir = path.join(home, '.agents');
    const routinesDir = path.join(agentsDir, 'routines');
    fs.mkdirSync(routinesDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'agents.yaml'), 'agents: {}\n');
    fs.mkdirSync(path.join(agentsDir, '.system', '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(routinesDir, 'legacy.yaml'),
      yaml.stringify({ name: 'legacy', schedule, agent: 'claude', prompt: 'noop', device: 'yosemite-s0' }),
    );
    return home;
  }

  function run(home: string, args: string[], extraEnv: Record<string, string> = {}): ReturnType<typeof spawnSync> {
    return spawnSync('node', ['--import', 'tsx', 'src/index.ts', 'routines', ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 30_000,
    });
  }

  it('fails closed: a stale routine with a legacy device key is absent/inert, never unrestricted', () => {
    if (process.platform === 'win32') {
      // Windows read-only directory semantics do not reliably block writes.
      return;
    }
    const home = makeLegacyHome('0 3 * * *');
    const routinesDir = path.join(home, '.agents', 'routines');
    fs.chmodSync(routinesDir, 0o555);
    try {
      const res = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      // The stale routine must not surface as an unrestricted job. The safe
      // fail-closed outcome is absence/inertness, not a process exit code.
      const parsed = res.status === 0 ? JSON.parse(res.stdout.trim()) : [];
      const found = parsed.find((j: Record<string, unknown>) => j.name === 'legacy');
      expect(found).toBeUndefined();
      expect(res.stdout + res.stderr).not.toContain('legacy');
    } finally {
      fs.chmodSync(routinesDir, 0o755);
    }
  });
});

describe('v12 device migration daemon _run failure (POSIX)', () => {
  function makeLegacyHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-migrate-daemon-'));
    tempDirs.push(home);
    const agentsDir = path.join(home, '.agents');
    const routinesDir = path.join(agentsDir, 'routines');
    fs.mkdirSync(routinesDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'agents.yaml'), 'agents: {}\n');
    fs.mkdirSync(path.join(agentsDir, '.system', '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(routinesDir, 'legacy.yaml'),
      yaml.stringify({ name: 'legacy', schedule: '* * * * * *', agent: 'claude', prompt: 'noop', device: 'yosemite-s0' }),
    );
    return home;
  }

  function readDaemonPid(home: string): number | null {
    const pidPath = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');
    if (!fs.existsSync(pidPath)) return null;
    const raw = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  }

  function startDaemon(home: string): { child: ReturnType<typeof spawn>; pidPromise: Promise<number | null> } {
    const child = spawn('node', ['--import', 'tsx', 'src/index.ts', 'daemon', '_run'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
      detached: true,
      stdio: 'ignore',
    });

    const pidPromise = new Promise<number | null>((resolve) => {
      const deadline = Date.now() + 15_000;
      const interval = setInterval(() => {
        const pid = readDaemonPid(home);
        if (pid) {
          clearInterval(interval);
          resolve(pid);
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve(null);
        }
      }, 50);
    });

    return { child, pidPromise };
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function stopDaemon(child: ReturnType<typeof spawn>): Promise<void> {
    if (!child.pid) return;
    const closePromise = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.on('close', () => resolve());
    });
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 3_000);
    await closePromise;
    clearTimeout(timer);
  }

  it('creates no run directory when migration cannot write the legacy fixture', async () => {
    if (process.platform === 'win32') {
      // chmod(0o555) is not a reliable write barrier on Windows.
      return;
    }
    const home = makeLegacyHome();
    const routinesDir = path.join(home, '.agents', 'routines');
    fs.chmodSync(routinesDir, 0o555);

    let daemon: ReturnType<typeof startDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();
      expect(isProcessAlive(pid!)).toBe(true);

      // Wait long enough for an every-second schedule to fire if the stale job
      // were mistakenly loaded as unrestricted.
      await new Promise((resolve) => { setTimeout(resolve, 2_500); });

      const runsDir = path.join(home, '.agents', '.history', 'runs');
      // The top-level runs bucket is created by daemon startup; the critical
      // failure mode is a job-specific run directory for the stale routine.
      const jobRunDirs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : [];
      expect(jobRunDirs).not.toContain('legacy');
    } finally {
      fs.chmodSync(routinesDir, 0o755);
      if (daemon) await stopDaemon(daemon.child);
      if (pid !== null) {
        expect(isProcessAlive(pid)).toBe(false);
      }
    }
  });
});
