/**
 * Usage and rate-limit tracking for Claude, Codex, Kimi, and Droid agents.
 *
 * Fetches live usage data from each agent's usage API (Anthropic OAuth for
 * Claude, Kimi Code /usages, Factory billing limits for Droid) or parses
 * rate-limit events from Codex session logs. Results are normalized into a
 * common UsageSnapshot shape, cached to disk, and rendered as terminal
 * progress bars for the `agents view` command.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { promisify } from 'util';
import chalk from 'chalk';

import { decodeJwtPayload, decryptDroidAuthPayload, type AccountInfo } from './agents.js';
import { walkForFiles } from './fs-walk.js';
import {
  getKeychainToken,
  setKeychainToken,
  deleteKeychainToken,
} from './secrets/index.js';
import { getCacheDir } from './state.js';
import type { AgentId } from './types.js';

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CLAUDE_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const CLAUDE_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
const getClaudeUsageCachePath = () => path.join(getCacheDir(), 'claude-usage.json');
const CACHED_CLAUDE_USAGE_SOURCE_LABEL = 'last seen live account data';

const KIMI_USAGES_URL = 'https://api.kimi.com/coding/v1/usages';

const DROID_USAGE_URL = 'https://api.factory.ai/api/billing/limits';

const COMPACT_BAR_LEN = 5;
const USAGE_BAR_LEN = 10;
const FULL = '\u2588';
const EMPTY = '\u2591';

/** Discriminator for usage window types. */
export type UsageWindowKey = 'session' | 'week' | 'sonnet_week' | 'month';

/** A single rate-limit window with utilization percentage and reset time. */
export interface UsageWindow {
  key: UsageWindowKey;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: Date | null;
  windowMinutes: number | null;
}

/** A point-in-time collection of usage windows from a single source. */
export interface UsageSnapshot {
  source: 'live' | 'last_seen';
  sourceLabel: string;
  capturedAt: Date | null;
  windows: UsageWindow[];
  // Subscription tier, when the usage source also reports it in the same
  // response (Kimi's /usages returns membership.level). Account-level plan
  // otherwise comes from the local auth file via AccountInfo.plan; this field
  // lets a network usage fetch surface a plan the local credential can't.
  plan?: string | null;
}

/** Usage data plus any error encountered while fetching. */
export interface UsageInfo {
  snapshot: UsageSnapshot | null;
  error: string | null;
}

/** Input needed to identify an account for usage lookup. */
export interface UsageIdentityInput {
  agentId: AgentId;
  info: AccountInfo;
  home?: string;
  cliVersion?: string | null;
}

/** Options for fetching usage data. */
interface UsageOptions {
  home?: string;
  cliVersion?: string | null;
  organizationId?: string | null;
}

/** Canonical input for a single usage fetch operation. */
export interface UsageFetchInput {
  agentId: AgentId;
  home?: string;
  cliVersion: string | null;
  organizationId: string | null;
}

/** Raw rate-limit window from a Codex session event. */
interface CodexRateLimitWindow {
  used_percent?: number | null;
  window_minutes?: number | null;
  resets_at?: number | string | null;
}

/** Raw rate-limit payload from a Codex token_count event. */
interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

/** Raw usage window from the Claude OAuth usage API. */
interface ClaudeUsageWindow {
  utilization?: number | null;
  resets_at?: number | string | null;
}

/** Response shape from the Claude OAuth usage endpoint. */
interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  seven_day_sonnet?: ClaudeUsageWindow | null;
}

/** Claude OAuth credentials stored in the macOS Keychain. */
interface ClaudeOauthCredentials {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scopes?: string[] | null;
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  organizationUuid?: string | null;
}

/** Shape of the Keychain payload for Claude credentials. */
interface ClaudeKeychainPayload {
  organizationUuid?: string | null;
  claudeAiOauth?: ClaudeOauthCredentials | null;
}

/** Response from the Claude OAuth token refresh endpoint. */
interface ClaudeTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Serialized usage window for the on-disk cache. */
interface CachedUsageWindow {
  key: UsageWindowKey;
  label: string;
  shortLabel: string;
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

/** Serialized usage snapshot for the on-disk cache. */
interface CachedUsageSnapshot {
  capturedAt: string | null;
  windows: CachedUsageWindow[];
  plan?: string | null;
}

/** Parsed rate-limit data extracted from a Codex session file. */
interface CodexRateLimitMatch {
  capturedAt: Date | null;
  rateLimits: CodexRateLimits;
}

/** Fetch usage info for a given agent, dispatching to the agent-specific implementation. */
export async function getUsageInfo(agentId: AgentId, options?: UsageOptions): Promise<UsageInfo> {
  switch (agentId) {
    case 'claude':
      return getClaudeUsageInfo(options);
    case 'codex':
      return getCodexUsageInfo(options);
    case 'kimi':
      return getKimiUsageInfo(options);
    case 'droid':
      return getDroidUsageInfo(options);
    default:
      return { snapshot: null, error: null };
  }
}

/** Derive a stable lookup key from account info for usage deduplication. */
export function getUsageLookupKey(
  info?: Pick<AccountInfo, 'usageKey' | 'accountKey'> | null
): string | null {
  return info?.usageKey || info?.accountKey || null;
}

/**
 * Deduplicate identity inputs into canonical (most-recently-active) accounts
 * and build the corresponding fetch inputs for each unique usage key.
 */
export function buildCanonicalUsageContext(inputs: UsageIdentityInput[]): {
  canonicalByUsageKey: Map<string, AccountInfo>;
  usageFetchInputs: Map<string, UsageFetchInput>;
} {
  const canonicalByUsageKey = new Map<string, AccountInfo>();
  const usageFetchInputs = new Map<string, UsageFetchInput>();

  for (const input of inputs) {
    const key = getUsageLookupKey(input.info);
    if (!key) continue;

    const existing = canonicalByUsageKey.get(key);
    const existingMs = existing?.lastActive?.getTime() ?? -1;
    const currentMs = input.info.lastActive?.getTime() ?? -1;
    if (existing && existingMs >= currentMs) {
      continue;
    }

    canonicalByUsageKey.set(key, input.info);
    usageFetchInputs.set(key, {
      agentId: input.agentId,
      home: input.home,
      cliVersion: input.cliVersion || null,
      organizationId: input.info.organizationId,
    });
  }

  return { canonicalByUsageKey, usageFetchInputs };
}

/** Fetch usage info for all unique accounts in parallel, keyed by usage key. */
export async function getUsageInfoByIdentity(inputs: UsageIdentityInput[]): Promise<{
  canonicalByUsageKey: Map<string, AccountInfo>;
  usageByKey: Map<string, UsageInfo>;
}> {
  const { canonicalByUsageKey, usageFetchInputs } = buildCanonicalUsageContext(inputs);
  const usageResults = await Promise.all(
    [...usageFetchInputs.entries()].map(async ([key, input]) => ({
      key,
      usage: await getUsageInfoForIdentity({
        agentId: input.agentId,
        home: input.home,
        cliVersion: input.cliVersion,
        info: canonicalByUsageKey.get(key)!,
      }),
    }))
  );

  return {
    canonicalByUsageKey,
    usageByKey: new Map(usageResults.map(({ key, usage }) => [key, usage])),
  };
}

const USAGE_CACHE_FRESH_MS = 2 * 60 * 1000; // 2 minutes — fresh window: don't refresh.
const USAGE_CACHE_SWR_MS = 24 * 60 * 60 * 1000; // 24 hours — beyond this, block on live fetch.

/** In-process dedup: don't fire concurrent background refreshes for the same identity. */
const inFlightRefreshes = new Map<string, Promise<void>>();

/**
 * Fetch usage for a single identity using stale-while-revalidate.
 *
 * - Cache fresh (< 2 min): return cached snapshot, NO network.
 * - Cache stale but < 24h: return cached snapshot instantly, fire background refresh.
 * - Cache too stale or absent: block on live fetch, fall back to cache on error.
 *
 * This keeps `agents run` startup off the network on the hot path. The first
 * invocation after a cold install or 24h gap still blocks once to seed the
 * cache; every run after that returns instantly while the cache silently
 * refreshes in the background.
 */
export async function getUsageInfoForIdentity(input: UsageIdentityInput): Promise<UsageInfo> {
  const usageKey = getUsageLookupKey(input.info);

  // Agents whose usage comes from a live network call (Claude, Kimi, Droid) go
  // through the stale-while-revalidate cache below so `agents run`/`agents view`
  // stay off the network on the hot path. Everything else (Codex reads local
  // session logs) takes the legacy blocking path. The on-disk cache is shared and
  // keyed by usageKey, which is namespaced per agent (`claude:org=…`,
  // `kimi:user=…`, `droid:org=…`), so one cache file holds every account without
  // collision.
  const usesNetworkUsage =
    input.agentId === 'claude' || input.agentId === 'kimi' || input.agentId === 'droid';
  if (!usesNetworkUsage || !usageKey) {
    return getUsageInfo(input.agentId, {
      home: input.home,
      cliVersion: input.cliVersion,
      organizationId: input.info.organizationId,
    });
  }

  const cached = readClaudeUsageCache(usageKey);
  const ageMs = cached?.capturedAt ? Date.now() - cached.capturedAt.getTime() : Infinity;

  // Fresh: cache is recent enough, skip network entirely.
  if (cached && ageMs < USAGE_CACHE_FRESH_MS) {
    return { snapshot: cached, error: null };
  }

  // Stale-while-revalidate: cache exists and isn't ancient, return it now and
  // refresh in the background so the next invocation has fresh data.
  if (cached && ageMs < USAGE_CACHE_SWR_MS) {
    triggerBackgroundUsageRefresh(input, usageKey);
    return { snapshot: cached, error: null };
  }

  // Cold cache or > 24h old: block on live fetch.
  const usage = await getUsageInfo(input.agentId, {
    home: input.home,
    cliVersion: input.cliVersion,
    organizationId: input.info.organizationId,
  });

  if (usage.snapshot?.source === 'live') {
    writeClaudeUsageCache(usageKey, usage.snapshot);
    return usage;
  }

  // Live fetch failed — last-resort fallback to whatever cache we had.
  if (cached) {
    return { snapshot: cached, error: usage.error };
  }
  return usage;
}

/**
 * Kick off a background refresh of the usage cache. Errors are swallowed —
 * a failed background refresh leaves the existing cache in place for the
 * next invocation. The work is deferred to a future event-loop tick via
 * `setImmediate` because some of the call chain (loadClaudeOauth →
 * getKeychainToken → execFileSync) does synchronous I/O even though the
 * functions are declared `async`. Without the defer, that sync I/O blocks
 * the SWR caller and defeats the whole point of returning the cache instantly.
 */
function triggerBackgroundUsageRefresh(input: UsageIdentityInput, usageKey: string): void {
  if (inFlightRefreshes.has(usageKey)) return;

  const promise = new Promise<void>((resolve) => {
    setImmediate(async () => {
      try {
        const usage = await getUsageInfo(input.agentId, {
          home: input.home,
          cliVersion: input.cliVersion,
          organizationId: input.info.organizationId,
        });
        if (usage.snapshot?.source === 'live') {
          writeClaudeUsageCache(usageKey, usage.snapshot);
        }
      } catch {
        /* background refresh failed — leave existing cache in place */
      } finally {
        inFlightRefreshes.delete(usageKey);
        resolve();
      }
    });
  });
  inFlightRefreshes.set(usageKey, promise);
}

/** Format a one-line usage summary with compact bars for inline display. */
export function formatUsageSummary(
  plan: string | null,
  snapshot: UsageSnapshot | null,
  planWidth = 3
): string {
  const parts: string[] = [];

  if (plan) {
    parts.push(chalk.gray(plan.padEnd(planWidth)));
  }

  if (snapshot) {
    // Compact rows show the two windows every agent shares (session + week);
    // extra windows (Claude's Sonnet week, Droid's month) render only in the
    // full per-version usage section. An exhausted month window still surfaces
    // here as the rate-limited badge via deriveUsageStatusFromSnapshot.
    const windows = snapshot.windows
      .filter((window) => window.key === 'session' || window.key === 'week')
      .map((window) =>
      `${chalk.gray(`${window.shortLabel}:`)} ${renderCompactUsageBar(window.usedPercent)}`
    );
    if (windows.length > 0) {
      parts.push(windows.join(' '));
    }
  }

  return parts.join('  ');
}

/**
 * Derive an account's real throttle state from its live usage windows — the
 * single signal both the `agents view` badge and run-rotation eligibility share
 * (`hasUsageAvailable` in rotate.ts treats a `rate_limited` verdict here as
 * ineligible). A window at 100% utilization means the account is throttled until
 * that window resets. Rotation *weighting* still ranks eligible accounts by
 * weekly headroom (`getRoutingUsedPercent`); this function is the yes/no gate.
 *
 * Returns `null` when there is no snapshot, so callers render no badge rather
 * than a misleading one. This deliberately never consults
 * `cachedExtraUsageDisabledReason`: that field describes why pay-as-you-go
 * overage is disabled (`out_of_credits` = no overage credits purchased,
 * `org_level_disabled` = an admin turned overage off), NOT whether the account
 * can do work right now. A Pro account at 5% weekly usage with overage disabled
 * is fully usable, yet that flag would mislabel it "out of credits".
 *
 * The model-specific `sonnet_week` sub-limit is excluded: hitting it throttles
 * one model, not the account, so it shouldn't flip the whole row to throttled.
 */
export function deriveUsageStatusFromSnapshot(
  snapshot: UsageSnapshot | null | undefined
): 'available' | 'rate_limited' | null {
  if (!snapshot || snapshot.windows.length === 0) return null;
  const blocking = snapshot.windows.filter((window) => window.key !== 'sonnet_week');
  const windows = blocking.length > 0 ? blocking : snapshot.windows;
  const maxUsed = Math.max(...windows.map((window) => window.usedPercent));
  return maxUsed >= 100 ? 'rate_limited' : 'available';
}

/**
 * Compact colored badge for the account's overall usage status. Renders only
 * when the account is throttled — `available` and `null` return ''.
 *
 * - `out_of_credits` → red "out of credits" (terminal account, all buckets dry)
 * - `rate_limited`   → yellow "rate-limited" (transient throttling)
 *
 * The badge sits between the usage bars and `lastActive` in `agents view`, so
 * a glance at the row tells the user whether the version can do useful work.
 * The same signal is exposed as `usageStatus` in `agents view --json` for
 * programmatic consumers (e.g. the swarmify panel's "resume in healthy agent").
 *
 * The switch is exhaustive on purpose — adding a new `AccountInfo.usageStatus`
 * value without updating the cases here is a build error at `_exhaustive`,
 * which is exactly the bug class this PR is fixing.
 */
export function formatUsageStatusBadge(
  usageStatus: 'available' | 'rate_limited' | 'out_of_credits' | null | undefined
): string {
  if (usageStatus === null || usageStatus === undefined) return '';
  switch (usageStatus) {
    case 'available':       return '';
    case 'out_of_credits':  return chalk.red('out of credits');
    case 'rate_limited':    return chalk.yellow('rate-limited');
    default: {
      const _exhaustive: never = usageStatus;
      void _exhaustive;
      return '';
    }
  }
}

/** Format a multi-line usage section for detailed agent views. */
export function formatUsageSection(usage: UsageInfo): string[] {
  if (!usage.snapshot && !usage.error) {
    return [];
  }

  const lines = ['  Usage', ''];

  if (!usage.snapshot) {
    lines.push(`    ${chalk.dim(usage.error || 'Usage data unavailable right now.')}`);
    return lines;
  }

  const labelWidth = usage.snapshot.windows.reduce((max, window) => Math.max(max, window.label.length), 0);
  for (const window of usage.snapshot.windows) {
    const bar = renderUsageBar(window.usedPercent);
    lines.push(`    ${chalk.bold(window.label.padEnd(labelWidth))}  ${bar} ${formatPercent(window.usedPercent)}% used`);
    if (window.resetsAt) {
      lines.push(`    ${chalk.dim(`Resets ${formatResetAt(window.resetsAt)}`)}`);
    }
    lines.push('');
  }

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.push(`    ${chalk.dim(`Source: ${usage.snapshot.sourceLabel}`)}`);
  return lines;
}

/** Fetch Codex usage by scanning the most recent session files for rate-limit events. */
async function getCodexUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const files = collectCodexSessionFiles(options?.home);
    for (const filePath of files) {
      const match = await readLatestCodexRateLimits(filePath);
      if (!match) continue;

      const windows = normalizeCodexWindows(match.rateLimits);
      if (windows.length === 0) continue;

      return {
        snapshot: {
          source: 'last_seen',
          sourceLabel: 'last seen in latest Codex session',
          capturedAt: match.capturedAt,
          windows,
        },
        error: null,
      };
    }

    return { snapshot: null, error: null };
  } catch {
    return { snapshot: null, error: null };
  }
}

/** Fetch Claude usage via the Anthropic OAuth usage API. */
async function getClaudeUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const oauth = await loadClaudeOauth(options?.home);
    if (!oauth?.accessToken) {
      return { snapshot: null, error: null };
    }

    const requestedOrgId = normalizeString(options?.organizationId);
    const liveOrgId = normalizeString(oauth.organizationUuid);
    if (!isClaudeUsageOrgMatch(requestedOrgId, liveOrgId)) {
      return { snapshot: null, error: null };
    }

    const accessToken = await getClaudeAccessToken(oauth, options?.home);
    if (!accessToken) {
      return { snapshot: null, error: null };
    }

    const response = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
        'User-Agent': getClaudeUserAgent(options?.cliVersion),
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { snapshot: null, error: formatClaudeUsageError(response.status) };
    }

    const data = await response.json() as ClaudeUsageResponse;
    const windows = normalizeClaudeWindows(data);
    if (windows.length === 0) {
      return { snapshot: null, error: null };
    }

    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows,
      },
      error: null,
    };
  } catch {
    return { snapshot: null, error: 'Usage data unavailable right now.' };
  }
}

/** Raw quota bucket from the Kimi /usages response (numbers arrive as strings). */
interface KimiUsageQuota {
  limit?: string | number | null;
  used?: string | number | null;
  remaining?: string | number | null;
  resetTime?: string | null;
}

/** Response shape from the Kimi Code /usages endpoint (subset we render). */
export interface KimiUsagesResponse {
  user?: { userId?: string | null; membership?: { level?: string | null } | null } | null;
  usage?: KimiUsageQuota | null;
  limits?: Array<{
    window?: { duration?: number | null; timeUnit?: string | null } | null;
    detail?: KimiUsageQuota | null;
  } | null> | null;
  subType?: string | null;
}

/**
 * Resolve Kimi's OAuth credential file. Sign-in is account-global but each
 * installed version has an isolated home; the file physically lives only in the
 * home the user logged in under. Check the per-version home first, then the
 * active location under the real HOME — mirrors resolveAccountCredentialPath in
 * agents.ts so every version reflects the true account state.
 */
function resolveKimiCredentialPath(home?: string): string | null {
  const rel = ['.kimi-code', 'credentials', 'kimi-code.json'];
  const perVersion = path.join(home || os.homedir(), ...rel);
  try { if (fs.existsSync(perVersion)) return perVersion; } catch { /* unreadable */ }
  const active = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...rel);
  if (active !== perVersion) {
    try { if (fs.existsSync(active)) return active; } catch { /* unreadable */ }
  }
  return null;
}

/**
 * Fetch Kimi usage via the Kimi Code /usages API. Kimi's JWT has no email
 * claim, so the account row can't show an address — but /usages returns quota
 * windows and the membership tier, which is what we render.
 *
 * Deliberately NO token refresh: `agents view` is a read/inspect command and
 * must not rotate the user's Kimi OAuth credential (rewriting the file,
 * invalidating the old refresh token, racing a concurrently-running kimi CLI).
 * The kimi CLI refreshes on its own launch; if the stored token is expired we
 * skip the live fetch and let the SWR cache serve the last-seen snapshot.
 */
async function getKimiUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const credPath = resolveKimiCredentialPath(options?.home);
    if (!credPath) return { snapshot: null, error: null };

    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const accessToken = cred?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      return { snapshot: null, error: null };
    }

    const expiresAt = typeof cred?.expires_at === 'number' ? cred.expires_at : null;
    if (expiresAt !== null && Date.now() / 1000 >= expiresAt) {
      return { snapshot: null, error: null };
    }

    const response = await fetch(KIMI_USAGES_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    // 401/403/404 => expired token or no Kimi For Coding subscription; render
    // nothing rather than a misleading empty bar.
    if (!response.ok) {
      return { snapshot: null, error: null };
    }

    const data = await response.json() as KimiUsagesResponse;
    const windows = normalizeKimiWindows(data);
    if (windows.length === 0) {
      return { snapshot: null, error: null };
    }

    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows,
        plan: formatKimiPlan(data),
      },
      error: null,
    };
  } catch {
    return { snapshot: null, error: null };
  }
}

/** Normalize the Kimi /usages payload into the common UsageWindow shape. */
export function normalizeKimiWindows(data: KimiUsagesResponse): UsageWindow[] {
  const windows: UsageWindow[] = [];

  // Per-window rate limit (e.g. a 300-minute bucket) -> "session".
  const shortLimit = Array.isArray(data.limits)
    ? data.limits.find((entry) => entry?.detail)
    : null;
  const session = normalizeKimiWindow(
    shortLimit?.detail,
    'session',
    'Current session',
    'S',
    kimiWindowMinutes(shortLimit?.window)
  );
  if (session) windows.push(session);

  // Rolling account quota -> "week".
  const period = normalizeKimiWindow(data.usage, 'week', 'Current period', 'W', null);
  if (period) windows.push(period);

  return windows;
}

/** Normalize a single Kimi quota bucket (used/limit strings) into a UsageWindow. */
function normalizeKimiWindow(
  quota: KimiUsageQuota | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string,
  windowMinutes: number | null
): UsageWindow | null {
  const limit = kimiNumber(quota?.limit);
  const used = kimiNumber(quota?.used);
  if (limit === null || used === null || limit <= 0) return null;

  const usedPercent = normalizePercent((used / limit) * 100);
  if (usedPercent === null) return null;

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(quota?.resetTime),
    windowMinutes: windowMinutes ?? inferWindowMinutes(key),
  };
}

/** Parse a numeric field that Kimi serializes as a string (e.g. "100"). */
function kimiNumber(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Convert a Kimi limit window (duration + timeUnit enum) to minutes. */
function kimiWindowMinutes(
  window: { duration?: number | null; timeUnit?: string | null } | null | undefined
): number | null {
  const duration = typeof window?.duration === 'number' ? window.duration : null;
  if (duration === null || duration <= 0) return null;
  switch (window?.timeUnit) {
    case 'TIME_UNIT_HOUR': return duration * 60;
    case 'TIME_UNIT_SECOND': return duration / 60;
    default: return duration; // TIME_UNIT_MINUTE or unknown -> minutes
  }
}

/** Derive a display plan label from Kimi's membership tier or subscription type. */
export function formatKimiPlan(data: KimiUsagesResponse): string | null {
  const level = data.user?.membership?.level;
  const raw = (typeof level === 'string' && level) || (typeof data.subType === 'string' && data.subType) || '';
  const tail = raw.split('_').pop() || ''; // LEVEL_INTERMEDIATE -> INTERMEDIATE
  if (!tail) return null;
  return tail.charAt(0).toUpperCase() + tail.slice(1).toLowerCase();
}

/** A single Droid token-rate-limit window from /api/billing/limits. */
interface DroidLimitWindow {
  usedPercent?: number | null;
  windowEnd?: string | null;
}

/** Response shape from Factory's billing limits endpoint (subset we render). */
export interface DroidBillingLimitsResponse {
  usesTokenRateLimitsBilling?: boolean | null;
  limits?: {
    standard?: {
      fiveHour?: DroidLimitWindow | null;
      weekly?: DroidLimitWindow | null;
      monthly?: DroidLimitWindow | null;
    } | null;
  } | null;
}

/**
 * Fetch Droid usage via Factory's billing limits API — the same endpoint the
 * droid CLI polls for its token-limit banner. The WorkOS access token comes
 * from the locally decrypted ~/.factory/auth.v2.file (the same credential
 * account identity in agents.ts reads).
 *
 * Deliberately NO token refresh, for a sharper reason than Kimi's: WorkOS
 * refresh tokens are single-use and rotate on every exchange, so refreshing
 * here would race a concurrently running droid session and can permanently
 * invalidate the user's login chain. Droid refreshes its own credential when
 * it runs; if the stored token is expired we skip the live fetch and let the
 * SWR cache serve the last-seen snapshot.
 */
async function getDroidUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const cred = decryptDroidAuthPayload(options?.home || os.homedir());
    const accessToken = cred?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      return { snapshot: null, error: null };
    }

    const exp = decodeJwtPayload(accessToken)?.exp;
    if (typeof exp === 'number' && Date.now() / 1000 >= exp) {
      return { snapshot: null, error: null };
    }

    const response = await fetch(DROID_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    // 401 => revoked/expired token; render nothing rather than a misleading
    // empty bar.
    if (!response.ok) {
      return { snapshot: null, error: null };
    }

    const data = await response.json() as DroidBillingLimitsResponse;
    const windows = normalizeDroidWindows(data);
    if (windows.length === 0) {
      return { snapshot: null, error: null };
    }

    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows,
      },
      error: null,
    };
  } catch {
    return { snapshot: null, error: null };
  }
}

/**
 * Normalize the Factory billing-limits payload into the common UsageWindow
 * shape. Orgs on the legacy (non token-rate-limit) billing model have no
 * meaningful windows, so they render nothing — mirrors droid's own gate on
 * `usesTokenRateLimitsBilling` before it reads `limits.standard`.
 */
export function normalizeDroidWindows(data: DroidBillingLimitsResponse): UsageWindow[] {
  if (data.usesTokenRateLimitsBilling !== true) return [];
  const standard = data.limits?.standard;
  if (!standard) return [];

  const windows = [
    normalizeDroidWindow(standard.fiveHour, 'session', 'Current session', 'S'),
    normalizeDroidWindow(standard.weekly, 'week', 'Current week', 'W'),
    normalizeDroidWindow(standard.monthly, 'month', 'Current month', 'M'),
  ];

  return windows.filter((window): window is UsageWindow => window !== null);
}

/** Normalize a single Droid billing-limits window. */
function normalizeDroidWindow(
  window: DroidLimitWindow | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string
): UsageWindow | null {
  const usedPercent = normalizePercent(window?.usedPercent);
  if (usedPercent === null) return null;

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(window?.windowEnd),
    windowMinutes: inferWindowMinutes(key),
  };
}

/** Collect Codex JSONL session files sorted newest-first. */
function collectCodexSessionFiles(home?: string): string[] {
  const base = home || os.homedir();
  const dir = path.join(base, '.codex', 'sessions');
  if (!fs.existsSync(dir)) return [];

  const seenFiles = new Set<string>();
  const files: Array<{ path: string; mtime: number }> = [];
  for (const filePath of walkForFiles(dir, '.jsonl', 20)) {
    const real = safeRealpathSync(filePath) || filePath;
    if (seenFiles.has(real)) continue;
    seenFiles.add(real);
    const stat = safeStatSync(filePath);
    if (!stat) continue;
    files.push({ path: filePath, mtime: stat.mtimeMs });
  }

  files.sort((a, b) => b.mtime - a.mtime);
  return files.map((file) => file.path);
}

/** Stream a Codex JSONL file and return the last rate_limits payload found. */
async function readLatestCodexRateLimits(filePath: string): Promise<CodexRateLimitMatch | null> {
  return new Promise((resolve) => {
    let latest: CodexRateLimitMatch | null = null;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== 'event_msg' || parsed.payload?.type !== 'token_count' || !parsed.payload?.rate_limits) {
          return;
        }

        latest = {
          capturedAt: parseDateValue(parsed.timestamp),
          rateLimits: parsed.payload.rate_limits as CodexRateLimits,
        };
      } catch {
        /* malformed session line */
      }
    });

    rl.on('close', () => resolve(latest));
    rl.on('error', () => resolve(latest));
  });
}

/** Normalize Codex rate-limit windows into the common UsageWindow shape. */
function normalizeCodexWindows(rateLimits: CodexRateLimits): UsageWindow[] {
  const windows: UsageWindow[] = [];

  const primary = normalizeCodexWindow(rateLimits.primary, 'session', 'Current session', 'S');
  if (primary) windows.push(primary);

  const secondary = normalizeCodexWindow(rateLimits.secondary, 'week', 'Current week', 'W');
  if (secondary) windows.push(secondary);

  return windows;
}

/** Normalize a single Codex rate-limit window. */
function normalizeCodexWindow(
  window: CodexRateLimitWindow | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string
): UsageWindow | null {
  const usedPercent = normalizePercent(window?.used_percent);
  if (usedPercent === null) return null;

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(window?.resets_at),
    windowMinutes: normalizeWindowMinutes(window?.window_minutes),
  };
}

/** Normalize Claude API usage windows into the common UsageWindow shape. */
function normalizeClaudeWindows(data: ClaudeUsageResponse): UsageWindow[] {
  const windows = [
    normalizeClaudeWindow(data.five_hour, 'session', 'Current session', 'S'),
    normalizeClaudeWindow(data.seven_day, 'week', 'Current week (all models)', 'W'),
    normalizeClaudeWindow(data.seven_day_sonnet, 'sonnet_week', 'Current week (Sonnet only)', 'So'),
  ];

  return windows.filter((window): window is UsageWindow => window !== null);
}

/** Normalize a single Claude API usage window. */
function normalizeClaudeWindow(
  window: ClaudeUsageWindow | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string
): UsageWindow | null {
  const usedPercent = normalizePercent(window?.utilization);
  if (usedPercent === null) return null;

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(window?.resets_at),
    windowMinutes: inferWindowMinutes(key),
  };
}

/**
 * Parse a wrapped Claude OAuth payload — the `{ claudeAiOauth, organizationUuid }`
 * shape written by BOTH the macOS Keychain item and the Linux `.credentials.json`
 * file — into our credential struct. Returns null when there is no usable access
 * token. Never throws (malformed JSON => null).
 */
function parseClaudeOauthPayload(raw: string): ClaudeOauthCredentials | null {
  try {
    const payload = JSON.parse(raw.trim()) as ClaudeKeychainPayload;
    if (!payload?.claudeAiOauth || typeof payload.claudeAiOauth.accessToken !== 'string') {
      return null;
    }
    return {
      ...payload.claudeAiOauth,
      organizationUuid: normalizeString(payload.organizationUuid),
    };
  } catch {
    return null;
  }
}

/**
 * Load a version home's Claude OAuth credential from the two stores Claude Code
 * uses, tried in order:
 *
 *  1. The OS keychain (`getKeychainToken`). Canonical on macOS — Claude Code
 *     writes the token to the login keychain and we read it via `/usr/bin/security`.
 *  2. `<home>/.claude/.credentials.json`. On a headless Linux box (the
 *     `agents view --host <linux>` case) there is no reachable Secret Service, so
 *     the Claude CLI stores its OAuth token in this plaintext file instead. The
 *     keychain read above finds nothing on that platform, so we fall back to the
 *     file. Same wrapped `{ claudeAiOauth }` shape, so one parser handles both.
 *     Mirrors `readClaudeCredentialsBlob` (cloud/rush.ts), the proven pattern.
 *
 * Without step 2 the live usage fetch got no token on Linux, so `agents view`
 * (run remotely over SSH by `--host`) rendered no usage bars even though the
 * account + plan — read from the plaintext `.claude.json` — showed fine.
 */
export async function loadClaudeOauth(home?: string): Promise<ClaudeOauthCredentials | null> {
  // Windows not yet supported
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null;
  }

  try {
    const fromKeychain = parseClaudeOauthPayload(getKeychainToken(getClaudeKeychainService(home)));
    if (fromKeychain) return fromKeychain;
  } catch {
    // No keychain item, or no reachable keyring (headless Linux) — fall through.
  }

  const credsPath = path.join(home ?? os.homedir(), '.claude', '.credentials.json');
  try {
    if (fs.existsSync(credsPath)) {
      return parseClaudeOauthPayload(fs.readFileSync(credsPath, 'utf-8'));
    }
  } catch {
    // Unreadable file — treat as not signed in.
  }
  return null;
}

/**
 * Save Claude OAuth credentials to the system keychain/keyring.
 * Reads the existing payload, merges the new OAuth fields, and writes back.
 */
async function saveClaudeOauth(
  home: string | undefined,
  credentials: ClaudeOauthCredentials
): Promise<boolean> {
  // Windows not yet supported
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return false;
  }

  try {
    const service = getClaudeKeychainService(home);

    // Read existing payload to preserve other fields
    let existingPayload: ClaudeKeychainPayload = {};
    try {
      const stdout = getKeychainToken(service);
      existingPayload = JSON.parse(stdout.trim()) as ClaudeKeychainPayload;
    } catch {
      // No existing entry, start fresh
    }

    // Merge new credentials into existing payload
    const newPayload: ClaudeKeychainPayload = {
      ...existingPayload,
      claudeAiOauth: {
        ...existingPayload.claudeAiOauth,
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        scopes: credentials.scopes ?? existingPayload.claudeAiOauth?.scopes,
      },
    };

    const payloadJson = JSON.stringify(newPayload);

    // Delete existing entry first, then add updated entry
    try {
      deleteKeychainToken(service);
    } catch {
      // Entry might not exist, ignore
    }

    setKeychainToken(service, payloadJson);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive the Keychain service name for a Claude home directory.
 * Managed (non-default) homes get a hash suffix for isolation.
 */
export function getClaudeKeychainService(home?: string): string {
  if (!home) {
    return CLAUDE_KEYCHAIN_SERVICE;
  }

  const configDir = path.join(home, '.claude').normalize('NFC');
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

/**
 * Check whether a requested org ID matches the live OAuth org ID.
 * Returns true when either is absent (no filtering) or when they match.
 */
export function isClaudeUsageOrgMatch(
  requestedOrgId: string | null | undefined,
  liveOrgId: string | null | undefined
): boolean {
  const requested = normalizeString(requestedOrgId);
  const live = normalizeString(liveOrgId);
  return !requested || !live || requested === live;
}

/** Read a cached usage snapshot for a given usage key. Returns null if absent or stale. */
export function readClaudeUsageCache(
  usageKey: string,
  cachePath = getClaudeUsageCachePath(),
  now = new Date()
): UsageSnapshot | null {
  const cache = readClaudeUsageCacheFile(cachePath);
  const cached = cache[usageKey];
  if (!cached) {
    return null;
  }

  const snapshot = deserializeClaudeUsageSnapshot(cached, now);
  if (!snapshot) {
    delete cache[usageKey];
    writeClaudeUsageCacheFile(cache, cachePath);
  }
  return snapshot;
}

/** Write a usage snapshot to the on-disk cache. */
export function writeClaudeUsageCache(
  usageKey: string,
  snapshot: UsageSnapshot,
  cachePath = getClaudeUsageCachePath()
): void {
  const cache = readClaudeUsageCacheFile(cachePath);
  cache[usageKey] = serializeClaudeUsageSnapshot(snapshot);
  writeClaudeUsageCacheFile(cache, cachePath);
}

/** Read the entire usage cache file from disk. */
function readClaudeUsageCacheFile(cachePath: string): Record<string, CachedUsageSnapshot> {
  if (!fs.existsSync(cachePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, CachedUsageSnapshot>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Write the entire usage cache to disk. Best-effort; failures are silent. */
function writeClaudeUsageCacheFile(
  cache: Record<string, CachedUsageSnapshot>,
  cachePath: string
): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    /* best-effort cache write */
  }
}

/** Convert a live UsageSnapshot to its JSON-serializable cached form. */
function serializeClaudeUsageSnapshot(snapshot: UsageSnapshot): CachedUsageSnapshot {
  return {
    capturedAt: snapshot.capturedAt?.toISOString() || null,
    plan: snapshot.plan ?? null,
    windows: snapshot.windows.map((window) => ({
      key: window.key,
      label: window.label,
      shortLabel: window.shortLabel,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt?.toISOString() || null,
      windowMinutes: window.windowMinutes,
    })),
  };
}

/** Deserialize a cached snapshot, zeroing out windows whose reset time has passed. */
function deserializeClaudeUsageSnapshot(
  snapshot: CachedUsageSnapshot,
  now: Date
): UsageSnapshot | null {
  const capturedAt = parseDateValue(snapshot.capturedAt);
  const windows = snapshot.windows
    .map((window) => {
      const w = {
        key: window.key,
        label: window.label,
        shortLabel: window.shortLabel,
        usedPercent: window.usedPercent,
        resetsAt: parseDateValue(window.resetsAt),
        windowMinutes: window.windowMinutes,
      };
      if (!isCachedUsageWindowFresh(w, capturedAt, now)) {
        w.usedPercent = 0;
      }
      return w;
    });

  if (windows.length === 0) {
    return null;
  }

  return {
    source: 'last_seen',
    sourceLabel: CACHED_CLAUDE_USAGE_SOURCE_LABEL,
    capturedAt,
    windows,
    plan: snapshot.plan ?? null,
  };
}

/** Check whether a cached usage window is still relevant (not expired or reset). */
function isCachedUsageWindowFresh(
  window: UsageWindow,
  capturedAt: Date | null,
  now: Date
): boolean {
  if (window.resetsAt && window.resetsAt.getTime() <= now.getTime()) {
    return false;
  }
  if (capturedAt && window.windowMinutes !== null) {
    const expiresAt = capturedAt.getTime() + window.windowMinutes * 60 * 1000;
    if (expiresAt <= now.getTime()) {
      return false;
    }
  }
  return true;
}

/** Obtain a valid access token, refreshing if expired. Saves refreshed tokens to Keychain. */
async function getClaudeAccessToken(oauth: ClaudeOauthCredentials, home?: string): Promise<string | null> {
  const accessToken = oauth.accessToken?.trim();
  if (!accessToken) {
    return null;
  }

  const expiresAt = oauth.expiresAt ?? null;
  if (expiresAt === null || Date.now() + CLAUDE_REFRESH_LEEWAY_MS < expiresAt) {
    return accessToken;
  }

  if (!oauth.refreshToken) {
    return null;
  }

  const refreshed = await refreshClaudeToken(oauth);
  if (!refreshed?.accessToken) {
    return null;
  }

  // Persist refreshed credentials to Keychain so they survive across runs
  await saveClaudeOauth(home, refreshed);

  return refreshed.accessToken.trim();
}

/** Refresh an expired Claude OAuth access token using the refresh token. */
async function refreshClaudeToken(oauth: ClaudeOauthCredentials): Promise<ClaudeOauthCredentials | null> {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
      scope: (oauth.scopes?.length ? oauth.scopes : CLAUDE_SCOPES).join(' '),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json() as ClaudeTokenResponse;
  if (!data.access_token || !data.expires_in) {
    return null;
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || oauth.refreshToken || null,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : (oauth.scopes || CLAUDE_SCOPES),
  };
}

/**
 * Check whether the Claude OAuth credentials for a given home are usable.
 * Attempts a token refresh if the access token is expired.
 * Returns true only when a valid access token can be obtained.
 */
export async function isClaudeAuthValid(home?: string): Promise<boolean> {
  const oauth = await loadClaudeOauth(home);
  if (!oauth) return false;
  const token = await getClaudeAccessToken(oauth, home);
  return token !== null;
}

/** Build a User-Agent string for Claude API requests. */
function getClaudeUserAgent(cliVersion?: string | null): string {
  return cliVersion ? `claude-code/${cliVersion}` : 'claude-code';
}

/** Map an HTTP status code to a user-facing error message. */
function formatClaudeUsageError(status: number): string {
  if (status === 429) {
    return 'Usage data unavailable right now.';
  }
  return 'Could not load usage data right now.';
}

/** Clamp a numeric value to 0..100, returning null for non-finite values. */
function normalizePercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

/** Validate and return a positive window duration, or null. */
function normalizeWindowMinutes(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

/** Infer the window duration in minutes from a well-known window key. */
function inferWindowMinutes(key: UsageWindowKey): number | null {
  switch (key) {
    case 'session':
      return 300;
    case 'week':
    case 'sonnet_week':
      return 10080;
    case 'month':
      return 43200;
  }
}

/** Parse a date value from a number (epoch seconds or ms) or ISO string. */
function parseDateValue(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }

  if (typeof value === 'string') {
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
      return parseDateValue(numeric);
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

/** Trim and return a string, or null if empty/non-string. */
function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Render a full-width usage bar for detailed views. */
function renderUsageBar(usedPercent: number): string {
  return renderBar(usedPercent, USAGE_BAR_LEN);
}

/** Render a compact usage bar for inline summaries. */
function renderCompactUsageBar(usedPercent: number): string {
  return renderBar(usedPercent, COMPACT_BAR_LEN, usedPercent > 0 ? 1 : 0);
}

/** Render a colored block-character progress bar. */
function renderBar(usedPercent: number, length: number, minimumVisible = 0): string {
  const rounded = Math.round((usedPercent / 100) * length);
  const filled = Math.max(minimumVisible, Math.max(0, Math.min(length, rounded)));
  const color = getUsageColor(usedPercent);
  return color(FULL.repeat(filled)) + chalk.dim(EMPTY.repeat(length - filled));
}

/** Apply the appropriate color to a text string based on usage percentage. */
function colorUsage(text: string, usedPercent: number): string {
  return getUsageColor(usedPercent)(text);
}

/** Return a chalk color function based on the usage percentage threshold. */
function getUsageColor(usedPercent: number): (text: string) => string {
  if (usedPercent >= 100) return chalk.red;
  if (usedPercent >= 80) return chalk.yellow;
  return chalk.cyan;
}

/** Format a percentage value with at most one decimal place. */
function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Format a reset timestamp as a human-readable relative or absolute time. */
function formatResetAt(date: Date): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const isWithinDay = (date.getTime() - now.getTime()) / 3600000 <= 24;
  const minutes = date.getMinutes();

  if (isWithinDay) {
    return `${date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: minutes === 0 ? undefined : '2-digit',
      hour12: true,
    })} (${timezone})`;
  }

  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: minutes === 0 ? undefined : '2-digit',
    hour12: true,
  };

  if (date.getFullYear() !== now.getFullYear()) {
    options.year = 'numeric';
  }

  return `${date.toLocaleString('en-US', options)} (${timezone})`;
}

/** Safe wrapper around fs.realpathSync that returns null on error. */
function safeRealpathSync(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

/** Safe wrapper around fs.statSync that returns null on error. */
function safeStatSync(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}
