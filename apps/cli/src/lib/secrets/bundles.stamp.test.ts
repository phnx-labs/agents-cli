/**
 * Regression for the broker-snapshot manifest-resurrection race: the last-used
 * stamp fires on every broker HIT with the BROKER'S copy of the bundle, and
 * used to persist that copy's whole `vars` map back to the authoritative
 * store. A stale snapshot (a detached auto-load captured before a `remove`
 * landing after its eviction) would then resurrect the removed key on the next
 * hit — observed live as a removed key reappearing in `secrets view` minutes
 * after a clean `remove`. Worse, a snapshot of a since-deleted bundle would
 * recreate the whole bundle.
 *
 * The stamp is usage telemetry: it must never write anything BUT the
 * timestamp, and only onto the store's own current copy.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readBundle, writeBundle, deleteBundle, stampLastUsed } from './bundles.js';
import { _resetFileStoreForTest } from './filestore.js';
import { setKeychainBackendForTest, type KeychainBackend } from './index.js';

class MemoryKeychain implements KeychainBackend {
  readable = new Map<string, string>();
  has(item: string): boolean {
    return this.readable.has(item);
  }
  get(item: string): string {
    const v = this.readable.get(item);
    if (v === undefined) throw new Error(`missing ${item}`);
    return v;
  }
  set(item: string, value: string): void {
    this.readable.set(item, value);
  }
  delete(item: string): boolean {
    return this.readable.delete(item);
  }
  list(prefix: string): string[] {
    return [...this.readable.keys()].filter((k) => k.startsWith(prefix));
  }
}

const NAME = 'stamp-race.test';
let prevBackend: ReturnType<typeof setKeychainBackendForTest>;
let prevNoTrack: string | undefined;
let fileDir: string;

beforeEach(() => {
  prevBackend = setKeychainBackendForTest(new MemoryKeychain());
  fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-stamp-'));
  _resetFileStoreForTest({ fileDir });
  prevNoTrack = process.env.AGENTS_NO_USAGE_TRACK;
  delete process.env.AGENTS_NO_USAGE_TRACK;
});

afterEach(() => {
  setKeychainBackendForTest(prevBackend);
  _resetFileStoreForTest();
  if (prevNoTrack === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoTrack;
  try { fs.rmSync(fileDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('stampLastUsed writes only the timestamp, onto the authoritative copy', () => {
  it('a stale broker snapshot cannot resurrect a removed key', () => {
    writeBundle({ name: NAME, policy: 'hold', vars: { A: 'keychain:A' } });
    // The broker's copy predates the remove: it still carries GHOST.
    const staleSnapshot = { ...readBundle(NAME), vars: { A: 'keychain:A', GHOST: 'keychain:GHOST' } };

    stampLastUsed(staleSnapshot);

    const authoritative = readBundle(NAME);
    expect(Object.keys(authoritative.vars)).toEqual(['A']);
    expect(authoritative.last_used).toBeTruthy();
  });

  it('a snapshot of a deleted bundle does not recreate it', () => {
    writeBundle({ name: NAME, policy: 'hold', vars: { A: 'keychain:A' } });
    const staleSnapshot = readBundle(NAME);
    deleteBundle(NAME);

    stampLastUsed(staleSnapshot);

    expect(() => readBundle(NAME)).toThrow();
  });

  it('throttles via the caller-held copy so repeat hits stay cheap', () => {
    writeBundle({ name: NAME, policy: 'hold', vars: { A: 'keychain:A' } });
    const snapshot = readBundle(NAME);
    stampLastUsed(snapshot);
    const stamped = snapshot.last_used;
    expect(stamped).toBeTruthy();
    // Second stamp inside the throttle window: last_used unchanged.
    stampLastUsed(snapshot);
    expect(readBundle(NAME).last_used).toBe(stamped);
  });
});
