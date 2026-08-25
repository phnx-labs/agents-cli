import { describe, expect, it } from 'vitest';
import {
  findNewerDuplicateVersions,
  formatNewerDuplicateNotice,
  type VersionAccountEntry,
} from '../version-duplicates.js';
import type { AccountInfo } from '../agents.js';

function account(overrides: Partial<AccountInfo>): AccountInfo {
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

function entry(version: string, info: Partial<AccountInfo>): VersionAccountEntry {
  return { version, info: account(info) };
}

describe('findNewerDuplicateVersions', () => {
  it('returns newer versions sharing the selected account identity', () => {
    const result = findNewerDuplicateVersions([
      entry('0.125.0', { email: 'user@example.com', plan: 'Pro' }),
      entry('0.124.0', { email: 'user@example.com', plan: 'Pro' }),
      entry('0.116.0', { email: 'user@example.com', plan: 'Pro' }),
      entry('0.130.0', { email: 'other@example.com', plan: 'Team' }),
    ], '0.116.0');

    expect(result).toEqual([
      { version: '0.125.0', email: 'user@example.com', plan: 'Pro' },
      { version: '0.124.0', email: 'user@example.com', plan: 'Pro' },
    ]);
  });

  it('returns nothing when the selected version is already the newest duplicate', () => {
    const result = findNewerDuplicateVersions([
      entry('0.125.0', { email: 'user@example.com', plan: 'Pro' }),
      entry('0.124.0', { email: 'user@example.com', plan: 'Pro' }),
      entry('0.116.0', { email: 'user@example.com', plan: 'Pro' }),
    ], '0.125.0');

    expect(result).toEqual([]);
  });

  it('matches usage identity before falling back to email', () => {
    const result = findNewerDuplicateVersions([
      entry('0.125.0', {
        usageKey: 'codex:org-1:user-1',
        email: 'renamed@example.com',
        plan: 'Pro',
      }),
      entry('0.116.0', {
        usageKey: 'codex:org-1:user-1',
        email: 'old@example.com',
        plan: 'Pro',
      }),
    ], '0.116.0');

    expect(result).toEqual([
      { version: '0.125.0', email: 'renamed@example.com', plan: 'Pro' },
    ]);
  });

  it('returns nothing when the selected version is not signed in', () => {
    const result = findNewerDuplicateVersions([
      entry('0.125.0', { email: 'user@example.com', plan: 'Pro' }),
      entry('0.116.0', { email: null, plan: null }),
    ], '0.116.0');

    expect(result).toEqual([]);
  });
});

describe('formatNewerDuplicateNotice', () => {
  it('formats the guidance without calling it a warning', () => {
    const notice = formatNewerDuplicateNotice('codex', '0.116.0', [
      { version: '0.125.0', email: 'user@example.com', plan: 'Pro' },
      { version: '0.124.0', email: 'user@example.com', plan: 'Pro' },
    ], 'default');

    expect(notice).toContain('Found 2 newer duplicates for default Codex@0.116.0:');
    expect(notice).toContain('0.125.0');
    expect(notice).toContain('user@example.com');
    expect(notice).toContain('Pro');
    expect(notice).toContain('Run: agents use codex@0.125.0');
    expect(notice.toLowerCase()).not.toContain('warning');
  });
});
