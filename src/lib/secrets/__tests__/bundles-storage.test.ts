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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

// vitest 4 hoists vi.mock above any const declared in this file, so a
// top-level `const osMockState` would be in the TDZ when the factory runs.
// Stash the mutable override on globalThis instead — that binding always
// exists. vi.importActual / importOriginal are also vitest-only; pull the
// real `os` via `node:os` so the factory works under Bun's native runner.
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

import {
  bundleExists,
  deleteBundle,
  listBundles,
  migrateLegacyBundles,
  readBundle,
  renameBundle,
  resolveBundleEnv,
  rotateBundleSecret,
  writeBundle,
  type SecretsBundle,
} from '../bundles.js';
import {
  setKeychainBackendForTest,
  type KeychainBackend,
} from '../index.js';
import { _resetFileStoreForTest } from '../filestore.js';

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

let restore: KeychainBackend | null = null;
let store: Map<string, StoredItem>;
let fileTmpDir: string;

beforeEach(() => {
  const m = makeMemoryBackend();
  store = m.store;
  restore = setKeychainBackendForTest(m.backend);
  // Isolate the encrypted-file store to an empty temp dir. Without this,
  // listBundles() enumerates the developer's REAL ~/.agents/.cache/secrets on
  // any machine that has file-backed bundles (e.g. a headless Linux box under
  // the secret-service fallback), leaking those into the counts asserted here.
  fileTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-bundles-storage-'));
  _resetFileStoreForTest({ fileDir: fileTmpDir });
});

afterEach(() => {
  setKeychainBackendForTest(restore);
  _resetFileStoreForTest();
  fs.rmSync(fileTmpDir, { recursive: true, force: true });
});

describe('writeBundle + readBundle round-trip', () => {
  it('preserves description, allow_exec, and all var kinds', () => {
    const bundle: SecretsBundle = {
      name: 'roundtrip',
      description: 'a test bundle',
      allow_exec: true,
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
    expect(got.description).toBeUndefined();
    expect(got.vars).toEqual({ A: 'x' });
  });
});

describe('timestamps', () => {
  it('writeBundle stamps created_at and updated_at on first write', () => {
    const before = Date.now();
    writeBundle({ name: 'ts-first', vars: {} });
    const after = Date.now();
    const got = readBundle('ts-first');
    expect(got.created_at).toBeDefined();
    expect(got.updated_at).toBeDefined();
    const created = Date.parse(got.created_at!);
    const updated = Date.parse(got.updated_at!);
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
    expect(updated).toBe(created);
  });

  it('created_at is sticky across rewrites; updated_at advances', async () => {
    writeBundle({ name: 'ts-sticky', vars: {} });
    const first = readBundle('ts-sticky');
    await new Promise((r) => setTimeout(r, 5));
    writeBundle({ ...first, description: 'edited' });
    const second = readBundle('ts-sticky');
    expect(second.created_at).toBe(first.created_at);
    expect(Date.parse(second.updated_at!)).toBeGreaterThan(Date.parse(first.updated_at!));
  });

  it('resolveBundleEnv stamps last_used', () => {
    writeBundle({ name: 'used-1', vars: { A: 'x' } });
    const bundle = readBundle('used-1');
    expect(bundle.last_used).toBeUndefined();
    resolveBundleEnv(bundle);
    const after = readBundle('used-1');
    expect(after.last_used).toBeDefined();
    expect(Date.now() - Date.parse(after.last_used!)).toBeLessThan(1000);
  });

  it('last_used stamp is throttled within the window', () => {
    writeBundle({ name: 'used-throttle', vars: { A: 'x' } });
    const bundle = readBundle('used-throttle');
    resolveBundleEnv(bundle);
    const first = readBundle('used-throttle').last_used!;
    // Second call inside the throttle window must not bump the stamp.
    resolveBundleEnv(readBundle('used-throttle'));
    const second = readBundle('used-throttle').last_used!;
    expect(second).toBe(first);
  });

  it('AGENTS_NO_USAGE_TRACK disables the stamp', () => {
    writeBundle({ name: 'used-disabled', vars: { A: 'x' } });
    const prev = process.env.AGENTS_NO_USAGE_TRACK;
    process.env.AGENTS_NO_USAGE_TRACK = '1';
    try {
      const bundle = readBundle('used-disabled');
      resolveBundleEnv(bundle);
      const after = readBundle('used-disabled');
      expect(after.last_used).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
      else process.env.AGENTS_NO_USAGE_TRACK = prev;
    }
  });

  it('stamp failure does not break resolution', () => {
    writeBundle({ name: 'used-flaky', vars: { LIT: 'value' } });
    const bundle = readBundle('used-flaky');
    // Force writeBundle to fail by swapping the backend mid-test.
    const broken: KeychainBackend = {
      has: () => false,
      get: () => { throw new Error('boom'); },
      set: () => { throw new Error('boom'); },
      delete: () => false,
      list: () => [],
    };
    const prevRestore = setKeychainBackendForTest(broken);
    try {
      const env = resolveBundleEnv(bundle);
      expect(env).toEqual({ LIT: 'value' });
    } finally {
      setKeychainBackendForTest(prevRestore);
    }
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

  it('preserves description, allow_exec, and timestamps for every bundle', () => {
    // Regression for the Touch-ID-per-bundle bug: listBundles must produce
    // fully-populated SecretsBundle objects from the batched read, not just
    // names. We previously delegated to readBundle in a loop; the batch path
    // duplicates the parse logic so this guards against drift.
    writeBundle({
      name: 'alpha',
      description: 'first',
      allow_exec: true,
      vars: { API: 'keychain:API' },
      meta: { API: { type: 'api-key', note: 'pinned' } },
    });
    writeBundle({
      name: 'beta',
      description: 'second',
      vars: { TOKEN: 'literal-value' },
    });
    const bundles = listBundles();
    expect(bundles).toHaveLength(2);
    const a = bundles.find((b) => b.name === 'alpha')!;
    expect(a.description).toBe('first');
    expect(a.allow_exec).toBe(true);
    expect(a.vars).toEqual({ API: 'keychain:API' });
    expect(a.meta).toEqual({ API: { type: 'api-key', note: 'pinned' } });
    expect(typeof a.created_at).toBe('string');
    expect(typeof a.updated_at).toBe('string');
    const b = bundles.find((b) => b.name === 'beta')!;
    expect(b.description).toBe('second');
    expect(b.allow_exec).toBe(false);
  });

  it('scales to many bundles without dropping any (no prompt-per-bundle regression)', () => {
    // The realistic scenario from a real user: 20+ bundles all sync to iCloud
    // Keychain. Before the fix, this produced 20+ Touch ID prompts because
    // readBundle was called in a loop, each spawning a fresh LAContext. The
    // batch read must return all of them in one shot.
    for (let i = 0; i < 25; i++) {
      writeBundle({ name: `bundle-${String(i).padStart(2, '0')}`, vars: {} });
    }
    const bundles = listBundles();
    expect(bundles).toHaveLength(25);
    expect(bundles[0].name).toBe('bundle-00');
    expect(bundles[24].name).toBe('bundle-24');
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

describe('rotateBundleSecret', () => {
  it('replaces the keychain value when bundle and key both exist', () => {
    writeBundle({
      name: 'rot',
      vars: { API: 'keychain:API' },
    });
    // Seed the underlying keychain item directly via the backend store.
    store.set('agents-cli.secrets.rot.API', { value: 'old' });

    const bundle = readBundle('rot');
    rotateBundleSecret(bundle, 'API', { newValue: 'new' });

    expect(store.get('agents-cli.secrets.rot.API')?.value).toBe('new');
  });

  it('preserves existing meta when no meta patch is passed', () => {
    writeBundle({
      name: 'rot-meta',
      vars: { API: 'keychain:API' },
      meta: { API: { type: 'api-key', note: 'original note', expires: '2099-12-31' } },
    });
    store.set('agents-cli.secrets.rot-meta.API', { value: 'old' });

    const bundle = readBundle('rot-meta');
    rotateBundleSecret(bundle, 'API', { newValue: 'new' });

    const after = readBundle('rot-meta');
    expect(after.meta?.API).toEqual({
      type: 'api-key',
      note: 'original note',
      expires: '2099-12-31',
    });
  });

  it('merges a meta patch over existing meta', () => {
    writeBundle({
      name: 'rot-patch',
      vars: { API: 'keychain:API' },
      meta: { API: { type: 'api-key', note: 'old note' } },
    });
    store.set('agents-cli.secrets.rot-patch.API', { value: 'old' });

    const bundle = readBundle('rot-patch');
    rotateBundleSecret(bundle, 'API', {
      newValue: 'new',
      meta: { note: 'rotated' },
    });

    const after = readBundle('rot-patch');
    expect(after.meta?.API).toEqual({ type: 'api-key', note: 'rotated' });
  });

  it('errors when the key does not exist', () => {
    writeBundle({ name: 'rot-missing', vars: { OTHER: 'literal' } });
    const bundle = readBundle('rot-missing');
    expect(() => rotateBundleSecret(bundle, 'NOPE', { newValue: 'x' })).toThrow(
      /Key 'NOPE' not in bundle 'rot-missing'/,
    );
  });

  it('errors when the key is not keychain-backed', () => {
    writeBundle({ name: 'rot-lit', vars: { LIT: 'plain' } });
    const bundle = readBundle('rot-lit');
    expect(() => rotateBundleSecret(bundle, 'LIT', { newValue: 'x' })).toThrow(
      /not keychain-backed/,
    );
  });

  it('clearMeta wipes only the rotated key, leaving other keys meta intact', () => {
    writeBundle({
      name: 'rot-clear',
      vars: { A: 'keychain:A', B: 'keychain:B' },
      meta: {
        A: { type: 'api-key', note: 'goes away' },
        B: { type: 'token', note: 'stays' },
      },
    });
    store.set('agents-cli.secrets.rot-clear.A', { value: 'a-old', sync: false });
    store.set('agents-cli.secrets.rot-clear.B', { value: 'b-old', sync: false });

    const bundle = readBundle('rot-clear');
    rotateBundleSecret(bundle, 'A', { newValue: 'a-new', clearMeta: true });

    const after = readBundle('rot-clear');
    expect(after.meta?.A).toBeUndefined();
    expect(after.meta?.B).toEqual({ type: 'token', note: 'stays' });
  });
});

describe('renameBundle', () => {
  it('moves metadata and every keychain value to the new name', () => {
    writeBundle({
      name: 'old',
      description: 'before',
      vars: { API_KEY: 'keychain:API_KEY', LITERAL: 'lit' },
    });
    // Seed the per-key keychain item the way `add` would.
    store.set('agents-cli.secrets.old.API_KEY', { value: 'v1' });

    renameBundle('old', 'new');

    expect(bundleExists('old')).toBe(false);
    expect(store.has('agents-cli.secrets.old.API_KEY')).toBe(false);
    const got = readBundle('new');
    expect(got.description).toBe('before');
    expect(got.vars).toEqual({ API_KEY: 'keychain:API_KEY', LITERAL: 'lit' });
    expect(store.get('agents-cli.secrets.new.API_KEY')?.value).toBe('v1');
  });

  it('preserves created_at and refreshes updated_at', async () => {
    writeBundle({ name: 'src', vars: {} });
    const before = readBundle('src');
    await new Promise((r) => setTimeout(r, 10));
    renameBundle('src', 'dst');
    const after = readBundle('dst');
    expect(after.created_at).toBe(before.created_at);
    expect(Date.parse(after.updated_at!)).toBeGreaterThan(Date.parse(before.updated_at!));
  });

  it('refuses when destination exists and --force is not set', () => {
    writeBundle({ name: 'src', vars: {} });
    writeBundle({ name: 'dst', vars: {} });
    expect(() => renameBundle('src', 'dst')).toThrow(/already exists/);
    expect(bundleExists('src')).toBe(true);
    expect(bundleExists('dst')).toBe(true);
  });

  it('overwrites destination and purges its keychain items with force', () => {
    writeBundle({ name: 'src', vars: { K: 'keychain:K' } });
    store.set('agents-cli.secrets.src.K', { value: 'src-val' });
    writeBundle({ name: 'dst', vars: { OLD: 'keychain:OLD' } });
    store.set('agents-cli.secrets.dst.OLD', { value: 'dst-val' });

    renameBundle('src', 'dst', { force: true });

    expect(bundleExists('src')).toBe(false);
    expect(store.has('agents-cli.secrets.dst.OLD')).toBe(false);
    expect(readBundle('dst').vars).toEqual({ K: 'keychain:K' });
    expect(store.get('agents-cli.secrets.dst.K')?.value).toBe('src-val');
  });

  it('rejects renaming to the same name', () => {
    writeBundle({ name: 'same', vars: {} });
    expect(() => renameBundle('same', 'same')).toThrow(/unchanged/);
  });

  it('errors when the source does not exist', () => {
    expect(() => renameBundle('nope', 'something')).toThrow(/not found/);
  });
});

describe('migrateLegacyBundles', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-mig-'));
    osMockState.homedir = tmpHome;
  });

  afterEach(() => {
    osMockState.homedir = '';
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('moves YAML bundle into keychain and unlinks the file', async () => {
    const dir = path.join(tmpHome, '.agents', 'secrets');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'legacy-bundle.yml');
    fs.writeFileSync(file, yaml.stringify({
      name: 'legacy-bundle',
      description: 'from yaml',
      vars: { A: 'literal', B: 'keychain:K_B' },
    }), 'utf-8');

    await migrateLegacyBundles(() => true);

    expect(fs.existsSync(file)).toBe(false);
    const got = readBundle('legacy-bundle');
    expect(got.description).toBe('from yaml');
    expect(got.vars).toEqual({ A: 'literal', B: 'keychain:K_B' });
    expect(store.has('agents-cli.bundles.legacy-bundle')).toBe(true);
  });

  it('refuses legacy YAML with dynamic-loader env keys before writing', async () => {
    const dir = path.join(tmpHome, '.agents', 'secrets');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'legacy-bundle.yml');
    fs.writeFileSync(file, yaml.stringify({
      vars: { DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib' },
    }), 'utf-8');

    await expect(migrateLegacyBundles(() => {
      throw new Error('confirmation should not run');
    })).rejects.toThrow(/DYLD_INSERT_LIBRARIES.*reserved/);

    expect(fs.existsSync(file)).toBe(true);
    expect(store.has('agents-cli.bundles.legacy-bundle')).toBe(false);
  });

  it('is a no-op when the secrets dir does not exist', async () => {
    await expect(migrateLegacyBundles(() => true)).resolves.toBe(0);
  });
});
