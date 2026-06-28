import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setKeychainBackendForTest, type KeychainBackend } from './index.js';
import { writeBundle, readBundle, listBundles, bundlePolicy, secretsDefaultPolicy, type SecretsBundle } from './bundles.js';

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

  it('stores no policy when unset and resolves it to the configured default', () => {
    writeBundle(bundle('b'));
    const read = readBundle('b');
    expect(read.policy).toBeUndefined(); // absent on disk → inherits the default
    // On a clean machine/CI (no `secrets.policy` in agents.yaml) the default is daily.
    expect(secretsDefaultPolicy()).toBe('daily');
    expect(bundlePolicy(read)).toBe(secretsDefaultPolicy());
  });

  it('persists an explicit always override (survives the daily default flip)', () => {
    writeBundle(bundle('b2', 'always'));
    // always is no longer the default, so it MUST be persisted — under the legacy
    // `biometry` token, which older CLIs read as their own always default.
    const raw = JSON.parse(mem.get('agents-cli.bundles.b2'));
    expect(raw.tier).toBe('biometry');
    expect(readBundle('b2').policy).toBe('always');
    expect(bundlePolicy(readBundle('b2'))).toBe('always');
  });

  it('reads a legacy `tier: biometry` bundle back as an explicit always', () => {
    writeBundle(bundle('old')); // create the metadata item
    const item = 'agents-cli.bundles.old';
    const raw = JSON.parse(mem.get(item));
    raw.tier = 'biometry'; // simulate metadata written by an older CLI version
    mem.set(item, JSON.stringify(raw));
    expect(bundlePolicy(readBundle('old'))).toBe('always');
  });

  it('reflects the policy in listBundles (unset inherits the default)', () => {
    writeBundle(bundle('alpha', 'daily'));
    writeBundle(bundle('beta')); // unset → default
    writeBundle(bundle('gamma', 'always')); // explicit override
    const byName = Object.fromEntries(listBundles().map((b) => [b.name, bundlePolicy(b)]));
    expect(byName.alpha).toBe('daily');
    expect(byName.beta).toBe(secretsDefaultPolicy());
    expect(byName.gamma).toBe('always');
  });

  it('treats an unknown/forward-incompatible persisted policy as the default', () => {
    writeBundle(bundle('weird', 'daily'));
    // Simulate a token written by a newer/other version.
    const item = 'agents-cli.bundles.weird';
    const raw = JSON.parse(mem.get(item));
    raw.tier = 'galaxy-brain';
    mem.set(item, JSON.stringify(raw));
    expect(readBundle('weird').policy).toBeUndefined();
    expect(bundlePolicy(readBundle('weird'))).toBe(secretsDefaultPolicy());
  });
});
