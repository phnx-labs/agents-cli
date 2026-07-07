import { describe, it, expect } from 'vitest';
import {
  normalizeRunStrategy,
  pickAvailableCandidate,
  pickBalancedCandidate,
  type RotateCandidate,
} from '../rotate.js';
import type { UsageSnapshot } from '../usage.js';

function usage(usedPercent: number): UsageSnapshot {
  return {
    source: 'live',
    sourceLabel: 'test',
    capturedAt: new Date('2026-04-20T00:00:00Z'),
    windows: [
      {
        key: 'session',
        label: 'Session',
        shortLabel: 'S',
        usedPercent,
        resetsAt: null,
        windowMinutes: 300,
      },
    ],
  };
}

function claudeUsage(sessionUsedPercent: number, weekUsedPercent: number, sonnetWeekUsedPercent = 0): UsageSnapshot {
  return {
    source: 'live',
    sourceLabel: 'test',
    capturedAt: new Date('2026-04-20T00:00:00Z'),
    windows: [
      {
        key: 'session',
        label: 'Session',
        shortLabel: 'S',
        usedPercent: sessionUsedPercent,
        resetsAt: null,
        windowMinutes: 300,
      },
      {
        key: 'week',
        label: 'Week',
        shortLabel: 'W',
        usedPercent: weekUsedPercent,
        resetsAt: null,
        windowMinutes: 10080,
      },
      {
        key: 'sonnet_week',
        label: 'Sonnet week',
        shortLabel: 'So',
        usedPercent: sonnetWeekUsedPercent,
        resetsAt: null,
        windowMinutes: 10080,
      },
    ],
  };
}

function cand(overrides: Partial<RotateCandidate>): RotateCandidate {
  return {
    agent: 'claude',
    version: '0.0.0',
    email: 'a@b.com',
    usageKey: null,
    usageStatus: 'available',
    usageSnapshot: null,
    authValid: true,
    lastActive: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('pickBalancedCandidate', () => {
  it('returns null when nothing is signed in', () => {
    const result = pickBalancedCandidate([
      cand({ version: '1.0.0', email: null }),
      cand({ version: '2.0.0', email: null }),
    ]);
    expect(result).toBeNull();
  });

  it('returns null when every signed-in account is out of credits', () => {
    const result = pickBalancedCandidate([
      cand({ version: '1.0.0', usageStatus: 'out_of_credits' }),
      cand({ version: '2.0.0', usageStatus: 'out_of_credits' }),
    ]);
    expect(result).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(pickBalancedCandidate([])).toBeNull();
  });

  it('always picks the only healthy candidate', () => {
    const only = cand({ version: '2.1.113', email: 'a@x.com', usageSnapshot: usage(50) });
    for (let i = 0; i < 50; i++) {
      const result = pickBalancedCandidate([only]);
      expect(result!.picked.version).toBe('2.1.113');
    }
  });

  it('excludes out-of-credits but keeps them reported', () => {
    const healthy = cand({ version: '2.1.113', lastActive: new Date('2026-04-20T10:00:00Z') });
    const dead = cand({ version: '2.1.85', usageStatus: 'out_of_credits', lastActive: new Date('2026-04-15T00:00:00Z') });

    const result = pickBalancedCandidate([healthy, dead]);
    expect(result!.picked.version).toBe('2.1.113');
    expect(result!.healthy).toHaveLength(1);
    expect(result!.excluded).toHaveLength(1);
    expect(result!.excluded[0].version).toBe('2.1.85');
  });

  it('excludes not-signed-in versions (fresh installs with no auth)', () => {
    const healthy = cand({ version: '2.1.113' });
    const notAuthed = cand({ version: '2.1.120', email: null, lastActive: null });

    const result = pickBalancedCandidate([healthy, notAuthed]);
    expect(result!.picked.version).toBe('2.1.113');
    expect(result!.excluded).toHaveLength(1);
  });

  it('excludes accounts with invalid auth tokens', () => {
    const valid = cand({ version: '2.1.110', lastActive: new Date('2026-04-20T10:00:00Z') });
    const expired = cand({ version: '2.1.112', authValid: false, lastActive: new Date('2026-04-15T00:00:00Z') });

    const result = pickBalancedCandidate([valid, expired]);
    expect(result!.picked.version).toBe('2.1.110');
    expect(result!.healthy).toHaveLength(1);
    expect(result!.excluded).toHaveLength(1);
    expect(result!.excluded[0].version).toBe('2.1.112');
  });

  it('excludes rate-limited accounts from selection', () => {
    const rateLimited = cand({ version: '2.1.113', email: 'a@x.com', usageStatus: 'rate_limited' });
    const newer = cand({ version: '2.1.112', email: 'b@x.com' });

    const result = pickBalancedCandidate([rateLimited, newer]);
    expect(result!.picked.version).toBe('2.1.112');
    expect(result!.healthy).toHaveLength(1);
    expect(result!.excluded.map((c) => c.version)).toContain('2.1.113');
  });

  it('prefers live usage windows over stale local out-of-credits flags', () => {
    const staleFlag = cand({
      version: '2.1.121',
      email: 'icloud@example.com',
      usageStatus: 'out_of_credits',
      usageSnapshot: usage(15),
      lastActive: new Date('2026-04-20T10:00:00Z'),
    });
    const busier = cand({
      version: '2.1.118',
      email: 'trp@example.com',
      usageStatus: 'available',
      usageSnapshot: usage(95),
      lastActive: new Date('2026-04-15T00:00:00Z'),
    });

    // Both eligible — stale flag overridden by live snapshot at 15% used.
    const result = pickBalancedCandidate([staleFlag, busier]);
    expect(result!.healthy).toHaveLength(2);
    expect(result!.healthy.map((c) => c.version).sort()).toEqual(['2.1.118', '2.1.121']);
  });

  it('excludes accounts whose live usage windows are exhausted', () => {
    const exhausted = cand({ version: '2.1.113', email: 'a@x.com', usageSnapshot: usage(100) });
    const available = cand({ version: '2.1.112', email: 'b@x.com', usageSnapshot: usage(60) });

    const result = pickBalancedCandidate([exhausted, available]);
    expect(result!.picked.version).toBe('2.1.112');
    expect(result!.excluded.map((c) => c.version)).toContain('2.1.113');
  });

  it('weights selection by remaining capacity — fresher account wins more often', () => {
    // 10% used vs 90% used → weights 90 vs 10. Over 2000 trials, 10%-used
    // should win ~9× more often than 90%-used. Allow generous tolerance.
    const fresh = cand({ version: '2.1.113', email: 'a@x.com', usageSnapshot: usage(10) });
    const tired = cand({ version: '2.1.112', email: 'b@x.com', usageSnapshot: usage(90) });

    const counts: Record<string, number> = { '2.1.113': 0, '2.1.112': 0 };
    const iterations = 2000;
    for (let i = 0; i < iterations; i++) {
      const result = pickBalancedCandidate([fresh, tired]);
      counts[result!.picked.version] += 1;
    }
    // Expected: fresh wins ~90% of trials. Allow [80%, 95%].
    const freshRatio = counts['2.1.113'] / iterations;
    expect(freshRatio).toBeGreaterThan(0.8);
    expect(freshRatio).toBeLessThan(0.95);
    // Tired is still picked sometimes — never zero.
    expect(counts['2.1.112']).toBeGreaterThan(0);
  });

  it('distributes roughly evenly across equal-capacity candidates', () => {
    // Four candidates all at 0% used → equal weights → uniform random.
    const accounts = [
      { version: '2.1.110', email: 'a@x.com' },
      { version: '2.1.111', email: 'b@x.com' },
      { version: '2.1.112', email: 'c@x.com' },
      { version: '2.1.113', email: 'd@x.com' },
    ];
    const counts: Record<string, number> = {};
    for (const a of accounts) counts[a.version] = 0;

    const iterations = 2000;
    for (let i = 0; i < iterations; i++) {
      const result = pickBalancedCandidate(
        accounts.map((a) => cand({ version: a.version, email: a.email, usageSnapshot: usage(0) })),
      );
      counts[result!.picked.version] += 1;
    }

    // Expected: ~25% each. Allow [15%, 35%].
    for (const a of accounts) {
      const ratio = counts[a.version] / iterations;
      expect(ratio).toBeGreaterThan(0.15);
      expect(ratio).toBeLessThan(0.35);
    }
  });

  it('still picks a near-exhausted-but-eligible account occasionally', () => {
    // 99% used has weight 1; 0% used has weight 100. The 99% account should
    // be picked roughly 1% of the time — small but nonzero.
    const almost = cand({ version: '2.1.113', email: 'a@x.com', usageSnapshot: usage(99) });
    const fresh = cand({ version: '2.1.112', email: 'b@x.com', usageSnapshot: usage(0) });

    const counts: Record<string, number> = { '2.1.113': 0, '2.1.112': 0 };
    const iterations = 5000;
    for (let i = 0; i < iterations; i++) {
      const result = pickBalancedCandidate([almost, fresh]);
      counts[result!.picked.version] += 1;
    }
    // Sanity: never zero. The fresh one dominates but we don't starve the other.
    expect(counts['2.1.113']).toBeGreaterThan(0);
    expect(counts['2.1.112']).toBeGreaterThan(counts['2.1.113'] * 10);
  });

  it('uses the highest non-session window for capacity weighting', () => {
    // session=100 should NOT exclude the candidate or zero its weight; weekly
    // is what matters for routing. A high session% with low week% remains a
    // valid, high-weight pick.
    const sessionMaxed = cand({
      version: '2.1.112',
      email: 'icloud@example.com',
      usageSnapshot: claudeUsage(100, 15, 0),
      lastActive: new Date('2026-04-20T10:00:00Z'),
    });
    const weeklyBusy = cand({
      version: '2.1.110',
      email: 'trp@example.com',
      usageSnapshot: claudeUsage(15, 80, 7),
      lastActive: new Date('2026-04-15T00:00:00Z'),
    });

    // sessionMaxed: routing usage = max(15, 0) = 15 → weight 85
    // weeklyBusy:    routing usage = max(80, 7) = 80 → weight 20
    // Expected: sessionMaxed wins ~85/(85+20) = 81% of trials.
    const counts: Record<string, number> = { '2.1.112': 0, '2.1.110': 0 };
    const iterations = 2000;
    for (let i = 0; i < iterations; i++) {
      const result = pickBalancedCandidate([sessionMaxed, weeklyBusy]);
      counts[result!.picked.version] += 1;
    }
    const sessionMaxedRatio = counts['2.1.112'] / iterations;
    expect(sessionMaxedRatio).toBeGreaterThan(0.7);
    expect(sessionMaxedRatio).toBeLessThan(0.92);
  });

  it('dedupes by email — same account on two versions collapses to one candidate', () => {
    // user-a@example.com installed under 2.1.118 and 2.1.110. Without dedup,
    // weighted random could pick 2.1.118 OR 2.1.110 even though they're the
    // same Anthropic account — both calls would land on the same quota.
    const a = cand({ version: '2.1.110', email: 'user-a@example.com', lastActive: new Date('2026-04-20T10:00:00Z') });
    const b = cand({ version: '2.1.118', email: 'user-a@example.com', lastActive: new Date('2026-04-20T05:00:00Z') });
    const c = cand({ version: '2.1.111', email: 'other@x.com', lastActive: new Date('2026-04-20T08:00:00Z') });

    const result = pickBalancedCandidate([a, b, c]);
    expect(result!.healthy).toHaveLength(2);
    const emails = result!.healthy.map((x) => x.email).sort();
    expect(emails).toEqual(['other@x.com', 'user-a@example.com']);
    // The duplicate (newer of the two user-a@example.com versions) lands in excluded.
    expect(result!.excluded.map((x) => x.version)).toContain('2.1.110');
    // Among the user-a@example.com versions, the older lastActive wins.
    const survivor = result!.healthy.find((x) => x.email === 'user-a@example.com');
    expect(survivor!.version).toBe('2.1.118');
  });

  it('keeps two orgs under one email as distinct candidates (dedup by org, not email)', () => {
    // Same Google identity signed into a Personal org on one version and an
    // Enterprise org on another. Quota is per-org, so these are separate
    // rate-limit buckets and must both stay healthy — the email collision is
    // not an account collision. Regression for #309.
    const personal = cand({
      version: '2.1.170',
      email: 'taylor@example.com',
      usageKey: 'claude:org=e93db6f2',
      usageSnapshot: claudeUsage(0, 0),
    });
    const enterprise = cand({
      version: '2.1.183',
      email: 'taylor@example.com',
      usageKey: 'claude:org=8763a87b',
      usageSnapshot: claudeUsage(0, 64),
    });

    const result = pickBalancedCandidate([personal, enterprise]);
    expect(result!.healthy).toHaveLength(2);
    expect(result!.excluded).toHaveLength(0);
    expect(result!.healthy.map((c) => c.version).sort()).toEqual(['2.1.170', '2.1.183']);
  });

  it('still collapses two versions sharing one org (same usage key)', () => {
    // Two installed versions, same org → same quota bucket → must dedup to one
    // even though they are distinct versions. The lower-used / older-active one
    // survives per compareCandidates.
    const a = cand({
      version: '2.1.170',
      email: 'taylor@example.com',
      usageKey: 'claude:org=e93db6f2',
      lastActive: new Date('2026-04-20T10:00:00Z'),
    });
    const b = cand({
      version: '2.1.183',
      email: 'taylor@example.com',
      usageKey: 'claude:org=e93db6f2',
      lastActive: new Date('2026-04-20T05:00:00Z'),
    });

    const result = pickBalancedCandidate([a, b]);
    expect(result!.healthy).toHaveLength(1);
    expect(result!.excluded).toHaveLength(1);
    // Older lastActive wins (compareCandidates tiebreak), newer is excluded.
    expect(result!.healthy[0].version).toBe('2.1.183');
    expect(result!.excluded[0].version).toBe('2.1.170');
  });

  it('parallel selection fans out across unique accounts even when versions share emails', () => {
    // 6 versions, 5 unique accounts. After dedup, 5 candidates with equal
    // capacity (no usage data) get ~20% each.
    const candidates = [
      { version: '2.1.118', email: 'user-a@example.com' },
      { version: '2.1.110', email: 'user-a@example.com' },
      { version: '2.1.113', email: 'user-b@example.com' },
      { version: '2.1.112', email: 'user-c@example.com' },
      { version: '2.1.111', email: 'user-d@example.org' },
      { version: '2.1.109', email: 'user-e@example.org' },
    ];
    const emailCounts: Record<string, number> = {};
    const iterations = 2500;
    for (let i = 0; i < iterations; i++) {
      const result = pickBalancedCandidate(
        candidates.map((c) => cand({ version: c.version, email: c.email, usageSnapshot: usage(0) })),
      );
      const email = result!.picked.email!;
      emailCounts[email] = (emailCounts[email] ?? 0) + 1;
    }

    // 5 unique accounts → expected ~20% each. Allow each to land within [10%, 35%].
    expect(Object.keys(emailCounts)).toHaveLength(5);
    for (const email of Object.keys(emailCounts)) {
      const ratio = emailCounts[email] / iterations;
      expect(ratio).toBeGreaterThan(0.1);
      expect(ratio).toBeLessThan(0.35);
    }
  });
});

describe('pickAvailableCandidate', () => {
  it('prefers the pinned version when it has usage available', () => {
    const preferred = cand({ version: '2.1.113', email: 'a@x.com', lastActive: new Date('2026-04-20T10:00:00Z') });
    const older = cand({ version: '2.1.112', email: 'b@x.com', lastActive: new Date('2026-04-15T10:00:00Z') });

    const result = pickAvailableCandidate([older, preferred], '2.1.113');
    expect(result!.picked.version).toBe('2.1.113');
  });

  it('switches away from the pinned version when it is rate limited', () => {
    const preferred = cand({ version: '2.1.113', email: 'a@x.com', usageStatus: 'rate_limited' });
    const available = cand({ version: '2.1.112', email: 'b@x.com', usageStatus: 'available' });

    const result = pickAvailableCandidate([preferred, available], '2.1.113');
    expect(result!.picked.version).toBe('2.1.112');
    expect(result!.excluded.map((candidate) => candidate.version)).toContain('2.1.113');
  });

  it('keeps the pinned version when live usage still has headroom', () => {
    const preferred = cand({
      version: '2.1.121',
      email: 'icloud@example.com',
      usageStatus: 'out_of_credits',
      usageSnapshot: usage(15),
    });
    const alternative = cand({
      version: '2.1.118',
      email: 'trp@example.com',
      usageStatus: 'available',
      usageSnapshot: usage(30),
    });

    const result = pickAvailableCandidate([preferred, alternative], '2.1.121');
    expect(result!.picked.version).toBe('2.1.121');
    expect(result!.excluded).toHaveLength(0);
  });

  it('returns null when no signed-in account has usage available', () => {
    const result = pickAvailableCandidate([
      cand({ version: '2.1.113', usageStatus: 'rate_limited' }),
      cand({ version: '2.1.112', usageStatus: 'out_of_credits' }),
    ], '2.1.113');

    expect(result).toBeNull();
  });
});

describe('normalizeRunStrategy', () => {
  it('accepts supported strategies', () => {
    expect(normalizeRunStrategy('pinned')).toBe('pinned');
    expect(normalizeRunStrategy('available')).toBe('available');
    expect(normalizeRunStrategy('balanced')).toBe('balanced');
  });

  it('aliases the deprecated `rotate` to `balanced` for backward compat', () => {
    expect(normalizeRunStrategy('rotate')).toBe('balanced');
  });

  it('rejects unknown strategies', () => {
    expect(normalizeRunStrategy('version_policy')).toBeNull();
    expect(normalizeRunStrategy(null)).toBeNull();
  });
});
