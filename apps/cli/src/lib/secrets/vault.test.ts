import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  bundleItemStore,
  readAndResolveBundleEnv,
  readBundle,
  writeBundle,
  writeBundleWithItems,
  type SecretsBundle,
} from './bundles.js';
import {
  setKeychainBackendForTest,
  type KeychainBackend,
} from './index.js';
import {
  _clearVaultDataCacheForTest,
  _getVaultAgeOperationCountForTest,
  _resetVaultAgeOperationCountForTest,
  _setVaultAgeHelperLaunchForTest,
  _setVaultPathForTest,
  cacheVaultKey,
  clearVaultKey,
  createVault,
  decrypt,
  encrypt,
  getVaultSession,
  joinVault,
  vaultGetItem,
  vaultPath,
  vaultSetItem,
  type VaultKey,
} from './vault.js';
import { secretsKeychainItem } from './index.js';
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

function waitForFile(file: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function concurrentVaultWriterScript(args: {
  vaultFile: string;
  passphrase: string;
  readyFile: string;
  goFile: string;
  item: string;
  value: string;
}): string {
  return `
    import * as fs from 'fs';
    import { _setVaultAgeHelperLaunchForTest, _setVaultPathForTest, cacheVaultKey, vaultSetItem } from './src/lib/secrets/vault.ts';
    import { setKeychainBackendForTest } from './src/lib/secrets/index.ts';

    const keychain = new Map();
    setKeychainBackendForTest({
      has: (item) => keychain.has(item),
      get: (item) => {
        const value = keychain.get(item);
        if (value === undefined) throw new Error(\`Keychain item '\${item}' not found.\`);
        return value;
      },
      set: (item, value) => { keychain.set(item, value); },
      delete: (item) => keychain.delete(item),
      list: (prefix) => [...keychain.keys()].filter((item) => item.startsWith(prefix)),
    });
    _setVaultPathForTest(${JSON.stringify(args.vaultFile)});
    _setVaultAgeHelperLaunchForTest({ command: 'bun', args: ['src/index.ts', '__vault-age-helper'] });
    cacheVaultKey({ passphrase: ${JSON.stringify(args.passphrase)} });
    fs.writeFileSync(${JSON.stringify(args.readyFile)}, 'ready');
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(${JSON.stringify(args.goFile)})) Atomics.wait(sleep, 0, 0, 50);
    vaultSetItem(${JSON.stringify(args.item)}, ${JSON.stringify(args.value)});
  `;
}

async function waitForChild(child: ReturnType<typeof spawn>): Promise<void> {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-vault-test-'));
  _setVaultPathForTest(path.join(tmpDir, 'vault.age'));
  _setVaultAgeHelperLaunchForTest({ command: 'bun', args: ['src/index.ts', '__vault-age-helper'] });
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
  _setVaultAgeHelperLaunchForTest(null);
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

  it('does not depend on process.execPath being an eval-capable runtime', () => {
    const originalExecPath = process.execPath;
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: path.join(tmpDir, 'compiled-agents-binary'),
    });
    try {
      const blob = encrypt({ passphrase: 'pw' }, {
        v: 1,
        bundles: { synced: { keys: { API_KEY: 'from-vault' } } },
      });

      expect(decrypt({ passphrase: 'pw' }, blob).bundles.synced.keys.API_KEY).toBe('from-vault');
    } finally {
      Object.defineProperty(process, 'execPath', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: originalExecPath,
      });
    }
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

describe('vault create and join safety', () => {
  it('refuses to replace an existing vault on create without overwrite', () => {
    createVault('first-pw');
    vaultSetItem('agents-cli.secrets.prod.API_KEY', 'super-secret-prod-value');

    expect(() => createVault('second-pw')).toThrow(/Vault file already exists/);
    expect(vaultGetItem('agents-cli.secrets.prod.API_KEY')).toBe('super-secret-prod-value');
  });

  it('refuses to write when the vault file is missing while logged in', () => {
    createVault('pw');
    vaultSetItem('agents-cli.secrets.prod.API_KEY', 'super-secret-prod-value');

    // Simulate a sync conflict / accidental delete: the file is gone but the
    // session is still cached (still "logged in").
    fs.rmSync(vaultPath());
    _clearVaultDataCacheForTest();
    expect(getVaultSession().loggedIn).toBe(true);

    // A write must not silently start from an empty vault and persist it.
    expect(() => vaultSetItem('agents-cli.secrets.other.KEY', 'value'))
      .toThrow(/Vault file is missing/);
    // And a read of the missing vault must not report an empty vault.
    expect(() => vaultGetItem('agents-cli.secrets.prod.API_KEY'))
      .toThrow(/Vault file is missing/);
  });

  it('preserves both writes from concurrent synced vault writers', async () => {
    createVault('pw');
    const goFile = path.join(tmpDir, 'go');
    const firstReady = path.join(tmpDir, 'first.ready');
    const secondReady = path.join(tmpDir, 'second.ready');
    const childEnv = { ...process.env, AGENTS_NO_USAGE_TRACK: '1' };
    const first = spawn(process.execPath, ['--import', 'tsx', '--eval', concurrentVaultWriterScript({
      vaultFile: vaultPath(),
      passphrase: 'pw',
      readyFile: firstReady,
      goFile,
      item: 'agents-cli.secrets.prod.FIRST',
      value: 'first-value',
    })], { cwd: process.cwd(), env: childEnv });
    const second = spawn(process.execPath, ['--import', 'tsx', '--eval', concurrentVaultWriterScript({
      vaultFile: vaultPath(),
      passphrase: 'pw',
      readyFile: secondReady,
      goFile,
      item: 'agents-cli.secrets.prod.SECOND',
      value: 'second-value',
    })], { cwd: process.cwd(), env: childEnv });

    waitForFile(firstReady, 10_000);
    waitForFile(secondReady, 10_000);
    fs.writeFileSync(goFile, 'go');
    await Promise.all([waitForChild(first), waitForChild(second)]);

    _clearVaultDataCacheForTest();
    expect(vaultGetItem('agents-cli.secrets.prod.FIRST')).toBe('first-value');
    expect(vaultGetItem('agents-cli.secrets.prod.SECOND')).toBe('second-value');
    expect((fs.statSync(vaultPath()).mode & 0o777)).toBe(0o600);
  }, 90_000);

  it('refuses to replace an existing vault on join without overwrite', () => {
    const dest = vaultPath();
    const source = path.join(tmpDir, 'source-vault.age');

    createVault('dest-pw');
    vaultSetItem('agents-cli.secrets.prod.API_KEY', 'super-secret-prod-value');

    _setVaultPathForTest(source);
    createVault('source-pw');

    _setVaultPathForTest(dest);
    cacheVaultKey({ passphrase: 'dest-pw' });

    expect(() => joinVault('source-pw', source)).toThrow(/Vault file already exists/);
    expect(vaultGetItem('agents-cli.secrets.prod.API_KEY')).toBe('super-secret-prod-value');
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
    writeBundleWithItems(
      syncedBundle,
      new Map([[secretsKeychainItem('synced', 'API_KEY'), 'from-vault']]),
    );

    expect(readBundle('local').backend).toBeUndefined();
    expect(readBundle('synced').backend).toBe('vault');
    expect(readAndResolveBundleEnv('local', { keyMode: 'storage' }).env).toEqual({ API_KEY: 'from-keychain' });
    expect(readAndResolveBundleEnv('synced', { keyMode: 'storage' }).env).toEqual({ API_KEY: 'from-vault' });
    expect(fs.existsSync(vaultPath())).toBe(true);
  });

  it('writes synced bundle metadata and stored keys with one vault read-modify-write', () => {
    createVault('pw');
    _clearVaultDataCacheForTest();
    _resetVaultAgeOperationCountForTest();

    writeBundleWithItems(
      {
        name: 'synced',
        backend: 'vault',
        vars: { API_KEY: 'keychain:API_KEY' },
      },
      new Map([[secretsKeychainItem('synced', 'API_KEY'), 'from-vault']]),
    );

    expect(_getVaultAgeOperationCountForTest()).toBe(2);
    expect(readBundle('synced').backend).toBe('vault');
    expect(readAndResolveBundleEnv('synced', { keyMode: 'storage' }).env).toEqual({ API_KEY: 'from-vault' });
  });
});
