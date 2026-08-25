/**
 * Persistence guarantees for the device ignore-list.
 *
 * The ignore-list is what makes "a dismissed device never resurfaces" true, so
 * the real bugs to guard:
 *   1. addIgnored must survive a reload (a dismissal that evaporates would let
 *      the node re-appear on the next sync — exactly what the user asked us to
 *      prevent), and it must land in the TRACKED central agents.yaml
 *      (`fleet.ignored`) so the dismissal reaches every box (RUSH-3062).
 *   2. addIgnored is idempotent and removeIgnored is the exact inverse — a
 *      re-add keeps the original who/when rather than rewriting history.
 *   3. A malformed `fleet.ignored` block throws rather than silently returning
 *      an empty set that the next write would clobber (the data-loss path,
 *      mirroring the registry) — and a WRITE against it must fail too, never
 *      replace the block.
 *   4. An ignored node stays subtracted from the discovery pending-diff (the
 *      behavior runDeviceSync depends on at sync.ts's loadIgnored call site).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Set HOME before state.ts loads so its module-level root picks up the override.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-ignored-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');

const { loadIgnored, loadIgnoredEntries, addIgnored, removeIgnored, isIgnored } = await import('./registry.js');
const { computePendingDevices } = await import('./sync.js');
import type { TailscaleNode } from './tailscale.js';

function centralPath(): string {
  return path.join(TEST_HOME, '.agents', 'agents.yaml');
}
function readCentral(): string {
  return fs.existsSync(centralPath()) ? fs.readFileSync(centralPath(), 'utf-8') : '';
}
function node(name: string): TailscaleNode {
  return { name, platform: 'linux', online: true, direct: true, sharee: false };
}

beforeEach(async () => {
  // Fresh central store (and its lock dir) per test.
  await fsp.rm(path.join(TEST_HOME, '.agents'), { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('device ignore-list', () => {
  it('returns an empty set when nothing is ignored', async () => {
    expect([...(await loadIgnored())]).toEqual([]);
    expect(loadIgnoredEntries()).toEqual([]);
  });

  it('persists a dismissal across reloads and lands in the TRACKED central agents.yaml', async () => {
    await addIgnored('ipad165');
    expect(await isIgnored('ipad165')).toBe(true);
    // Fresh read from disk — not the in-memory set from addIgnored.
    expect([...(await loadIgnored())]).toEqual(['ipad165']);
    // The dismissal is a fleet-wide fact: it lives in the tracked file, with
    // who/when recorded for `agents devices ignored` to render.
    const central = readCentral();
    expect(central).toContain('ignored:');
    expect(central).toContain('ipad165');
    expect(central).toContain('testbox');
    const entries = loadIgnoredEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('ipad165');
    expect(entries[0].ignoredOn).toBe('testbox');
    expect(Number.isNaN(Date.parse(entries[0].ignoredAt))).toBe(false);
  });

  it('is idempotent, stores names sorted, and keeps the original who/when on re-add', async () => {
    await addIgnored('win-mini');
    await addIgnored('ipad165');
    const before = loadIgnoredEntries();
    await addIgnored('win-mini');
    expect([...(await loadIgnored())]).toEqual(['ipad165', 'win-mini']);
    expect(loadIgnoredEntries()).toEqual(before);
  });

  it('removeIgnored is the exact inverse and reports miss vs hit', async () => {
    await addIgnored('mac-mini');
    expect(await removeIgnored('mac-mini')).toBe(true);
    expect(await isIgnored('mac-mini')).toBe(false);
    expect(await removeIgnored('mac-mini')).toBe(false);
  });

  it('throws on a corrupted fleet.ignored instead of silently emptying it — and a write fails too', async () => {
    await fsp.mkdir(path.dirname(centralPath()), { recursive: true });
    await fsp.writeFile(centralPath(), 'fleet:\n  devices: {}\n  ignored: not-a-list\n');
    await expect(loadIgnored()).rejects.toThrow(/corrupted/);
    await expect(addIgnored('win-mini')).rejects.toThrow(/corrupted/);
    // The failed write must NOT have replaced the block (the data-loss path).
    expect(readCentral()).toContain('not-a-list');

    // An entry missing its who/when is corruption too.
    await fsp.writeFile(centralPath(), 'fleet:\n  devices: {}\n  ignored:\n    - name: ipad165\n');
    await expect(loadIgnored()).rejects.toThrow(/corrupted/);
  });

  it('keeps an ignored node subtracted from the discovery pending-diff', async () => {
    // The sync.ts read path: loadIgnored() feeds computePendingDevices.
    await addIgnored('ipad165');
    const pending = computePendingDevices(
      [node('zion'), node('ipad165')],
      [],
      [...(await loadIgnored())],
    );
    expect(pending).toEqual(['zion']);
  });
});
