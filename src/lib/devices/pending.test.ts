/**
 * Pending-device sentinel dir is the contract between the daemon probe (writer)
 * and the menu-bar helper (reader). Real bugs this guards:
 *   1. reconcile must ADD a sentinel for a new pending device and REMOVE one for
 *      a device that is no longer pending (registered/ignored/left the tailnet) —
 *      a stale sentinel would show a phantom "NEW DEVICE" forever.
 *   2. the file content is the platform (so the tray can label it) and survives
 *      a read-back.
 *   3. clearPendingSentinel removes exactly one and is a no-op when absent (the
 *      Register/Ignore actions call it; a throw would surface as a CLI error).
 *   4. a path-traversal name can never escape the sentinel dir.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-pending-test-'));
process.env.HOME = TEST_HOME;

const { reconcilePendingSentinels, clearPendingSentinel, readPendingSentinels } = await import('./pending.js');

function pendingDir(): string {
  return path.join(TEST_HOME, '.agents', '.cache', 'state', 'devices-pending');
}

beforeEach(async () => {
  await fsp.rm(pendingDir(), { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('pending-device sentinels', () => {
  it('creates one sentinel per pending device with the platform as content', () => {
    reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }, { name: 'win-mini', platform: 'windows' }]);
    const read = readPendingSentinels().sort((a, b) => a.name.localeCompare(b.name));
    expect(read).toEqual([
      { name: 'win-mini', platform: 'windows' },
      { name: 'zion', platform: 'macos' },
    ]);
  });

  it('removes a sentinel that is no longer pending on the next reconcile', () => {
    reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }, { name: 'win-mini', platform: 'windows' }]);
    // zion got registered → only win-mini remains pending.
    reconcilePendingSentinels([{ name: 'win-mini', platform: 'windows' }]);
    expect(readPendingSentinels().map((p) => p.name)).toEqual(['win-mini']);
  });

  it('reconcile to empty clears everything', () => {
    reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }]);
    reconcilePendingSentinels([]);
    expect(readPendingSentinels()).toEqual([]);
  });

  it('clearPendingSentinel removes exactly one and no-ops when absent', () => {
    reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }, { name: 'win-mini', platform: 'windows' }]);
    clearPendingSentinel('zion');
    expect(readPendingSentinels().map((p) => p.name)).toEqual(['win-mini']);
    expect(() => clearPendingSentinel('zion')).not.toThrow(); // already gone
  });

  it('ignores a path-traversal device name (never escapes the dir)', () => {
    reconcilePendingSentinels([{ name: '../evil', platform: 'linux' }]);
    // Nothing written outside; the unsafe name is filtered out.
    expect(fs.existsSync(path.join(TEST_HOME, '.agents', '.cache', 'state', 'evil'))).toBe(false);
    expect(readPendingSentinels()).toEqual([]);
  });
});
