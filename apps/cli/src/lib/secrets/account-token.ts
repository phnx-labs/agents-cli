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
 * Read the signed-in account email for a Claude version home from its
 * `.claude/.claude.json` (`oauthAccount.emailAddress`). Sync, no keychain, no
 * network — mirrors {@link claudeHomeHasOwnCredential}. Returns null when the
 * file/field is absent or unreadable.
 */
export function readClaudeAccountEmail(home: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(home, '.claude', '.claude.json'), 'utf-8');
    const email = (JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } })
      .oauthAccount?.emailAddress;
    return typeof email === 'string' && email.trim().length > 0 ? email.trim() : null;
  } catch {
    return null;
  }
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
