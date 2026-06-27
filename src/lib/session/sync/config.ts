/**
 * Configuration for cross-machine session sync: R2 credentials and this
 * machine's stable identity. Credentials come from the `r2.backups` secrets
 * bundle (OS keychain on macOS, libsecret on Linux) — never from env or disk.
 */

import * as os from 'os';
import { readAndResolveBundleEnv } from '../../secrets/bundles.js';

/** Secrets bundle holding the R2 credentials. */
export const SYNC_BUNDLE = 'r2.backups';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** S3-compatible endpoint for the account (no bucket, no trailing slash). */
  endpoint: string;
}

/**
 * Resolve R2 credentials from the `r2.backups` bundle. Throws a clear,
 * actionable error if the bundle or any key is missing — sync cannot proceed
 * without real credentials (no silent fallback).
 */
function resolveR2Config(): R2Config {
  const { env } = readAndResolveBundleEnv(SYNC_BUNDLE, { caller: 'sessions-sync' });
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucket = env.R2_BUCKET_NAME?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();

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
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
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

/**
 * This machine's stable, human-readable id, used as its R2 prefix and mirror
 * directory name. Tailnet hostnames (zion, yosemite-s0, mac-mini) are already
 * unique and readable; we lowercase and strip any domain suffix. Overridable
 * via AGENTS_SYNC_MACHINE_ID for tests and unusual setups.
 */
export function machineId(): string {
  const raw = process.env.AGENTS_SYNC_MACHINE_ID || os.hostname();
  return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
}
