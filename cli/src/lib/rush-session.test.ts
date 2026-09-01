import { describe, it, expect } from 'vitest';
import { isRushSessionExpired } from './rush-session.js';

describe('isRushSessionExpired', () => {
  it('treats expires_at: 0 as non-expiring (Phoenix pid_ bearer, PHNX-3645)', () => {
    // 0 is the sentinel `rush login` writes for a non-expiring opaque bearer.
    // Reading it as an absolute timestamp was the 1970-01-01 bug that rejected
    // every valid Phoenix session across cloud dispatch, secrets sync, and the
    // cloud session source.
    expect(isRushSessionExpired(0)).toBe(false);
  });

  it('treats a missing expires_at as non-expiring', () => {
    expect(isRushSessionExpired(undefined)).toBe(false);
  });

  it('is expired when expires_at is in the past', () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    expect(isRushSessionExpired(oneHourAgo)).toBe(true);
  });

  it('is not expired when expires_at is in the future', () => {
    const oneHourAhead = Math.floor(Date.now() / 1000) + 3600;
    expect(isRushSessionExpired(oneHourAhead)).toBe(false);
  });
});
