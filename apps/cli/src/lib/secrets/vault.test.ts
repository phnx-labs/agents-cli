import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bundleItemStore,
  readAndResolveBundleEnv,
  readBundle,
  writeBundle,
  type SecretsBundle,
} from './bundles.js';
import {
  setKeychainBackendForTest,
  type KeychainBackend,
} from './index.js';
import {
  _setVaultPathForTest,
  cacheVaultKey,
  clearVaultKey,
  createVault,
  decrypt,
  encrypt,
  getVaultSession,
  vaultGetItem,
  vaultPath,
  type VaultKey,
} from './vault.js';
import { _resetFileStoreForTest } from './filestore.js';

interface StoredItem { value: string }

function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, StoredItem> } {
  const store = new Map<string, StoredItem>();
  const backend: KeychainBackend = {
    has: (item) => store.has(item),
    get: (item) => {
      const value = store.get(item);
      if (!value) throw new Error(`Keychain item '${item}' not found.`);
      return value.value;
    },
    set: (item, value) => { store.set(item, { value }); },
    delete: (item) => store.delete(item),
    list: (prefix) => [...store.keys()].filter((item) => item.startsWith(prefix)),
  };
  return { backend, store };
}

let tmpDir: string;
let restoreBackend: KeychainBackend | null;
let keychainStore: Map<string, StoredItem>;
let prevNoUsageTrack: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vault-test-'));
  _setVaultPathForTest(path.join(tmpDir, 'vault.age'));
  _resetFileStoreForTest({ fileDir: path.join(tmpDir, 'file-store') });
  const memory = makeMemoryBackend();
  keychainStore = memory.store;
  restoreBackend = setKeychainBackendForTest(memory.backend);
  prevNoUsageTrack = process.env.AGENTS_NO_USAGE_TRACK;
  process.env.AGENTS_NO_USAGE_TRACK = '1';
});

afterEach(() => {
  clearVaultKey();
  setKeychainBackendForTest(restoreBackend);
  _setVaultPathForTest(null);
  _resetFileStoreForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (prevNoUsageTrack === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoUsageTrack;
});

describe('vault encryption', () => {
  it('round-trips encrypt -> decrypt with age passphrase encryption', () => {
    const key: VaultKey = { passphrase: 'correct horse battery staple' };
    const blob = encrypt(key, {
      v: 1,
      bundles: {
        prod: {
          metadata: JSON.stringify({ name: 'prod', vars: { API_KEY: 'keychain:API_KEY' } }),
          keys: { API_KEY: 'secret-value' },
        },
      },
    });

    const opened = decrypt(key, blob);
    expect(opened.bundles.prod.keys.API_KEY).toBe('secret-value');
  });

  it('rejects the wrong password', () => {
    const blob = encrypt({ passphrase: 'right-password' }, { v: 1, bundles: {} });

    expect(() => decrypt({ passphrase: 'wrong-password' }, blob))
      .toThrow(/Wrong password or tampered vault file/);
  });

  it('rejects a tampered blob', () => {
    const blob = encrypt({ passphrase: 'right-password' }, { v: 1, bundles: {} });
    const tampered = blob.replace(/A/, 'B');

    expect(() => decrypt({ passphrase: 'right-password' }, tampered))
      .toThrow(/Wrong password or tampered vault file/);
  });
});

describe('vault login cache', () => {
  it('expires the cached key and forces a new login before vault reads', () => {
    const key = createVault('pw');
    bundleItemStore('vault').set('agents-cli.secrets.prod.API_KEY', 'from-vault');
    cacheVaultKey(key, -1);

    expect(getVaultSession().loggedIn).toBe(false);
    expect(() => vaultGetItem('agents-cli.secrets.prod.API_KEY'))
      .toThrow(/Not logged in/);
  });
});

describe('vault bundle storage', () => {
  it('isolates synced and keychain bundles with the same key name', () => {
    createVault('pw');

    const keychainBundle: SecretsBundle = {
      name: 'local',
      vars: { API_KEY: 'keychain:API_KEY' },
    };
    keychainStore.set('agents-cli.secrets.local.API_KEY', { value: 'from-keychain' });
    writeBundle(keychainBundle);

    const syncedBundle: SecretsBundle = {
      name: 'synced',
      backend: 'vault',
      vars: { API_KEY: 'keychain:API_KEY' },
    };
    bundleItemStore('vault').set('agents-cli.secrets.synced.API_KEY', 'from-vault');
    writeBundle(syncedBundle);

    expect(readBundle('local').backend).toBeUndefined();
    expect(readBundle('synced').backend).toBe('vault');
    expect(readAndResolveBundleEnv('local', { keyMode: 'storage' }).env).toEqual({ API_KEY: 'from-keychain' });
    expect(readAndResolveBundleEnv('synced', { keyMode: 'storage' }).env).toEqual({ API_KEY: 'from-vault' });
    expect(fs.existsSync(vaultPath())).toBe(true);
  });
});
