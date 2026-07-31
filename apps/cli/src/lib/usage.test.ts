import { describe, it, expect } from 'vitest';

import { claudeAccessTokenNeedsRefresh, claudeUsageAccessTokenNoRefresh } from './usage.js';

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
