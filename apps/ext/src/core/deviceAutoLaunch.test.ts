import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-autolaunch-test-'));
const ORIGINAL_USER_DIR = process.env.AGENTS_USER_AGENTS_DIR;

process.env.AGENTS_USER_AGENTS_DIR = path.join(TEST_HOME, '.agents');

const {
  loadAutoLaunchPreferences,
  isAutoLaunchEnabled,
  isAutoLaunchPreferred,
  readDeviceMaxConcurrent,
  FLEET_DEFAULTS_KEY,
} = await import('./deviceAutoLaunch');

function centralPath(): string {
  return path.join(process.env.AGENTS_USER_AGENTS_DIR!, 'agents.yaml');
}

function writeCentral(text: string): void {
  fs.mkdirSync(path.dirname(centralPath()), { recursive: true });
  fs.writeFileSync(centralPath(), text);
}

function deviceDocPath(name: string): string {
  return path.join(process.env.AGENTS_USER_AGENTS_DIR!, 'devices', name, 'agents.yaml');
}

function writeDeviceDoc(name: string, text: string): void {
  fs.mkdirSync(path.dirname(deviceDocPath(name)), { recursive: true });
  fs.writeFileSync(deviceDocPath(name), text);
}

beforeEach(() => {
  fs.rmSync(centralPath(), { force: true });
  fs.rmSync(path.join(process.env.AGENTS_USER_AGENTS_DIR!, 'devices'), { recursive: true, force: true });
});

afterAll(() => {
  process.env.AGENTS_USER_AGENTS_DIR = ORIGINAL_USER_DIR;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('deviceAutoLaunch (per-device docs + fleet.defaults.config)', () => {
  test('missing files default every device to enabled and not preferred', () => {
    const prefs = loadAutoLaunchPreferences();
    expect(prefs).toEqual({});
    expect(isAutoLaunchEnabled(prefs, 'zion')).toBe(true);
    expect(isAutoLaunchPreferred(prefs, 'zion')).toBe(false);
  });

  test('reads enabled and preferred flags from per-device docs', () => {
    writeDeviceDoc('box-a', 'config:\n  autoLaunchEnabled: false\n');
    writeDeviceDoc('box-b', 'config:\n  autoLaunchPreferred: true\n');

    const prefs = loadAutoLaunchPreferences();
    expect(isAutoLaunchEnabled(prefs, 'box-a')).toBe(false);
    expect(isAutoLaunchPreferred(prefs, 'box-b')).toBe(true);
  });

  test('an unlisted device defaults to enabled and not preferred', () => {
    writeDeviceDoc('box-a', 'config:\n  autoLaunchEnabled: false\n');
    const prefs = loadAutoLaunchPreferences();
    expect(isAutoLaunchEnabled(prefs, 'never-seen')).toBe(true);
    expect(isAutoLaunchPreferred(prefs, 'never-seen')).toBe(false);
  });

  test('the fleet-defaults layer applies to every device; a device entry wins', () => {
    writeCentral('fleet:\n  devices: {}\n  defaults:\n    config:\n      autoLaunchEnabled: false\n');
    writeDeviceDoc('box-a', 'config:\n  autoLaunchEnabled: true\n');

    const prefs = loadAutoLaunchPreferences();
    expect(prefs[FLEET_DEFAULTS_KEY]).toEqual({ enabled: false });
    // A device with no own flag inherits the fleet default…
    expect(isAutoLaunchEnabled(prefs, 'zion')).toBe(false);
    // …and a device entry wins over it.
    expect(isAutoLaunchEnabled(prefs, 'box-a')).toBe(true);
  });

  // Counterpart to the CLI-side corruption contract (which throws on a corrupt
  // store). The extension must keep launching; see the module doc for why they
  // differ.
  test('a corrupted file degrades to defaults rather than throwing', () => {
    writeDeviceDoc('broken', 'config:\n  autoLaunchEnabled: [unclosed\n');
    const prefs = loadAutoLaunchPreferences();
    expect(isAutoLaunchEnabled(prefs, 'broken')).toBe(true);
    writeCentral('fleet: [unclosed\n');
    expect(loadAutoLaunchPreferences()).toEqual({});
  });

  test('a non-map config block is ignored', () => {
    writeDeviceDoc('box', 'config: just-a-string\n');
    expect(loadAutoLaunchPreferences()).toEqual({});
  });
});

describe('readDeviceMaxConcurrent (agents.max-concurrent, device doc over fleet default)', () => {
  test('missing files mean uncapped (undefined)', () => {
    expect(readDeviceMaxConcurrent('never-configured')).toBeUndefined();
  });

  test('reads config.maxAgents from the device doc', () => {
    writeDeviceDoc('mac-mini', 'config:\n  maxAgents: 4\n  schedulerEnabled: false\n');
    expect(readDeviceMaxConcurrent('mac-mini')).toBe(4);
  });

  test('the fleet default applies when the device has no own cap; the device doc wins', () => {
    writeCentral('fleet:\n  devices: {}\n  defaults:\n    config:\n      maxAgents: 2\n');
    expect(readDeviceMaxConcurrent('zion')).toBe(2);

    writeDeviceDoc('mac-mini', 'config:\n  maxAgents: 8\n');
    expect(readDeviceMaxConcurrent('mac-mini')).toBe(8);
  });

  test('a device without maxAgents is uncapped', () => {
    writeDeviceDoc('zion', 'config:\n  schedulerEnabled: true\n');
    expect(readDeviceMaxConcurrent('zion')).toBeUndefined();
  });

  test('invalid cap values are ignored (uncapped), not trusted', () => {
    writeDeviceDoc('bad-zero', 'config:\n  maxAgents: 0\n');
    writeDeviceDoc('bad-string', 'config:\n  maxAgents: four\n');
    writeDeviceDoc('bad-float', 'config:\n  maxAgents: 2.5\n');
    expect(readDeviceMaxConcurrent('bad-zero')).toBeUndefined();
    expect(readDeviceMaxConcurrent('bad-string')).toBeUndefined();
    expect(readDeviceMaxConcurrent('bad-float')).toBeUndefined();
  });

  test('a malformed doc degrades to uncapped rather than throwing', () => {
    writeDeviceDoc('broken', 'config:\n  maxAgents: [unclosed\n');
    expect(readDeviceMaxConcurrent('broken')).toBeUndefined();
  });
});
