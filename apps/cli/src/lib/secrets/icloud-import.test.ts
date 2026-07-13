import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  setKeychainBackendForTest,
  setSyncedKeychainBackendForTest,
  type KeychainBackend,
  type SyncedKeychainBackend,
} from './index.js';
import { _resetFileStoreForTest } from './filestore.js';
import { readBundle, bundleExists, writeBundle } from './bundles.js';
import {
  discoverSyncedBundles,
  groupSyncedServices,
  importSyncedBundle,
} from './icloud-import.js';

function makeMemoryBackend(): { backend: KeychainBackend; store: Map<string, string> } {
  const store = new Map<string, string>();
  const backend: KeychainBackend = {
    has: (item) => store.has(item),
    get: (item) => {
      const v = store.get(item);
      if (v === undefined) throw new Error(`Keychain item '${item}' not found.`);
      return v;
    },
    set: (item, value) => {
      store.set(item, value);
    },
    delete: (item) => store.delete(item),
    list: (prefix) => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
  };
  return { backend, store };
}

function makeSyncedBackend(): { backend: SyncedKeychainBackend; store: Map<string, string> } {
  const store = new Map<string, string>();
  const backend: SyncedKeychainBackend = {
    list: (prefix) => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
    getBatch: (items) => {
      const out = new Map<string, string>();
      for (const item of items) {
        const v = store.get(item);
        if (v !== undefined) out.set(item, v);
      }
      return out;
    },
    delete: (item) => store.delete(item),
  };
  return { backend, store };
}

describe('groupSyncedServices', () => {
  it('splits secret services at the last dot so dotted bundle names survive', () => {
    const candidates = groupSyncedServices(['agents-cli.secrets.hetzner.com.HCLOUD_TOKEN']);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('hetzner.com');
    expect(candidates[0].keys).toEqual(['HCLOUD_TOKEN']);
    expect(candidates[0].hasMeta).toBe(false);
  });

  it('merges metadata and secret items of the same bundle into one candidate', () => {
    const candidates = groupSyncedServices([
      'agents-cli.bundles.hetzner',
      'agents-cli.secrets.hetzner.HETZNER_USERNAME',
      'agents-cli.secrets.hetzner.HETZNER_PASSWORD',
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('hetzner');
    expect(candidates[0].hasMeta).toBe(true);
    expect(candidates[0].keys.sort()).toEqual(['HETZNER_PASSWORD', 'HETZNER_USERNAME']);
    expect(candidates[0].services).toHaveLength(3);
  });

  it('ignores non-bundle items and invalid names, dedupes, sorts by name', () => {
    const candidates = groupSyncedServices([
      'agents-cli.github.token', // raw provider token — not a bundle item
      'agents-cli.secrets.zeta.KEY_A',
      'agents-cli.secrets.zeta.KEY_A', // duplicate
      'agents-cli.secrets.alpha.KEY_B',
      'agents-cli.secrets.bad.not a key', // invalid env key
      'agents-cli.bundles.-bad-name-', // fails BUNDLE_NAME_PATTERN (leading dash)
    ]);
    expect(candidates.map((c) => c.name)).toEqual(['alpha', 'zeta']);
    expect(candidates[1].keys).toEqual(['KEY_A']);
  });
});

describe('importSyncedBundle', () => {
  let local: ReturnType<typeof makeMemoryBackend>;
  let synced: ReturnType<typeof makeSyncedBackend>;
  let restoreLocal: KeychainBackend | null;
  let restoreSynced: SyncedKeychainBackend | null;
  let fileTmpDir: string;

  beforeEach(() => {
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    process.env.AGENTS_NO_USAGE_TRACK = '1';
    local = makeMemoryBackend();
    synced = makeSyncedBackend();
    restoreLocal = setKeychainBackendForTest(local.backend);
    restoreSynced = setSyncedKeychainBackendForTest(synced.backend);
    fileTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-icloud-import-'));
    _resetFileStoreForTest({ fileDir: fileTmpDir });
  });

  afterEach(() => {
    setKeychainBackendForTest(restoreLocal);
    setSyncedKeychainBackendForTest(restoreSynced);
    _resetFileStoreForTest();
    fs.rmSync(fileTmpDir, { recursive: true, force: true });
    delete process.env.AGENTS_SECRETS_NO_AGENT;
    delete process.env.AGENTS_NO_USAGE_TRACK;
  });

  function seedHetzner(): void {
    synced.store.set(
      'agents-cli.bundles.hetzner',
      JSON.stringify({
        description: 'Hetzner robot login',
        vars: {
          HETZNER_USERNAME: 'keychain:HETZNER_USERNAME',
          HETZNER_PASSWORD: 'keychain:HETZNER_PASSWORD',
          REGION: { value: 'fsn1' },
        },
      }),
    );
    synced.store.set('agents-cli.secrets.hetzner.HETZNER_USERNAME', 'robot-user');
    synced.store.set('agents-cli.secrets.hetzner.HETZNER_PASSWORD', 'robot-pass');
  }

  it('imports a discovered bundle into the device-local store end to end', () => {
    seedHetzner();
    const [candidate] = discoverSyncedBundles();
    expect(candidate.name).toBe('hetzner');

    const result = importSyncedBundle(candidate);
    expect(result.added).toBe(3); // two keychain-backed keys + one literal from metadata
    expect(result.skipped).toBe(0);
    expect(result.missing).toEqual([]);

    expect(bundleExists('hetzner')).toBe(true);
    const bundle = readBundle('hetzner');
    expect(bundle.description).toBe('Hetzner robot login');
    expect(bundle.vars.HETZNER_USERNAME).toBe('keychain:HETZNER_USERNAME');
    expect(bundle.vars.REGION).toEqual({ value: 'fsn1' });
    // The values themselves landed device-locally under the standard item names.
    expect(local.store.get('agents-cli.secrets.hetzner.HETZNER_USERNAME')).toBe('robot-user');
    expect(local.store.get('agents-cli.secrets.hetzner.HETZNER_PASSWORD')).toBe('robot-pass');
  });

  it('imports a metadata-less bundle from bare secret items (dotted name)', () => {
    synced.store.set('agents-cli.secrets.hetzner.com.HCLOUD_TOKEN', 'hcloud-tok');
    const [candidate] = discoverSyncedBundles();
    expect(candidate.name).toBe('hetzner.com');
    expect(candidate.hasMeta).toBe(false);

    const result = importSyncedBundle(candidate);
    expect(result.added).toBe(1);
    const bundle = readBundle('hetzner.com');
    expect(bundle.vars.HCLOUD_TOKEN).toBe('keychain:HCLOUD_TOKEN');
    expect(local.store.get('agents-cli.secrets.hetzner.com.HCLOUD_TOKEN')).toBe('hcloud-tok');
  });

  it('reports a keychain ref whose synced item is gone as missing', () => {
    synced.store.set(
      'agents-cli.bundles.partial',
      JSON.stringify({ vars: { GONE_KEY: 'keychain:GONE_KEY' } }),
    );
    const [candidate] = discoverSyncedBundles();
    const result = importSyncedBundle(candidate);
    expect(result.added).toBe(0);
    expect(result.missing).toEqual(['GONE_KEY']);
    // The bundle is still created (empty), so a later re-run can top it up.
    expect(bundleExists('partial')).toBe(true);
  });

  it('skips existing keys without force and overwrites with force', () => {
    seedHetzner();
    writeBundle({ name: 'hetzner', vars: { HETZNER_USERNAME: { value: 'local-existing' } } });
    const [candidate] = discoverSyncedBundles();

    const kept = importSyncedBundle(candidate);
    expect(kept.skipped).toBe(1);
    expect(readBundle('hetzner').vars.HETZNER_USERNAME).toEqual({ value: 'local-existing' });

    const forced = importSyncedBundle(candidate, { force: true });
    expect(forced.skipped).toBe(0);
    expect(readBundle('hetzner').vars.HETZNER_USERNAME).toBe('keychain:HETZNER_USERNAME');
  });

  it('purge deletes imported items but keeps the meta while a key is missing', () => {
    seedHetzner();
    // A phantom secret service that lists but does not read back (sync raced).
    const phantom = 'agents-cli.secrets.hetzner.PHANTOM_KEY';
    synced.store.set(phantom, 'v');
    const [candidate] = discoverSyncedBundles();
    synced.store.delete(phantom); // vanishes between list and read

    const result = importSyncedBundle(candidate, { purge: true });
    expect(result.missing).toEqual(['PHANTOM_KEY']);
    // Only the two read-and-imported secret items go; the metadata item stays
    // behind as the sole record of the missing key.
    expect(result.purged).toBe(2);
    expect([...synced.store.keys()]).toEqual(['agents-cli.bundles.hetzner']);
  });

  it('purge removes everything, meta included, when the import is complete', () => {
    seedHetzner();
    const [candidate] = discoverSyncedBundles();
    const result = importSyncedBundle(candidate, { purge: true });
    expect(result.missing).toEqual([]);
    expect(result.purged).toBe(3); // meta + two secret items
    expect(synced.store.size).toBe(0);
    // Re-listing discovers nothing left to import.
    expect(discoverSyncedBundles()).toEqual([]);
  });

  it('purge treats skipped-because-present keys as safe to remove', () => {
    synced.store.set('agents-cli.secrets.skippy.ONLY_KEY', 'icloud-v');
    writeBundle({ name: 'skippy', vars: { ONLY_KEY: { value: 'local-v' } } });
    const [candidate] = discoverSyncedBundles();
    const result = importSyncedBundle(candidate, { purge: true });
    expect(result.skipped).toBe(1);
    expect(result.purged).toBe(1); // the local bundle owns the key — iCloud copy redundant
    expect(synced.store.size).toBe(0);
  });

  it('reserved keys are reported unimportable, never abort the bundle, never purge', () => {
    synced.store.set(
      'agents-cli.bundles.legacy',
      JSON.stringify({
        vars: {
          GOOD_KEY: 'keychain:GOOD_KEY',
          USERNAME: 'keychain:USERNAME', // reserved in the modern store
          DYLD_INSERT_LIBRARIES: { value: 'evil.dylib' }, // loader var, also refused
        },
      }),
    );
    synced.store.set('agents-cli.secrets.legacy.GOOD_KEY', 'good-v');
    synced.store.set('agents-cli.secrets.legacy.USERNAME', 'muqsit');
    const [candidate] = discoverSyncedBundles();

    const result = importSyncedBundle(candidate, { purge: true });
    expect(result.added).toBe(1);
    expect(result.unimportable.sort()).toEqual(['DYLD_INSERT_LIBRARIES', 'USERNAME']);
    // The bundle still lands with the importable key — no abort.
    const bundle = readBundle('legacy');
    expect(bundle.vars.GOOD_KEY).toBe('keychain:GOOD_KEY');
    expect('USERNAME' in bundle.vars).toBe(false);
    // Purge removed only the imported key; the reserved item and the metadata
    // (its only record) survive.
    expect(result.purged).toBe(1);
    expect([...synced.store.keys()].sort()).toEqual([
      'agents-cli.bundles.legacy',
      'agents-cli.secrets.legacy.USERNAME',
    ]);
  });

  it('all-plaintext stores values as literals without touching the local keychain', () => {
    synced.store.set('agents-cli.secrets.lit.ONLY_KEY', 'plain');
    const [candidate] = discoverSyncedBundles();
    const result = importSyncedBundle(candidate, { allPlaintext: true });
    expect(result.added).toBe(1);
    expect(readBundle('lit').vars.ONLY_KEY).toEqual({ value: 'plain' });
    expect(local.store.has('agents-cli.secrets.lit.ONLY_KEY')).toBe(false);
  });
});
