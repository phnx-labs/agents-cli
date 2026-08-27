import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  accountColumnLabel,
  allowInteractiveUsageLogin,
  compareAccountOrderedVersions,
  joinViewColumns,
  pruneGroupKey,
  viewUsageSummaryOptions,
  type AccountOrderedVersion,
} from './view.js';
import {
  formatUsageSummary,
  readClaudeUsageCache,
  setClaudeUsageCachePathForTest,
  writeClaudeUsageCache,
  usageExpiredKimiCredentialError,
  USAGE_BENIGN_STATE,
  type UsageInfo,
} from '../lib/accounting/usage.js';
import { padToWidth, stringWidth } from '../lib/session/width.js';

describe('joinViewColumns — fixed multi-agent layout', () => {
  it('keeps the unlabeled last-active timestamp aligned when status is empty', () => {
    const wVer = 18;
    const wModel = 8;
    const wEmail = 10;
    const wUsage = 22;
    const wStatus = 12;
    const wActive = 18;

    const row = (
      ver: string,
      model: string,
      email: string,
      usage: string,
      status: string,
      active: string,
    ) =>
      joinViewColumns([
        padToWidth(ver, wVer),
        padToWidth(model, wModel),
        padToWidth(email, wEmail),
        padToWidth(usage, wUsage),
        padToWidth(status, wStatus),
        padToWidth(active, wActive),
      ]);

    const rateLimited = row(
      '2.1.220 (default)',
      'default',
      'a@x.com',
      'Max  S: 100%',
      'rate-limited',
      '8h ago',
    );
    const healthy = row(
      '2.1.219',
      'default',
      'b@y.com',
      'Max  S: 5%',
      '',
      '2m ago',
    );
    expect(rateLimited.indexOf('8h ago')).toBe(healthy.indexOf('2m ago'));
    expect(rateLimited).not.toContain('auth');
    expect(healthy).not.toContain('auth');
    // Both rows stay within a sane terminal width after the overview meter cap.
    expect(stringWidth(rateLimited)).toBeLessThanOrEqual(120);
    expect(stringWidth(healthy)).toBe(stringWidth(rateLimited));
  });

  it('drops only trailing empty columns', () => {
    expect(joinViewColumns(['ver', 'model', '', ''])).toBe('ver  model');
    expect(joinViewColumns(['ver', '', 'acct'])).toBe('ver    acct');
  });
});

describe('viewUsageSummaryOptions — truthful unavailable states', () => {
  it.each(['codex', 'grok', 'muse'] as const)(
    'renders no recent usage truthfully for a signed-in %s account',
    (agentId) => {
      const usageInfo: UsageInfo = {
        snapshot: null,
        error: null,
        [USAGE_BENIGN_STATE]: 'no-recent-usage',
      };
      const opts = viewUsageSummaryOptions(agentId, true, usageInfo, 2);

      expect(opts.unavailable).toBe(false);
      expect(formatUsageSummary(null, usageInfo.snapshot, 3, opts)).toBe(
        agentId === 'grok' ? 'run grok once to refresh usage' : 'no usage recorded yet',
      );
    },
  );

  it('names the exact Grok version that must emit a fresh billing event', () => {
    const usageInfo: UsageInfo = {
      snapshot: null,
      error: null,
      [USAGE_BENIGN_STATE]: 'no-recent-usage',
    };
    const opts = viewUsageSummaryOptions('grok', true, usageInfo, 2, '0.2.118');
    expect(formatUsageSummary(null, null, 3, opts)).toBe(
      'run grok@0.2.118 once to refresh usage',
    );
  });

  it('renders the specific usage error for a signed-in usage-capable harness', () => {
    const error = 'Claude credential expired; re-authentication required for usage.';
    const opts = viewUsageSummaryOptions('claude', true, { snapshot: null, error }, 2);

    expect(formatUsageSummary(null, null, 3, opts)).toBe('re-auth for usage');
  });

  it('renders "run Kimi once" for an expired Kimi credential (RUSH-3198)', () => {
    const error = usageExpiredKimiCredentialError();
    const opts = viewUsageSummaryOptions('kimi', true, { snapshot: null, error }, 2);

    expect(formatUsageSummary(null, null, 3, opts)).toBe('run Kimi once');
    expect(error).toContain('run Kimi once');
    expect(error).not.toContain('re-auth');
  });

  it('renders an unavailable state for a globally installed signed-in harness', () => {
    const error = 'Codex usage is rate-limiting the usage endpoint; not retrying for 13 minutes.';
    const opts = viewUsageSummaryOptions('codex', true, { snapshot: null, error }, 2);

    expect(opts.unavailable).toBe(true);
    expect(formatUsageSummary(null, null, 3, opts)).toBe('rate-limited (retry ~13 minutes)');
  });

  it('keeps the usage column blank for a harness with no usage concept', () => {
    const error = 'usage read failed: unavailable';
    const opts = viewUsageSummaryOptions('opencode', true, { snapshot: null, error }, 2);

    expect(opts.unavailable).toBe(false);
    expect(formatUsageSummary(null, null, 3, opts)).toBe('');
  });

  it('renders the cached plan for a meterless harness instead of "usage unavailable"', () => {
    // Drives the REAL read path the plain, non-refreshing `agents view` uses:
    // the row `--refresh` wrote goes through readClaudeUsageCache and into the
    // renderer. Before the deserializer kept plan-only rows this read returned
    // null and the row rendered "usage unavailable" — the reported bug.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-view-planonly-'));
    const prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
    try {
      const usageKey = 'grok:user=view-plan-only-test:org=view-plan-only-org';
      writeClaudeUsageCache(usageKey, {
        source: 'live',
        sourceLabel: 'live',
        capturedAt: new Date(),
        plan: 'SuperGrok Heavy',
        windows: [],
      });

      const usageInfo: UsageInfo = { snapshot: readClaudeUsageCache(usageKey), error: null };
      const opts = viewUsageSummaryOptions('grok', true, usageInfo, 2);

      expect(opts.unavailable).toBe(false);
      expect(formatUsageSummary(usageInfo.snapshot?.plan ?? null, usageInfo.snapshot, 3, opts))
        .toBe('SuperGrok Heavy');
    } finally {
      setClaudeUsageCachePathForTest(prevPath);
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('accountColumnLabel — organization suffix', () => {
  it('appends the org NAME (identity) for a Team seat — the tier shows in the plan column', () => {
    expect(accountColumnLabel({
      email: 'taylor@example.com',
      accountId: null,
      signedIn: true,
      organizationType: 'claude_team',
      organizationName: 'Turing Labs',
    })).toBe('taylor@example.com (Turing Labs)');
  });

  it('renders the bare email for a personal Max plan — no badge, tier is in the plan column', () => {
    expect(accountColumnLabel({
      email: 'taylor@example.com',
      accountId: null,
      signedIn: true,
      organizationType: 'claude_max',
      organizationName: "taylor@example.com's Organization",
    })).toBe('taylor@example.com');
  });

  it('renders the bare email when no organization type is present', () => {
    expect(accountColumnLabel({
      email: 'taylor@example.com',
      accountId: null,
      signedIn: true,
      organizationType: null,
      organizationName: null,
    })).toBe('taylor@example.com');
  });

  it('leaves the id: and signed-in branches untouched', () => {
    expect(accountColumnLabel({
      email: null,
      accountId: 'u-123',
      signedIn: true,
      organizationType: null,
      organizationName: null,
    })).toBe('id:u-123');
    expect(accountColumnLabel({
      email: null,
      accountId: null,
      signedIn: true,
      organizationType: null,
      organizationName: null,
    })).toBe('signed in');
  });

  it('renders empty when signed out', () => {
    expect(accountColumnLabel(null)).toBe('');
    expect(accountColumnLabel({
      email: null,
      accountId: null,
      signedIn: false,
      organizationType: null,
      organizationName: null,
    })).toBe('');
  });
});

describe('compareAccountOrderedVersions — human view ordering', () => {
  const sort = (rows: AccountOrderedVersion[], globalDefault: string | null): string[] =>
    [...rows]
      .sort((a, b) => compareAccountOrderedVersions(a, b, globalDefault))
      .map(({ version }) => version);

  it('keeps the global default first, then sorts emails case-insensitively', () => {
    const rows: AccountOrderedVersion[] = [
      { version: '2.1.300', email: 'beta@example.com' },
      { version: '2.1.100', email: 'zeta@example.com' },
      { version: '2.1.200', email: 'Alpha@example.com' },
    ];

    expect(sort(rows, '2.1.100')).toEqual(['2.1.100', '2.1.200', '2.1.300']);
  });

  it('places non-email rows last and keeps them version-descending', () => {
    const rows: AccountOrderedVersion[] = [
      { version: '3.0.0', email: null },
      { version: '1.0.0', email: 'alpha@example.com' },
      { version: '4.0.0', email: null },
    ];

    expect(sort(rows, null)).toEqual(['1.0.0', '4.0.0', '3.0.0']);
  });

  it('uses version-descending order when normalized emails match', () => {
    const rows: AccountOrderedVersion[] = [
      { version: '1.0.0', email: 'same@example.com' },
      { version: '2.0.0', email: 'SAME@example.com' },
    ];

    expect(sort(rows, null)).toEqual(['2.0.0', '1.0.0']);
  });
});

describe('pruneGroupKey — duplicate detection identity', () => {
  it('keeps same-email installs in different orgs in separate prune groups', () => {
    const max = pruneGroupKey({
      accountKey: 'claude:account:acc-1:org:org-personal',
      email: 'taylor@example.com',
    });
    const team = pruneGroupKey({
      accountKey: 'claude:account:acc-1:org:org-team',
      email: 'taylor@example.com',
    });
    expect(max).not.toBeNull();
    expect(max).not.toBe(team);
  });

  it('groups installs with the same accountKey together', () => {
    const a = pruneGroupKey({ accountKey: 'claude:account:acc-1:org:org-1', email: 'a@x.com' });
    const b = pruneGroupKey({ accountKey: 'claude:account:acc-1:org:org-1', email: 'A@X.COM' });
    expect(a).toBe(b);
  });

  it('falls back to the lowercased email when no accountKey exists', () => {
    expect(pruneGroupKey({ accountKey: null, email: 'Taylor@Example.com' }))
      .toBe('taylor@example.com');
  });

  it('returns null when there is no identity at all', () => {
    expect(pruneGroupKey({ accountKey: null, email: null })).toBeNull();
  });
});

describe('allowInteractiveUsageLogin — the USAGE-READ-2 role + foreground gate', () => {
  it('allows the interactive login only for a personal device at a human TTY', () => {
    expect(allowInteractiveUsageLogin('personal', true)).toBe(true);
  });

  it('rejects a personal device when output is not a TTY (piped/scripted reader)', () => {
    // A --json or piped run must never silently acquire the interactive credential,
    // even on the user's own box — role alone is not sufficient (USAGE-READ-2).
    expect(allowInteractiveUsageLogin('personal', false)).toBe(false);
  });

  it('rejects a worker device even at a TTY (RUSH-1822 guarantee: setup-token only)', () => {
    expect(allowInteractiveUsageLogin('worker', true)).toBe(false);
    expect(allowInteractiveUsageLogin('worker', false)).toBe(false);
  });

  it('rejects an unmarked device (undefined role is treated as non-personal)', () => {
    expect(allowInteractiveUsageLogin(undefined, true)).toBe(false);
    expect(allowInteractiveUsageLogin(undefined, false)).toBe(false);
  });
});
