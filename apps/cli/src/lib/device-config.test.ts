import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// state.ts resolves HOME and the device id at import time, so we point both at a
// throwaway temp dir and re-import the modules fresh for each test — the REAL
// central-block read/write path against real files, no mocks
// (mirrors state.test.ts).
let TMP = '';

async function freshModules() {
  vi.resetModules();
  const state = await import('./state.js');
  const deviceConfig = await import('./device-config.js');
  return { ...state, ...deviceConfig };
}

function centralPath() {
  return path.join(TMP, '.agents', 'agents.yaml');
}
function readCentral(): string {
  return fs.existsSync(centralPath()) ? fs.readFileSync(centralPath(), 'utf-8') : '';
}
function writeCentral(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(centralPath(), yamlText);
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-device-config-test-'));
  process.env.HOME = TMP;
  process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
});
afterEach(() => {
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('user-scope keys (interactive.host)', () => {
  it('round-trips through central agents.yaml under config:, never the fleet block', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('interactive.host', 'zion');

    const central = readCentral();
    expect(central).toContain('config:');
    expect(central).toContain('interactiveHost: zion');
    expect(central).not.toContain('fleet:');

    const got = getConfigValue('interactive.host');
    expect(got.value).toBe('zion');
    expect(got.layer).toBe('user');

    unsetConfigValue('interactive.host');
    expect(getConfigValue('interactive.host').value).toBeUndefined();
    expect(readCentral()).not.toContain('interactiveHost');
  });

  it('keeps hand-written comments in central agents.yaml when setting config', async () => {
    writeCentral('# my hand-written note\nprojectRoot: ~/src\n# another comment\n');
    const { setConfigValue } = await freshModules();

    setConfigValue('interactive.host', 'zion');

    const central = readCentral();
    expect(central).toContain('# my hand-written note');
    expect(central).toContain('# another comment');
    expect(central).toContain('projectRoot: ~/src');
    expect(central).toContain('interactiveHost: zion');
  });
});

describe('device-scope keys (central fleet.devices.<name>.config block)', () => {
  it('round-trips through the central fleet block for this machine', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('agents.max-concurrent', 4);
    setConfigValue('scheduler.enabled', false);
    setConfigValue('notes', ['runs the releases']);

    const central = readCentral();
    expect(central).toContain('fleet:');
    expect(central).toContain('testbox:');
    expect(central).toContain('maxAgents: 4');
    expect(central).toContain('schedulerEnabled: false');
    expect(central).toContain('- runs the releases');
    // Device scope never lands in the user-scope config: block.
    expect(central).not.toContain('interactiveHost');

    expect(getConfigValue('agents.max-concurrent')).toMatchObject({ value: 4, layer: 'device' });
    expect(getConfigValue('scheduler.enabled')).toMatchObject({ value: false, layer: 'device' });
    expect(getConfigValue('notes')).toMatchObject({ value: ['runs the releases'], layer: 'device' });

    unsetConfigValue('agents.max-concurrent');
    expect(getConfigValue('agents.max-concurrent').value).toBeUndefined();
    // The other device-scope keys survive an unset of a sibling key.
    expect(getConfigValue('scheduler.enabled').value).toBe(false);
    expect(readCentral()).not.toContain('maxAgents');
  });

  it('targets another device in the same central block — no per-device files', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('agents.max-concurrent', 2, { device: 'mac-mini' });
    setConfigValue('notes', ['do not reboot'], { device: 'mac-mini' });

    const central = readCentral();
    expect(central).toContain('mac-mini:');
    expect(central).toContain('maxAgents: 2');
    expect(central).toContain('- do not reboot');
    // No per-device doc is created anywhere.
    expect(fs.existsSync(path.join(TMP, '.agents', 'devices'))).toBe(false);

    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(2);
    expect(getConfigValue('agents.max-concurrent').value).toBeUndefined();

    unsetConfigValue('agents.max-concurrent', { device: 'mac-mini' });
    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBeUndefined();
    // Unsetting a key that was never set is a no-op — no block created.
    unsetConfigValue('scheduler.enabled', { device: 'ghost' });
    expect(readCentral()).not.toContain('ghost');
  });

  it('preserves other fleet.devices fields across a config write', async () => {
    writeCentral('fleet:\n  devices:\n    mac-mini:\n      agents:\n        - claude@latest\n');
    const { setConfigValue, getConfigValue } = await freshModules();

    setConfigValue('scheduler.enabled', false, { device: 'mac-mini' });

    const central = readCentral();
    expect(central).toContain('- claude@latest');
    expect(central).toContain('schedulerEnabled: false');
    expect(getConfigValue('scheduler.enabled', { device: 'mac-mini' }).value).toBe(false);
  });

  it('upgrades fleet.devices: all to an explicit roster map on a config write', async () => {
    // A registered roster, so the upgrade expands 'all' to it. getDevicesDir()
    // reads AGENTS_DEVICES_DIR at call time (tests/setup.ts pins it fork-wide),
    // so point it at this test's dir.
    const prevDevicesDir = process.env.AGENTS_DEVICES_DIR;
    const devicesDir = path.join(TMP, '.agents', '.history', 'devices');
    process.env.AGENTS_DEVICES_DIR = devicesDir;
    fs.mkdirSync(devicesDir, { recursive: true });
    const now = new Date().toISOString();
    const profile = (name: string) => ({
      name, platform: 'macos', shell: 'posix',
      address: { via: 'tailscale', dnsName: `${name}.example.ts.net` },
      auth: { method: 'key' }, createdAt: now, updatedAt: now,
    });
    fs.writeFileSync(
      path.join(devicesDir, 'registry.json'),
      JSON.stringify({ testbox: profile('testbox'), 'mac-mini': profile('mac-mini') }),
    );
    writeCentral('fleet:\n  devices: all\n');
    const { setConfigValue, readMeta } = await freshModules();

    try {
      setConfigValue('agents.max-concurrent', 3, { device: 'mac-mini' });

      const fleet = readMeta().fleet;
      expect(fleet?.devices).not.toBe('all');
      const devices = fleet?.devices as Record<string, { config?: Record<string, unknown> }>;
      expect(Object.keys(devices).sort()).toEqual(['mac-mini', 'testbox']);
      expect(devices['mac-mini'].config).toEqual({ maxAgents: 3 });
    } finally {
      if (prevDevicesDir === undefined) delete process.env.AGENTS_DEVICES_DIR;
      else process.env.AGENTS_DEVICES_DIR = prevDevicesDir;
    }
  });

  it('drops the fleet block entirely when an unset empties a block it created', async () => {
    const { setConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('scheduler.enabled', false, { device: 'mac-mini' });
    expect(readCentral()).toContain('fleet:');

    unsetConfigValue('scheduler.enabled', { device: 'mac-mini' });
    expect(readCentral()).not.toContain('fleet:');
  });
});

describe('browser.profile is a device-scope key in the central block', () => {
  it('set/get/unset land under fleet.devices.<self>.config.defaultBrowserProfile', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('browser.profile', 'comet-local');

    const central = readCentral();
    expect(central).toContain('defaultBrowserProfile: comet-local');
    expect(central).toContain('testbox:');

    const got = getConfigValue('browser.profile');
    expect(got.value).toBe('comet-local');
    expect(got.layer).toBe('device');

    unsetConfigValue('browser.profile');
    expect(getConfigValue('browser.profile').value).toBeUndefined();
    expect(readCentral()).not.toContain('defaultBrowserProfile');
  });
});

describe('ssh.* / platform / auto-launch keys', () => {
  it('round-trip each new key class through the central block', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('ssh.user', 'muqsit', { device: 'win-mini' });
    setConfigValue('ssh.auth', 'password', { device: 'win-mini' });
    setConfigValue('ssh.bundle', 'fleet', { device: 'win-mini' });
    setConfigValue('ssh.bundle-key', 'password.work', { device: 'win-mini' });
    setConfigValue('ssh.identity-file', '/keys/fleet', { device: 'worker' });
    setConfigValue('platform', 'windows', { device: 'win-mini' });
    setConfigValue('auto-launch.enabled', false, { device: 'win-mini' });
    setConfigValue('auto-launch.preferred', true, { device: 'worker' });

    expect(getConfigValue('ssh.user', { device: 'win-mini' }).value).toBe('muqsit');
    expect(getConfigValue('ssh.auth', { device: 'win-mini' }).value).toBe('password');
    expect(getConfigValue('ssh.bundle', { device: 'win-mini' }).value).toBe('fleet');
    expect(getConfigValue('ssh.bundle-key', { device: 'win-mini' }).value).toBe('password.work');
    expect(getConfigValue('ssh.identity-file', { device: 'worker' }).value).toBe('/keys/fleet');
    expect(getConfigValue('platform', { device: 'win-mini' }).value).toBe('windows');
    expect(getConfigValue('auto-launch.enabled', { device: 'win-mini' }).value).toBe(false);
    expect(getConfigValue('auto-launch.preferred', { device: 'worker' }).value).toBe(true);

    unsetConfigValue('ssh.identity-file', { device: 'worker' });
    expect(getConfigValue('ssh.identity-file', { device: 'worker' }).value).toBeUndefined();
  });

  it('validates the enum keys', async () => {
    const { setConfigValue } = await freshModules();
    expect(() => setConfigValue('ssh.auth', 'magic')).toThrow(/key \| password/);
    expect(() => setConfigValue('platform', 'plan9')).toThrow(/windows \| linux \| macos \| unknown/);
  });
});

describe('validation', () => {
  it('rejects unknown keys, naming the known set', async () => {
    const { setConfigValue, getConfigValue } = await freshModules();
    expect(() => setConfigValue('nope.nope', 1)).toThrow(/Unknown config key 'nope\.nope'.*interactive\.host/);
    expect(() => getConfigValue('nope.nope')).toThrow(/Unknown config key/);
  });

  it('rejects values of the wrong type', async () => {
    const { setConfigValue } = await freshModules();
    expect(() => setConfigValue('agents.max-concurrent', 'four')).toThrow(/expects an integer/);
    expect(() => setConfigValue('agents.max-concurrent', 2.5)).toThrow(/expects an integer/);
    expect(() => setConfigValue('scheduler.enabled', 'off')).toThrow(/expects a boolean/);
    expect(() => setConfigValue('notes', 'just a string')).toThrow(/expects a list of strings/);
    expect(() => setConfigValue('notes', ['ok', 7])).toThrow(/expects a list of strings/);
    expect(() => setConfigValue('interactive.host', '')).toThrow(/non-empty string/);
  });

  it('rejects out-of-domain values (maxAgents < 1, bad device name)', async () => {
    const { setConfigValue } = await freshModules();
    expect(() => setConfigValue('agents.max-concurrent', 0)).toThrow(/>= 1/);
    expect(() => setConfigValue('interactive.host', 'has spaces')).toThrow(/Invalid value/);
  });
});

describe('listConfig', () => {
  it('reports every known key with its value and setting layer', async () => {
    const { listConfig, setConfigValue } = await freshModules();
    setConfigValue('interactive.host', 'zion');
    setConfigValue('scheduler.enabled', true);
    setConfigValue('watchdog.enabled', false);

    const entries = listConfig();
    const byName = Object.fromEntries(entries.map((e) => [e.spec.name, e]));
    expect(Object.keys(byName).sort()).toEqual([
      'agents.max-concurrent',
      'auto-launch.enabled',
      'auto-launch.preferred',
      'browser.profile',
      'browser.remote-control',
      'daemon.enabled',
      'interactive.host',
      'notes',
      'platform',
      'scheduler.enabled',
      'ssh.auth',
      'ssh.bundle',
      'ssh.bundle-key',
      'ssh.identity-file',
      'ssh.user',
      'watchdog.enabled',
    ]);
    expect(byName['interactive.host']).toMatchObject({ value: 'zion', layer: 'user' });
    expect(byName['scheduler.enabled']).toMatchObject({ value: true, layer: 'device' });
    expect(byName['watchdog.enabled']).toMatchObject({ value: false, layer: 'device' });
    expect(byName['notes'].value).toBeUndefined();
    expect(byName['notes'].layer).toBeUndefined();
  });
});

describe('scheduler gate (scheduler.enabled=false on this device)', () => {
  it('defaults to enabled when unset (unset = today’s behavior)', async () => {
    const { isSchedulerEnabled, assertSchedulerEnabled } = await freshModules();
    expect(isSchedulerEnabled()).toBe(true);
    expect(() => assertSchedulerEnabled()).not.toThrow();
  });

  it('isSchedulerEnabled reflects the stored value', async () => {
    const { isSchedulerEnabled, setConfigValue } = await freshModules();
    setConfigValue('scheduler.enabled', false);
    expect(isSchedulerEnabled()).toBe(false);
    setConfigValue('scheduler.enabled', true);
    expect(isSchedulerEnabled()).toBe(true);
  });

  it('assertSchedulerEnabled throws naming the setting and the fix', async () => {
    const { assertSchedulerEnabled, setConfigValue } = await freshModules();
    setConfigValue('scheduler.enabled', false);
    expect(() => assertSchedulerEnabled()).toThrow(/scheduler\.enabled=false/);
    expect(() => assertSchedulerEnabled()).toThrow(
      /agents devices config testbox scheduler\.enabled on/,
    );
  });

  it('a peer device’s scheduler.enabled does not gate this machine', async () => {
    const { isSchedulerEnabled, setConfigValue } = await freshModules();
    setConfigValue('scheduler.enabled', false, { device: 'mac-mini' });
    expect(isSchedulerEnabled()).toBe(true);
  });
});

describe('readMaxConcurrentCaps', () => {
  it('reads caps from the central block, omitting uncapped devices', async () => {
    const { readMaxConcurrentCaps, setConfigValue } = await freshModules();
    setConfigValue('agents.max-concurrent', 4);                         // self (testbox)
    setConfigValue('agents.max-concurrent', 2, { device: 'mac-mini' }); // peer

    expect(readMaxConcurrentCaps(['testbox', 'mac-mini', 'zion'])).toEqual({
      testbox: 4,
      'mac-mini': 2,
    });
  });

  it('returns {} when no device has a cap', async () => {
    const { readMaxConcurrentCaps } = await freshModules();
    expect(readMaxConcurrentCaps(['testbox', 'ghost'])).toEqual({});
  });
});

describe('auto-launch accessors', () => {
  it('default every device to enabled and not preferred', async () => {
    const { isAutoLaunchEnabled, isAutoLaunchPreferred } = await freshModules();
    expect(isAutoLaunchEnabled('zion')).toBe(true);
    expect(isAutoLaunchPreferred('zion')).toBe(false);
  });

  it('persist through the central block and invert to a removal', async () => {
    const { setAutoLaunchEnabled, isAutoLaunchEnabled, setAutoLaunchPreferred, isAutoLaunchPreferred, loadAutoLaunchPreferences } = await freshModules();

    setAutoLaunchEnabled('zion', false);
    expect(isAutoLaunchEnabled('zion')).toBe(false);
    expect(readCentral()).toContain('autoLaunchEnabled: false');

    setAutoLaunchPreferred('mac-mini', true);
    expect(isAutoLaunchPreferred('mac-mini')).toBe(true);
    expect(loadAutoLaunchPreferences()).toEqual({
      zion: { enabled: false },
      'mac-mini': { preferred: true },
    });

    // Back to the default removes the key.
    setAutoLaunchEnabled('zion', true);
    setAutoLaunchPreferred('mac-mini', false);
    expect(loadAutoLaunchPreferences()).toEqual({});
    expect(readCentral()).not.toContain('autoLaunch');
  });
});
