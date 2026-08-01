// Per-account Claude setup-token resolution.
//
// A headless/unattended Claude run should authenticate with the account's
// long-lived `claude setup-token` (exported as a per-account
// `CLAUDE_CODE_OAUTH_TOKEN_<slug>` env var), NOT the interactive OAuth session.
// Claude Code's interactive session uses single-use ROTATING refresh tokens: when
// one machine refreshes, the server invalidates the old refresh token globally, so
// every other machine on that account 401s and gets logged out (Claude Code
// #25609 / #56339). The 1-year setup-token sits earlier in the auth precedence
// (`CLAUDE_CODE_OAUTH_TOKEN`, before subscription login) and does not participate
// in that rotation — so per-account setup-tokens keep the fleet signed in.
//
// The per-account env key encodes the account email. The convention (verified
// against live bundles, e.g. `muqsit@getrush.ai` →
// `CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_GETRUSH_DOT_AI`): upper-case, `@`→`_AT_`,
// `.`→`_DOT_`, any other non-alphanumeric → `_`.

import fs from 'node:fs';
import path from 'node:path';

/** The `CLAUDE_CODE_OAUTH_TOKEN_<slug>` env key for a given account email/id. */
export function accountTokenKey(account: string): string {
  const slug = account
    .trim()
    .toUpperCase()
    .replace(/@/g, '_AT_')
    .replace(/\./g, '_DOT_')
    .replace(/[^A-Z0-9_]/g, '_');
  return `CLAUDE_CODE_OAUTH_TOKEN_${slug}`;
}

/**
 * Read the signed-in account email for a Claude version home from
 * `oauthAccount.emailAddress`. Sync, no keychain, no network. Tries both stores
 * the canonical resolver uses (agents.ts getAccountInfo): the shim-set
 * `CLAUDE_CONFIG_DIR` location `<home>/.claude/.claude.json` first, then the
 * home-level `<home>/.claude.json` (an account signed in via the IDE / direct
 * binary without the shim writes there). Returns null when neither has a usable
 * email.
 */
export function readClaudeAccountEmail(home: string): string | null {
  for (const p of [path.join(home, '.claude', '.claude.json'), path.join(home, '.claude.json')]) {
    try {
      const email = (JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        oauthAccount?: { emailAddress?: unknown };
      }).oauthAccount?.emailAddress;
      if (typeof email === 'string' && email.trim().length > 0) return email.trim();
    } catch {
      // Missing/unreadable/malformed at this location — try the next.
    }
  }
  return null;
}

/**
 * Resolve the per-account setup-token for the account pinned to `home`, looking
 * it up in the provided env (the daemon injects the `claude` bundle's
 * `CLAUDE_CODE_OAUTH_TOKEN_*` keys). Returns null when the home has no known
 * account, or no matching per-account token is present — callers then leave the
 * existing ambient/interactive credential untouched (a safe no-op).
 */
export function resolveAccountSetupToken(
  env: Record<string, string | undefined>,
  home: string,
): string | null {
  const email = readClaudeAccountEmail(home);
  if (!email) return null;
  const token = env[accountTokenKey(email)];
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : null;
}
