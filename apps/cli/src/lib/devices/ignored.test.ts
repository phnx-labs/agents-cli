/**
 * Persistence guarantees for the device ignore-list.
 *
 * The ignore-list is what makes "a dismissed device never resurfaces" true, so
 * the real bugs to guard:
 *   1. addIgnored must survive a reload (a dismissal that evaporates would let
 *      the node re-appear on the next sync — exactly what the user asked us to
 *      prevent).
 *   2. addIgnored is idempotent and removeIgnored is the exact inverse.
 *   3. A malformed file throws rather than silently returning an empty set that
 *      the next write would clobber (the data-loss path, mirroring the registry).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Set HOME before state.ts loads so its module-level root picks up the override.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-ignored-test-'));
process.env.HOME = TEST_HOME;

const { loadIgnored, addIgnored, removeIgnored, isIgnored } = await import('./registry.js');

function ignoredPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'devices', 'ignored.json');
}

beforeEach(async () => {
  await fsp.rm(ignoredPath(), { force: true });
  await fsp.rm(`${ignoredPath()}.lock`, { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('device ignore-list', () => {
  it('returns an empty set when the file does not exist', async () => {
    expect([...(await loadIgnored())]).toEqual([]);
  });

  it('persists a dismissal across reloads', async () => {
    await addIgnored('ipad165');
    expect(await isIgnored('ipad165')).toBe(true);
    // Fresh read from disk — not the in-memory set from addIgnored.
    expect([...(await loadIgnored())]).toEqual(['ipad165']);
  });

  it('is idempotent and stores names sorted', async () => {
    await addIgnored('win-mini');
    await addIgnored('ipad165');
    await addIgnored('win-mini');
    expect([...(await loadIgnored())]).toEqual(['ipad165', 'win-mini']);
  });

  it('removeIgnored is the exact inverse and reports miss vs hit', async () => {
    await addIgnored('mac-mini');
    expect(await removeIgnored('mac-mini')).toBe(true);
    expect(await isIgnored('mac-mini')).toBe(false);
    expect(await removeIgnored('mac-mini')).toBe(false);
  });

  it('throws on a corrupted file instead of silently emptying it', async () => {
    await fsp.mkdir(path.dirname(ignoredPath()), { recursive: true });
    await fsp.writeFile(ignoredPath(), '{ this is not json');
    await expect(loadIgnored()).rejects.toThrow(/corrupted/);
  });
});
