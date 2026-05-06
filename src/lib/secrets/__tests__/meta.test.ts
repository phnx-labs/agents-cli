/**
 * Tests for per-secret metadata (type, expires, note).
 *
 * Covers the validators and the round-trip through writeBundle/readBundle
 * via the in-memory keychain backend seam.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readBundle,
  validateExpiresFutureDated,
  validateSecretType,
  writeBundle,
  SECRET_TYPES,
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

beforeEach(() => {
  const m = makeMemoryBackend();
  restore = setKeychainBackendForTest(m.backend);
});

afterEach(() => {
  setKeychainBackendForTest(restore);
});

describe('validateSecretType', () => {
  it('accepts every enum value', () => {
    for (const t of SECRET_TYPES) {
      expect(() => validateSecretType(t)).not.toThrow();
    }
  });

  it('rejects unknown values with the allowed list in the message', () => {
    expect(() => validateSecretType('made-up')).toThrow(/Invalid type 'made-up'/);
    expect(() => validateSecretType('made-up')).toThrow(/api-key/);
  });

  it('rejects empty string', () => {
    expect(() => validateSecretType('')).toThrow();
  });
});

describe('validateExpiresFutureDated', () => {
  it('accepts a clearly future date', () => {
    expect(() => validateExpiresFutureDated('2099-12-31')).not.toThrow();
  });

  it('rejects a past date', () => {
    expect(() => validateExpiresFutureDated('2000-01-01')).toThrow(/future-dated/);
  });

  it('rejects today (boundary at end-of-day UTC)', () => {
    // The validator compares against 23:59:59Z of the chosen date. So a date
    // whose end-of-day UTC is already in the past must fail. We pick yesterday
    // in UTC to make the assertion deterministic regardless of the test host's
    // local timezone.
    const yesterdayUTC = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(() => validateExpiresFutureDated(yesterdayUTC)).toThrow(/future-dated/);
  });

  it('rejects malformed shapes', () => {
    expect(() => validateExpiresFutureDated('2099/12/31')).toThrow(/YYYY-MM-DD/);
    expect(() => validateExpiresFutureDated('99-12-31')).toThrow(/YYYY-MM-DD/);
    expect(() => validateExpiresFutureDated('not-a-date')).toThrow(/YYYY-MM-DD/);
    expect(() => validateExpiresFutureDated('2099-13-01')).toThrow();
  });
});

describe('writeBundle + readBundle round-trip with meta', () => {
  it('preserves all three meta subfields per var', () => {
    const bundle: SecretsBundle = {
      name: 'meta-rt',
      vars: {
        STRIPE_API_KEY: 'keychain:STRIPE_API_KEY',
        DB_URL: 'keychain:DB_URL',
        LOG: 'info',
      },
      meta: {
        STRIPE_API_KEY: {
          type: 'api-key',
          expires: '2099-12-31',
          note: 'Live payments key',
        },
        DB_URL: {
          type: 'database-url',
        },
        LOG: {
          note: 'logging level',
        },
      },
    };
    writeBundle(bundle);
    const got = readBundle('meta-rt');
    expect(got.meta).toEqual(bundle.meta);
  });

  it('preserves meta for a key removed from vars (consumers must clean up)', () => {
    // We DO NOT auto-purge orphan meta. Callers (e.g. `secrets remove`) are
    // responsible for deleting bundle.meta[key] when removing a var. This
    // test pins that behavior so it doesn't regress silently.
    const bundle: SecretsBundle = {
      name: 'orphan-meta',
      vars: { LIVE: 'literal' },
      meta: {
        LIVE: { type: 'token' },
        DELETED_KEY: { type: 'api-key', note: 'used to live in vars' },
      },
    };
    writeBundle(bundle);
    const got = readBundle('orphan-meta');
    expect(got.meta?.DELETED_KEY).toEqual({ type: 'api-key', note: 'used to live in vars' });
  });

  it('drops the meta field entirely when every entry is empty', () => {
    const bundle: SecretsBundle = {
      name: 'empty-meta',
      vars: { A: 'x' },
      meta: { A: {}, B: {} },
    };
    writeBundle(bundle);
    const got = readBundle('empty-meta');
    expect(got.meta).toBeUndefined();
  });

  it('round-trips an undefined meta as undefined', () => {
    writeBundle({ name: 'no-meta', vars: { A: 'x' } });
    const got = readBundle('no-meta');
    expect(got.meta).toBeUndefined();
  });
});
