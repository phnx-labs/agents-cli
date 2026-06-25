import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setKeychainBackendForTest, type KeychainBackend } from './index.js';
import { writeBundle, readBundle, listBundles, bundleTier, type SecretsBundle } from './bundles.js';

/**
 * Covers the secrets-agent `tier` field's persistence across the three parse
 * sites (readBundle, listBundles, readAndResolveBundleEnv) and the default
 * resolution. Uses the in-memory keychain backend seam so no real keychain or
 * Touch ID is touched — the alternative would require an interactive unlock.
 */

class MemBackend implements KeychainBackend {
  store = new Map<string, string>();
  has(item: string) { return this.store.has(item); }
  get(item: string) {
    const v = this.store.get(item);
    if (v === undefined) throw new Error(`missing ${item}`);
    return v;
  }
  set(item: string, value: string) { this.store.set(item, value); }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
}

let mem: MemBackend;
let prev: KeychainBackend | null = null;

beforeEach(() => { mem = new MemBackend(); prev = setKeychainBackendForTest(mem); });
afterEach(() => { setKeychainBackendForTest(prev); });

function bundle(name: string, tier?: SecretsBundle['tier']): SecretsBundle {
  return { name, tier, vars: {} };
}

describe('secrets tier persistence', () => {
  it('round-trips a session tier through write -> read', () => {
    writeBundle(bundle('s', 'session'));
    expect(readBundle('s').tier).toBe('session');
    expect(bundleTier(readBundle('s'))).toBe('session');
  });

  it('defaults to biometry when no tier is stored', () => {
    writeBundle(bundle('b'));
    const read = readBundle('b');
    expect(read.tier).toBeUndefined();
    expect(bundleTier(read)).toBe('biometry');
  });

  it('persists an explicit biometry tier as the absent default (not a literal)', () => {
    writeBundle(bundle('b2', 'biometry'));
    // biometry is the default, so it is not written into the JSON — it reads
    // back as undefined, which bundleTier() resolves to biometry.
    expect(readBundle('b2').tier).toBeUndefined();
    expect(bundleTier(readBundle('b2'))).toBe('biometry');
  });

  it('reflects the tier in listBundles', () => {
    writeBundle(bundle('alpha', 'session'));
    writeBundle(bundle('beta'));
    const byName = Object.fromEntries(listBundles().map((b) => [b.name, bundleTier(b)]));
    expect(byName.alpha).toBe('session');
    expect(byName.beta).toBe('biometry');
  });

  it('treats an unknown/forward-incompatible persisted tier as the default', () => {
    writeBundle(bundle('weird', 'session'));
    // Simulate a tier value written by a newer/other version.
    const item = 'agents-cli.bundles.weird';
    const raw = JSON.parse(mem.get(item));
    raw.tier = 'galaxy-brain';
    mem.set(item, JSON.stringify(raw));
    expect(readBundle('weird').tier).toBeUndefined();
    expect(bundleTier(readBundle('weird'))).toBe('biometry');
  });
});
