import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setKeychainBackendForTest, type KeychainBackend } from '../../secrets/index.js';
import { writeBundle, type SecretsBundle } from '../../secrets/bundles.js';
import {
  loadR2Config,
  isSyncConfigured,
  clearR2ConfigCache,
  SYNC_BUNDLE,
} from './config.js';

/**
 * Guards the session-transport secret read. Two invariants:
 *   1. The resolution cache stops the daemon's ~90s cycle from re-reading the
 *      `r2.backups` keychain bundle every cycle (the read-frequency storm).
 *   2. SEC-13: the read is `agentOnly` — it NEVER pops Touch ID. A `never`/no-ACL
 *      bundle resolves silently; a locked `hold`/`always` bundle throws the
 *      "unlock" error, which isSyncConfigured catches and degrades to
 *      no-transport (sync disabled) with no prompt and no crash.
 *
 * Uses the in-memory keychain backend seam so the real readAndResolveBundleEnv
 * path runs without a real keychain. `gets` counts backend reads. Note a locked
 * bundle still does ONE no-ACL metadata read (the policy guard's readBundle) and
 * then THROWS before the biometry-gated batch read — so a locked-bundle read can
 * never prompt, and "no prompt" is proven by the throw firing, not by gets===0.
 */
class CountingBackend implements KeychainBackend {
  store = new Map<string, string>();
  gets = 0;
  has(item: string) { return this.store.has(item); }
  get(item: string) {
    this.gets++;
    const v = this.store.get(item);
    if (v === undefined) throw new Error(`missing ${item}`);
    return v;
  }
  set(item: string, value: string) { this.store.set(item, value); }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter(k => k.startsWith(prefix)); }
}

let be: CountingBackend;
let prev: KeychainBackend | null = null;

beforeEach(() => {
  be = new CountingBackend();
  prev = setKeychainBackendForTest(be);
  process.env.AGENTS_SECRETS_NO_AGENT = '1'; // force keychain path, skip secrets-agent
  clearR2ConfigCache();
});
afterEach(() => {
  setKeychainBackendForTest(prev);
  delete process.env.AGENTS_SECRETS_NO_AGENT;
  clearR2ConfigCache();
});

/** A complete, VALID r2.backups bundle. `policy` decides whether the agentOnly
 *  read resolves silently (`never`, no-ACL) or throws (`hold`/`always`, locked). */
function writeValidBundle(policy: SecretsBundle['policy'] = 'never'): void {
  const b: SecretsBundle = {
    name: SYNC_BUNDLE,
    policy,
    vars: {
      R2_ACCOUNT_ID: 'acct123',
      R2_BUCKET_NAME: 'agents-sessions',
      R2_ACCESS_KEY_ID: 'ak-test',
      R2_SECRET_ACCESS_KEY: 'sk-test',
    },
  };
  writeBundle(b);
}

describe('R2 config resolution cache', () => {
  it('reads the keychain once across many loadR2Config calls (never/no-ACL bundle resolves silently)', () => {
    writeValidBundle('never');
    const a = loadR2Config();
    const afterFirst = be.gets; // the one resolving read (meta + batch)
    const b1 = loadR2Config();
    const c = loadR2Config();
    expect(a.bucket).toBe('agents-sessions');
    expect(a.endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(b1).toBe(a); // memoized: same object
    expect(c).toBe(a);
    expect(be.gets).toBe(afterFirst); // memoized: no further backend reads
  });

  it('lets isSyncConfigured short-circuit once resolved (no re-read)', () => {
    writeValidBundle('never');
    expect(isSyncConfigured()).toBe(true);
    const after = be.gets;
    expect(isSyncConfigured()).toBe(true);
    expect(isSyncConfigured()).toBe(true);
    expect(be.gets).toBe(after); // cached — never re-read
  });

  it('clearR2ConfigCache forces a fresh read (credential rotation / SIGHUP)', () => {
    writeValidBundle('never');
    loadR2Config();
    const afterFirst = be.gets;
    expect(afterFirst).toBeGreaterThan(0);
    clearR2ConfigCache();
    loadR2Config();
    expect(be.gets).toBeGreaterThan(afterFirst); // re-read after cache cleared
  });

  it('re-checks an ABSENT bundle every cycle (never prompts, fast pickup)', () => {
    // No bundle written → "not found" → must keep polling so a later
    // `agents secrets add` is picked up promptly. A missing item never prompts.
    expect(isSyncConfigured(1_000)).toBe(false);
    const afterOne = be.gets;
    expect(isSyncConfigured(2_000)).toBe(false);
    expect(be.gets).toBeGreaterThan(afterOne); // re-read each call, no backoff
  });
});

describe('session-sync SEC-13: agentOnly read never prompts, degrades on a locked bundle', () => {
  it('a LOCKED hold bundle degrades to no-transport: isSyncConfigured false, NO throw propagates', () => {
    // A biometry-gated (`hold`) bundle that the broker does not hold. With the
    // agentOnly read, the policy guard throws "unlock r2.backups"; isSyncConfigured
    // swallows the throw and reports the transport as unconfigured (sync disabled).
    writeValidBundle('hold');
    expect(() => isSyncConfigured()).not.toThrow();
    expect(isSyncConfigured()).toBe(false);
  });

  it('the LOCKED read throws BEFORE the biometry-gated batch read — it can never prompt', () => {
    // The only prompting read is the batch getKeychainTokens; the policy guard
    // throws before it. The batch read would read the 4 R2 secret items on top of
    // the meta item — a silent `never` bundle reads meta + batch (>=2). A locked
    // bundle stops at the guard's single no-ACL meta read, so it reads strictly
    // fewer items and never reaches the gated batch. Proven by comparing counts.
    const beSilent = new CountingBackend();
    setKeychainBackendForTest(beSilent);
    clearR2ConfigCache();
    writeValidBundle('never');
    loadR2Config();
    const silentGets = beSilent.gets; // meta + gated batch

    const beLocked = new CountingBackend();
    setKeychainBackendForTest(beLocked);
    clearR2ConfigCache();
    writeValidBundle('hold');
    expect(() => loadR2Config()).toThrow();
    // Restore the shared backend for afterEach.
    setKeychainBackendForTest(be);
    // The locked read stopped before the gated batch → strictly fewer reads.
    expect(beLocked.gets).toBeLessThan(silentGets);
  });

  it('loadR2Config on a LOCKED hold bundle throws the actionable "unlock" hint (not a silent no-op)', () => {
    writeValidBundle('hold');
    expect(() => loadR2Config()).toThrow(/not unlocked in the secrets agent/);
    expect(() => loadR2Config()).toThrow(/agents secrets unlock r2\.backups/);
  });

  it('a LOCKED bundle is re-checked each cycle (no cooldown) and recovers once made no-ACL', () => {
    writeValidBundle('hold');
    expect(isSyncConfigured(1_000)).toBe(false);
    const afterOne = be.gets;
    expect(isSyncConfigured(2_000)).toBe(false); // no backoff — re-checked
    expect(be.gets).toBeGreaterThan(afterOne);
    // User runs `agents secrets policy r2.backups never` → now readable silently.
    writeValidBundle('never');
    expect(isSyncConfigured(3_000)).toBe(true);
    expect(loadR2Config().bucket).toBe('agents-sessions');
  });

  it('an always-policy (prompt-every-time) bundle also degrades, never throws through isSyncConfigured', () => {
    writeValidBundle('always');
    expect(() => isSyncConfigured()).not.toThrow();
    expect(isSyncConfigured()).toBe(false);
    expect(() => loadR2Config()).toThrow(/not unlocked in the secrets agent/);
  });

  it('recovers immediately once an absent bundle becomes valid (no-ACL)', () => {
    const t0 = 5_000_000;
    expect(isSyncConfigured(t0)).toBe(false); // absent
    writeValidBundle('never');
    // absent path does not back off, so the very next check resolves
    expect(isSyncConfigured(t0 + 1)).toBe(true);
    expect(loadR2Config().bucket).toBe('agents-sessions');
  });
});
