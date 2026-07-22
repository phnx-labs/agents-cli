import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KeychainBackend } from '../secrets/index.js';

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

let tmpHome = '';
let previousEnvToken: string | undefined;

async function freshShareConfig() {
  vi.resetModules();
  const mem = makeMemoryBackend();
  const secrets = await import('../secrets/index.js');
  secrets.setKeychainBackendForTest(mem.backend);
  const filestore = await import('../secrets/filestore.js');
  filestore._resetFileStoreForTest({ fileDir: path.join(tmpHome, '.file-secrets') });
  return import('./config.js');
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-config-'));
  process.env.HOME = tmpHome;
  previousEnvToken = process.env.SHARE_WRITE_TOKEN;
  delete process.env.SHARE_WRITE_TOKEN;
});

afterEach(() => {
  vi.resetModules();
  if (previousEnvToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
  else process.env.SHARE_WRITE_TOKEN = previousEnvToken;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('share write-token resolution', () => {
  it('prefers an injected SHARE_WRITE_TOKEN over the local bundle', async () => {
    const { readWriteToken, storeWriteToken } = await freshShareConfig();
    storeWriteToken('bundle-token');
    process.env.SHARE_WRITE_TOKEN = 'env-token';

    expect(readWriteToken()).toBe('env-token');
  });

  it('builds runtime env only when synced share config exists', async () => {
    const { shareRuntimeEnv, storeWriteToken, writeShareConfig } = await freshShareConfig();
    storeWriteToken('bundle-token');

    expect(shareRuntimeEnv()).toBeUndefined();

    writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: 'acct',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });

    expect(shareRuntimeEnv()).toEqual({ SHARE_WRITE_TOKEN: 'bundle-token' });
  });

  it('uses the injected token for runtime env without touching the bundle', async () => {
    const { shareRuntimeEnv, writeShareConfig } = await freshShareConfig();
    writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: 'acct',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    process.env.SHARE_WRITE_TOKEN = 'env-token';

    expect(shareRuntimeEnv({ agentOnly: true })).toEqual({ SHARE_WRITE_TOKEN: 'env-token' });
  });
});
