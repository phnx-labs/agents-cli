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
  it('resolves the usage primary override, interactive fallback, and null default', async () => {
    const { resolveUsagePrimaryHost, setConfigValue, unsetConfigValue } = await freshModules();

    expect(resolveUsagePrimaryHost()).toBeNull();
    setConfigValue('interactive.host', 'zion');
    expect(resolveUsagePrimaryHost()).toBe('zion');
    setConfigValue('usage.primary-host', 'mac-mini');
    expect(resolveUsagePrimaryHost()).toBe('mac-mini');
    unsetConfigValue('usage.primary-host');
    expect(resolveUsagePrimaryHost()).toBe('zion');
  });

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
    // Anchor on a key that STAYS central. A leading comment belongs to the key
    // it precedes, so anchoring on one that moves machine-local (projectRoot did)
    // would delete the comment with it and test the wrong thing.
    writeCentral('# my hand-written note\nnotify:\n  owner:\n    channel: imessage\n    to: me\n# another comment\n');
    const { setConfigValue } = await freshModules();

    setConfigValue('interactive.host', 'zion');

    const central = readCentral();
    expect(central).toContain('# my hand-written note');
    expect(central).toContain('# another comment');
    expect(central).toContain('channel: imessage');
    expect(central).toContain('interactiveHost: zion');
  });

  it('moves projectRoot out of the shared file on the next write', async () => {
    // projectRoot is inferred from whatever directory the CLI happened to run in
    // (lib/project-root.ts), so it is machine state, not fleet policy. It now
    // lives in this machine's own doc and is dropped from the synced file.
    writeCentral('projectRoot: ~/src\n');
    const { setConfigValue, readMeta } = await freshModules();

    setConfigValue('interactive.host', 'zion');

    expect(readCentral()).not.toContain('projectRoot');
    // ...and the value itself is not lost — it is read back from the device doc.
    expect(readMeta().projectRoot).toBe('~/src');
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
    expect(central).toContain('- runs the releases');
    // scheduler.enabled is machine-visibility: only this box reads it, so it
    // stays in this box's own doc and never enters the synced file.
    expect(central).not.toContain('schedulerEnabled');
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
    // Both are shared-visibility, so a peer's values live centrally and no
    // per-device doc is needed for them.
    expect(fs.existsSync(path.join(TMP, '.agents', 'devices'))).toBe(false);

    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(2);
    expect(getConfigValue('agents.max-concurrent').value).toBeUndefined();

    unsetConfigValue('agents.max-concurrent', { device: 'mac-mini' });
    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBeUndefined();
    // Unsetting a key that was never set is a no-op — no block created.
    unsetConfigValue('agents.max-concurrent', { device: 'ghost' });
    expect(readCentral()).not.toContain('ghost');
  });

  it('preserves other fleet.devices fields across a config write', async () => {
    writeCentral('fleet:\n  devices:\n    mac-mini:\n      agents:\n        - claude@latest\n');
    const { setConfigValue, getConfigValue } = await freshModules();

    // A shared-visibility key, because a peer's machine-local key is refused by
    // design — the point here is that the write preserves sibling fields.
    setConfigValue('agents.max-concurrent', 3, { device: 'mac-mini' });

    const central = readCentral();
    expect(central).toContain('- claude@latest');
    expect(central).toContain('maxAgents: 3');
    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(3);
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

    setConfigValue('agents.max-concurrent', 2, { device: 'mac-mini' });
    expect(readCentral()).toContain('fleet:');

    unsetConfigValue('agents.max-concurrent', { device: 'mac-mini' });
    expect(readCentral()).not.toContain('fleet:');
  });
});

describe('browser.profile is machine-local', () => {
  it('set/get/unset land in this machine\'s own doc, never the synced file', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('browser.profile', 'comet-local');

    // Nothing off-box resolves another machine's default browser profile, so it
    // belongs in the gitignored per-machine doc — keeping it out of the file all
    // 13 machines share.
    const localPath = path.join(TMP, '.agents', 'devices', 'testbox', 'agents.yaml');
    expect(fs.readFileSync(localPath, 'utf-8')).toContain('defaultBrowserProfile: comet-local');
    expect(readCentral()).not.toContain('defaultBrowserProfile');

    const got = getConfigValue('browser.profile');
    expect(got.value).toBe('comet-local');
    expect(got.layer).toBe('device');

    unsetConfigValue('browser.profile');
    expect(getConfigValue('browser.profile').value).toBeUndefined();
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
      'auto.pool',
      'browser.profile',
      'browser.remote-control',
      'daemon.enabled',
      'interactive.host',
      'notes',
      'platform',
      'role',
      'scheduler.enabled',
      'ssh.auth',
      'ssh.bundle',
      'ssh.bundle-key',
      'ssh.identity-file',
      'ssh.user',
      'tmux.enabled',
      'usage.primary-host',
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

  it('cannot be set for a peer at all — it is machine-local', async () => {
    const { isSchedulerEnabled, setConfigValue } = await freshModules();
    // Previously this was settable for a peer and simply ignored locally. Now it
    // is refused outright, so a peer's value can never gate this machine.
    expect(() => setConfigValue('scheduler.enabled', false, { device: 'mac-mini' }))
      .toThrow(/machine-local/);
    expect(isSchedulerEnabled()).toBe(true);
  });
});

describe('tmux gate (tmux.enabled=false on this device)', () => {
  it('defaults to enabled when unset (unset = today’s behavior: wrap)', async () => {
    const { isTmuxEnabled } = await freshModules();
    expect(isTmuxEnabled()).toBe(true);
  });

  it('isTmuxEnabled reflects the stored value', async () => {
    const { isTmuxEnabled, setConfigValue } = await freshModules();
    setConfigValue('tmux.enabled', false);
    expect(isTmuxEnabled()).toBe(false);
    setConfigValue('tmux.enabled', true);
    expect(isTmuxEnabled()).toBe(true);
  });

  it('persists to this box’s own doc, never the fleet-shared file', async () => {
    const { setConfigValue } = await freshModules();
    setConfigValue('tmux.enabled', false);
    expect(readCentral()).not.toMatch(/tmuxEnabled/);
  });

  it('cannot be set for a peer at all — it is machine-local', async () => {
    const { isTmuxEnabled, setConfigValue } = await freshModules();
    expect(() => setConfigValue('tmux.enabled', false, { device: 'mac-mini' }))
      .toThrow(/machine-local/);
    expect(isTmuxEnabled()).toBe(true);
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

describe('every device-scope key declares who reads it', () => {
  /**
   * The discriminated union already makes a missing `visibility` a COMPILE
   * error. This is the runtime backstop plus the record of intent: a key's tier
   * decides whether it lands in the fleet-shared agents.yaml or the owning box's
   * own doc, and getting it wrong is how operator config drifted into the shared
   * file twice (once for agent pins, once for device config).
   */
  it('assigns a valid visibility to every device key, and none to user keys', async () => {
    const { CONFIG_KEYS } = await freshModules();
    for (const spec of CONFIG_KEYS) {
      if (spec.scope === 'device') {
        expect(['shared', 'machine'], `${spec.name} must declare a visibility`).toContain(spec.visibility);
      } else {
        expect(spec.visibility, `${spec.name} is user-scope and must not declare one`).toBeUndefined();
      }
    }
  });

  it('keeps the self-read keys machine-local — browser.remote-control is a consent flag', async () => {
    const { CONFIG_KEYS } = await freshModules();
    const vis = (name: string) => CONFIG_KEYS.find((s: { name: string }) => s.name === name)?.visibility;

    // Nothing off-box reads these; storing them centrally syncs one machine's
    // choice to the rest. For browser.remote-control that is a security bug —
    // the flag gates whether OTHER machines may drive this box's browser.
    for (const name of ['browser.remote-control', 'browser.profile', 'scheduler.enabled', 'daemon.enabled']) {
      expect(vis(name), `${name} must be machine-local`).toBe('machine');
    }

    // A peer resolves these BEFORE it can dial the box, so they cannot be
    // machine-local — there is no way to ask the box for them first.
    for (const name of ['ssh.user', 'ssh.auth', 'platform', 'agents.max-concurrent']) {
      expect(vis(name), `${name} is read by peers and must be shared`).toBe('shared');
    }
  });
});

describe('machine-visibility keys never reach the fleet-shared file', () => {
  it('writes browser.remote-control to the local doc, not agents.yaml', async () => {
    const { setConfigValue, getConfigValue } = await freshModules();

    setConfigValue('browser.remote-control', true);

    // The consent flag gates whether OTHER machines may drive this box's
    // browser. It lands in this machine's gitignored doc; if it reached the
    // synced agents.yaml, one box's opt-in would propagate to the fleet on pull.
    expect(readCentral()).not.toContain('browserRemoteControl');
    const localDoc = fs.readFileSync(
      path.join(TMP, '.agents', 'devices', 'testbox', 'agents.yaml'), 'utf-8',
    );
    expect(localDoc).toContain('browserRemoteControl: true');
    expect(getConfigValue('browser.remote-control').value).toBe(true);
  });

  it('still writes a shared key centrally so peers can read it', async () => {
    const { setConfigValue } = await freshModules();
    setConfigValue('ssh.user', 'muqsit', { device: 'mac-mini' });
    // A peer resolves ssh.user BEFORE it can dial mac-mini, so this one must
    // stay in the synced file.
    expect(readCentral()).toContain('sshUser: muqsit');
  });

  it('refuses to read or set a machine-local key for a peer, and names the fix', async () => {
    const { getConfigValue, setConfigValue } = await freshModules();
    expect(() => getConfigValue('browser.remote-control', { device: 'mac-mini' }))
      .toThrow(/machine-local/);
    expect(() => setConfigValue('browser.remote-control', true, { device: 'mac-mini' }))
      .toThrow(/agents ssh mac-mini/);
  });

  it('honors a value an older CLI left centrally until it is overwritten', async () => {
    // The migration is additive, so a pre-upgrade central value must keep working
    // rather than silently reverting to the default on the first read.
    fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
    fs.writeFileSync(
      path.join(TMP, '.agents', 'agents.yaml'),
      'fleet:\n  devices:\n    testbox:\n      config:\n        browserRemoteControl: true\n',
    );
    const { getConfigValue } = await freshModules();
    expect(getConfigValue('browser.remote-control').value).toBe(true);
  });
});

describe('the machine-local key leaf stays pinned to the registry', () => {
  it('MACHINE_LOCAL_YAML_KEYS equals the machine-visibility keys in CONFIG_KEYS', async () => {
    // devices/config-migration.ts cannot import CONFIG_KEYS (device-config imports
    // it, so that would cycle), so the set is duplicated in a zero-dep leaf. This
    // is the pin that stops the two drifting — a new machine-visibility key that
    // is not added to the leaf would still be folded into the shared file.
    const { CONFIG_KEYS } = await freshModules();
    const { MACHINE_LOCAL_YAML_KEYS } = await import('./config-machine-keys.js');
    const fromRegistry = CONFIG_KEYS
      .filter((s: { scope: string; visibility?: string }) => s.scope === 'device' && s.visibility === 'machine')
      .map((s: { yamlKey: string }) => s.yamlKey)
      .sort();
    expect([...MACHINE_LOCAL_YAML_KEYS].sort()).toEqual(fromRegistry);
  });
});
