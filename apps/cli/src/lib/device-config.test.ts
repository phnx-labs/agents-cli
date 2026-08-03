import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// state.ts resolves HOME and the device id at import time, so we point both at a
// throwaway temp dir and re-import the modules fresh for each test — the REAL
// partition + overlay + device-doc routing against real files, no mocks
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
function devicePath(host = 'testbox') {
  return path.join(TMP, '.agents', 'devices', host, 'agents.yaml');
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
  it('round-trips through central agents.yaml under config:, never the device doc', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('interactive.host', 'zion');

    const central = readCentral();
    expect(central).toContain('config:');
    expect(central).toContain('interactiveHost: zion');
    // User scope never lands in the per-device doc.
    expect(fs.existsSync(devicePath()) ? fs.readFileSync(devicePath(), 'utf-8') : '').not.toContain('interactiveHost');

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

describe('device-scope keys', () => {
  it('round-trips through devices/<host>/agents.yaml under config:, never central', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('agents.max-concurrent', 4);
    setConfigValue('scheduler.enabled', false);
    setConfigValue('notes', ['runs the releases']);

    const device = fs.readFileSync(devicePath(), 'utf-8');
    expect(device).toContain('config:');
    expect(device).toContain('maxAgents: 4');
    expect(device).toContain('schedulerEnabled: false');
    expect(device).toContain('- runs the releases');

    const central = readCentral();
    expect(central).not.toContain('maxAgents');
    expect(central).not.toContain('schedulerEnabled');
    expect(central).not.toContain('notes:');

    expect(getConfigValue('agents.max-concurrent')).toMatchObject({ value: 4, layer: 'device' });
    expect(getConfigValue('scheduler.enabled')).toMatchObject({ value: false, layer: 'device' });
    expect(getConfigValue('notes')).toMatchObject({ value: ['runs the releases'], layer: 'device' });

    unsetConfigValue('agents.max-concurrent');
    expect(getConfigValue('agents.max-concurrent').value).toBeUndefined();
    // The other device-scope keys survive an unset of a sibling key.
    expect(getConfigValue('scheduler.enabled').value).toBe(false);
    expect(fs.readFileSync(devicePath(), 'utf-8')).not.toContain('maxAgents');
  });

  it('targets another device by writing its doc in place (devices/ tree syncs)', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('agents.max-concurrent', 2, { device: 'mac-mini' });
    setConfigValue('notes', ['do not reboot'], { device: 'mac-mini' });

    const peer = fs.readFileSync(devicePath('mac-mini'), 'utf-8');
    expect(peer).toContain('maxAgents: 2');
    expect(peer).toContain('- do not reboot');

    // Self doc and central stay clean of the peer's values.
    expect(fs.existsSync(devicePath()) ? fs.readFileSync(devicePath(), 'utf-8') : '').not.toContain('maxAgents');
    expect(readCentral()).not.toContain('maxAgents');

    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(2);
    expect(getConfigValue('agents.max-concurrent').value).toBeUndefined();

    unsetConfigValue('agents.max-concurrent', { device: 'mac-mini' });
    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBeUndefined();
    // Unsetting a key that was never set on a peer with no doc is a no-op.
    unsetConfigValue('scheduler.enabled', { device: 'ghost' });
    expect(fs.existsSync(devicePath('ghost'))).toBe(false);
  });

  it('preserves a peer doc’s other fields across a config write', async () => {
    const { setConfigValue } = await freshModules();
    // A peer doc that already pins an agent version.
    fs.mkdirSync(path.dirname(devicePath('mac-mini')), { recursive: true });
    fs.writeFileSync(devicePath('mac-mini'), 'agents:\n  claude: 2.1.0\n');

    setConfigValue('scheduler.enabled', false, { device: 'mac-mini' });

    const peer = fs.readFileSync(devicePath('mac-mini'), 'utf-8');
    expect(peer).toContain('claude: 2.1.0');
    expect(peer).toContain('schedulerEnabled: false');
  });
});

describe('browser.profile routes to defaultBrowserProfile (no config: key)', () => {
  it('set/get/unset land on the existing device-local field', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue, readMeta } = await freshModules();

    setConfigValue('browser.profile', 'comet-local');

    const device = fs.readFileSync(devicePath(), 'utf-8');
    expect(device).toContain('defaultBrowserProfile: comet-local');
    expect(device).not.toContain('config:');
    expect(readMeta().defaultBrowserProfile).toBe('comet-local');

    const got = getConfigValue('browser.profile');
    expect(got.value).toBe('comet-local');
    expect(got.layer).toBe('device');

    unsetConfigValue('browser.profile');
    expect(readMeta().defaultBrowserProfile).toBeUndefined();
    expect(fs.readFileSync(devicePath(), 'utf-8')).not.toContain('defaultBrowserProfile');
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

    const entries = listConfig();
    const byName = Object.fromEntries(entries.map((e) => [e.spec.name, e]));
    expect(Object.keys(byName).sort()).toEqual([
      'agents.max-concurrent',
      'browser.profile',
      'interactive.host',
      'notes',
      'scheduler.enabled',
    ]);
    expect(byName['interactive.host']).toMatchObject({ value: 'zion', layer: 'user' });
    expect(byName['scheduler.enabled']).toMatchObject({ value: true, layer: 'device' });
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
      /agents devices configure testbox --scheduler on/,
    );
  });

  it('a peer device’s scheduler.enabled does not gate this machine', async () => {
    const { isSchedulerEnabled, setConfigValue } = await freshModules();
    setConfigValue('scheduler.enabled', false, { device: 'mac-mini' });
    expect(isSchedulerEnabled()).toBe(true);
  });
});

describe('readMaxConcurrentCaps', () => {
  it('reads caps from local + peer device docs, omitting uncapped devices', async () => {
    const { readMaxConcurrentCaps, setConfigValue } = await freshModules();
    setConfigValue('agents.max-concurrent', 4);                    // self (testbox)
    setConfigValue('agents.max-concurrent', 2, { device: 'mac-mini' }); // peer doc

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

describe('device doc corruption contract', () => {
  it('rejects valid-but-non-map YAML with the corruption error, not a later TypeError', async () => {
    const { getConfigValue, setConfigValue } = await freshModules();
    fs.mkdirSync(path.dirname(devicePath('mac-mini')), { recursive: true });
    fs.writeFileSync(devicePath('mac-mini'), 'just a string\n');
    expect(() => getConfigValue('agents.max-concurrent', { device: 'mac-mini' }))
      .toThrow(/Device config corrupted.*expected a YAML map/);
    expect(() => setConfigValue('agents.max-concurrent', 2, { device: 'mac-mini' }))
      .toThrow(/Device config corrupted/);

    fs.writeFileSync(devicePath('mac-mini'), '- a\n- b\n');
    expect(() => getConfigValue('agents.max-concurrent', { device: 'mac-mini' }))
      .toThrow(/Device config corrupted.*got a list/);
  });

  it('still parses a header-only (empty) doc as empty', async () => {
    const { getConfigValue } = await freshModules();
    fs.mkdirSync(path.dirname(devicePath('mac-mini')), { recursive: true });
    fs.writeFileSync(devicePath('mac-mini'), '# agents-cli metadata\n');
    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBeUndefined();
  });
});

describe('self vs peer routing is case-insensitive', () => {
  it('targeting TESTBOX on host testbox takes the self path (no peer doc created)', async () => {
    const { setConfigValue, getConfigValue, unsetConfigValue } = await freshModules();

    setConfigValue('agents.max-concurrent', 3, { device: 'TESTBOX' });
    // Written through the SELF path: the value is visible to a plain self read
    // (readMeta + overlay of devices/testbox/agents.yaml). (No peer-path
    // assertion — macOS fileystems are case-insensitive, so devices/TESTBOX and
    // devices/testbox are the same file there.)
    expect(getConfigValue('agents.max-concurrent').value).toBe(3);
    expect(fs.readFileSync(devicePath('testbox'), 'utf-8')).toContain('maxAgents: 3');

    expect(getConfigValue('agents.max-concurrent', { device: 'TestBox' }).value).toBe(3);
    unsetConfigValue('agents.max-concurrent', { device: 'TESTBOX' });
    expect(getConfigValue('agents.max-concurrent').value).toBeUndefined();
  });
});
