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
} = await import('./deviceAutoLaunch');

function centralPath(): string {
  return path.join(process.env.AGENTS_USER_AGENTS_DIR!, 'agents.yaml');
}

/** Seed the central agents.yaml with a fleet.devices map. */
function writeCentral(text: string): void {
  fs.mkdirSync(path.dirname(centralPath()), { recursive: true });
  fs.writeFileSync(centralPath(), text);
}

describe('deviceAutoLaunch (central fleet.devices.<name>.config)', () => {
  beforeEach(() => {
    fs.rmSync(centralPath(), { force: true });
  });

  test('missing file defaults every device to enabled and not preferred', () => {
    const prefs = loadAutoLaunchPreferences();
    expect(prefs).toEqual({});
    expect(isAutoLaunchEnabled(prefs, 'zion')).toBe(true);
    expect(isAutoLaunchPreferred(prefs, 'zion')).toBe(false);
  });

  test('reads enabled and preferred flags from the central config block', () => {
    writeCentral(
      'fleet:\n  devices:\n    box-a:\n      config:\n        autoLaunchEnabled: false\n    box-b:\n      config:\n        autoLaunchPreferred: true\n',
    );

    const prefs = loadAutoLaunchPreferences();
    expect(isAutoLaunchEnabled(prefs, 'box-a')).toBe(false);
    expect(isAutoLaunchPreferred(prefs, 'box-b')).toBe(true);
  });

  test('an unlisted device defaults to enabled and not preferred', () => {
    writeCentral('fleet:\n  devices: {}\n');
    const prefs = loadAutoLaunchPreferences();
    expect(isAutoLaunchEnabled(prefs, 'never-seen')).toBe(true);
    expect(isAutoLaunchPreferred(prefs, 'never-seen')).toBe(false);
  });

  test('a `devices: all` manifest carries no per-device flags', () => {
    writeCentral('fleet:\n  devices: all\n');
    expect(loadAutoLaunchPreferences()).toEqual({});
  });

  // Counterpart to the CLI-side corruption contract (which throws on a corrupt
  // store). The extension must keep launching; see the module doc for why they
  // differ.
  test('a corrupted file degrades to defaults rather than throwing', () => {
    writeCentral('fleet:\n  devices: [unclosed\n');
    const prefs = loadAutoLaunchPreferences();
    expect(prefs).toEqual({});
    expect(isAutoLaunchEnabled(prefs, 'anything')).toBe(true);
  });

  test('a non-map config block is ignored', () => {
    writeCentral('fleet:\n  devices:\n    box:\n      config: just-a-string\n');
    expect(loadAutoLaunchPreferences()).toEqual({});
  });
});

describe('readDeviceMaxConcurrent (agents.max-concurrent from the central block)', () => {
  beforeEach(() => {
    fs.rmSync(centralPath(), { force: true });
  });

  test('missing file means uncapped (undefined)', () => {
    expect(readDeviceMaxConcurrent('never-configured')).toBeUndefined();
  });

  test('reads config.maxAgents from the central block', () => {
    writeCentral(
      'fleet:\n  devices:\n    mac-mini:\n      config:\n        maxAgents: 4\n        schedulerEnabled: false\n',
    );
    expect(readDeviceMaxConcurrent('mac-mini')).toBe(4);
  });

  test('a device without maxAgents is uncapped', () => {
    writeCentral('fleet:\n  devices:\n    zion:\n      config:\n        schedulerEnabled: true\n');
    expect(readDeviceMaxConcurrent('zion')).toBeUndefined();
  });

  test('invalid cap values are ignored (uncapped), not trusted', () => {
    writeCentral(
      'fleet:\n  devices:\n    bad-zero:\n      config:\n        maxAgents: 0\n    bad-string:\n      config:\n        maxAgents: four\n    bad-float:\n      config:\n        maxAgents: 2.5\n',
    );
    expect(readDeviceMaxConcurrent('bad-zero')).toBeUndefined();
    expect(readDeviceMaxConcurrent('bad-string')).toBeUndefined();
    expect(readDeviceMaxConcurrent('bad-float')).toBeUndefined();
  });

  test('a malformed file degrades to uncapped rather than throwing', () => {
    writeCentral('fleet:\n  devices: [unclosed\n');
    expect(readDeviceMaxConcurrent('broken')).toBeUndefined();
  });
});

afterAll(() => {
  process.env.AGENTS_USER_AGENTS_DIR = ORIGINAL_USER_DIR;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});
