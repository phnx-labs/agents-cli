import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { bundleBackend, bundleExists, readAndResolveBundleEnv } from './secrets/bundles.js';

/**
 * Reserved FILE-BASED secrets bundle holding long-lived, non-rotating Claude
 * setup-tokens. Usage/probe reads authenticate with these instead of Claude
 * Code's ACL-bound login item, so they never pop Touch ID. Keyed strictly
 * per-account (`CLAUDE_CODE_OAUTH_TOKEN_<slug>` from the account email) — never a
 * bare key, so one account's token can't be misapplied to another in a
 * multi-account fleet.
 */
const AUTH_BUNDLE = 'auth';

/**
 * A well-formed Claude OAuth setup-token: the `sk-ant-oat01-` prefix followed by
 * token-safe characters only, on a single line. `claude setup-token` mints exactly
 * this; nothing else is a token.
 *
 * The provisioning capture bug behind #1767 stored the raw `claude setup-token`
 * TTY stream — the welcome banner, ANSI control sequences, box-drawing art, and the
 * token buried inside — under a per-account key instead of the parsed value. That
 * blob is not a token: injected as `Authorization: Bearer <blob>` it made Anthropic
 * reject every request and the run crash. agents-cli only *consumes* these tokens
 * (the mint itself is the Rush Cloud / mint-auth path), so this is the boundary
 * where a corrupt bundle entry must be caught before it reaches the auth header.
 */
const SETUP_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]+$/;

/** True only for a clean, single-line `sk-ant-oat01-…` token — see {@link SETUP_TOKEN_RE}. */
export function isValidClaudeSetupToken(value: string): boolean {
  return SETUP_TOKEN_RE.test(value);
}

/** The per-account key an email maps to inside the `auth` bundle. */
export function claudeAccountTokenKey(account: string): string {
  const slug = account
    .trim()
    .toUpperCase()
    .replace(/@/g, '_AT_')
    .replace(/\./g, '_DOT_')
    .replace(/[^A-Z0-9_]/g, '_');
  return `CLAUDE_CODE_OAUTH_TOKEN_${slug}`;
}

/** Signed-in account email for a version home, from `.claude.json` (no keychain). */
export function readClaudeAccountEmail(home?: string): string | null {
  const base = home ?? os.homedir();
  for (const p of [path.join(base, '.claude', '.claude.json'), path.join(base, '.claude.json')]) {
    try {
      const email = (JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        oauthAccount?: { emailAddress?: unknown };
      }).oauthAccount?.emailAddress;
      if (typeof email === 'string' && email.trim().length > 0) return email.trim();
    } catch {
      // Missing/unreadable at this location — try the next.
    }
  }
  return null;
}

/**
 * Resolve a long-lived `claude setup-token` for the account signed into `home`
 * from the reserved FILE-BASED `auth` bundle. Returns the token or null. Reads
 * ONLY when the bundle is file-backed (never keychain), so this path itself can
 * never trigger a Touch ID prompt — that is the entire point: usage/probe reads
 * authenticate with the shareable setup-token, not the ACL-bound login item.
 */
export function resolveClaudeSetupToken(home?: string): string | null {
  try {
    // Require a known account (email) up front: without it we cannot key a
    // per-account token, and we must NOT fall back to a bare shared key that
    // would misapply one account's setup-token to another.
    const email = readClaudeAccountEmail(home);
    if (!email) return null;
    if (!bundleExists(AUTH_BUNDLE) || bundleBackend(AUTH_BUNDLE) !== 'file') return null;
    const { env } = readAndResolveBundleEnv(AUTH_BUNDLE, { caller: 'usage', agentOnly: true });
    const v = (env[claudeAccountTokenKey(email)] ?? '').trim();
    if (v.length === 0) return null;
    // Reject a malformed stored value (e.g. a captured setup-token TTY blob, #1767)
    // rather than let it become an `Authorization: Bearer <blob>` header that
    // Anthropic rejects and crashes the run. A corrupt entry is treated as no
    // usable file-based token, so the caller falls back to the normal login.
    if (!isValidClaudeSetupToken(v)) return null;
    return v;
  } catch {
    return null;
  }
}
