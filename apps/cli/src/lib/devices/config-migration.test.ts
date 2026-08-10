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

    // Pins survive in the device doc; config keys are gone from it.
    const macDoc = fs.readFileSync(deviceDocPath('mac-mini'), 'utf-8');
    expect(macDoc).toContain('claude: 2.1.0');
    expect(macDoc).not.toContain('maxAgents');
    expect(macDoc).not.toContain('defaultBrowserProfile');
    expect(macDoc).not.toContain('config:');
    // A doc that held ONLY config is removed outright.
    expect(fs.existsSync(deviceDocPath('testbox'))).toBe(false);

    // The fold did not invent agent pins centrally either.
    expect(readMeta().agents?.claude).toBeUndefined();
  });

  it('folds auto-launch.json flags and removes the file', async () => {
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
    expect(fs.existsSync(autoLaunchPath())).toBe(false);
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
    // The legacy doc was still stripped (its value was folded-or-overridden).
    expect(fs.existsSync(deviceDocPath('mac-mini'))).toBe(false);
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
