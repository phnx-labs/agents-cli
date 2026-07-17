import { describe, expect, it } from 'vitest';
import { accountColumnLabel, pruneGroupKey } from './view.js';

describe('accountColumnLabel — organization suffix', () => {
  it('appends the org badge for a Team seat', () => {
    expect(accountColumnLabel({
      email: 'taylor@example.com',
      accountId: null,
      signedIn: true,
      organizationType: 'claude_team',
      organizationName: 'Turing Labs',
    })).toBe('taylor@example.com (Turing Labs · Team)');
  });

  it('appends only the tier label for a personal Max plan', () => {
    expect(accountColumnLabel({
      email: 'taylor@example.com',
      accountId: null,
      signedIn: true,
      organizationType: 'claude_max',
      organizationName: "taylor@example.com's Organization",
    })).toBe('taylor@example.com (Max)');
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
