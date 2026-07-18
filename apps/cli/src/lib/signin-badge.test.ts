import { describe, expect, it } from 'vitest';
import { formatSignInBadge, loginHint } from './signin-badge.js';
import type { AccountInfo } from './agents.js';

// Strip ANSI so assertions read against text, not color codes.
const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

const acct = (over: Partial<AccountInfo>): Pick<AccountInfo, 'signedIn' | 'email' | 'accountId'> => ({
  signedIn: false,
  email: null,
  accountId: null,
  ...over,
});

describe('loginHint', () => {
  // The whole point of the warning is telling the user the RIGHT command — a
  // wrong hint sends them down the wrong path, so pin the per-agent overrides.
  it('uses the correct login command per agent', () => {
    expect(loginHint('codex')).toBe('codex login');
    expect(loginHint('grok')).toBe('grok login');
    expect(loginHint('opencode')).toBe('opencode auth login');
    expect(loginHint('claude')).toBe('claude, then /login');
  });

  it('falls back to the bare cli command for device/oauth-on-launch agents', () => {
    // kimi/gemini start their flow on launch — no subcommand.
    expect(loginHint('kimi')).toBe('kimi');
    expect(loginHint('gemini')).toBe('gemini');
  });
});

describe('formatSignInBadge', () => {
  it('renders logged out for a missing or unsigned account', () => {
    expect(plain(formatSignInBadge(null))).toBe('✗ logged out');
    expect(plain(formatSignInBadge(acct({ signedIn: false, email: 'x@y.com' })))).toBe('✗ logged out');
  });

  it('renders signed in with the email when present', () => {
    expect(plain(formatSignInBadge(acct({ signedIn: true, email: 'muqsit@gmail.com' })))).toBe(
      '✓ signed in muqsit@gmail.com',
    );
  });

  it('falls back to an account id when signed in without an email', () => {
    expect(plain(formatSignInBadge(acct({ signedIn: true, accountId: 'abc123' })))).toBe('✓ signed in id:abc123');
  });

  it('renders a bare signed-in badge for opaque credentials (no email, no id)', () => {
    // Kimi / Antigravity: signed in but no surfaceable identity.
    expect(plain(formatSignInBadge(acct({ signedIn: true })))).toBe('✓ signed in');
  });
});
