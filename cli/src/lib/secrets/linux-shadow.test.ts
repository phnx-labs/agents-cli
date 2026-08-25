import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock secret-tool so these run deterministically on any platform (no real
// keyring). `which` reports secret-tool present; `secret-tool lookup/search`
// serve an in-memory `keyring` map, or a locked-collection error when `locked`.
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawnSync: spawnSyncMock };
});

import {
  getSecretToolToken,
  hasSecretToolToken,
  setSecretToolToken,
  importNativeSecretToolItems,
  _resetForTest,
} from './linux.js';

const buf = (s?: string) => Buffer.from(s ?? '');
let keyring: Record<string, string>;
let locked: boolean;
let dir: string;

beforeEach(() => {
  keyring = {};
  locked = false;
  spawnSyncMock.mockReset();
  spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'which') return { status: 0, stdout: buf('/usr/bin/secret-tool'), stderr: buf() };
    if (cmd === 'secret-tool') {
      const op = args[0];
      if (op === 'lookup') {
        if (locked) return { status: 1, stdout: buf(), stderr: buf('Cannot read an item in a locked collection') };
        const item = args[args.indexOf('item') + 1];
        return item in keyring
          ? { status: 0, stdout: buf(keyring[item]), stderr: buf() }
          : { status: 1, stdout: buf(), stderr: buf('') };
      }
      if (op === 'search') {
        if (locked) return { status: 1, stdout: buf(), stderr: buf('locked collection') };
        const dump = Object.keys(keyring).map((k) => `attribute.item = ${k}`).join('\n');
        return { status: 0, stdout: buf(), stderr: buf(dump) };
      }
    }
    return { status: 1, stdout: buf(), stderr: buf('unexpected spawn') };
  });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-linux-shadow-'));
  _resetForTest({ fileDir: dir, forceFileFallback: true, passphrase: 'test-pass' });
});

afterEach(() => {
  _resetForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('linux file-fallback read-through (de-shadow)', () => {
  it('reads an item straight from an unlocked keyring when the file store misses', () => {
    keyring['linear-api-key'] = 'lin_api_xyz';
    expect(getSecretToolToken('linear-api-key')).toBe('lin_api_xyz');
    expect(hasSecretToolToken('linear-api-key')).toBe(true);
  });

  it('a plain miss (not in file store, not in keyring) throws', () => {
    expect(() => getSecretToolToken('nope')).toThrow(/not found/i);
    expect(hasSecretToolToken('nope')).toBe(false);
  });

  it('stops probing the keyring once it is observed locked', () => {
    locked = true;
    expect(() => getSecretToolToken('linear-api-key')).toThrow();
    const afterFirst = spawnSyncMock.mock.calls.length;
    // Second read must not spawn secret-tool again — nativeUnreachable short-circuits.
    expect(() => getSecretToolToken('linear-api-key')).toThrow();
    expect(spawnSyncMock.mock.calls.length).toBe(afterFirst);
  });

  it('prefers the file store over the keyring on a hit (no native spawn)', () => {
    setSecretToolToken('local-only', 'from-file'); // lands in the file store
    const before = spawnSyncMock.mock.calls.length;
    expect(getSecretToolToken('local-only')).toBe('from-file');
    expect(spawnSyncMock.mock.calls.length).toBe(before); // never touched secret-tool
  });
});

describe('importNativeSecretToolItems', () => {
  it('copies keyring items missing from the file store, then they read back locally', () => {
    keyring['linear-api-key'] = 'lin_api_xyz';
    keyring['agents-cli.bundles.demo'] = '{"k":"v"}';
    const report = importNativeSecretToolItems('', true);
    expect(report.available).toBe(true);
    expect(report.locked).toBe(false);
    const byItem = Object.fromEntries(report.results.map((r) => [r.item, r.status]));
    expect(byItem['linear-api-key']).toBe('imported');
    expect(byItem['agents-cli.bundles.demo']).toBe('imported');
    // The imported value now resolves from the file store even if the keyring goes away.
    locked = true;
    expect(getSecretToolToken('linear-api-key')).toBe('lin_api_xyz');
  });

  it('marks items already in the file store as "exists" and does not re-copy', () => {
    setSecretToolToken('linear-api-key', 'already-here');
    keyring['linear-api-key'] = 'lin_api_other';
    const report = importNativeSecretToolItems('', true);
    expect(report.results).toEqual([{ item: 'linear-api-key', status: 'exists' }]);
    expect(getSecretToolToken('linear-api-key')).toBe('already-here'); // untouched
  });

  it('dry-run reports "would-import" without writing', () => {
    keyring['linear-api-key'] = 'lin_api_xyz';
    const report = importNativeSecretToolItems('', false);
    expect(report.results).toEqual([{ item: 'linear-api-key', status: 'would-import' }]);
    expect(() => getSecretToolToken('linear-api-key')).not.toThrow(); // read-through still finds it
  });

  it('reports locked (empty results) when the keyring is locked', () => {
    locked = true;
    const report = importNativeSecretToolItems('', true);
    expect(report.locked).toBe(true);
    expect(report.available).toBe(true);
    expect(report.results).toEqual([]);
  });
});
