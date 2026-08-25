import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The v2 store convergence: the central `fleet.devices.<name>.config` block
 * (#2458) and legacy `.history/devices/auto-launch.json` fold into each
 * per-device doc's `config:`; doc-level `defaultBrowserProfile:` folds into
 * `config:`; and agent pins leave the tracked docs — SELF's pins move to the
 * untracked `.history/devices/pins-<host>.json`, peers' pins are dropped.
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
function writeCentral(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(centralPath(), yamlText);
}
function deviceDocPath(host: string) {
  return path.join(TMP, '.agents', 'devices', host, 'agents.yaml');
}
function writeDoc(host: string, yamlText: string) {
  fs.mkdirSync(path.dirname(deviceDocPath(host)), { recursive: true });
  fs.writeFileSync(deviceDocPath(host), yamlText);
}
function readDoc(host: string): string {
  return fs.existsSync(deviceDocPath(host)) ? fs.readFileSync(deviceDocPath(host), 'utf-8') : '';
}
function autoLaunchPath() {
  return path.join(TMP, '.agents', '.history', 'devices', 'auto-launch.json');
}
function pinsPath(host = 'testbox') {
  return path.join(TMP, '.agents', '.history', 'devices', `pins-${host}.json`);
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

describe('migrateDeviceConfigStores', () => {
  it('folds the central #2458 block into per-device docs (central wins) and strips it', async () => {
    writeCentral(
      'fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 8\n        schedulerEnabled: false\n',
    );
    // A doc with an OLDER value for one key — central wins the conflict.
    writeDoc('mac-mini', 'routines:\n  - watchdog\nconfig:\n  maxAgents: 4\n  notes:\n    - runs the releases\n');

    const { migrateDeviceConfigStores, getConfigValue, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(8);
    // scheduler.enabled is machine-local — a peer read is refused, so assert
    // the fold via the doc itself.
    expect(readDoc('mac-mini')).toContain('schedulerEnabled: false');
    expect(getConfigValue('notes', { device: 'mac-mini' }).value).toEqual(['runs the releases']);

    // The doc keeps routines: and gains the merged config:.
    const doc = readDoc('mac-mini');
    expect(doc).toContain('- watchdog');
    expect(doc).toContain('maxAgents: 8');

    // Central is stripped — an override with nothing left is dropped, and an
    // emptied fleet block goes away entirely.
    expect(readCentral()).not.toContain('maxAgents');
    expect(readMeta().fleet).toBeUndefined();
  });

  it('keeps non-config override fields (agents/sync/login) in central while stripping config', async () => {
    writeCentral(
      'fleet:\n  devices:\n    mac-mini:\n      agents:\n        - claude@latest\n      config:\n        maxAgents: 8\n',
    );

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    const fleet = readMeta().fleet;
    const devices = fleet?.devices as Record<string, Record<string, unknown>>;
    expect(devices['mac-mini']).toEqual({ agents: ['claude@latest'] });
    expect(readDoc('mac-mini')).toContain('maxAgents: 8');
  });

  it('folds auto-launch.json flags into device docs and removes the file', async () => {
    fs.mkdirSync(path.dirname(autoLaunchPath()), { recursive: true });
    fs.writeFileSync(
      autoLaunchPath(),
      JSON.stringify({
        devices: { zion: { enabled: false }, 'mac-mini': { preferred: true } },
        updatedAt: new Date().toISOString(),
      }),
    );

    const { migrateDeviceConfigStores, isAutoLaunchEnabled, isAutoLaunchPreferred, loadAutoLaunchPreferences } =
      await freshModules();
    migrateDeviceConfigStores();

    expect(isAutoLaunchEnabled('zion')).toBe(false);
    expect(isAutoLaunchPreferred('mac-mini')).toBe(true);
    expect(loadAutoLaunchPreferences()).toEqual({
      zion: { enabled: false },
      'mac-mini': { preferred: true },
    });
    expect(fs.existsSync(autoLaunchPath())).toBe(false);
    expect(readDoc('zion')).toContain('autoLaunchEnabled: false');
  });

  it('folds a doc-level defaultBrowserProfile into config:', async () => {
    writeDoc('testbox', 'defaultBrowserProfile: comet-local\n');

    const { migrateDeviceConfigStores, getConfigValue } = await freshModules();
    migrateDeviceConfigStores();

    expect(getConfigValue('browser.profile').value).toBe('comet-local');
    const doc = readDoc('testbox');
    expect(doc).toContain('config:');
    expect(doc).toContain('defaultBrowserProfile: comet-local');
    // Exactly one occurrence — the top-level key folded into the block.
    expect(doc.indexOf('defaultBrowserProfile')).toBe(doc.lastIndexOf('defaultBrowserProfile'));
  });

  it('moves SELF pins to the untracked pins file and drops peer pins from the tracked docs', async () => {
    writeDoc('testbox', 'agents:\n  claude: 2.1.0\nisolatedAgents:\n  codex: 0.144.6\nroutines:\n  - watchdog\n');
    writeDoc('mac-mini', 'agents:\n  claude: 2.0.14\nconfig:\n  maxAgents: 4\n');

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    // Self pins land in the pins JSON…
    const pins = JSON.parse(fs.readFileSync(pinsPath(), 'utf-8'));
    expect(pins).toEqual({ agents: { claude: '2.1.0' }, isolatedAgents: { codex: '0.144.6' } });
    // …and read back through the overlay.
    expect(readMeta().agents?.claude).toBe('2.1.0');
    expect(readMeta().isolatedAgents?.codex).toBe('0.144.6');

    // The tracked docs keep operator-owned fields only.
    const selfDoc = readDoc('testbox');
    expect(selfDoc).not.toContain('claude');
    expect(selfDoc).not.toContain('codex');
    expect(selfDoc).toContain('- watchdog');
    const peerDoc = readDoc('mac-mini');
    expect(peerDoc).not.toContain('claude');
    expect(peerDoc).toContain('maxAgents: 4');
    // Peers get NO pins file here — each peer owns its own locally.
    expect(fs.existsSync(pinsPath('mac-mini'))).toBe(false);
  });

  it('pins file wins over doc pins on conflict (destination-wins, crash-safe re-run)', async () => {
    fs.mkdirSync(path.dirname(pinsPath()), { recursive: true });
    fs.writeFileSync(pinsPath(), JSON.stringify({ agents: { claude: '2.2.0' } }, null, 2) + '\n');
    writeDoc('testbox', 'agents:\n  claude: 2.1.0\n');

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    expect(readMeta().agents?.claude).toBe('2.2.0');
    expect(readDoc('testbox')).toBe(''); // doc had only pins → removed
  });

  it('is idempotent — a second run changes nothing', async () => {
    writeCentral('fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 8\n');
    writeDoc('testbox', 'agents:\n  claude: 2.1.0\n');

    const { migrateDeviceConfigStores } = await freshModules();
    migrateDeviceConfigStores();
    const afterFirst = [readCentral(), readDoc('testbox'), readDoc('mac-mini'), fs.readFileSync(pinsPath(), 'utf-8')];
    migrateDeviceConfigStores();
    expect([readCentral(), readDoc('testbox'), readDoc('mac-mini'), fs.readFileSync(pinsPath(), 'utf-8')]).toEqual(afterFirst);
  });

  it('skips a corrupted device doc loudly and leaves it for a later retry', async () => {
    writeDoc('broken', 'config:\n  maxAgents: [unclosed\n');
    writeDoc('mac-mini', 'config:\n  maxAgents: 4\n');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { migrateDeviceConfigStores, getConfigValue } = await freshModules();
    try {
      migrateDeviceConfigStores();

      // The healthy device is untouched (its config was already home); the
      // broken one is left in place.
      expect(getConfigValue('agents.max-concurrent', { device: 'mac-mini' }).value).toBe(4);
      expect(fs.existsSync(deviceDocPath('broken'))).toBe(true);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('broken'));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('is a no-op when no legacy stores exist', async () => {
    writeDoc('mac-mini', 'config:\n  maxAgents: 4\n'); // already current layout
    const { migrateDeviceConfigStores } = await freshModules();
    migrateDeviceConfigStores();
    expect(readCentral()).toBe('');
    expect(readDoc('mac-mini')).toContain('maxAgents: 4');
  });

  it('folds a legacy ignored.json into fleet.ignored, removes the file, and re-running is a no-op', async () => {
    const legacy = path.join(TMP, '.agents', '.history', 'devices', 'ignored.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(
      legacy,
      JSON.stringify({ ignored: ['old-phone', 'ipad165'], updatedAt: '2026-08-01T10:00:00.000Z' }),
    );

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    // Entries preserved — the legacy file's updatedAt becomes ignoredAt, and
    // the folding box is the only attribution the legacy store could offer.
    const fleet = readMeta().fleet as unknown as { ignored: Array<Record<string, string>> };
    expect(fleet.ignored).toEqual([
      { name: 'ipad165', ignoredAt: '2026-08-01T10:00:00.000Z', ignoredOn: 'testbox' },
      { name: 'old-phone', ignoredAt: '2026-08-01T10:00:00.000Z', ignoredOn: 'testbox' },
    ]);
    // The dismissal now lives in the TRACKED central file…
    expect(readCentral()).toContain('ignored:');
    // …and the legacy file is gone.
    expect(fs.existsSync(legacy)).toBe(false);

    // Second run: nothing to fold — no duplication, no rewrite.
    const afterFirst = readCentral();
    migrateDeviceConfigStores();
    expect(readCentral()).toBe(afterFirst);
    const fleet2 = readMeta().fleet as unknown as { ignored: Array<Record<string, string>> };
    expect(fleet2.ignored).toHaveLength(2);
  });

  it('unions legacy names with existing fleet.ignored entries — existing who/when wins', async () => {
    writeCentral(
      'fleet:\n  devices: {}\n  ignored:\n    - name: ipad165\n      ignoredAt: "2026-07-01T00:00:00.000Z"\n      ignoredOn: zion\n',
    );
    const legacy = path.join(TMP, '.agents', '.history', 'devices', 'ignored.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ ignored: ['ipad165', 'kindle'], updatedAt: '2026-08-01T10:00:00.000Z' }));

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    const fleet = readMeta().fleet as unknown as { ignored: Array<Record<string, string>> };
    expect(fleet.ignored).toEqual([
      { name: 'ipad165', ignoredAt: '2026-07-01T00:00:00.000Z', ignoredOn: 'zion' }, // untouched
      { name: 'kindle', ignoredAt: '2026-08-01T10:00:00.000Z', ignoredOn: 'testbox' }, // folded
    ]);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('leaves a malformed legacy ignored.json in place (loudly) for a later retry', async () => {
    const legacy = path.join(TMP, '.agents', '.history', 'devices', 'ignored.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, '{ this is not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { migrateDeviceConfigStores } = await freshModules();
    try {
      migrateDeviceConfigStores();

      expect(fs.existsSync(legacy)).toBe(true); // never silently emptied
      expect(readCentral()).not.toContain('ignored:');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ignored.json'));
    } finally {
      errSpy.mockRestore();
    }
  });

  it('never drops a populated fleet.ignored when the #2458 strip empties the rest of the fleet block', async () => {
    // A box carrying BOTH legacy central per-device config AND dismissals: the
    // strip must not delete the whole fleet block — the deletion would sync
    // fleet-wide via `agents repo push`.
    writeCentral(
      'fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 8\n  ignored:\n    - name: ipad165\n      ignoredAt: "2026-08-20T09:15:00.000Z"\n      ignoredOn: zion\n',
    );

    const { migrateDeviceConfigStores, readMeta } = await freshModules();
    migrateDeviceConfigStores();

    const fleet = readMeta().fleet as unknown as { devices: Record<string, unknown>; ignored: Array<Record<string, string>> };
    expect(fleet).toBeDefined();
    expect(fleet.ignored).toEqual([
      { name: 'ipad165', ignoredAt: '2026-08-20T09:15:00.000Z', ignoredOn: 'zion' },
    ]);
    expect(fleet.devices).toEqual({}); // config stripped, block kept
    expect(readDoc('mac-mini')).toContain('maxAgents: 8');
  });
});
