import { describe, it, expect } from 'vitest';
import { accountTokenKey, resolveAccountSetupToken } from './account-token.js';

describe('accountTokenKey', () => {
  it('encodes an email the way the live per-account bundle keys are named', () => {
    // Verified against real bundle keys.
    expect(accountTokenKey('muqsit@getrush.ai')).toBe('CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_GETRUSH_DOT_AI');
    expect(accountTokenKey('muqsitnawaz@gmail.com')).toBe('CLAUDE_CODE_OAUTH_TOKEN_MUQSITNAWAZ_AT_GMAIL_DOT_COM');
    expect(accountTokenKey('muqsit@trp.so')).toBe('CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_TRP_DOT_SO');
    expect(accountTokenKey('muqsitnawaz@icloud.com')).toBe('CLAUDE_CODE_OAUTH_TOKEN_MUQSITNAWAZ_AT_ICLOUD_DOT_COM');
  });

  it('collapses other non-alphanumerics (hyphens, plus) to underscore', () => {
    expect(accountTokenKey('a.b-c+d@x.co')).toBe('CLAUDE_CODE_OAUTH_TOKEN_A_DOT_B_C_D_AT_X_DOT_CO');
  });
});

describe('resolveAccountSetupToken', () => {
  // resolveAccountSetupToken reads the home's account email from disk, so these
  // exercise the env-lookup half against a synthetic env; the email read is
  // covered where the version-home fixtures live.
  it('returns null when the env has no matching per-account token (safe no-op)', () => {
    // No .claude.json at this path → readClaudeAccountEmail returns null → null.
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_X: 'y' }, '/nonexistent/home')).toBeNull();
  });

  it('ignores an empty/whitespace token value', () => {
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_GETRUSH_DOT_AI: '   ' }, '/nonexistent/home')).toBeNull();
  });
});
