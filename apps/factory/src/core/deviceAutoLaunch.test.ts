import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-autolaunch-test-'));
const ORIGINAL_DEVICES_DIR = process.env.AGENTS_DEVICES_DIR;

process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');

const {
  loadAutoLaunchPreferences,
  isAutoLaunchEnabled,
  isAutoLaunchPreferred,
  readDeviceMaxConcurrent,
} = await import('./deviceAutoLaunch');

function prefsPath(): string {
  return path.join(process.env.AGENTS_DEVICES_DIR!, 'auto-launch.json');
}

describe('deviceAutoLaunch', () => {
  beforeEach(() => {
    fs.rmSync(prefsPath(), { force: true });
    fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
  });

  afterAll(() => {
    process.env.AGENTS_DEVICES_DIR = ORIGINAL_DEVICES_DIR;
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  test('missing file defaults every device to enabled and not preferred', () => {
    const prefs = loadAutoLaunchPreferences();
    expect(prefs).toEqual({});
    expect(isAutoLaunchEnabled(prefs, 'zion')).toBe(true);
    expect(isAutoLaunchPreferred(prefs, 'zion')).toBe(false);
  });

  test('reads enabled and preferred flags', () => {
    const data = {
      devices: {
        'box-a': { enabled: false },
        'box-b': { preferred: true },
      },
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(prefsPath(), JSON.stringify(data));

    const prefs = loadAutoLaunchPreferences();
    expect(isAutoLaunchEnabled(prefs, 'box-a')).toBe(false);
    expect(isAutoLaunchPreferred(prefs, 'box-b')).toBe(true);
  });

  test('an unlisted device defaults to enabled and not preferred', () => {
    fs.writeFileSync(prefsPath(), JSON.stringify({ devices: {} }));
    const prefs = loadAutoLaunchPreferences();
    expect(isAutoLaunchEnabled(prefs, 'never-seen')).toBe(true);
    expect(isAutoLaunchPreferred(prefs, 'never-seen')).toBe(false);
  });

  // Counterpart to the CLI-side test that pins the opposite behavior
  // (apps/cli/src/lib/devices/auto-launch.test.ts: "throws on a corrupted file").
  // The extension must keep launching; see the module doc for why they differ.
  test('a corrupted file degrades to defaults rather than throwing', () => {
    fs.writeFileSync(prefsPath(), '{ not json at all');
    const prefs = loadAutoLaunchPreferences();
    expect(prefs).toEqual({});
    expect(isAutoLaunchEnabled(prefs, 'anything')).toBe(true);
  });

  test('non-object devices field returns empty map', () => {
    fs.writeFileSync(prefsPath(), JSON.stringify({ devices: 'bad', updatedAt: new Date().toISOString() }));
    const prefs = loadAutoLaunchPreferences();
    expect(prefs).toEqual({});
  });
});

describe('readDeviceMaxConcurrent (agents.max-concurrent from the device doc)', () => {
  const ORIGINAL_USER_DIR = process.env.AGENTS_USER_AGENTS_DIR;

  beforeEach(() => {
    process.env.AGENTS_USER_AGENTS_DIR = path.join(TEST_HOME, '.agents');
  });

  afterAll(() => {
    process.env.AGENTS_USER_AGENTS_DIR = ORIGINAL_USER_DIR;
  });

  function writeDeviceDoc(name: string, text: string): void {
    const dir = path.join(process.env.AGENTS_USER_AGENTS_DIR!, 'devices', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.yaml'), text);
  }

  test('missing doc means uncapped (undefined)', () => {
    expect(readDeviceMaxConcurrent('never-configured')).toBeUndefined();
  });

  test('reads config.maxAgents from the device doc', () => {
    writeDeviceDoc('mac-mini', 'config:\n  maxAgents: 4\n  schedulerEnabled: false\n');
    expect(readDeviceMaxConcurrent('mac-mini')).toBe(4);
  });

  test('a doc without maxAgents is uncapped', () => {
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
