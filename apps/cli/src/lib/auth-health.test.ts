import { describe, it, expect } from 'vitest';

import {
  authAccountLabel,
  authCacheKey,
  classifyHttpStatus,
  formatCheckedAge,
  probeDetail,
  summarizeVerdicts,
  verdictFromProbe,
  verdictGlyph,
  verdictLabel,
  type AuthVerdict,
} from './auth-health.js';

describe('classifyHttpStatus', () => {
  it('maps 2xx to live', () => {
    expect(classifyHttpStatus(200)).toBe('live');
    expect(classifyHttpStatus(204)).toBe('live');
  });
  it('maps 401/403 to revoked — the exact case the "signed in" flag misses', () => {
    expect(classifyHttpStatus(401)).toBe('revoked');
    expect(classifyHttpStatus(403)).toBe('revoked');
  });
  it('maps 429 to rate_limited (token good, throttled)', () => {
    expect(classifyHttpStatus(429)).toBe('rate_limited');
  });
  it('maps other statuses to error, not a false negative', () => {
    expect(classifyHttpStatus(500)).toBe('error');
    expect(classifyHttpStatus(404)).toBe('error');
  });
});

describe('verdictFromProbe', () => {
  it('missing credential -> unconfigured', () => {
    expect(verdictFromProbe({ status: null, token: 'missing' })).toBe('unconfigured');
  });
  it('locally expired -> expired (never revoked, since no refresh on read path)', () => {
    expect(verdictFromProbe({ status: null, token: 'expired' })).toBe('expired');
  });
  it('present token + network error -> error, so we keep the last known verdict', () => {
    expect(verdictFromProbe({ status: null, token: 'present', error: 'timeout' })).toBe('error');
  });
  it('present token + 401 -> revoked', () => {
    expect(verdictFromProbe({ status: 401, token: 'present' })).toBe('revoked');
  });
  it('present token + 200 -> live', () => {
    expect(verdictFromProbe({ status: 200, token: 'present' })).toBe('live');
  });
});

describe('probeDetail', () => {
  it('surfaces the HTTP status for non-2xx', () => {
    expect(probeDetail({ status: 401, token: 'present' })).toBe('HTTP 401');
  });
  it('surfaces the network error when there was no status', () => {
    expect(probeDetail({ status: null, token: 'present', error: 'ETIMEDOUT' })).toBe('ETIMEDOUT');
  });
  it('is undefined for a clean 200', () => {
    expect(probeDetail({ status: 200, token: 'present' })).toBeUndefined();
  });
});

describe('verdictGlyph / verdictLabel', () => {
  const verdicts: AuthVerdict[] = ['live', 'revoked', 'expired', 'rate_limited', 'unverified', 'unconfigured', 'error'];
  it('returns a non-empty glyph and label for every verdict', () => {
    for (const v of verdicts) {
      expect(verdictGlyph(v).length).toBeGreaterThan(0);
      expect(verdictLabel(v).length).toBeGreaterThan(0);
    }
  });
  it('live and revoked read differently', () => {
    expect(verdictGlyph('live')).not.toBe(verdictGlyph('revoked'));
    expect(verdictLabel('live')).toBe('live');
    expect(verdictLabel('revoked')).toBe('revoked');
  });
});

describe('authAccountLabel', () => {
  it('prefers email, then accountId, then userId', () => {
    expect(authAccountLabel({ email: 'a@b.com', accountId: 'x', userId: 'y' })).toBe('a@b.com');
    expect(authAccountLabel({ email: null, accountId: 'x', userId: 'y' })).toBe('x');
    expect(authAccountLabel({ email: null, accountId: null, userId: 'y' })).toBe('y');
    expect(authAccountLabel({ email: null, accountId: null, userId: null })).toBeUndefined();
    expect(authAccountLabel(null)).toBeUndefined();
  });
});

describe('authCacheKey', () => {
  it('is one entry per install — host+agent+version (unique per token)', () => {
    expect(authCacheKey('zion', 'claude', '2.1.170')).toBe('zion:claude:2.1.170');
    expect(authCacheKey('yosemite-s0', 'kimi', 'default')).toBe('yosemite-s0:kimi:default');
  });
  it('distinguishes two installs of the same account on one host', () => {
    // gmail live in 2.1.207 but revoked in 2.1.186 — different keys, no collision
    expect(authCacheKey('yosemite-s1', 'claude', '2.1.207'))
      .not.toBe(authCacheKey('yosemite-s1', 'claude', '2.1.186'));
  });
});

describe('summarizeVerdicts', () => {
  it('counts live, bad (revoked/expired), and warn (everything else)', () => {
    expect(summarizeVerdicts(['live', 'live', 'live', 'live'])).toEqual({ live: 4, bad: 0, warn: 0, total: 4 });
    // only revoked is "bad"; expired is soft (kimi/droid self-refresh on launch) -> warn
    expect(summarizeVerdicts(['live', 'revoked', 'expired', 'unverified'])).toEqual({ live: 1, bad: 1, warn: 2, total: 4 });
    expect(summarizeVerdicts(['rate_limited', 'error'])).toEqual({ live: 0, bad: 0, warn: 2, total: 2 });
    expect(summarizeVerdicts([])).toEqual({ live: 0, bad: 0, warn: 0, total: 0 });
  });
});

describe('formatCheckedAge', () => {
  const now = 1_000_000_000_000;
  it('renders seconds/minutes/hours/days', () => {
    expect(formatCheckedAge(now - 5_000, now)).toBe('5s ago');
    expect(formatCheckedAge(now - 3 * 60_000, now)).toBe('3m ago');
    expect(formatCheckedAge(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(formatCheckedAge(now - 3 * 86_400_000, now)).toBe('3d ago');
  });
  it('never goes negative for a future timestamp', () => {
    expect(formatCheckedAge(now + 5_000, now)).toBe('0s ago');
  });
});
