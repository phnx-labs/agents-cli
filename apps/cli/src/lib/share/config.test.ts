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
let previousHome: string | undefined;
let previousEnvToken: string | undefined;

async function freshShareConfig() {
  vi.resetModules();
  const mem = makeMemoryBackend();
  const secrets = await import('../secrets/index.js');
  secrets.setKeychainBackendForTest(mem.backend);
  const filestore = await import('../secrets/filestore.js');
  filestore._resetFileStoreForTest({ fileDir: path.join(tmpHome, '.file-secrets') });
  const config = await import('./config.js');
  return { config, mem };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-share-config-'));
  previousHome = process.env.HOME;
  previousEnvToken = process.env.SHARE_WRITE_TOKEN;
  process.env.HOME = tmpHome;
  delete process.env.SHARE_WRITE_TOKEN;
});

afterEach(() => {
  vi.resetModules();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousEnvToken === undefined) delete process.env.SHARE_WRITE_TOKEN;
  else process.env.SHARE_WRITE_TOKEN = previousEnvToken;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('share config and token store', () => {
  it('mints a 32-byte hex write token', async () => {
    const { config } = await freshShareConfig();
    expect(config.generateWriteToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores endpoint config under redirected HOME', async () => {
    const { config } = await freshShareConfig();

    config.writeShareConfig({
      baseUrl: 'https://share.example.com/',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });

    expect(config.readShareConfig()).toEqual({
      baseUrl: 'https://share.example.com',
      accountId: 'acct_1',
      workerName: 'agents-share',
      bucketName: 'agents-share',
      domain: 'share.example.com',
    });
    expect(fs.existsSync(path.join(tmpHome, '.agents', 'agents.yaml'))).toBe(true);
  });

  it('stores the write token in the share secrets bundle and reads it back', async () => {
    const { config, mem } = await freshShareConfig();
    const token = config.generateWriteToken();

    config.storeWriteToken(token);

    expect(config.readWriteToken()).toBe(token);
    expect(mem.store.get('agents-cli.secrets.share.SHARE_WRITE_TOKEN')?.value).toBe(token);
    expect(fs.readFileSync(path.join(tmpHome, '.agents', 'agents.yaml'), 'utf8')).not.toContain(token);
  });
});

describe('share write-token resolution', () => {
  it('prefers an injected SHARE_WRITE_TOKEN over the local bundle', async () => {
    const { config } = await freshShareConfig();
    config.storeWriteToken('bundle-token');
    process.env.SHARE_WRITE_TOKEN = 'env-token';

    expect(config.readWriteToken()).toBe('env-token');
  });

  it('builds runtime env only when synced share config exists', async () => {
    const { config } = await freshShareConfig();
    config.storeWriteToken('bundle-token');

    expect(config.shareRuntimeEnv()).toBeUndefined();

    config.writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: 'acct',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });

    expect(config.shareRuntimeEnv()).toEqual({ SHARE_WRITE_TOKEN: 'bundle-token' });
  });

  it('uses the injected token for runtime env without touching the bundle', async () => {
    const { config } = await freshShareConfig();
    config.writeShareConfig({
      baseUrl: 'https://share.example.com',
      accountId: 'acct',
      workerName: 'agents-share',
      bucketName: 'agents-share',
    });
    process.env.SHARE_WRITE_TOKEN = 'env-token';

    expect(config.shareRuntimeEnv({ agentOnly: true })).toEqual({ SHARE_WRITE_TOKEN: 'env-token' });
  });
});
