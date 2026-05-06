/**
 * Tests for keychain-backed bundle storage.
 *
 * Mocking note: per project rules tests should not mock real services, but
 * touching the user's real macOS Keychain in unit tests is destructive (it
 * would mutate or surface confirmation prompts on real items). The storage
 * code is exercised through a small in-memory backend installed via
 * `setKeychainBackendForTest`; the contract under test is the bundle layer
 * (JSON shape, validation, list/read/write/delete behavior), not Keychain
 * itself. End-to-end Keychain wiring is verified via the e2e smoke run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  bundleExists,
  deleteBundle,
  listBundles,
  migrateLegacyBundles,
  readBundle,
  writeBundle,
  type SecretsBundle,
} from '../bundles.js';
import {
  setKeychainBackendForTest,
  type KeychainBackend,
} from '../index.js';

interface StoredItem { value: string; sync: boolean }

function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, StoredItem> } {
  const store = new Map<string, StoredItem>();
  const backend: KeychainBackend = {
    has: (item) => store.has(item),
    get: (item) => {
      const v = store.get(item);
      if (!v) throw new Error(`Keychain item '${item}' not found.`);
      return v.value;
    },
    set: (item, value, sync) => { store.set(item, { value, sync }); },
    delete: (item) => store.delete(item),
    list: (prefix) => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
  };
  return { backend, store };
}

let restore: KeychainBackend | null = null;
let store: Map<string, StoredItem>;

beforeEach(() => {
  const m = makeMemoryBackend();
  store = m.store;
  restore = setKeychainBackendForTest(m.backend);
});

afterEach(() => {
  setKeychainBackendForTest(restore);
});

describe('writeBundle + readBundle round-trip', () => {
  it('preserves description, allow_exec, icloud_sync, and all var kinds', () => {
    const bundle: SecretsBundle = {
      name: 'roundtrip',
      description: 'a test bundle',
      allow_exec: true,
      icloud_sync: true,
      vars: {
        LITERAL_STR: 'hello',
        LITERAL_OBJ: { value: 'env:NOT_A_REF' },
        FROM_KEYCHAIN: 'keychain:API_KEY',
        FROM_ENV: 'env:HOME',
        FROM_FILE: 'file:/tmp/x',
        FROM_EXEC: 'exec:echo hi',
      },
    };
    writeBundle(bundle);
    const got = readBundle('roundtrip');
    expect(got).toEqual(bundle);
  });

  it('omits absent optional fields after read (boolean defaults to false)', () => {
    writeBundle({ name: 'minimal', vars: { A: 'x' } });
    const got = readBundle('minimal');
    expect(got.allow_exec).toBe(false);
    expect(got.icloud_sync).toBe(false);
    expect(got.description).toBeUndefined();
    expect(got.vars).toEqual({ A: 'x' });
  });

  it('routes icloud_sync through the sync flag of the backend', () => {
    writeBundle({ name: 'syncy', icloud_sync: true, vars: {} });
    expect(store.get('agents-cli.bundles.syncy')?.sync).toBe(true);
    writeBundle({ name: 'local', vars: {} });
    expect(store.get('agents-cli.bundles.local')?.sync).toBe(false);
  });
});

describe('bundleExists', () => {
  it('returns true after write and false after delete', () => {
    expect(bundleExists('exists-test')).toBe(false);
    writeBundle({ name: 'exists-test', vars: {} });
    expect(bundleExists('exists-test')).toBe(true);
    deleteBundle('exists-test');
    expect(bundleExists('exists-test')).toBe(false);
  });
});

describe('listBundles', () => {
  it('returns bundles sorted by name and only the bundle prefix', () => {
    writeBundle({ name: 'beta', vars: {} });
    writeBundle({ name: 'alpha', vars: {} });
    // Add a non-bundle keychain item under a different prefix
    store.set('agents-cli.secrets.alpha.X', { value: 'should-be-ignored', sync: false });
    const bundles = listBundles();
    expect(bundles.map((b) => b.name)).toEqual(['alpha', 'beta']);
  });

  it('skips malformed JSON entries silently', () => {
    writeBundle({ name: 'good', vars: {} });
    store.set('agents-cli.bundles.broken', { value: '{not json', sync: false });
    const bundles = listBundles();
    expect(bundles.map((b) => b.name)).toEqual(['good']);
  });
});

describe('readBundle errors', () => {
  it('throws not-found when the meta item is missing', () => {
    expect(() => readBundle('missing')).toThrow(/not found/);
  });

  it('throws malformed when the JSON is invalid', () => {
    store.set('agents-cli.bundles.broken', { value: '{not json', sync: false });
    expect(() => readBundle('broken')).toThrow(/malformed/);
  });
});

describe('deleteBundle', () => {
  it('removes the meta and is idempotent', () => {
    writeBundle({ name: 'doomed', vars: {} });
    expect(deleteBundle('doomed')).toBe(true);
    expect(deleteBundle('doomed')).toBe(false);
    expect(bundleExists('doomed')).toBe(false);
  });
});

describe('migrateLegacyBundles', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-mig-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // The state module captured HOME at import; getUserSecretsDir() returns the
  // captured path. We can't re-import per test cheaply, so create the legacy
  // dir at the captured path. Read it back and assert against state.
  it('moves YAML bundle into keychain and unlinks the file', async () => {
    const stateMod = await import('../../state.js');
    const dir = stateMod.getUserSecretsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'legacy-bundle.yml');
    fs.writeFileSync(file, yaml.stringify({
      name: 'legacy-bundle',
      description: 'from yaml',
      icloud_sync: true,
      vars: { A: 'literal', B: 'keychain:K_B' },
    }), 'utf-8');

    migrateLegacyBundles();

    expect(fs.existsSync(file)).toBe(false);
    const got = readBundle('legacy-bundle');
    expect(got.description).toBe('from yaml');
    expect(got.icloud_sync).toBe(true);
    expect(got.vars).toEqual({ A: 'literal', B: 'keychain:K_B' });
    // Should have written with the bundle's icloud_sync flag.
    expect(store.get('agents-cli.bundles.legacy-bundle')?.sync).toBe(true);
  });

  it('is a no-op when the secrets dir does not exist', () => {
    expect(() => migrateLegacyBundles()).not.toThrow();
  });
});
