/**
 * Configuration for cross-machine session sync: R2 credentials and this
 * machine's stable identity. Credentials come from the `r2.backups` secrets
 * bundle (OS keychain on macOS, libsecret on Linux) — never from env or disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { readAndResolveBundleEnv } from '../../secrets/bundles.js';
import { getHistoryDir } from '../../state.js';

/** Secrets bundle holding the R2 credentials. */
export const SYNC_BUNDLE = 'r2.backups';

// ── Enable / disable switch ─────────────────────────────────────────────────
// Whether the daemon's automatic cross-machine sync (and `agents sync
// --sessions`) may run on THIS machine. Independent of credential presence
// (isSyncConfigured): a machine can hold valid R2 creds yet still opt out of the
// background push/pull — e.g. when on-demand `agents sessions --host` is
// preferred over the ad-hoc R2 mirror. Manual `agents sessions sync` is an
// explicit user action and is deliberately NOT gated by this switch.
//
// Resolution order: the AGENTS_SESSIONS_SYNC env var (a recognized on/off value
// wins outright, for ad-hoc overrides and tests), then a durable machine-local
// flag file, then the default (enabled). The flag lives in the durable
// ~/.agents/.history tree — NOT .cache — so a cache wipe can never silently
// re-enable a sync the operator turned off.

/** Env var that overrides the persisted enable flag (on/off/true/false/1/0/yes/no). */
export const SYNC_ENABLED_ENV = 'AGENTS_SESSIONS_SYNC';

const SYNC_ENABLED_FILE = 'sessions-sync.json';
const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'disabled']);
const ON_VALUES = new Set(['1', 'on', 'true', 'yes', 'enabled']);

/** Durable, machine-local path holding the sync enable flag. */
export function syncStateFilePath(): string {
  return path.join(getHistoryDir(), SYNC_ENABLED_FILE);
}

/**
 * Whether automatic session sync is enabled on this machine. Defaults to true;
 * an unrecognized env value falls through to the file; an absent/unreadable file
 * falls through to the default. Read fresh every call (no memoization) so a
 * `--disable` takes effect on the daemon's next ~90s cycle without a restart.
 */
export function isSyncEnabled(): boolean {
  const envRaw = process.env[SYNC_ENABLED_ENV]?.trim().toLowerCase();
  if (envRaw) {
    if (OFF_VALUES.has(envRaw)) return false;
    if (ON_VALUES.has(envRaw)) return true;
    // Unrecognized value: ignore and consult the persisted flag.
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStateFilePath(), 'utf-8'));
    if (parsed && typeof parsed.enabled === 'boolean') return parsed.enabled;
  } catch {
    // Absent or unreadable → default enabled.
  }
  return true;
}

/** Persist the machine-local sync enable flag (durable across cache wipes). */
export function setSyncEnabled(enabled: boolean): void {
  const p = syncStateFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ enabled }, null, 2) + '\n', 'utf-8');
}

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

// machineId() and normalizeHost() now live in the dependency-free leaf
// ../../machine-id.ts so low-level modules (state.ts) can use them without an
// import cycle. Re-exported here for existing importers.
export { machineId, normalizeHost } from '../../machine-id.js';
