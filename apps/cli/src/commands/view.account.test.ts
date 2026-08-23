import { describe, expect, it } from 'vitest';
import {
  accountColumnLabel,
  compareAccountOrderedVersions,
  joinViewColumns,
  pruneGroupKey,
  viewUsageSummaryOptions,
  type AccountOrderedVersion,
} from './view.js';
import { formatUsageSummary } from '../lib/accounting/usage.js';
import { padToWidth, stringWidth } from '../lib/session/width.js';

describe('joinViewColumns — fixed multi-agent layout', () => {
  it('keeps the auth chip at the same column when status is empty', () => {
    // The multi-agent misalignment bug: skipping empty status mid-row shifted
    // lastActive/auth left. Fixed columns pad empties so gutters match.
    const wVer = 18;
    const wModel = 8;
    const wEmail = 10;
    const wUsage = 22;
    const wStatus = 12;
    const wActive = 10;

    const row = (
      ver: string,
      model: string,
      email: string,
      usage: string,
      status: string,
      active: string,
      auth: string,
    ) =>
      joinViewColumns([
        padToWidth(ver, wVer),
        padToWidth(model, wModel),
        padToWidth(email, wEmail),
        padToWidth(usage, wUsage),
        padToWidth(status, wStatus),
        padToWidth(active, wActive),
        auth,
      ]);

    const rateLimited = row(
      '2.1.220 (default)',
      'default',
      'a@x.com',
      'Max  S: 100%',
      'rate-limited',
      '8h ago',
      '○ 1m ago',
    );
    const healthy = row(
      '2.1.219',
      'default',
      'b@y.com',
      'Max  S: 5%',
      '',
      '2m ago',
      '● 1m ago',
    );

    const authAt = (line: string): number => {
      const m = line.match(/[●○◐]/);
      return m?.index ?? -1;
    };
    expect(authAt(rateLimited)).toBeGreaterThan(0);
    expect(authAt(healthy)).toBe(authAt(rateLimited));
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
  it('renders the specific usage error for a signed-in usage-capable harness', () => {
    const error = 'Claude credential expired; re-authentication required for usage.';
    const opts = viewUsageSummaryOptions('claude', true, { snapshot: null, error }, 2);

    expect(formatUsageSummary(null, null, 3, opts)).toBe('re-auth for usage');
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
