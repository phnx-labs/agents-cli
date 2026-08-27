/**
 * Reserved `auth` bundle (PHNX-2365 / SEC-GAP-3): the secrets layer refuses a
 * non-file backend instead of letting create succeed and usage/probe silently
 * ignore the tokens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AUTH_BUNDLE_NAME,
  AUTH_BUNDLE_BACKEND,
  ReservedBundleWrongBackendError,
  assertFileBundleDecryptable,
  assertReservedBundleBackend,
  bundleBackend,
  inspectReservedAuthBundle,
  isReservedBundleName,
  writeBundle,
  writeBundleWithItems,
  type SecretsBundle,
} from './bundles.js';
import { _resetFileStoreForTest } from './filestore.js';
import {
  secretsKeychainItem,
  setKeychainBackendForTest,
  setKeychainServiceHashingForTest,
  type KeychainBackend,
} from './index.js';

class MemoryKeychain implements KeychainBackend {
  store = new Map<string, string>();
  has(item: string) { return this.store.has(item); }
  get(item: string): string {
    const v = this.store.get(item);
    if (v === undefined) throw new Error(`missing ${item}`);
    return v;
  }
  set(item: string, value: string) { this.store.set(item, value); }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
}

let prevBackend: KeychainBackend | null;
let fileDir: string;
let prevPassphrase: string | undefined;
let prevNoAgent: string | undefined;

beforeEach(() => {
  prevBackend = setKeychainBackendForTest(new MemoryKeychain());
  setKeychainServiceHashingForTest(null);
  fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-reserved-auth-'));
  prevPassphrase = process.env.AGENTS_SECRETS_PASSPHRASE;
  prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  process.env.AGENTS_SECRETS_NO_AGENT = '1';
  delete process.env.AGENTS_SECRETS_PASSPHRASE;
  _resetFileStoreForTest({ fileDir });
});

afterEach(() => {
  setKeychainBackendForTest(prevBackend);
  _resetFileStoreForTest({});
  if (prevPassphrase === undefined) delete process.env.AGENTS_SECRETS_PASSPHRASE;
  else process.env.AGENTS_SECRETS_PASSPHRASE = prevPassphrase;
  if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
  fs.rmSync(fileDir, { recursive: true, force: true });
});

describe('reserved auth bundle name', () => {
  it('recognizes auth case-insensitively and no other name', () => {
    expect(isReservedBundleName('auth')).toBe(true);
    expect(isReservedBundleName('AUTH')).toBe(true);
    expect(isReservedBundleName('Auth')).toBe(true);
    expect(isReservedBundleName('prod')).toBe(false);
    expect(isReservedBundleName('apple.com')).toBe(false);
  });

  it('requires the file backend and names the recreate command', () => {
    expect(() => assertReservedBundleBackend('auth', 'keychain')).toThrow(ReservedBundleWrongBackendError);
    expect(() => assertReservedBundleBackend('auth', 'vault')).toThrow(/agents secrets create auth --backend file/);
    expect(() => assertReservedBundleBackend('auth', 'file')).not.toThrow();
    expect(() => assertReservedBundleBackend('prod', 'keychain')).not.toThrow();
    expect(AUTH_BUNDLE_BACKEND).toBe('file');
    expect(AUTH_BUNDLE_NAME).toBe('auth');
  });
});

describe('writeBundle refuses a non-file auth bundle (SEC-GAP-3)', () => {
  it('throws on a keychain-backed auth create instead of persisting it', () => {
    expect(() => writeBundle({ name: 'auth', vars: {} })).toThrow(ReservedBundleWrongBackendError);
    expect(inspectReservedAuthBundle()).toEqual({ exists: false, backend: null, ok: true });
  });

  it('throws on an explicit keychain backend and on vault', () => {
    expect(() => writeBundle({ name: 'auth', backend: 'keychain', vars: {} }))
      .toThrow(/keychain-backed/);
    expect(() => writeBundle({ name: 'auth', backend: 'vault', vars: {} }))
      .toThrow(/vault-backed/);
  });

  it('writes a file-backed auth bundle and inspects it as ok', () => {
    const bundle: SecretsBundle = { name: 'auth', backend: 'file', vars: {} };
    writeBundle(bundle);
    expect(bundleBackend('auth')).toBe('file');
    expect(inspectReservedAuthBundle()).toEqual({ exists: true, backend: 'file', ok: true });
  });

  it('ordinary bundles are unchanged', () => {
    writeBundle({ name: 'prod', vars: {} });
    expect(bundleBackend('prod')).toBe('keychain');
  });
});

describe('inspectReservedAuthBundle flags an existing keychain-backed auth', () => {
  it('reports not-ok when metadata was planted in the keychain', () => {
    // Simulate the pre-fix accident: a user created `auth` on the default
    // keychain backend before the name was reserved. writeBundle now refuses
    // that, so the test plants the metadata item the way the old path did.
    const mem = new MemoryKeychain();
    setKeychainBackendForTest(mem);
    mem.set('agents-cli.bundles.auth', JSON.stringify({ name: 'auth', vars: {} }));
    expect(inspectReservedAuthBundle()).toEqual({ exists: true, backend: 'keychain', ok: false });
  });
});

describe('assertFileBundleDecryptable', () => {
  it('passes when the file-backed keys decrypt', () => {
    const item = secretsKeychainItem('rel', 'TOKEN');
    writeBundleWithItems(
      { name: 'rel', backend: 'file', vars: { TOKEN: 'keychain:TOKEN' } },
      new Map([[item, 'readable-value']]),
    );
    expect(() => assertFileBundleDecryptable('rel', ['TOKEN'])).not.toThrow();
  });

  it('fails loud when the ciphertext will not decrypt', () => {
    const item = secretsKeychainItem('rel', 'TOKEN');
    process.env.AGENTS_SECRETS_PASSPHRASE = 'write-key-write-key';
    _resetFileStoreForTest({ fileDir, passphrase: 'write-key-write-key' });
    writeBundleWithItems(
      { name: 'rel', backend: 'file', vars: { TOKEN: 'keychain:TOKEN' } },
      new Map([[item, 'sealed']]),
    );
    process.env.AGENTS_SECRETS_PASSPHRASE = 'wrong-key-wrong-key';
    _resetFileStoreForTest({ fileDir, passphrase: 'wrong-key-wrong-key' });
    expect(() => assertFileBundleDecryptable('rel', ['TOKEN'])).toThrow(/could not decrypt|unreadable/);
  });
});
