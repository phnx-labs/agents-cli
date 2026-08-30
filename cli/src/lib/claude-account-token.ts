import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AUTH_BUNDLE_NAME,
  ReservedBundleWrongBackendError,
  bundleBackend,
  bundleExists,
  readAndResolveBundleEnv,
} from './secrets/bundles.js';
import { fileStoreItemPath } from './secrets/filestore.js';
import { secretsKeychainItem } from './secrets/index.js';

/**
 * Reserved FILE-BASED secrets bundle holding long-lived, non-rotating Claude
 * setup-tokens. Usage/probe reads authenticate with these instead of Claude
 * Code's ACL-bound login item, so they never pop Touch ID. Keyed strictly
 * per-account (`CLAUDE_CODE_OAUTH_TOKEN_<slug>` from the account email) — never a
 * bare key, so one account's token can't be misapplied to another in a
 * multi-account fleet.
 */
/** Alias of the secrets-layer reserved name so mint/seed shares one source of truth. */
export const AUTH_BUNDLE = AUTH_BUNDLE_NAME;

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

interface SetupTokenCacheEntry {
  credentialPath: string;
  fingerprint: string;
  token: string | null;
}

/** Process-local only: plaintext setup-tokens are never written to another cache. */
const setupTokenCache = new Map<string, SetupTokenCacheEntry>();

function credentialFingerprint(credentialPath: string): string {
  try {
    const stat = fs.statSync(credentialPath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

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
  // Require a known account (email) up front: without it we cannot key a
  // per-account token, and we must NOT fall back to a bare shared key that
  // would misapply one account's setup-token to another.
  const email = readClaudeAccountEmail(home);
  if (!email) return null;
  return resolveClaudeSetupTokenForEmail(email, home ?? os.homedir());
}

/**
 * Resolve a long-lived setup-token for an EXPLICIT account email, independent of
 * any version home's `.claude.json`. This is what lets `agents accounts attach`
 * provision a headless worker home that has never had an interactive login: the
 * account's non-rotating setup-token is already fleet-synced in the file-based
 * `auth` bundle, keyed by email ({@link claudeAccountTokenKey}), so we can write
 * the home's `.oauth_token` from it without the circular
 * "read the home's email to resolve the home's token" dependency that
 * {@link resolveClaudeSetupToken} has. Same file-backed-only, fail-closed,
 * fingerprint-stable read as the home-keyed path — it is the shared core.
 *
 * `cacheKey` scopes the process-local token cache; callers pass a version home
 * so a home-keyed and email-keyed read of the same account share nothing stale.
 */
export function resolveClaudeSetupTokenForEmail(email: string, cacheKey?: string): string | null {
  try {
    const trimmed = email.trim();
    if (!trimmed) return null;
    if (!bundleExists(AUTH_BUNDLE)) return null;
    const backend = bundleBackend(AUTH_BUNDLE);
    if (backend !== 'file') {
      // SEC-GAP-3: a keychain/vault-backed `auth` used to return null here, so
      // usage/probe fell through to the interactive login (Touch ID) with no
      // hint that the seeded setup-token was being ignored.
      throw new ReservedBundleWrongBackendError(AUTH_BUNDLE, backend);
    }
    const key = claudeAccountTokenKey(trimmed);
    const ck = cacheKey ?? `email:${trimmed}`;
    const item = secretsKeychainItem(AUTH_BUNDLE, key);
    const credentialPath = fileStoreItemPath(item);
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = credentialFingerprint(credentialPath);
      const cached = setupTokenCache.get(ck);
      if (cached?.credentialPath === credentialPath && cached.fingerprint === before) {
        return cached.token;
      }
      if (before === 'missing') {
        setupTokenCache.set(ck, { credentialPath, fingerprint: before, token: null });
        return null;
      }
      const { env } = readAndResolveBundleEnv(AUTH_BUNDLE, { caller: 'usage', agentOnly: true });
      const v = (env[key] ?? '').trim();
      const token = v.length > 0 && isValidClaudeSetupToken(v) ? v : null;
      const after = credentialFingerprint(credentialPath);
      if (before === after) {
        setupTokenCache.set(ck, { credentialPath, fingerprint: after, token });
        return token;
      }
    }
    // The credential changed during both decrypt attempts. Fail closed rather
    // than return a token whose current file fingerprint was never observed.
    return null;
  } catch (err) {
    if (err instanceof ReservedBundleWrongBackendError) throw err;
    return null;
  }
}

/**
 * Seed a keychain-less Linux worker's Claude version-home identity so an account's
 * fleet-synced setup-token resolves for it. A worker home never had an interactive
 * browser login, so its `.claude.json` carries no `oauthAccount.emailAddress` and
 * the account reads "signed out" even though its non-rotating setup-token is present
 * in the `auth` bundle. This writes ONLY the descriptive identity (the email), merged
 * into both `.claude.json` locations Claude Code reads, preserving every other field.
 * It never copies a rotating OAuth credential (`.credentials.json`) — the setup-token
 * stays the credential of record.
 */
export function seedClaudeWorkerHomeIdentity(versionHome: string, email: string): void {
  const trimmed = email.trim();
  if (!trimmed) return;
  for (const p of [
    path.join(versionHome, '.claude', '.claude.json'),
    path.join(versionHome, '.claude.json'),
  ]) {
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Missing or unreadable at this location — write a fresh minimal document.
    }
    const existing = (doc.oauthAccount && typeof doc.oauthAccount === 'object'
      ? (doc.oauthAccount as Record<string, unknown>)
      : {});
    doc.oauthAccount = { ...existing, emailAddress: trimmed };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(doc));
  }
}
