import { describe, expect, it } from 'vitest';
import { accountColumnLabel, joinViewColumns, pruneGroupKey } from './view.js';
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
