import * as fs from 'fs';
import * as path from 'path';

/**
 * The identity metadata a version home needs in its `.claude.json`
 * `oauthAccount` block for a setup-token account to be a first-class,
 * load-balanced candidate. This is IDENTITY ONLY — never a credential. The
 * account authenticates at exec time from the shared, non-rotating setup-token
 * (`resolveClaudeSetupToken`, keyed by `email`); the credential file is
 * deliberately absent.
 *
 * `email` is load-bearing: `getAccountInfo` derives `signedIn = !!email`
 * (so it decides balanced candidacy), and `resolveClaudeSetupToken` keys the
 * per-account setup-token by it. The UUIDs feed usage keying / plan tier; when
 * absent the account still runs and still balances, it just weights by the
 * fallback until the daemon's usage fetch backfills.
 */
export interface ClaudeSeedIdentity {
  email: string;
  accountUuid?: string;
  organizationUuid?: string;
  organizationType?: string;
  organizationName?: string;
}

/**
 * The two locations Claude reads `oauthAccount` from under a version home, in
 * the order `readClaudeHomeConfig` / `readClaudeAccountEmail` probe them: the
 * shim points `CLAUDE_CONFIG_DIR` at `<home>/.claude`, and the bare
 * `<home>/.claude.json` is the fallback for a version launched without the shim.
 * Seed both so every read path agrees on the identity.
 */
export function claudeConfigPaths(versionHome: string): string[] {
  return [
    path.join(versionHome, '.claude.json'),
    path.join(versionHome, '.claude', '.claude.json'),
  ];
}

/** The email already seeded into this home, or null. Reads either location. */
export function readSeededEmail(versionHome: string): string | null {
  for (const p of claudeConfigPaths(versionHome)) {
    try {
      const email = (JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        oauthAccount?: { emailAddress?: unknown };
      }).oauthAccount?.emailAddress;
      if (typeof email === 'string' && email.trim().length > 0) return email.trim();
    } catch {
      // Missing/unreadable here — try the next location.
    }
  }
  return null;
}

export type SeedOutcome = 'seeded' | 'skipped-conflict';

/**
 * Seed a version home's `.claude.json` `oauthAccount` identity so an attached
 * setup-token account becomes signed-in for balanced enumeration and runnable
 * via the injected setup-token. Merges into any existing config (preserving
 * onboarding flags etc.), writing only the `oauthAccount` block.
 *
 * REFUSES to clobber a *different* account's existing oauthAccount — a home
 * already signed into a real native login (`b@x` with its own credential) must
 * not be silently repointed at `a@x`, or a live login would start running the
 * wrong account. Re-seeding the SAME email is idempotent. The caller decides a
 * conflict is an error or picks a different home.
 */
export function seedClaudeIdentity(
  versionHome: string,
  identity: ClaudeSeedIdentity,
): SeedOutcome {
  const email = identity.email.trim();
  if (!email) throw new Error('seedClaudeIdentity: identity.email is required');

  const existing = readSeededEmail(versionHome);
  if (existing && existing.toLowerCase() !== email.toLowerCase()) {
    return 'skipped-conflict';
  }

  const oauthAccount = {
    accountUuid: identity.accountUuid,
    emailAddress: email,
    organizationUuid: identity.organizationUuid,
    organizationType: identity.organizationType,
    organizationName: identity.organizationName,
  };

  for (const p of claudeConfigPaths(versionHome)) {
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch {
      // No existing config here — start a fresh object.
    }
    const prior = (doc.oauthAccount as Record<string, unknown> | undefined) ?? {};
    // Keep any fields the caller did not supply (e.g. a prior same-account seed
    // that already carried the org uuid); drop undefined so we never write nulls.
    const merged: Record<string, unknown> = { ...prior };
    for (const [k, v] of Object.entries(oauthAccount)) {
      if (v !== undefined) merged[k] = v;
    }
    doc.oauthAccount = merged;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  }
  return 'seeded';
}

/**
 * Remove a seeded `oauthAccount` from a version home — the detach counterpart,
 * so a detached setup-token account stops reading as signed-in and stops
 * resolving its setup-token. Only clears when the seeded email matches
 * `email` (so detaching account A never wipes account B's identity from a home
 * that was re-pointed). Leaves the rest of `.claude.json` intact.
 */
export function clearClaudeIdentity(versionHome: string, email: string): void {
  const want = email.trim().toLowerCase();
  for (const p of claudeConfigPaths(versionHome)) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const seeded = (doc.oauthAccount as { emailAddress?: unknown } | undefined)?.emailAddress;
    if (typeof seeded === 'string' && seeded.trim().toLowerCase() === want) {
      delete doc.oauthAccount;
      fs.writeFileSync(p, JSON.stringify(doc, null, 2));
    }
  }
}
