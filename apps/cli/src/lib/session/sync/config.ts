/**
 * Configuration for cross-machine session sync: R2 credentials and this
 * machine's stable identity. Credentials come from the `r2.backups` secrets
 * bundle (OS keychain on macOS, libsecret on Linux) — never from env or disk.
 */

import { readAndResolveBundleEnv, isHeadlessSecretsContext } from '../../secrets/bundles.js';

/** Secrets bundle holding the R2 credentials. */
export const SYNC_BUNDLE = 'r2.backups';

// Whether the daemon runs automatic cross-machine sync is gated by the
// `session-sync` beta feature (opt-in, off by default) — see isBetaEnabled()
// in ../../beta.ts and the gates in daemon.ts / sync-umbrella.ts. This module
// only owns credential resolution (isSyncConfigured), not the on/off switch.

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** S3-compatible endpoint for the account (no bucket, no trailing slash). */
  endpoint: string;
  /**
   * Shared 32-byte key (hex or base64) for client-side transcript encryption,
   * held in the bundle as `R2_SYNC_ENC_KEY`. Optional and deliberately separate
   * from the R2 credentials so rotating the access token never orphans already
   * encrypted objects. When absent, transcripts upload unencrypted (with a loud
   * per-cycle warning) — see transcript-crypto.ts + pushOwn.
   */
  syncEncKey?: string;
}

/**
 * Resolve R2 credentials from the `r2.backups` bundle. Throws a clear,
 * actionable error if the bundle or any key is missing — sync cannot proceed
 * without real credentials (no silent fallback).
 */
function resolveR2Config(): R2Config {
  // The daemon monitor loop is headless by construction (no TTY, ever), so
  // isHeadlessSecretsContext() is true here and this resolves broker-only — a
  // broker miss can never pop an unattended Touch ID sheet on the user's screen
  // (same rationale as daemon.ts readDaemonClaudeOAuthToken). Using the shared
  // predicate rather than a literal keeps it consistent with the other callers
  // and lets any interactive caller of loadR2Config still prompt.
  const { env } = readAndResolveBundleEnv(SYNC_BUNDLE, { caller: 'sessions-sync', agentOnly: isHeadlessSecretsContext() });
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const syncEncKey = env.R2_SYNC_ENC_KEY?.trim() || undefined;

  const missing = [
    !accountId && 'R2_ACCOUNT_ID',
    !bucket && 'R2_BUCKET_NAME',
    !accessKeyId && 'R2_ACCESS_KEY_ID',
    !secretAccessKey && 'R2_SECRET_ACCESS_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Sessions sync: bundle '${SYNC_BUNDLE}' is missing ${missing.join(', ')}. ` +
      `Add them with: agents secrets add ${SYNC_BUNDLE} <KEY>`,
    );
  }

  return {
    accountId: accountId!,
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    // Default to the account's R2 endpoint; an explicit R2_ENDPOINT override
    // points sync at any S3-compatible store (MinIO, another provider) — which
    // is also how the feature is verified end-to-end without live R2.
    endpoint: env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
    syncEncKey,
  };
}

// ── Resolution cache ────────────────────────────────────────────────────────
// The daemon calls isSyncConfigured() + syncSessions() every ~90s, and each used
// to trigger a fresh read of the biometry-gated `r2.backups` keychain items —
// one Touch ID prompt per gated item, every cycle, forever. We instead resolve
// at most once per process: a success is memoized for the process lifetime
// (cleared on daemon SIGHUP via clearR2ConfigCache), so subsequent cycles never
// touch the keychain again. A *prompt-bearing* failure (cancelled Touch ID, etc.)
// starts a cooldown so a dismissed prompt is not re-issued every cycle. A simply
// absent bundle never prompts, so it is re-checked each cycle (fast pickup when
// the user later adds credentials).
let cachedConfig: R2Config | null = null;
let lastPromptFailureAt = 0;
/** Window after a prompt-bearing resolution failure during which we skip
 *  re-attempting (and thus re-prompting). SIGHUP / restart bypasses it. */
export const RESOLVE_RETRY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/** Drop the cached resolution so the next call reads the bundle fresh. Called on
 *  daemon SIGHUP (to pick up rotated credentials) and between tests. */
export function clearR2ConfigCache(): void {
  cachedConfig = null;
  lastPromptFailureAt = 0;
}

/**
 * Resolve R2 credentials, reading the keychain at most once per process. The
 * first call reads (and may prompt for Touch ID); every later call returns the
 * memoized result. Throws if the bundle/keys are missing — failures are not
 * memoized, but see isSyncConfigured for the re-prompt cooldown.
 */
export function loadR2Config(): R2Config {
  if (cachedConfig) return cachedConfig;
  cachedConfig = resolveR2Config();
  return cachedConfig;
}

/**
 * True when the sync bundle exists and resolves, without throwing. After a
 * prompt-bearing failure (e.g. a cancelled Touch ID) it returns false without
 * re-reading the keychain for RESOLVE_RETRY_COOLDOWN_MS, so a dismissed prompt
 * does not re-storm every cycle. `now` is injectable for tests.
 */
export function isSyncConfigured(now: number = Date.now()): boolean {
  if (cachedConfig) return true;
  if (lastPromptFailureAt && now - lastPromptFailureAt < RESOLVE_RETRY_COOLDOWN_MS) return false;
  try {
    loadR2Config();
    return true;
  } catch (err) {
    // A missing bundle never prompts, so keep re-checking it each cycle (so a
    // later `agents secrets add` is picked up quickly). Any other failure may
    // have cost a prompt (cancelled Touch ID, keychain error) — back off.
    if (!/not found/i.test((err as Error).message)) lastPromptFailureAt = now;
    return false;
  }
}

// machineId() and normalizeHost() now live in the dependency-free leaf
// ../../machine-id.ts so low-level modules (state.ts) can use them without an
// import cycle. Re-exported here for existing importers.
export { machineId, normalizeHost } from '../../machine-id.js';
