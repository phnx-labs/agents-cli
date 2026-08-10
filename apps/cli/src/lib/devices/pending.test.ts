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
 *   5. a device the user has ignored is never written as a sentinel, even when
 *      the caller passes it in a stale `pending` set (the probe/ignore race,
 *      RUSH-2495) — the writer re-subtracts the persisted ignore-list.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-pending-test-'));
process.env.HOME = TEST_HOME;

const { reconcilePendingSentinels, clearPendingSentinel, readPendingSentinels } = await import('./pending.js');
const { addIgnored, removeIgnored } = await import('./registry.js');

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
  it('creates one sentinel per pending device with the platform as content', async () => {
    await reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }, { name: 'win-mini', platform: 'windows' }]);
    const read = readPendingSentinels().sort((a, b) => a.name.localeCompare(b.name));
    expect(read).toEqual([
      { name: 'win-mini', platform: 'windows' },
      { name: 'zion', platform: 'macos' },
    ]);
  });

  it('removes a sentinel that is no longer pending on the next reconcile', async () => {
    await reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }, { name: 'win-mini', platform: 'windows' }]);
    // zion got registered → only win-mini remains pending.
    await reconcilePendingSentinels([{ name: 'win-mini', platform: 'windows' }]);
    expect(readPendingSentinels().map((p) => p.name)).toEqual(['win-mini']);
  });

  it('reconcile to empty clears everything', async () => {
    await reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }]);
    await reconcilePendingSentinels([]);
    expect(readPendingSentinels()).toEqual([]);
  });

  it('clearPendingSentinel removes exactly one and no-ops when absent', async () => {
    await reconcilePendingSentinels([{ name: 'zion', platform: 'macos' }, { name: 'win-mini', platform: 'windows' }]);
    clearPendingSentinel('zion');
    expect(readPendingSentinels().map((p) => p.name)).toEqual(['win-mini']);
    expect(() => clearPendingSentinel('zion')).not.toThrow(); // already gone
  });

  it('ignores a path-traversal device name (never escapes the dir)', async () => {
    await reconcilePendingSentinels([{ name: '../evil', platform: 'linux' }]);
    // Nothing written outside; the unsafe name is filtered out.
    expect(fs.existsSync(path.join(TEST_HOME, '.agents', '.cache', 'state', 'evil'))).toBe(false);
    expect(readPendingSentinels()).toEqual([]);
  });

  it('never re-surfaces a device the user has ignored, even in a stale pending set (RUSH-2495)', async () => {
    // The user dismissed 'ghost' (the menu-bar Ignore action persists it via
    // addIgnored). A device-probe that computed its `pending` set BEFORE the
    // dismissal landed still passes 'ghost' in — the writer must drop it.
    await addIgnored('ghost');
    try {
      await reconcilePendingSentinels([
        { name: 'ghost', platform: 'linux' },
        { name: 'zion', platform: 'macos' },
      ]);
      expect(readPendingSentinels().map((p) => p.name)).toEqual(['zion']);
      // And a sentinel that already existed for a device that then got ignored is
      // removed on the next reconcile, not left behind.
      await reconcilePendingSentinels([{ name: 'ghost', platform: 'linux' }]);
      expect(readPendingSentinels()).toEqual([]);
    } finally {
      await removeIgnored('ghost');
    }
  });
});
