/**
 * Tests for the file-store bundle-metadata plaintext cache (PHNX-3585).
 *
 * Enumerating file-backed bundles decrypts every bundle's metadata item, and
 * each decrypt runs a fresh scrypt KDF — hundreds of ms on a box with dozens of
 * bundles, paid on every `agents run` account rotation. Metadata is non-secret
 * by contract, so its plaintext is cached keyed by the `.enc` file's
 * (mtime,size) + a passphrase fingerprint. These tests pin the real behaviour on
 * a real on-disk store (no mocks): the cache short-circuits the decrypt across a
 * simulated process restart, NEVER holds a secret value, and self-invalidates on
 * any write or passphrase change.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { fileStore, _resetFileStoreForTest, _flushMetaCacheForTest } from './filestore.js';

const META = 'agents-cli.bundles.demo';
const SECRET_VALUE_ITEM = 'agents-cli.secrets.demo.TOKEN';
const SECRET_VALUE = 'sk-super-secret-token-value-1234567890';

describe('filestore bundle-metadata cache (PHNX-3585)', () => {
  let tmpRoot: string;
  let storeDir: string;
  let keyDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-metacache-'));
    storeDir = path.join(tmpRoot, 'store');
    keyDir = path.join(tmpRoot, 'key');
    cachePath = `${storeDir}.meta-cache.json`; // sibling of the store dir
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
  });

  afterEach(() => {
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    _resetFileStoreForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('serves metadata from the on-disk cache without decrypting, across a process restart', () => {
    const metaJson = JSON.stringify({ name: 'demo', vars: { K: 'keychain:K' } });
    fileStore.set(META, metaJson);
    const encPath = path.join(storeDir, `${META}.enc`);

    // Pin the mtime to a millisecond-aligned value so it can be reproduced
    // exactly (a native write carries sub-ms precision that utimes can't
    // restore). The cache records THIS mtime + the file size at get time.
    const fixed = new Date(1_700_000_000_000);
    fs.utimesSync(encPath, fixed, fixed);
    const size = fs.statSync(encPath).size;
    expect(fileStore.get(META)).toBe(metaJson); // decrypt + populate the in-memory cache

    _flushMetaCacheForTest(); // write the on-disk cache
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir }); // simulate the next process (clears in-memory cache, same dir/key)

    // Replace the file with garbage of the SAME byte length and restore the
    // exact recorded mtime — decryption would now throw at JSON.parse, but the
    // cache key still matches. A correct return can only come from the cache,
    // proving the scrypt decrypt was skipped.
    fs.writeFileSync(encPath, 'x'.repeat(size));
    fs.utimesSync(encPath, fixed, fixed);
    expect(fs.statSync(encPath).size).toBe(size);

    expect(fileStore.get(META)).toBe(metaJson); // cache hit — never decrypts the corrupted file
  });

  it('re-derives (does not serve a stale hit) when the metadata file changes', () => {
    const encPath = path.join(storeDir, `${META}.enc`);
    fileStore.set(META, JSON.stringify({ name: 'demo', v: 1 }));
    expect(JSON.parse(fileStore.get(META)).v).toBe(1);
    _flushMetaCacheForTest();
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });

    // A genuine rewrite through the store (new content, new mtime/size). The
    // stale cache entry must NOT be served.
    fileStore.set(META, JSON.stringify({ name: 'demo', v: 2, extra: 'padding' }));
    expect(fs.existsSync(encPath)).toBe(true);
    expect(JSON.parse(fileStore.get(META)).v).toBe(2);
  });

  it('never writes a secret VALUE item into the cache, only bundle metadata', () => {
    fileStore.set(SECRET_VALUE_ITEM, SECRET_VALUE);
    fileStore.set(META, JSON.stringify({ name: 'demo' }));
    // Read both through the store.
    expect(fileStore.get(SECRET_VALUE_ITEM)).toBe(SECRET_VALUE);
    expect(fileStore.get(META)).toContain('demo');
    _flushMetaCacheForTest();

    const cacheRaw = fs.readFileSync(cachePath, 'utf8');
    // The secret value and its item name must be absent; the metadata item present.
    expect(cacheRaw).not.toContain(SECRET_VALUE);
    expect(cacheRaw).not.toContain(SECRET_VALUE_ITEM);
    expect(cacheRaw).toContain(META);
    // Every cached key is in the metadata namespace.
    const doc = JSON.parse(cacheRaw) as { entries: Record<string, unknown> };
    expect(Object.keys(doc.entries).every((k) => k.startsWith('agents-cli.bundles.'))).toBe(true);
  });

  it('discards the cache when the passphrase changes (fingerprint mismatch)', () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'passphrase-A';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set(META, JSON.stringify({ name: 'demo', under: 'A' }));
    fileStore.get(META);
    _flushMetaCacheForTest();
    const keyFpA = (JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { keyFp: string }).keyFp;

    // A different passphrase re-keys the store; the cache fingerprint must change
    // so the A-era plaintext is never reused under key B.
    process.env.AGENTS_SECRETS_PASSPHRASE = 'passphrase-B';
    _resetFileStoreForTest({ fileDir: storeDir, passphraseDir: keyDir });
    fileStore.set(META, JSON.stringify({ name: 'demo', under: 'B' }));
    expect(JSON.parse(fileStore.get(META)).under).toBe('B');
    _flushMetaCacheForTest();
    const keyFpB = (JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { keyFp: string }).keyFp;

    expect(keyFpB).not.toBe(keyFpA);
  });
});
