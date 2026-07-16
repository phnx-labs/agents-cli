import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountInfo } from '../agents.js';
import * as state from '../state.js';
import {
  buildCanonicalUsageContext,
  deriveUsageStatusFromSnapshot,
  formatUsageSummary,
  formatUsageStatusBadge,
  getClaudeKeychainService,
  loadClaudeOauth,
  getUsageInfoForIdentity,
  readClaudeUsageCache,
  isClaudeUsageOrgMatch,
  writeClaudeUsageCache,
  normalizeKimiWindows,
  formatKimiPlan,
  normalizeDroidWindows,
  type DroidBillingLimitsResponse,
  type KimiUsagesResponse,
  type UsageSnapshot,
  type UsageWindow,
} from '../usage.js';
import { deleteKeychainToken, setKeychainToken } from '../secrets/index.js';

function makeAccountInfo(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    accountKey: null,
    usageKey: null,
    accountId: null,
    organizationId: null,
    userId: null,
    email: null,
    plan: null,
    usageStatus: null,
    overageCredits: null,
    lastActive: null,
    signedIn: false,
    ...overrides,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('usage formatting', () => {
  it('renders compact S:/W: bars and skips the sonnet-only window', () => {
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-04-17T12:00:00Z'),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 40,
          resetsAt: null,
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 80,
          resetsAt: null,
          windowMinutes: 10080,
        },
        {
          key: 'sonnet_week',
          label: 'Current week (Sonnet only)',
          shortLabel: 'So',
          usedPercent: 55,
          resetsAt: null,
          windowMinutes: 10080,
        },
      ],
    };

    const summary = stripAnsi(formatUsageSummary(null, snapshot));

    expect(summary).toContain('S:');
    expect(summary).toContain('W:');
    expect(summary).not.toContain('So:');
  });

  it('formatUsageStatusBadge renders only for throttled states', () => {
    expect(formatUsageStatusBadge(null)).toBe('');
    expect(formatUsageStatusBadge('available')).toBe('');
    expect(stripAnsi(formatUsageStatusBadge('rate_limited'))).toBe('rate-limited');
    expect(stripAnsi(formatUsageStatusBadge('out_of_credits'))).toBe('out of credits');
  });
});

describe('deriveUsageStatusFromSnapshot', () => {
  function win(key: UsageWindow['key'], usedPercent: number): UsageWindow {
    return {
      key,
      label: key,
      shortLabel: key === 'week' ? 'W' : key === 'session' ? 'S' : 'So',
      usedPercent,
      resetsAt: null,
      windowMinutes: null,
    };
  }
  function snap(windows: UsageWindow[]): UsageSnapshot {
    return { source: 'live', sourceLabel: 'live account data', capturedAt: new Date('2026-04-17T12:00:00Z'), windows };
  }

  it('returns null when there is no snapshot or no windows', () => {
    expect(deriveUsageStatusFromSnapshot(null)).toBeNull();
    expect(deriveUsageStatusFromSnapshot(undefined)).toBeNull();
    expect(deriveUsageStatusFromSnapshot(snap([]))).toBeNull();
  });

  it('is available when every blocking window is below 100%', () => {
    expect(deriveUsageStatusFromSnapshot(snap([win('session', 5), win('week', 5)]))).toBe('available');
  });

  it('is rate_limited when any blocking window is maxed', () => {
    expect(deriveUsageStatusFromSnapshot(snap([win('session', 100), win('week', 40)]))).toBe('rate_limited');
    expect(deriveUsageStatusFromSnapshot(snap([win('session', 10), win('week', 100)]))).toBe('rate_limited');
  });

  it('ignores a maxed sonnet_week sub-limit when other windows are fine', () => {
    expect(
      deriveUsageStatusFromSnapshot(snap([win('session', 10), win('week', 20), win('sonnet_week', 100)]))
    ).toBe('available');
  });

  it('does not regress to "out of credits" for a usable account with overage disabled', () => {
    // The real-world bug: a Pro account at 5% weekly usage whose pay-as-you-go
    // overage is disabled must read as available, never out_of_credits.
    expect(deriveUsageStatusFromSnapshot(snap([win('session', 2), win('week', 5)]))).toBe('available');
  });
});

describe('usage identity deduping', () => {
  it('keeps only the freshest version home per usage identity', () => {
    const older = makeAccountInfo({
      usageKey: 'claude:org=shared',
      accountKey: 'claude:account=one',
      organizationId: 'org-old',
      plan: 'Pro',
      lastActive: new Date('2026-04-17T10:00:00Z'),
    });
    const newer = makeAccountInfo({
      usageKey: 'claude:org=shared',
      accountKey: 'claude:account=two',
      organizationId: 'org-new',
      plan: 'Max',
      lastActive: new Date('2026-04-17T11:00:00Z'),
    });
    const fallback = makeAccountInfo({
      usageKey: null,
      accountKey: 'codex:account=fallback',
      organizationId: 'org-codex',
      lastActive: new Date('2026-04-17T09:00:00Z'),
    });

    const { canonicalByUsageKey, usageFetchInputs } = buildCanonicalUsageContext([
      {
        agentId: 'claude',
        home: '/tmp/old',
        cliVersion: '2.1.80',
        info: older,
      },
      {
        agentId: 'claude',
        home: '/tmp/new',
        cliVersion: '2.1.98',
        info: newer,
      },
      {
        agentId: 'codex',
        home: '/tmp/codex',
        cliVersion: '0.113.0',
        info: fallback,
      },
    ]);

    expect(canonicalByUsageKey.size).toBe(2);
    expect(canonicalByUsageKey.get('claude:org=shared')).toEqual(newer);
    expect(canonicalByUsageKey.get('codex:account=fallback')).toEqual(fallback);
    expect(usageFetchInputs.get('claude:org=shared')).toEqual({
      agentId: 'claude',
      home: '/tmp/new',
      cliVersion: '2.1.98',
      organizationId: 'org-new',
    });
    expect(usageFetchInputs.get('codex:account=fallback')).toEqual({
      agentId: 'codex',
      home: '/tmp/codex',
      cliVersion: '0.113.0',
      organizationId: 'org-codex',
    });
  });
});

describe('Claude usage scoping', () => {
  const previousPassphrase = process.env.AGENTS_SECRETS_PASSPHRASE;

  afterEach(() => {
    if (previousPassphrase === undefined) delete process.env.AGENTS_SECRETS_PASSPHRASE;
    else process.env.AGENTS_SECRETS_PASSPHRASE = previousPassphrase;
  });

  it('uses the shared keychain service without a managed home', () => {
    expect(getClaudeKeychainService()).toBe('Claude Code-credentials');
  });

  it('derives distinct keychain services for distinct Claude homes', () => {
    const first = getClaudeKeychainService('/tmp/claude-a');
    const second = getClaudeKeychainService('/tmp/claude-b');

    expect(first).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(second).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it('does not reuse the shared keychain service for managed Claude homes', () => {
    expect(getClaudeKeychainService('/tmp/claude-a')).not.toBe('Claude Code-credentials');
  });

  it('ignores malformed keychain payloads without an access token', async () => {
    process.env.AGENTS_SECRETS_PASSPHRASE = 'usage-test-passphrase';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-oauth-'));
    const service = getClaudeKeychainService(home);
    setKeychainToken(service, JSON.stringify({ claudeAiOauth: { refreshToken: 'refresh-only' } }));

    try {
      await expect(loadClaudeOauth(home)).resolves.toBeNull();
    } finally {
      try { deleteKeychainToken(service); } catch {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // Linux/CI-scoped regression guard for `agents view --host <linux>`: the fallback
  // exists because a headless Linux Claude CLI writes its OAuth to .credentials.json
  // instead of a keychain. On Windows CI loadClaudeOauth returns undefined here (a
  // runner-environment divergence, not a product path this test targets), so assert
  // it only where it's meaningful — matching the posix-only stance in mailboxes.test.ts.
  it.skipIf(process.platform === 'win32')('falls back to <home>/.claude/.credentials.json when the keychain has no item (Linux/CI)', async () => {
    // A fresh temp home yields a unique hashed keychain service, so the keychain
    // read misses and loadClaudeOauth must fall back to the file the Linux Claude
    // CLI writes. This is the regression guard for `agents view --host <linux>`
    // rendering no usage bars.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-oauth-file-'));
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'file-token',
          refreshToken: 'file-refresh',
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
      })
    );

    try {
      const oauth = await loadClaudeOauth(home);
      expect(oauth?.accessToken).toBe('file-token');
      expect(oauth?.refreshToken).toBe('file-refresh');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps usage eligible when the live org is missing', () => {
    expect(isClaudeUsageOrgMatch('org-requested', null)).toBe(true);
  });

  it('rejects usage only when both org ids exist and mismatch', () => {
    expect(isClaudeUsageOrgMatch('org-requested', 'org-live')).toBe(false);
    expect(isClaudeUsageOrgMatch('org-requested', 'org-requested')).toBe(true);
  });
});

describe('Claude usage cache', () => {
  it('persists and reloads the last seen live snapshot by usage key', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-cache-'));
    const cachePath = path.join(tempDir, 'claude-usage.json');
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-04-17T12:00:00Z'),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 40,
          resetsAt: new Date('2026-04-17T16:00:00Z'),
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 80,
          resetsAt: new Date('2026-04-23T12:00:00Z'),
          windowMinutes: 10080,
        },
      ],
    };

    try {
      writeClaudeUsageCache('claude:org=shared', snapshot, cachePath);
      const cached = readClaudeUsageCache(
        'claude:org=shared',
        cachePath,
        new Date('2026-04-17T13:00:00Z')
      );

      expect(cached?.source).toBe('last_seen');
      expect(cached?.sourceLabel).toBe('last seen live account data');
      expect(cached?.windows.map((window) => window.shortLabel)).toEqual(['S', 'W']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('SWR: fresh cache (<2 min) is returned with no network call', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-swr-'));
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('fetch must not be called on fresh cache');
    }) as typeof globalThis.fetch;
    vi.spyOn(state, 'getCacheDir').mockReturnValue(tmpDir);

    try {
      const snapshot: UsageSnapshot = {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(Date.now() - 30_000), // 30 s old — fresh.
        windows: [
          { key: 'session', label: 'S', shortLabel: 'S', usedPercent: 10, resetsAt: null, windowMinutes: 300 },
        ],
      };
      writeClaudeUsageCache('claude:org=swr-fresh', snapshot);

      const result = await getUsageInfoForIdentity({
        agentId: 'claude',
        info: makeAccountInfo({ usageKey: 'claude:org=swr-fresh' }),
      });

      expect(result.error).toBeNull();
      expect(result.snapshot?.windows[0]?.usedPercent).toBe(10);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('SWR: stale cache (>2 min, <24 h) returns the cached snapshot instantly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-swr-'));
    vi.spyOn(state, 'getCacheDir').mockReturnValue(tmpDir);

    try {
      const snapshot: UsageSnapshot = {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min old — stale but within SWR.
        windows: [
          { key: 'session', label: 'S', shortLabel: 'S', usedPercent: 42, resetsAt: null, windowMinutes: 300 },
        ],
      };
      writeClaudeUsageCache('claude:org=swr-stale', snapshot);

      const t0 = Date.now();
      const result = await getUsageInfoForIdentity({
        agentId: 'claude',
        info: makeAccountInfo({ usageKey: 'claude:org=swr-stale' }),
      });
      const elapsedMs = Date.now() - t0;

      // The foreground must NOT block on any I/O — not network, not the
      // synchronous `security` CLI call that loadClaudeOauth makes under
      // the hood. The fix is that triggerBackgroundUsageRefresh defers its
      // entire body to setImmediate, so the caller returns before any of
      // that runs. 100 ms is a generous ceiling for the in-process cache
      // read + serialization.
      expect(elapsedMs).toBeLessThan(100);
      expect(result.error).toBeNull();
      expect(result.snapshot?.windows[0]?.usedPercent).toBe(42);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resets expired cached windows to 0%', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-usage-cache-'));
    const cachePath = path.join(tempDir, 'claude-usage.json');
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-04-17T12:00:00Z'),
      windows: [
        {
          key: 'session',
          label: 'Current session',
          shortLabel: 'S',
          usedPercent: 40,
          resetsAt: new Date('2026-04-17T13:00:00Z'),
          windowMinutes: 300,
        },
        {
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 80,
          resetsAt: new Date('2026-04-23T12:00:00Z'),
          windowMinutes: 10080,
        },
      ],
    };

    try {
      writeClaudeUsageCache('claude:org=shared', snapshot, cachePath);
      const cached = readClaudeUsageCache(
        'claude:org=shared',
        cachePath,
        new Date('2026-04-17T14:00:00Z')
      );

      expect(cached?.windows.map((window) => window.shortLabel)).toEqual(['S', 'W']);
      expect(cached?.windows.find((w) => w.shortLabel === 'S')?.usedPercent).toBe(0);
      expect(cached?.windows.find((w) => w.shortLabel === 'W')?.usedPercent).toBe(80);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('normalizeKimiWindows', () => {
  // A real /usages response body captured live from api.kimi.com. Numbers arrive
  // as strings; the short limit is a 300-minute bucket, and `usage` is the
  // rolling account quota.
  const payload: KimiUsagesResponse = {
    user: { userId: 'd483kfq783mkn8of1gtg', membership: { level: 'LEVEL_INTERMEDIATE' } },
    usage: { limit: '100', used: '1', remaining: '99', resetTime: '2026-07-06T03:47:50.921944Z' },
    limits: [
      {
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', used: '4', remaining: '96', resetTime: '2026-07-01T13:47:50.921944Z' },
      },
    ],
    subType: 'TYPE_PURCHASE',
  };

  it('maps the 300-minute limit to a session bar and the rolling quota to a week bar', () => {
    const windows = normalizeKimiWindows(payload);
    expect(windows.map((w) => w.shortLabel)).toEqual(['S', 'W']);
    const session = windows.find((w) => w.key === 'session')!;
    const week = windows.find((w) => w.key === 'week')!;
    // used/limit as a percentage: 4/100 and 1/100.
    expect(session.usedPercent).toBe(4);
    expect(week.usedPercent).toBe(1);
    // 300-minute window (TIME_UNIT_MINUTE) carries through as-is.
    expect(session.windowMinutes).toBe(300);
    expect(session.resetsAt?.toISOString()).toBe('2026-07-01T13:47:50.921Z');
  });

  it('drops a bucket with a zero or missing limit rather than dividing by zero', () => {
    const windows = normalizeKimiWindows({
      usage: { limit: '0', used: '5' },
      limits: [{ detail: { used: '4' } }], // no limit
    });
    expect(windows).toEqual([]);
  });

  it('derives the plan label from the membership tier, falling back to subType', () => {
    expect(formatKimiPlan(payload)).toBe('Intermediate');
    expect(formatKimiPlan({ subType: 'TYPE_PURCHASE' })).toBe('Purchase');
    expect(formatKimiPlan({})).toBeNull();
  });
});

describe('normalizeDroidWindows', () => {
  // The shape droid itself consumes from GET /api/billing/limits: token-rate-
  // limit billing exposes fiveHour/weekly/monthly windows, each with a
  // usedPercent and a windowEnd timestamp.
  const payload: DroidBillingLimitsResponse = {
    usesTokenRateLimitsBilling: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 12, windowEnd: '2026-07-15T18:00:00.000Z' },
        weekly: { usedPercent: 34, windowEnd: '2026-07-20T00:00:00.000Z' },
        monthly: { usedPercent: 5, windowEnd: '2026-08-01T00:00:00.000Z' },
      },
    },
  };

  it('maps fiveHour/weekly/monthly to session, week, and month windows', () => {
    const windows = normalizeDroidWindows(payload);
    expect(windows.map((w) => w.shortLabel)).toEqual(['S', 'W', 'M']);
    const session = windows.find((w) => w.key === 'session')!;
    const week = windows.find((w) => w.key === 'week')!;
    const month = windows.find((w) => w.key === 'month')!;
    expect(session.usedPercent).toBe(12);
    expect(week.usedPercent).toBe(34);
    expect(month.usedPercent).toBe(5);
    expect(session.windowMinutes).toBe(300);
    expect(month.windowMinutes).toBe(43200);
    expect(session.resetsAt?.toISOString()).toBe('2026-07-15T18:00:00.000Z');
  });

  it('renders nothing for orgs on the legacy billing model', () => {
    expect(normalizeDroidWindows({ ...payload, usesTokenRateLimitsBilling: false })).toEqual([]);
    expect(normalizeDroidWindows({ ...payload, usesTokenRateLimitsBilling: undefined })).toEqual([]);
  });

  it('renders nothing when limits.standard is missing', () => {
    expect(normalizeDroidWindows({ usesTokenRateLimitsBilling: true })).toEqual([]);
    expect(normalizeDroidWindows({ usesTokenRateLimitsBilling: true, limits: {} })).toEqual([]);
  });

  it('drops a window without a numeric usedPercent and clamps out-of-range values', () => {
    const windows = normalizeDroidWindows({
      usesTokenRateLimitsBilling: true,
      limits: {
        standard: {
          fiveHour: { windowEnd: '2026-07-15T18:00:00.000Z' }, // no usedPercent
          weekly: { usedPercent: 250 },
        },
      },
    });
    expect(windows.map((w) => w.key)).toEqual(['week']);
    expect(windows[0].usedPercent).toBe(100);
  });

  it('keeps the month window out of the compact summary but in the snapshot', () => {
    const snapshot: UsageSnapshot = {
      source: 'live',
      sourceLabel: 'live account data',
      capturedAt: new Date('2026-07-15T12:00:00Z'),
      windows: normalizeDroidWindows(payload),
    };
    const summary = stripAnsi(formatUsageSummary(null, snapshot));
    expect(summary).toContain('S:');
    expect(summary).toContain('W:');
    expect(summary).not.toContain('M:');
    // ...but an exhausted month window still flips the account to rate-limited.
    const exhausted = normalizeDroidWindows({
      ...payload,
      limits: { standard: { ...payload.limits!.standard, monthly: { usedPercent: 100 } } },
    });
    expect(deriveUsageStatusFromSnapshot({ ...snapshot, windows: exhausted })).toBe('rate_limited');
  });
});
