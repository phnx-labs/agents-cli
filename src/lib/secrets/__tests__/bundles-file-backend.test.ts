/**
 * Tests for file-backed bundles: the opt-in, non-biometry backend used for
 * headless / remote release runs. Items live in the AES-256-GCM encrypted-file
 * store (filestore.ts) keyed by AGENTS_SECRETS_PASSPHRASE — never the keychain.
 *
 * Setup: a real temp-dir file store (real crypto, per project "no mocking" of
 * the path under test) plus an in-memory keychain backend so the keychain
 * branch never touches the user's real Keychain. The assertions prove the
 * routing: file-backed values land in the file store and NOT in the keychain,
 * backend is discovered by location, and listBundles merges both stores.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bundleBackend,
  bundleItemStore,
  keychainRef,
  listBundles,
  readAndResolveBundleEnv,
  readBundle,
  writeBundle,
  type SecretsBundle,
} from '../bundles.js';
import { _resetFileStoreForTest } from '../filestore.js';
import {
  secretsKeychainItem,
  setKeychainBackendForTest,
  type KeychainBackend,
} from '../index.js';

interface StoredItem { value: string }
function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, StoredItem> } {
  const store = new Map<string, StoredItem>();
  const backend: KeychainBackend = {
    has: (item) => store.has(item),
    get: (item) => {
      const v = store.get(item);
      if (!v) throw new Error(`Keychain item '${item}' not found.`);
      return v.value;
    },
    set: (item, value) => { store.set(item, { value }); },
    delete: (item) => store.delete(item),
    list: (prefix) => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
  };
  return { backend, store };
}

const PASS = 'per-run-passphrase';
let restore: KeychainBackend | null = null;
let kcStore: Map<string, StoredItem>;
let tmpDir: string;

beforeEach(() => {
  const m = makeMemoryBackend();
  kcStore = m.store;
  restore = setKeychainBackendForTest(m.backend);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bundles-file-'));
  process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
  _resetFileStoreForTest({ fileDir: tmpDir, passphrase: PASS });
});

afterEach(() => {
  setKeychainBackendForTest(restore);
  delete process.env.AGENTS_SECRETS_PASSPHRASE;
  _resetFileStoreForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: create a file-backed bundle with one keychain-style secret value. */
function createFileBundle(name: string, key: string, value: string): void {
  const bundle: SecretsBundle = { name, backend: 'file', vars: {} };
  bundleItemStore('file').set(secretsKeychainItem(name, key), value);
  bundle.vars[key] = keychainRef(key);
  writeBundle(bundle);
}

describe('file-backed bundle routing', () => {
  it('stores items in the file store, not the keychain, and resolves them headlessly', () => {
    createFileBundle('rel', 'TOKEN', 'sealed-value');

    // Backend discovered by location (metadata .enc present in the file store).
    expect(bundleBackend('rel')).toBe('file');
    expect(readBundle('rel').backend).toBe('file');

    // Resolves from the file store with no keychain involvement.
    const { env } = readAndResolveBundleEnv('rel', { caller: 'test' });
    expect(env.TOKEN).toBe('sealed-value');

    // Nothing about this bundle leaked into the keychain backend.
    const keychainKeys = Array.from(kcStore.keys());
    expect(keychainKeys.some((k) => k.includes('rel'))).toBe(false);

    // Ciphertext is on disk; plaintext is not.
    const enc = fs.readFileSync(path.join(tmpDir, 'agents-cli.secrets.rel.TOKEN.enc'), 'utf8');
    expect(enc).not.toContain('sealed-value');
  });

  it('resolution fails clearly when the passphrase is wrong', () => {
    createFileBundle('rel', 'TOKEN', 'sealed-value');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'wrong';
    _resetFileStoreForTest({ fileDir: tmpDir, passphrase: 'wrong' });
    expect(() => readAndResolveBundleEnv('rel', { caller: 'test' })).toThrow(/decrypt|passphrase/i);
  });

  it('listBundles merges keychain and file bundles with the right backend tag', () => {
    // A keychain bundle (lands in the in-memory keychain backend).
    writeBundle({ name: 'kc-bundle', vars: { A: 'x' } });
    // A file bundle (lands in the temp file store).
    createFileBundle('file-bundle', 'TOKEN', 'v');

    const bundles = listBundles();
    const byName = Object.fromEntries(bundles.map((b) => [b.name, b]));
    expect(byName['kc-bundle']?.backend).toBeUndefined(); // keychain ⇒ absent
    expect(byName['file-bundle']?.backend).toBe('file');
  });
});
