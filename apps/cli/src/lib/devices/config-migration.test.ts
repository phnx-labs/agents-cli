import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The legacy-store fold: per-device `devices/<name>/agents.yaml` config +
 * `defaultBrowserProfile`, and `.history/devices/auto-launch.json`, migrate
 * into the central `fleet.devices.<name>.config` block — pins stay behind.
 *
 * Real files, fresh modules per test (state.ts captures HOME at import time,
 * same pattern as lib/device-config.test.ts). No mocks.
 */
let TMP = '';

async function freshModules() {
  vi.resetModules();
  const state = await import('../state.js');
  const migration = await import('./config-migration.js');
  const deviceConfig = await import('../device-config.js');
  return { ...state, ...migration, ...deviceConfig };
}

function centralPath() {
  return path.join(TMP, '.agents', 'agents.yaml');
}
function readCentral(): string {
  return fs.existsSync(centralPath()) ? fs.readFileSync(centralPath(), 'utf-8') : '';
}
function deviceDocPath(host: string) {
  return path.join(TMP, '.agents', 'devices', host, 'agents.yaml');
}
function autoLaunchPath() {
  return path.join(TMP, '.agents', '.history', 'devices', 'auto-launch.json');
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-config-migration-test-'));
  process.env.HOME = TMP;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  // getDevicesDir() reads this at call time (tests/setup.ts pins it fork-wide).
  process.env.AGENTS_DEVICES_DIR = path.join(TMP, '.agents', '.history', 'devices');
});
afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  delete process.env.AGENTS_DEVICES_DIR;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('the shared agents.yaml stays clean on read', () => {
  /**
   * `~/.agents/agents.yaml` is tracked and shared by every machine in the fleet.
   * The fold used to hang off getConfigValue/setConfigValue/unsetConfigValue, so
   * an ordinary `agents config get` rewrote that tracked file — 13 machines each
   * dirtying one path on nearly every command. yosemite-s0 ended up unable to
   * pull at all. A read must never write.
   */
  it('a config read does not create or modify the central file', async () => {
    // The fold must be ENABLED for this to mean anything: bootstrap.ts defaults
    // AGENTS_SKIP_MIGRATION=1, and with that set the read path is inert whether
    // or not it calls the migration — the test would pass against the bug.
    delete process.env.AGENTS_SKIP_MIGRATION;
    fs.mkdirSync(path.dirname(deviceDocPath('mac-mini')), { recursive: true });
    fs.writeFileSync(deviceDocPath('mac-mini'), 'config:\n  maxAgents: 4\n');

    const { getConfigValue } = await freshModules();

    // No central file yet: reading must not bring one into existence.
    expect(fs.existsSync(centralPath())).toBe(false);
    for (let i = 0; i < 50; i++) {
      getConfigValue('agents.max-concurrent', { device: 'mac-mini' });
      getConfigValue('browser.profile');
      getConfigValue('scheduler.enabled');
    }
    expect(fs.existsSync(centralPath())).toBe(false);
  });

  it('repeated reads leave an existing central file byte-identical', async () => {
    delete process.env.AGENTS_SKIP_MIGRATION;
    fs.mkdirSync(path.dirname(deviceDocPath('mac-mini')), { recursive: true });
    fs.writeFileSync(deviceDocPath('mac-mini'), 'config:\n  notes:\n    - legacy\n');
    fs.mkdirSync(path.dirname(centralPath()), { recursive: true });
    fs.writeFileSync(
      centralPath(),
      'fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 8\n',
    );
    const before = readCentral();

    const { getConfigValue } = await freshModules();
    for (let i = 0; i < 50; i++) {
      getConfigValue('agents.max-concurrent', { device: 'mac-mini' });
      getConfigValue('daemon.enabled');
    }

    expect(readCentral()).toBe(before);
  });
});

describe('migrateDeviceConfigToCentral', () => {
  it('folds device-doc config + defaultBrowserProfile into the central block, keeping pins', async () => {
    fs.mkdirSync(path.dirname(deviceDocPath('mac-mini')), { recursive: true });
    fs.writeFileSync(
      deviceDocPath('mac-mini'),
      'agents:\n  claude: 2.1.0\nconfig:\n  maxAgents: 4\n  notes:\n    - runs the releases\ndefaultBrowserProfile: comet-local\n',
    );
    fs.mkdirSync(path.dirname(deviceDocPath('testbox')), { recursive: true });
    fs.writeFileSync(deviceDocPath('testbox'), 'config:\n  schedulerEnabled: false\n');

    const { migrateDeviceConfigToCentral, getConfigValue, readMeta } = await freshModules();
    migrateDeviceConfigToCentral();

    // Central block carries the folded config for both devices.
    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(4);
    expect(getConfigValue('notes', { device: 'mac-mini' }).value).toEqual(['runs the releases']);
    expect(getConfigValue('browser.profile', { device: 'mac-mini' }).value).toBe('comet-local');
    expect(getConfigValue('scheduler.enabled').value).toBe(false); // self (testbox)

    // The fold is ADDITIVE: the legacy source is left exactly as it was. A box
    // still on the previous CLI reads that doc, so deleting it mid-rollout would
    // silently drop its config. The redundant copy is pruned later by one
    // explicit operator command, not by every machine independently.
    const macDoc = fs.readFileSync(deviceDocPath('mac-mini'), 'utf-8');
    expect(macDoc).toContain('claude: 2.1.0');
    expect(macDoc).toContain('maxAgents');
    expect(macDoc).toContain('defaultBrowserProfile');
    // A doc that held ONLY config also survives.
    expect(fs.existsSync(deviceDocPath('testbox'))).toBe(true);

    // The fold did not invent agent pins centrally either.
    expect(readMeta().agents?.claude).toBeUndefined();
  });

  it('folds auto-launch.json flags and leaves the file in place', async () => {
    fs.mkdirSync(path.dirname(autoLaunchPath()), { recursive: true });
    fs.writeFileSync(
      autoLaunchPath(),
      JSON.stringify({
        devices: { zion: { enabled: false }, 'mac-mini': { preferred: true } },
        updatedAt: new Date().toISOString(),
      }),
    );

    const { migrateDeviceConfigToCentral, isAutoLaunchEnabled, isAutoLaunchPreferred, loadAutoLaunchPreferences } =
      await freshModules();
    migrateDeviceConfigToCentral();

    expect(isAutoLaunchEnabled('zion')).toBe(false);
    expect(isAutoLaunchPreferred('mac-mini')).toBe(true);
    expect(loadAutoLaunchPreferences()).toEqual({
      zion: { enabled: false },
      'mac-mini': { preferred: true },
    });
    expect(fs.existsSync(autoLaunchPath())).toBe(true);
  });

  it('is idempotent — a second run changes nothing', async () => {
    fs.mkdirSync(path.dirname(deviceDocPath('mac-mini')), { recursive: true });
    fs.writeFileSync(deviceDocPath('mac-mini'), 'agents:\n  claude: 2.1.0\nconfig:\n  maxAgents: 4\n');

    const { migrateDeviceConfigToCentral } = await freshModules();
    migrateDeviceConfigToCentral();
    const afterFirst = readCentral();
    migrateDeviceConfigToCentral();
    expect(readCentral()).toBe(afterFirst);
  });

  it('a central value written by a newer CLI wins over the legacy fold', async () => {
    fs.mkdirSync(path.dirname(deviceDocPath('mac-mini')), { recursive: true });
    fs.writeFileSync(deviceDocPath('mac-mini'), 'config:\n  maxAgents: 4\n');
    fs.mkdirSync(path.dirname(centralPath()), { recursive: true });
    fs.writeFileSync(
      centralPath(),
      'fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 8\n',
    );

    const { migrateDeviceConfigToCentral, getConfigValue } = await freshModules();
    migrateDeviceConfigToCentral();

    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(8);
    // The legacy doc survives untouched — the newer central value simply wins.
    expect(fs.existsSync(deviceDocPath('mac-mini'))).toBe(true);
    expect(fs.readFileSync(deviceDocPath('mac-mini'), 'utf-8')).toContain('maxAgents: 4');
  });

  it('skips a corrupted device doc loudly and leaves it for a later retry', async () => {
    fs.mkdirSync(path.dirname(deviceDocPath('broken')), { recursive: true });
    fs.writeFileSync(deviceDocPath('broken'), 'config:\n  maxAgents: [unclosed\n');
    fs.mkdirSync(path.dirname(deviceDocPath('mac-mini')), { recursive: true });
    fs.writeFileSync(deviceDocPath('mac-mini'), 'config:\n  maxAgents: 4\n');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { migrateDeviceConfigToCentral, getConfigValue } = await freshModules();
    try {
      migrateDeviceConfigToCentral();

      // The healthy device migrated; the broken one is untouched.
      expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(4);
      expect(fs.existsSync(deviceDocPath('broken'))).toBe(true);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('broken'));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('is a no-op when no legacy stores exist', async () => {
    const { migrateDeviceConfigToCentral } = await freshModules();
    migrateDeviceConfigToCentral();
    expect(readCentral()).toBe('');
  });
});
