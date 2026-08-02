/**
 * Persistence guarantees for device auto-launch preferences.
 *
 * These preferences control which registered devices Factory's auto-host
 * selection considers and which it prefers. The real bugs to guard:
 *   1. Preferences must survive a reload.
 *   2. enable/disable/prefer/unprefer are idempotent and invertible.
 *   3. Missing file defaults every device to enabled/not-preferred.
 *   4. A malformed file throws rather than silently emptying preferences.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-autolaunch-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');

const {
  loadAutoLaunchPreferences,
  setAutoLaunchEnabled,
  setAutoLaunchPreferred,
  isAutoLaunchEnabled,
  isAutoLaunchPreferred,
} = await import('./registry.js');

function prefsPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'auto-launch.json');
}

beforeEach(async () => {
  await fsp.rm(prefsPath(), { force: true });
  await fsp.rm(`${prefsPath()}.lock`, { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('device auto-launch preferences', () => {
  it('defaults every device to enabled and not preferred', async () => {
    expect(await isAutoLaunchEnabled('zion')).toBe(true);
    expect(await isAutoLaunchPreferred('zion')).toBe(false);
  });

  it('persists disabled state across reloads', async () => {
    await setAutoLaunchEnabled('zion', false);
    expect(await isAutoLaunchEnabled('zion')).toBe(false);
    expect(await isAutoLaunchEnabled('mac-mini')).toBe(true);
    const prefs = await loadAutoLaunchPreferences();
    expect(prefs).toEqual({ zion: { enabled: false } });
  });

  it('persists preferred state across reloads', async () => {
    await setAutoLaunchPreferred('mac-mini', true);
    expect(await isAutoLaunchPreferred('mac-mini')).toBe(true);
    expect(await isAutoLaunchPreferred('zion')).toBe(false);
    const prefs = await loadAutoLaunchPreferences();
    expect(prefs['mac-mini']).toEqual({ preferred: true });
  });

  it('is idempotent and inverts correctly', async () => {
    await setAutoLaunchEnabled('zion', false);
    await setAutoLaunchEnabled('zion', false);
    await setAutoLaunchEnabled('zion', true);
    const prefs = await loadAutoLaunchPreferences();
    expect(prefs).toEqual({});

    await setAutoLaunchPreferred('mac-mini', true);
    await setAutoLaunchPreferred('mac-mini', true);
    await setAutoLaunchPreferred('mac-mini', false);
    expect(await loadAutoLaunchPreferences()).toEqual({});
  });

  it('throws on a corrupted file instead of silently emptying it', async () => {
    await fsp.mkdir(path.dirname(prefsPath()), { recursive: true });
    await fsp.writeFile(prefsPath(), '{ this is not json');
    await expect(loadAutoLaunchPreferences()).rejects.toThrow(/corrupted/);
  });
});
