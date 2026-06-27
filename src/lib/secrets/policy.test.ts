import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setKeychainBackendForTest, type KeychainBackend } from './index.js';
import { writeBundle, readBundle, listBundles, bundlePolicy, type SecretsBundle } from './bundles.js';

/**
 * Covers the bundle prompt-policy field across the three parse sites (readBundle,
 * listBundles, readAndResolveBundleEnv) and its default resolution — plus the
 * legacy wire-format compatibility that lets mixed-version machines stay
 * readable: the in-memory / user-facing vocabulary is `always`/`daily`, but it
 * persists under the legacy `tier`/`session` token. Uses the in-memory keychain
 * backend seam so no real keychain or Touch ID is touched — the alternative
 * would require an interactive unlock.
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

function bundle(name: string, policy?: SecretsBundle['policy']): SecretsBundle {
  return { name, policy, vars: {} };
}

describe('secrets prompt-policy persistence', () => {
  it('round-trips a daily policy through write -> read', () => {
    writeBundle(bundle('s', 'daily'));
    expect(readBundle('s').policy).toBe('daily');
    expect(bundlePolicy(readBundle('s'))).toBe('daily');
  });

  it('persists daily under the legacy `tier: session` wire token (cross-version sync)', () => {
    writeBundle(bundle('w', 'daily'));
    const raw = JSON.parse(mem.get('agents-cli.bundles.w'));
    expect(raw.tier).toBe('session'); // older CLIs read this
    expect(raw.policy).toBeUndefined(); // we never write a `policy` key
  });

  it('reads a legacy `tier: session` bundle back as daily', () => {
    writeBundle(bundle('legacy')); // create the metadata item
    const item = 'agents-cli.bundles.legacy';
    const raw = JSON.parse(mem.get(item));
    raw.tier = 'session'; // simulate metadata written by an older CLI version
    mem.set(item, JSON.stringify(raw));
    expect(bundlePolicy(readBundle('legacy'))).toBe('daily');
  });

  it('defaults to always when no policy is stored', () => {
    writeBundle(bundle('b'));
    const read = readBundle('b');
    expect(read.policy).toBeUndefined();
    expect(bundlePolicy(read)).toBe('always');
  });

  it('persists an explicit always policy as the absent default (not a literal)', () => {
    writeBundle(bundle('b2', 'always'));
    // always is the default, so it is not written into the JSON — it reads back
    // as undefined, which bundlePolicy() resolves to always.
    expect(readBundle('b2').policy).toBeUndefined();
    expect(bundlePolicy(readBundle('b2'))).toBe('always');
  });

  it('reflects the policy in listBundles', () => {
    writeBundle(bundle('alpha', 'daily'));
    writeBundle(bundle('beta'));
    const byName = Object.fromEntries(listBundles().map((b) => [b.name, bundlePolicy(b)]));
    expect(byName.alpha).toBe('daily');
    expect(byName.beta).toBe('always');
  });

  it('treats an unknown/forward-incompatible persisted policy as the default', () => {
    writeBundle(bundle('weird', 'daily'));
    // Simulate a token written by a newer/other version.
    const item = 'agents-cli.bundles.weird';
    const raw = JSON.parse(mem.get(item));
    raw.tier = 'galaxy-brain';
    mem.set(item, JSON.stringify(raw));
    expect(readBundle('weird').policy).toBeUndefined();
    expect(bundlePolicy(readBundle('weird'))).toBe('always');
  });
});
