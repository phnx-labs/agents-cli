import { describe, it, expect } from 'vitest';

import { claudeAccessTokenNeedsRefresh, claudeUsageAccessTokenNoRefresh, loadClaudeOauth, getClaudeKeychainService } from './usage.js';
import { setKeychainToken, setKeychainBackendForTest, type KeychainBackend } from './secrets/index.js';

const LEEWAY_MS = 5 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed epoch ms so the tests are deterministic

describe('claudeAccessTokenNeedsRefresh', () => {
  it('treats a missing expiry as still-fresh (never force a refresh)', () => {
    // A token with no known expiry must not trigger a refresh — that is what
    // kept the health probe from rotating tokens with an unknown lifetime.
    expect(claudeAccessTokenNeedsRefresh(null, NOW)).toBe(false);
    expect(claudeAccessTokenNeedsRefresh(undefined, NOW)).toBe(false);
  });

  it('is false while the token is comfortably in the future', () => {
    expect(claudeAccessTokenNeedsRefresh(NOW + LEEWAY_MS + 60_000, NOW)).toBe(false);
  });

  it('is true once the token is within the refresh leeway of expiry', () => {
    // The stampede fix depends on this comparison direction: a near-expiry
    // token reports `expired` from the probe (non-fatal) instead of refreshing.
    expect(claudeAccessTokenNeedsRefresh(NOW + LEEWAY_MS - 1, NOW)).toBe(true);
  });

  it('is true exactly at the leeway boundary (>=, not >)', () => {
    expect(claudeAccessTokenNeedsRefresh(NOW + LEEWAY_MS, NOW)).toBe(true);
  });

  it('is true for an already-expired token', () => {
    expect(claudeAccessTokenNeedsRefresh(NOW - 60_000, NOW)).toBe(true);
  });
});

describe('claudeUsageAccessTokenNoRefresh', () => {
  // Uses the real Date.now() internally (via claudeAccessTokenNeedsRefresh), so
  // express expiries relative to now.
  const now = Date.now();

  it('returns the token when it is comfortably fresh', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: now + 60 * 60 * 1000 })).toBe('tok-abc');
  });

  it('returns the token when the expiry is unknown (never forces a refresh)', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: null })).toBe('tok-abc');
  });

  it('returns null (NOT a rotating refresh) for a near-expiry token', () => {
    // The regression this guards: a usage read must never rotate Claude's
    // single-use refresh token. A token within the 5-min leeway yields "no usage
    // now" (null) instead of refreshing and logging every other fleet box out.
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: now + 60_000 })).toBeNull();
  });

  it('returns null for an already-expired token (still never refreshes)', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: now - 60_000 })).toBeNull();
  });

  it('returns null for a missing/empty access token', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: '', expiresAt: now + 60 * 60 * 1000 })).toBeNull();
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: '   ', expiresAt: now + 60 * 60 * 1000 })).toBeNull();
  });
});

/**
 * The Touch ID storm fix: `loadClaudeOauth` reads Claude's ACL-bound keychain item
 * (one prompt per read on macOS). We cache the access token in a no-ACL item so the
 * source read happens at most once per token lifetime, shared across processes.
 * Here the in-memory keychain backend (the sanctioned test seam) counts source reads
 * by payload shape — the source item wraps `claudeAiOauth`, the cache item does not.
 */
describe('loadClaudeOauth no-ACL access-token cache', () => {
  /** Counting backend: tracks reads of the source (ACL) item and no-ACL cache writes,
   *  identified by value shape so the test is agnostic to keychain name hashing. */
  class CountingBackend implements KeychainBackend {
    store = new Map<string, string>();
    sourceReads = 0;
    noAclCacheWrites = 0;
    has(item: string) { return this.store.has(item); }
    get(item: string) {
      const v = this.store.get(item);
      if (v === undefined) throw new Error(`missing ${item}`);
      if (v.includes('"claudeAiOauth"')) this.sourceReads += 1;
      return v;
    }
    set(item: string, value: string, opts?: { noAcl?: boolean }) {
      if (opts?.noAcl && value.includes('"cacheExpiresAt"')) this.noAclCacheWrites += 1;
      this.store.set(item, value);
    }
    delete(item: string) { return this.store.delete(item); }
    list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
  }

  const HOME = '/tmp/agents-cli-usage-cache-test';
  const service = getClaudeKeychainService(HOME);
  const seedSource = (expiresAt: number) =>
    setKeychainToken(
      service,
      JSON.stringify({
        organizationUuid: 'org-1',
        claudeAiOauth: { accessToken: 'tok-live', refreshToken: 'refresh-secret', expiresAt, scopes: ['user:inference'] },
      })
    );

  it('reads the ACL source once, then serves the no-ACL cache (no repeat prompt)', async () => {
    const mem = new CountingBackend();
    const prev = setKeychainBackendForTest(mem);
    try {
      seedSource(Date.now() + 60 * 60 * 1000); // fresh: 1h out

      const first = await loadClaudeOauth(HOME, { accessTokenCache: true });
      const second = await loadClaudeOauth(HOME, { accessTokenCache: true });

      expect(first?.accessToken).toBe('tok-live');
      expect(second?.accessToken).toBe('tok-live');
      // The source (prompting) item is read exactly once across both loads.
      expect(mem.sourceReads).toBe(1);
      // The cache was populated via the no-ACL write path.
      expect(mem.noAclCacheWrites).toBe(1);
      // The cache deliberately omits the refresh token (minimal no-ACL exposure);
      // the first read comes straight from source and still carries it.
      expect(first?.refreshToken).toBe('refresh-secret');
      expect(second?.refreshToken).toBeNull();
    } finally {
      setKeychainBackendForTest(prev);
    }
  });

  it('re-reads the source when the cached token has expired (never serves a stale token)', async () => {
    const mem = new CountingBackend();
    const prev = setKeychainBackendForTest(mem);
    try {
      seedSource(Date.now() - 60 * 1000); // already expired

      await loadClaudeOauth(HOME, { accessTokenCache: true });
      await loadClaudeOauth(HOME, { accessTokenCache: true });

      // Every load evicts the expired cache entry and reads the source again.
      expect(mem.sourceReads).toBe(2);
    } finally {
      setKeychainBackendForTest(prev);
    }
  });

  it('without the opt-in, returns the full credential and never caches (cloud-export contract)', async () => {
    // readClaudeCredentialsBlob / isClaudeAuthValid call loadClaudeOauth WITHOUT
    // the cache flag: they must always get the ACL-read credential WITH the refresh
    // token. Regression guard for the Rush Cloud token-export path.
    const mem = new CountingBackend();
    const prev = setKeychainBackendForTest(mem);
    try {
      seedSource(Date.now() + 60 * 60 * 1000);

      const first = await loadClaudeOauth(HOME); // default: no cache
      const second = await loadClaudeOauth(HOME);

      // Full refresh token every time — never dropped.
      expect(first?.refreshToken).toBe('refresh-secret');
      expect(second?.refreshToken).toBe('refresh-secret');
      // No no-ACL cache is ever written on the default path.
      expect(mem.noAclCacheWrites).toBe(0);
      // Every default read goes to the ACL source (no cache short-circuit).
      expect(mem.sourceReads).toBe(2);
    } finally {
      setKeychainBackendForTest(prev);
    }
  });
});
