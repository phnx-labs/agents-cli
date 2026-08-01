import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountTokenKey, resolveAccountSetupToken } from './account-token.js';

const tmpHomes: string[] = [];
function homeWith(email: string, atHomeLevel = false): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-token-'));
  tmpHomes.push(home);
  const file = atHomeLevel
    ? path.join(home, '.claude.json')
    : path.join(home, '.claude', '.claude.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: email } }));
  return home;
}
afterEach(() => {
  while (tmpHomes.length) fs.rmSync(tmpHomes.pop()!, { recursive: true, force: true });
});

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
  it('reads the home account email and returns its matching per-account token (the real path)', () => {
    const home = homeWith('muqsit@getrush.ai');
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_GETRUSH_DOT_AI: 'sk-ant-oat-getrush',
      CLAUDE_CODE_OAUTH_TOKEN_MUQSITNAWAZ_AT_GMAIL_DOT_COM: 'sk-ant-oat-gmail',
    };
    expect(resolveAccountSetupToken(env, home)).toBe('sk-ant-oat-getrush');
  });

  it('falls back to the home-level .claude.json (IDE / direct-binary sign-in)', () => {
    const home = homeWith('muqsitnawaz@gmail.com', /* atHomeLevel */ true);
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_MUQSITNAWAZ_AT_GMAIL_DOT_COM: 'sk-ant-oat-gmail' }, home))
      .toBe('sk-ant-oat-gmail');
  });

  it('returns null when the home account has no matching token in env (safe no-op)', () => {
    const home = homeWith('nobody@nowhere.co');
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_X: 'y' }, home)).toBeNull();
  });

  it('returns null when the home has no account file at all', () => {
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_X: 'y' }, '/nonexistent/home')).toBeNull();
  });

  it('ignores an empty/whitespace token value', () => {
    const home = homeWith('muqsit@getrush.ai');
    expect(resolveAccountSetupToken({ CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_GETRUSH_DOT_AI: '   ' }, home)).toBeNull();
  });
});
