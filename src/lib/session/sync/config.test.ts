import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setKeychainBackendForTest, type KeychainBackend } from '../../secrets/index.js';
import { writeBundle, type SecretsBundle } from '../../secrets/bundles.js';
import {
  loadR2Config,
  isSyncConfigured,
  clearR2ConfigCache,
  RESOLVE_RETRY_COOLDOWN_MS,
  SYNC_BUNDLE,
} from './config.js';

/**
 * Guards the resolution cache that stops the daemon's ~90s session-sync from
 * re-reading the biometry-gated `r2.backups` keychain bundle every cycle (the
 * Touch ID storm). Uses the in-memory keychain backend seam (same as
 * tier.test.ts) so the real readAndResolveBundleEnv path runs without a real
 * keychain — `gets` counts how often the backend is actually read, which is the
 * proxy for "would this prompt for Touch ID again?".
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

function writeValidBundle(): void {
  const b: SecretsBundle = {
    name: SYNC_BUNDLE,
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
  it('reads the keychain once across many loadR2Config calls', () => {
    writeValidBundle();
    const a = loadR2Config();
    const b1 = loadR2Config();
    const c = loadR2Config();
    expect(a.bucket).toBe('agents-sessions');
    expect(a.endpoint).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(b1).toBe(a); // memoized: same object
    expect(c).toBe(a);
    expect(be.gets).toBe(1); // only the first call touched the backend
  });

  it('lets isSyncConfigured short-circuit once resolved (no re-read)', () => {
    writeValidBundle();
    expect(isSyncConfigured()).toBe(true);
    const after = be.gets;
    expect(isSyncConfigured()).toBe(true);
    expect(isSyncConfigured()).toBe(true);
    expect(be.gets).toBe(after); // cached — never re-read
  });

  it('clearR2ConfigCache forces a fresh read (credential rotation / SIGHUP)', () => {
    writeValidBundle();
    loadR2Config();
    expect(be.gets).toBe(1);
    clearR2ConfigCache();
    loadR2Config();
    expect(be.gets).toBe(2);
  });

  it('re-checks an ABSENT bundle every cycle (never prompts, fast pickup)', () => {
    // No bundle written → "not found" → must keep polling so a later
    // `agents secrets add` is picked up promptly. A missing item never prompts.
    expect(isSyncConfigured(1_000)).toBe(false);
    expect(isSyncConfigured(2_000)).toBe(false);
    expect(be.gets).toBe(2); // re-read each call, no backoff
  });

  it('backs off after a prompt-bearing failure so it does not re-storm', () => {
    // A present-but-incomplete bundle resolves the meta (a real keychain read
    // that would prompt) then fails validation — exactly the case we must not
    // retry every 90s.
    writeBundle({ name: SYNC_BUNDLE, vars: { R2_ACCOUNT_ID: 'acct123' } });

    const t0 = 1_000_000;
    expect(isSyncConfigured(t0)).toBe(false);
    expect(be.gets).toBe(1); // read once (the failing attempt)

    // Within the cooldown: do NOT re-read (would re-prompt).
    expect(isSyncConfigured(t0 + RESOLVE_RETRY_COOLDOWN_MS - 1)).toBe(false);
    expect(be.gets).toBe(1);

    // After the cooldown: allowed to try again.
    expect(isSyncConfigured(t0 + RESOLVE_RETRY_COOLDOWN_MS + 1)).toBe(false);
    expect(be.gets).toBe(2);
  });

  it('recovers immediately once the bundle becomes valid after a cooldown', () => {
    const t0 = 5_000_000;
    expect(isSyncConfigured(t0)).toBe(false); // absent
    writeValidBundle();
    // absent path does not back off, so the very next check resolves
    expect(isSyncConfigured(t0 + 1)).toBe(true);
    expect(loadR2Config().bucket).toBe('agents-sessions');
  });
});
