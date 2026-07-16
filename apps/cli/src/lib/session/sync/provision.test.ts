/**
 * Tests for session-sync provisioning (writeSyncBundle). Mirrors the isolation
 * of bundles-storage.test.ts: an in-memory keychain via setKeychainBackendForTest
 * plus a temp homedir + file store, so nothing touches the real ~/.agents.
 * The pure bundle-writing contract is under test, not Keychain itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface OsMockState { homedir: string }
const osMockState: OsMockState = ((globalThis as Record<string, unknown>)
  .__agents_cli_os_mock__ as OsMockState | undefined)
  ?? (((globalThis as Record<string, unknown>).__agents_cli_os_mock__ = { homedir: '' }) as OsMockState);

vi.mock('os', () => {
  const actual = require('node:os') as typeof import('os');
  return {
    ...actual,
    default: actual,
    homedir: () => {
      const state = (globalThis as Record<string, unknown>)
        .__agents_cli_os_mock__ as OsMockState | undefined;
      return state?.homedir || actual.homedir();
    },
  };
});

import { writeSyncBundle } from './provision.js';
import { SYNC_BUNDLE } from './config.js';
import { resolveSyncEncKey } from './transcript-crypto.js';
import { readBundle, bundleExists } from '../../secrets/bundles.js';
import { setKeychainBackendForTest, secretsKeychainItem, type KeychainBackend } from '../../secrets/index.js';
import { _resetFileStoreForTest } from '../../secrets/filestore.js';

function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, { value: string }> } {
  const store = new Map<string, { value: string }>();
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

let restore: KeychainBackend | null = null;
let store: Map<string, { value: string }>;
let tmpHome: string;
let fileTmpDir: string;

const val = (key: string): string | undefined => store.get(secretsKeychainItem(SYNC_BUNDLE, key))?.value;

const CREDS = { accountId: 'acc123', bucketName: 'my-bucket', accessKeyId: 'AK', secretAccessKey: 'SK' };

beforeEach(() => {
  const m = makeMemoryBackend();
  store = m.store;
  restore = setKeychainBackendForTest(m.backend);
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-provision-home-'));
  osMockState.homedir = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.agents', 'secrets'), { recursive: true });
  fileTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-provision-file-'));
  _resetFileStoreForTest({ fileDir: fileTmpDir });
});

afterEach(() => {
  setKeychainBackendForTest(restore);
  _resetFileStoreForTest();
  osMockState.homedir = '';
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(fileTmpDir, { recursive: true, force: true });
});

describe('writeSyncBundle', () => {
  it('creates the bundle with all four R2 creds and a freshly minted enc key', () => {
    const { encKeyAction } = writeSyncBundle({ ...CREDS });
    expect(encKeyAction).toBe('generated');

    expect(bundleExists(SYNC_BUNDLE)).toBe(true);
    const bundle = readBundle(SYNC_BUNDLE);
    for (const k of ['R2_ACCOUNT_ID', 'R2_BUCKET_NAME', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_SYNC_ENC_KEY']) {
      expect(bundle.vars[k]).toBe(`keychain:${k}`);
    }
    expect(val('R2_ACCOUNT_ID')).toBe('acc123');
    expect(val('R2_SECRET_ACCESS_KEY')).toBe('SK');
    // The minted key must be a valid 32-byte key.
    expect(resolveSyncEncKey({ syncEncKey: val('R2_SYNC_ENC_KEY') })!.length).toBe(32);
  });

  it('does NOT write R2_ENDPOINT unless an override is supplied', () => {
    writeSyncBundle({ ...CREDS });
    expect(readBundle(SYNC_BUNDLE).vars['R2_ENDPOINT']).toBeUndefined();

    writeSyncBundle({ ...CREDS, endpoint: 'http://localhost:9000' });
    expect(readBundle(SYNC_BUNDLE).vars['R2_ENDPOINT']).toBe('keychain:R2_ENDPOINT');
    expect(val('R2_ENDPOINT')).toBe('http://localhost:9000');
  });

  it('REUSES an existing enc key on re-run (never orphans peers by overwriting)', () => {
    writeSyncBundle({ ...CREDS });
    const original = val('R2_SYNC_ENC_KEY');

    const { encKeyAction } = writeSyncBundle({ ...CREDS, accessKeyId: 'AK2' });
    expect(encKeyAction).toBe('reused');
    expect(val('R2_SYNC_ENC_KEY')).toBe(original); // unchanged
    expect(val('R2_ACCESS_KEY_ID')).toBe('AK2'); // creds still rotate
  });

  it('stores a joining machine\'s pasted key (provided, not generated)', () => {
    const shared = resolveSyncEncKey({ syncEncKey: undefined }); // null
    expect(shared).toBeNull();
    const key = Buffer.alloc(32, 7).toString('base64');
    const { encKeyAction } = writeSyncBundle({ ...CREDS, encKey: key });
    expect(encKeyAction).toBe('provided');
    expect(val('R2_SYNC_ENC_KEY')).toBe(key);
  });

  it('rejects a malformed pasted key before writing anything', () => {
    expect(() => writeSyncBundle({ ...CREDS, encKey: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/);
    expect(bundleExists(SYNC_BUNDLE)).toBe(false); // nothing written
  });
});
