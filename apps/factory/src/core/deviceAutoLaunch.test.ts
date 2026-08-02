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
