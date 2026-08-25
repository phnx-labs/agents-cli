import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  seedClaudeIdentity,
  clearClaudeIdentity,
  readSeededEmail,
  claudeConfigPaths,
} from './claude-identity-seed.js';

function readOauth(home: string, which: 0 | 1): any {
  const p = claudeConfigPaths(home)[which];
  return JSON.parse(fs.readFileSync(p, 'utf-8')).oauthAccount;
}

describe('seedClaudeIdentity', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-seed-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('seeds oauthAccount identity into both config locations (no credential written)', () => {
    const outcome = seedClaudeIdentity(home, {
      email: 'dev@getrush.ai',
      accountUuid: 'acc-1',
      organizationUuid: 'org-1',
      organizationType: 'claude_max',
    });
    expect(outcome).toBe('seeded');

    for (const which of [0, 1] as const) {
      const oa = readOauth(home, which);
      expect(oa.emailAddress).toBe('dev@getrush.ai');
      expect(oa.accountUuid).toBe('acc-1');
      expect(oa.organizationUuid).toBe('org-1');
      expect(oa.organizationType).toBe('claude_max');
    }
    // The load-bearing invariant: no credential file is ever written.
    expect(fs.existsSync(path.join(home, '.claude', '.credentials.json'))).toBe(false);
    expect(readSeededEmail(home)).toBe('dev@getrush.ai');
  });

  it('preserves unrelated .claude.json content when merging', () => {
    const p = claudeConfigPaths(home)[0];
    fs.writeFileSync(p, JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }));
    seedClaudeIdentity(home, { email: 'gmail@x.com' });
    const doc = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(doc.hasCompletedOnboarding).toBe(true);
    expect(doc.theme).toBe('dark');
    expect(doc.oauthAccount.emailAddress).toBe('gmail@x.com');
  });

  it('re-seeding the same email is idempotent and backfills missing uuids', () => {
    expect(seedClaudeIdentity(home, { email: 'a@x.com' })).toBe('seeded');
    expect(seedClaudeIdentity(home, { email: 'a@x.com', organizationUuid: 'org-9' })).toBe('seeded');
    expect(readOauth(home, 0).organizationUuid).toBe('org-9');
  });

  it('refuses to clobber a DIFFERENT account already seeded in the home', () => {
    expect(seedClaudeIdentity(home, { email: 'native@x.com', accountUuid: 'keep' })).toBe('seeded');
    const outcome = seedClaudeIdentity(home, { email: 'other@x.com', accountUuid: 'overwrite' });
    expect(outcome).toBe('skipped-conflict');
    // The incumbent identity is untouched.
    expect(readOauth(home, 0).emailAddress).toBe('native@x.com');
    expect(readOauth(home, 0).accountUuid).toBe('keep');
  });

  it('clearClaudeIdentity removes only the matching seeded identity', () => {
    seedClaudeIdentity(home, { email: 'trp@x.com' });
    clearClaudeIdentity(home, 'someone-else@x.com');
    expect(readSeededEmail(home)).toBe('trp@x.com'); // non-match leaves it
    clearClaudeIdentity(home, 'trp@x.com');
    expect(readSeededEmail(home)).toBeNull();
  });

  it('rejects an empty email', () => {
    expect(() => seedClaudeIdentity(home, { email: '  ' })).toThrow(/email is required/);
  });
});
