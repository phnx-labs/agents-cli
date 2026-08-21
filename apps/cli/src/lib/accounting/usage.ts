/**
 * Usage and rate-limit tracking for Claude, Codex, Kimi, Droid, Grok, Cursor,
 * and Antigravity agents.
 *
 * Fetches live usage data from each agent's usage API (Anthropic OAuth for
 * Claude, Kimi Code /usages, Factory billing limits for Droid, Google Code
 * Assist :retrieveUserQuota for Antigravity) or parses rate-limit events from
 * Codex session logs. Results are normalized into a common UsageSnapshot
 * shape, cached to disk, and rendered as terminal progress bars for the
 * `agents view` command.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { promisify } from 'util';
import chalk from 'chalk';

import { decodeJwtPayload, decryptDroidAuthPayload, type AccountInfo } from '../agents.js';
import { walkForFiles } from '../fs-walk.js';
import {
  getKeychainToken,
  setKeychainToken,
  deleteKeychainToken,
  isKeychainBackendOverridden,
} from '../secrets/index.js';
import { resolveClaudeSetupToken } from '../claude-account-token.js';
import {
  formatBackoffRemaining,
  noteUsageRateLimited,
  usageRateLimitedUntil,
} from '../usage-backoff.js';
import { getCacheDir } from '../state.js';
import type { AgentId } from '../types.js';
import { mapBounded } from '../concurrency.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from '../fs-atomic.js';
import { withRefreshLease } from '../refresh-coordinator.js';

const execFileAsync = promisify(execFile);

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CLAUDE_REFRESH_LEEWAY_MS = 5 * 60 * 1000;

/**
 * Why a usage read produced no snapshot, when the cause is the credential or the
 * server rather than the payload. Every provider used to return `error: null`
 * for all three, which made an account nobody can read indistinguishable from a
 * healthy one: the caller fell back to whatever was in the SWR cache and
 * rendered its bars as fact. On `yosemite-s1` that hid five Claude accounts
 * whose stored access token had expired — one of them eleven days earlier —
 * behind a cache frozen for 26h, and balanced routing launched into an account
 * that was actually at its weekly cap.
 *
 * No usage read ever refreshes a token (RUSH-1822 for Claude; the same rule for
 * Kimi/Droid/Cursor, whose own CLIs rotate on their next launch), so an expired
 * credential cannot heal on its own — the account stays unreadable until that
 * agent actually runs, or a long-lived token is provisioned for it.
 *
 * Shared across all four networked providers on purpose: the failure shape is
 * identical, and wiring only Claude would leave `agents view --refresh`
 * reporting Claude accounts while silently presenting stale Kimi, Droid, and
 * Cursor readings as confirmed.
 */
export function usageNoCredentialError(agent: string): string {
  return `No readable ${agent} credential — sign in, or provision a long-lived token for this account.`;
}
export function usageExpiredCredentialError(agent: string): string {
  return `${agent} credential expired — re-auth this account (a usage read never refreshes it).`;
}
export function usageRejectedError(agent: string, status: number): string {
  return status === 429
    ? `${agent} is rate-limiting the usage endpoint for this machine (HTTP 429).`
    : `${agent} rejected the usage read (HTTP ${status}).`;
}

/**
 * Canonical phrase for the Anthropic setup-token scope gap (RUSH-2392).
 * `claude setup-token` mints `user:inference` only; the usage endpoint requires
 * `user:profile`. The account can still run; usage bars cannot populate via
 * that token. Callers detect this string with {@link isUsageHeadlessScopeError}
 * so the UI can render it distinctly from a generic "unverified" failure.
 */
export const USAGE_HEADLESS_SCOPE_MARKER = 'usage unavailable (headless)';

/**
 * Distinct error when Claude's usage API returns 403 because the setup-token
 * lacks `user:profile` (RUSH-2392). Not a revocation, not a missing mint —
 * a permanent tradeoff of the headless credential.
 */
export function usageHeadlessScopeError(agent = 'Claude'): string {
  return `${agent} ${USAGE_HEADLESS_SCOPE_MARKER} — setup-token lacks user:profile; account can still run.`;
}

/** True when an error string is the setup-token scope gap (RUSH-2392). */
export function isUsageHeadlessScopeError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.includes(USAGE_HEADLESS_SCOPE_MARKER);
}

/**
 * Detect Anthropic's usage-endpoint scope denial: HTTP 403 whose body names
 * `user:profile` (or "scope requirement"). A bare 403 without that body stays
 * classified as a real rejection — only the known setup-token shape is special
 * (RUSH-2392).
 */
export function isClaudeUsageScopeDenied(
  status: number,
  bodyText: string | null | undefined,
): boolean {
  if (status !== 403) return false;
  if (!bodyText) return false;
  const lower = bodyText.toLowerCase();
  return lower.includes('user:profile') || lower.includes('scope requirement');
}

/**
 * The read threw rather than answering — a timeout, DNS/TLS failure, a payload
 * that would not parse, a credential that would not decrypt. Every provider
 * swallowed these into `error: null`, which is the same silence as an expired
 * token: the caller renders a stale snapshot as confirmed. The cause is carried
 * verbatim because these are the failures a user cannot otherwise see.
 */
/**
 * The provider told us to back off and we are still inside that window, so this
 * read made no request at all. Distinct from `usageRejectedError(agent, 429)`,
 * which is the 429 itself: this one says we are *honouring* it.
 */
export function usageThrottledError(agent: string, untilMs: number): string {
  return `${agent} rate-limited this machine — not retrying for ${formatBackoffRemaining(untilMs)}.`;
}
export function usageUnreachableError(agent: string, cause?: unknown): string {
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return detail
    ? `${agent} usage read failed: ${detail}`
    : `${agent} usage read failed.`;
}

/**
 * True when a Claude OAuth access token is within the refresh leeway of expiry
 * (or already expired) — i.e. it "would need a refresh" before the next use.
 *
 * Single source of truth for the expiry gate, shared by the two callers that
 * must agree on it but act differently: the run/usage hot path
 * (`getClaudeAccessToken`) refreshes when this is true; the health probe
 * (`probeClaudeStatus`) must NOT refresh and instead reports the non-fatal
 * `expired` state (RUSH-1822). A missing `expiresAt` is treated as "still
 * fresh" (never force a refresh on a token with no known expiry).
 */
export function claudeAccessTokenNeedsRefresh(
  expiresAt: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (expiresAt == null) return false;
  return nowMs + CLAUDE_REFRESH_LEEWAY_MS >= expiresAt;
}
const CLAUDE_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Test seam for the usage cache path, mirroring `setUsageBackoffDirForTest`.
 * `getCacheDir()` resolves from a module-level constant captured at import, so
 * overriding `HOME` in a test does NOT redirect this cache — it would write into
 * the developer's real `~/.agents/.cache/`. Point it at a tmpdir instead.
 */
let claudeUsageCachePathOverride: string | null = null;
export function setClaudeUsageCachePathForTest(cachePath: string | null): string | null {
  const prev = claudeUsageCachePathOverride;
  claudeUsageCachePathOverride = cachePath;
  return prev;
}
const getClaudeUsageCachePath = () => claudeUsageCachePathOverride ?? path.join(getCacheDir(), 'claude-usage.json');
const CACHED_CLAUDE_USAGE_SOURCE_LABEL = 'last seen live account data';

const KIMI_USAGES_URL = 'https://api.kimi.com/coding/v1/usages';

const DROID_USAGE_URL = 'https://api.factory.ai/api/billing/limits';

const CURSOR_USAGE_URL = 'https://cursor.com/api/usage';
const CURSOR_PERIOD_USAGE_URL = 'https://cursor.com/api/dashboard/get-current-period-usage';
const CURSOR_USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';

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
  /**
   * When true, never open the ACL-bound OS keychain item (macOS Touch ID).
   * Daemon usage refresh sets this so a background tick cannot pop biometrics.
   * Credentials come from the no-ACL access-token cache, a file-based
   * setup-token, or `<home>/.claude/.credentials.json` only.
   */
  fileOnly?: boolean;
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

interface UsageSource {
  fetch: (options?: UsageOptions) => Promise<UsageInfo>;
  network: boolean;
}

/** The single registry of agent usage sources and their transport. */
const USAGE_SOURCES = {
  claude: { fetch: getClaudeUsageInfo, network: true },
  codex: { fetch: getCodexUsageInfo, network: false },
  kimi: { fetch: getKimiUsageInfo, network: true },
  droid: { fetch: getDroidUsageInfo, network: true },
  grok: { fetch: getGrokUsageInfo, network: false },
  cursor: { fetch: getCursorUsageInfo, network: true },
  antigravity: { fetch: getAntigravityUsageInfo, network: true },
  muse: { fetch: getMuseUsageInfo, network: true },
} as const satisfies Partial<Record<AgentId, UsageSource>>;

export const USAGE_SOURCE_AGENT_IDS = Object.keys(USAGE_SOURCES) as (keyof typeof USAGE_SOURCES)[];

function getUsageSource(agentId: AgentId): UsageSource | undefined {
  return USAGE_SOURCES[agentId as keyof typeof USAGE_SOURCES];
}

/** Fetch usage info for a given agent through the canonical source registry. */
export async function getUsageInfo(agentId: AgentId, options?: UsageOptions): Promise<UsageInfo> {
  const source = getUsageSource(agentId);
  return source ? source.fetch(options) : { snapshot: null, error: null };
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

/**
 * Whether an agent exposes usage/limit data we can render — Claude/Kimi/Droid/
 * Cursor/Antigravity via a live API, Codex/Grok via local session logs.
 * Everything else has no usage concept, so callers use this to decide whether
 * a missing snapshot is worth flagging as "usage unavailable" (a signed-in
 * Claude account with no data) versus simply not applicable (OpenCode).
 */
export function agentReportsUsage(agentId: AgentId): boolean {
  return getUsageSource(agentId) !== undefined;
}

/**
 * Whether an agent's usage source makes a live NETWORK call (Claude/Kimi/Droid/
 * Cursor/Antigravity) versus reading local session logs (Codex/Grok). Both
 * kinds publish through the shared cache; callers use this only to distinguish
 * provider I/O from local collection.
 */
export function agentUsesNetworkUsage(agentId: AgentId): boolean {
  return getUsageSource(agentId)?.network === true;
}

/**
 * Concurrent live usage fetches for a single `agents view` / rotation pass.
 * High enough to finish a multi-account refresh in one round-trip window; low
 * enough that a cold cache of 10+ accounts cannot open 10+ HTTP calls at once
 * (and cannot stack behind delayed responses until the process is pegged).
 */
export const USAGE_FETCH_CONCURRENCY = 3;

/**
 * Unified entry for every multi-account usage lookup (`agents view`, rotation,
 * JSON export). Deduplicates by usage identity and reads the shared snapshot.
 * Only an explicit `forceRefresh` call may collect provider or local-log state.
 */
export interface UsageLookupOptions {
  forceRefresh?: boolean;
  fileOnly?: boolean;
}

export async function getUsageInfoByIdentity(
  inputs: UsageIdentityInput[],
  opts?: UsageLookupOptions,
): Promise<{
  canonicalByUsageKey: Map<string, AccountInfo>;
  usageByKey: Map<string, UsageInfo>;
}> {
  const { canonicalByUsageKey, usageFetchInputs } = buildCanonicalUsageContext(inputs);
  const entries = [...usageFetchInputs.entries()];
  const usageResults = await mapBounded(
    entries,
    async ([key, input]) => ({
      key,
      usage: await getUsageInfoForIdentity({
        agentId: input.agentId,
        home: input.home,
        cliVersion: input.cliVersion,
        info: canonicalByUsageKey.get(key)!,
      }, opts),
    }),
    { concurrency: USAGE_FETCH_CONCURRENCY },
  );

  return {
    canonicalByUsageKey,
    usageByKey: new Map(usageResults.map(({ key, usage }) => [key, usage])),
  };
}

/**
 * In-process dedup complements the device-wide lease. It avoids lock contention
 * when several callers in one process explicitly request the same refresh.
 */
const inFlightLiveFetches = new Map<string, Promise<UsageInfo>>();

/**
 * Fetch usage for one identity. Ordinary callers always read the shared cache;
 * the daemon and explicit `--refresh` calls collect through one device lease.
 */
export async function getUsageInfoForIdentity(
  input: UsageIdentityInput,
  opts?: UsageLookupOptions,
): Promise<UsageInfo> {
  const usageKey = getUsageLookupKey(input.info);
  const forceRefresh = opts?.forceRefresh === true;
  // Reading is the default. Only an explicit forceRefresh is authorized to
  // collect provider/local-log state; callers cannot accidentally turn a
  // display or routing path into a collector by omitting an option.
  const readOnly = !forceRefresh;

  // The on-disk cache is shared for both provider and local-log sources and is
  // keyed by usageKey, which is namespaced per agent (`claude:org=…`,
  // `kimi:user=…`, `droid:org=…`, `cursor:user=…`, `antigravity:sub=…`), so one
  // cache file holds every account without collision.
  if (!usageKey) {
    if (readOnly) return { snapshot: null, error: 'stale' };
    return getUsageInfo(input.agentId, {
      home: input.home,
      cliVersion: input.cliVersion,
      organizationId: input.info.organizationId,
      fileOnly: opts?.fileOnly,
    });
  }

  const cached = readClaudeUsageCache(usageKey);
  // `readOnly` (the `agents run` routing hot path): serve the cache and NEVER
  // touch the network — not even a background refresh. `collectRunCandidates`
  // used to pass a 5-minute `maxAgeMs`, which made a snapshot older than that
  // fall through to the blocking live fetch below (getUsageInfo → provider HTTP),
  // adding one round trip per account to `agents run` cold-start on a box whose
  // cache had gone stale. The daemon now owns keeping this cache fresh
  // (`runUsageRefresh`, adaptive + rate-capped), so the router only ever reads
  // it. A stale-or-absent snapshot is handled downstream by the router's own
  // freshness guard (`isUsageVerified` in rotate.ts), which routes around a
  // number it can't confirm rather than trusting an old one — so returning a
  // stale snapshot here is safe, and an absent one reports `'stale'`.
  if (readOnly) {
    if (cached) return { snapshot: cached, error: null };
    return { snapshot: null, error: 'stale' };
  }

  // Explicit refresh: block on the shared device collector.
  return fetchLiveUsageDeduped(input, usageKey, cached, opts?.fileOnly === true);
}

/**
 * Single-flight live usage fetch per usage key. Concurrent callers (view +
 * rotation, or two rows sharing an account) await the same promise rather than
 * opening duplicate HTTP requests that then time out and pile up.
 */
async function fetchLiveUsageDeduped(
  input: UsageIdentityInput,
  usageKey: string,
  cached: UsageSnapshot | null,
  fileOnly: boolean,
): Promise<UsageInfo> {
  const existing = inFlightLiveFetches.get(usageKey);
  if (existing) return existing;

  const previousCapturedAt = cached?.capturedAt?.getTime() ?? 0;
  const promise = withRefreshLease<UsageInfo>({
    scope: 'usage',
    key: usageKey,
    readCompleted: () => {
      const snapshot = readClaudeUsageCache(usageKey);
      return snapshot ? { snapshot, error: null } : null;
    },
    isCompleted: (value) => (value.snapshot?.capturedAt?.getTime() ?? 0) > previousCapturedAt,
    refresh: async (): Promise<UsageInfo> => {
      const latestCached = readClaudeUsageCache(usageKey) ?? cached;
      const usage = await getUsageInfo(input.agentId, {
        home: input.home,
        cliVersion: input.cliVersion,
        organizationId: input.info.organizationId,
        fileOnly,
      });

      if (usage.snapshot) {
        if (!usage.snapshot.capturedAt || usage.snapshot.capturedAt.getTime() <= previousCapturedAt) {
          usage.snapshot.capturedAt = new Date(previousCapturedAt + 1);
        }
        writeClaudeUsageCache(usageKey, usage.snapshot);
        return usage;
      }

      // Live fetch failed — last-resort fallback to whatever cache we had.
      if (latestCached) return { snapshot: latestCached, error: usage.error };
      return usage;
    },
  });

  inFlightLiveFetches.set(usageKey, promise);
  try {
    return await promise;
  } finally {
    inFlightLiveFetches.delete(usageKey);
  }
}

/**
 * Pick which usage windows to render in a compact one-line summary.
 *
 * Overview rows (`agents view` all agents) must stay narrow enough that one
 * multi-window agent (Antigravity's four model quotas, Droid's three buckets)
 * does not force every other row to pad to ~200 columns and wrap. Prefer the
 * canonical session + week windows when present; otherwise take the highest
 * utilization remaining. Returns the full set when `maxWindows` is unset.
 */
export function pickCompactUsageWindows(
  windows: UsageWindow[],
  maxWindows?: number,
): UsageWindow[] {
  const filtered = windows.filter((window) => window.key !== 'sonnet_week');
  if (maxWindows === undefined || maxWindows <= 0 || filtered.length <= maxWindows) {
    return filtered;
  }

  // Pick by object identity, not by key. Antigravity normalizes every model
  // quota as key: 'session', so a key-set filter would keep only the first and
  // drop the rest even when maxWindows > 1.
  const chosen: UsageWindow[] = [];
  const take = (w: UsageWindow | undefined): void => {
    if (!w || chosen.includes(w) || chosen.length >= maxWindows) return;
    chosen.push(w);
  };

  take(filtered.find((w) => w.key === 'session'));
  take(filtered.find((w) => w.key === 'week'));

  const rest = filtered
    .filter((w) => !chosen.includes(w))
    .sort((a, b) => b.usedPercent - a.usedPercent);
  for (const w of rest) {
    if (chosen.length >= maxWindows) break;
    chosen.push(w);
  }
  return chosen;
}

/** Options for {@link formatUsageSummary}. */
export interface FormatUsageSummaryOpts {
  unavailable?: boolean;
  unverified?: boolean;
  /**
   * Setup-token lacks `user:profile` so usage cannot be read headlessly
   * (RUSH-2392). Distinct from generic `unverified` (cache unconfirmed) —
   * minting again will not help; the account still runs.
   */
  headless?: boolean;
  /**
   * Cap how many usage windows render on one line. Overview (`agents view`
   * with no agent filter) passes 2 so multi-window agents cannot blow out
   * column width; single-agent and detail views leave this unset.
   */
  maxWindows?: number;
}

/** Format a one-line usage summary with compact bars for inline display. */
export function formatUsageSummary(
  plan: string | null,
  snapshot: UsageSnapshot | null,
  planWidth = 3,
  opts?: FormatUsageSummaryOpts
): string {
  const parts: string[] = [];

  if (plan) {
    parts.push(chalk.gray(plan.padEnd(planWidth)));
  }

  if (snapshot) {
    // Compact rows show BLOCKING windows — the same set
    // deriveUsageStatusFromSnapshot uses for the rate-limited badge — so an
    // account throttled by its month window (Droid meters on 5h/week/month)
    // shows the bar that explains why. Claude's Sonnet week is a per-model
    // sub-limit, not a blocking window; it renders only in the full
    // per-version usage section. Each window reads "S: ███░░ 58% (3d)" — the
    // gauge, the exact percentage, and a compact hint of when it resets.
    //
    // Overview caps the window count (see pickCompactUsageWindows) so one
    // multi-meter agent cannot force the whole table to wrap.
    const selected = pickCompactUsageWindows(snapshot.windows, opts?.maxWindows);
    const hidden = Math.max(
      0,
      snapshot.windows.filter((w) => w.key !== 'sonnet_week').length - selected.length,
    );
    const windowParts = selected.map((window) => {
      const bar = renderCompactUsageBar(window.usedPercent);
      const pct = colorUsage(`${Math.round(window.usedPercent)}%`, window.usedPercent);
      const reset = window.resetsAt ? chalk.dim(` (${formatResetHint(window.resetsAt)})`) : '';
      return `${chalk.gray(`${window.shortLabel}:`)} ${bar} ${pct}${reset}`;
    });
    if (hidden > 0) {
      windowParts.push(chalk.dim(`+${hidden}`));
    }
    if (windowParts.length > 0) {
      parts.push(windowParts.join('  '));
    }
    // The bars came from the cache and the live read that should have confirmed
    // them failed, so they are the last thing we saw — not the current state.
    // Drawing them unmarked is what let a 26h-old "48% used" read as fact.
    // Headless-scope (RUSH-2392) is a known permanent gap, not a flaky cache:
    // prefer that label over the generic "unverified" so operators do not re-mint.
    if (opts?.headless) {
      parts.push(chalk.dim(USAGE_HEADLESS_SCOPE_MARKER));
    } else if (opts?.unverified) {
      parts.push(chalk.yellow('unverified'));
    }
  } else if (opts?.headless) {
    // No bars at all: still name the scope gap so "usage pending" is not
    // mistaken for a missing setup-token or seeding failure (RUSH-2392).
    parts.push(chalk.dim(USAGE_HEADLESS_SCOPE_MARKER));
  } else if (opts?.unavailable) {
    // Signed-in account we could NOT fetch usage for (no live token in a reachable
    // home / org mismatch / fetch error). Say so explicitly instead of drawing a
    // blank gauge that reads like "0% used".
    parts.push(chalk.dim('usage unavailable'));
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

/** A prior sample of one window's utilization, for burn-rate projection. */
export interface UsagePriorSample {
  /** Epoch ms the prior snapshot was captured. */
  capturedAt: number;
  /** The session window's `usedPercent` in that prior snapshot. */
  usedPercent: number;
}

/**
 * An account's throttle state PLUS how long until it caps, projected from the
 * burn rate on its 5-hour `session` window — the window that throttles the next
 * request soonest. `deriveUsageStatusFromSnapshot` answers only "maxed right
 * now (100%)?"; this answers "and how close is it getting?", so routing can
 * deprioritize an account burning toward its cap before it actually hits it,
 * instead of treating 85%-and-climbing the same as 85%-and-idle.
 *
 * `minutesToLimit`:
 *   - `0`      — already rate-limited (a blocking window at 100%).
 *   - `n > 0`  — projected minutes until the session window reaches 100%, from
 *                `(100 - used) / burnRatePerMinute`, where the burn rate is
 *                measured between `prev` and this snapshot.
 *   - `null`   — unknown: no snapshot, no session window, no prior sample, or
 *                usage flat/falling since `prev` (a reset or an idle account is
 *                not "projected to cap", so it is NOT deprioritized).
 *
 * Pure: the daemon's refresher supplies `prev` from the last snapshot it stored
 * (`usage-refresh.ts`); the routing hot path reads the daemon-computed result
 * from the headroom cache rather than recomputing (it has no `prev`).
 */
export interface UsageHeadroom {
  status: 'available' | 'rate_limited' | null;
  minutesToLimit: number | null;
}

export function deriveUsageHeadroom(
  snapshot: UsageSnapshot | null | undefined,
  prev?: UsagePriorSample | null,
): UsageHeadroom {
  const status = deriveUsageStatusFromSnapshot(snapshot);
  if (!snapshot || status === null) return { status, minutesToLimit: null };
  if (status === 'rate_limited') return { status, minutesToLimit: 0 };

  const session = snapshot.windows.find((window) => window.key === 'session');
  const capturedAt = snapshot.capturedAt?.getTime();
  if (!session || capturedAt === undefined || !prev) {
    return { status, minutesToLimit: null };
  }

  const deltaPercent = session.usedPercent - prev.usedPercent;
  const deltaMinutes = (capturedAt - prev.capturedAt) / 60_000;
  // Flat, falling (a window reset), or a zero/negative time delta: no live burn
  // to project from, so this account is not "projected to cap".
  if (deltaPercent <= 0 || deltaMinutes <= 0) return { status, minutesToLimit: null };

  const burnPerMinute = deltaPercent / deltaMinutes;
  const remaining = Math.max(0, 100 - session.usedPercent);
  return { status, minutesToLimit: remaining / burnPerMinute };
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
    // Codex usage is read from on-disk session transcripts, which carry no
    // account identity and are not removed on logout. To keep the bar scoped to
    // the account signed in NOW, floor the scan at the current login time: the
    // id_token's `auth_time` claim — the OIDC time-of-authentication. A session
    // written before that login belongs to whoever was signed in before (e.g.
    // after `codex logout` + login into a different account), and showing its
    // rate_limits is the "wrong usage after switch" bug.
    //
    // `auth_time` — not the auth.json file mtime — is the correct floor: Codex
    // rewrites auth.json on every token refresh (advancing its mtime), but a
    // refresh_token grant does not re-authenticate the user, so `auth_time`
    // stays at the real login. Flooring on mtime would blank the bar after each
    // background refresh; flooring on `auth_time` does not. No readable
    // credential means the version is signed out — report no usage. A credential
    // that carries no `auth_time` falls back to no floor (prior behavior) rather
    // than hide a signed-in account's usage.
    const base = options?.home || os.homedir();
    let sinceMs: number | undefined;
    try {
      const tokens = (
        JSON.parse(fs.readFileSync(path.join(base, '.codex', 'auth.json'), 'utf-8')) as {
          tokens?: { id_token?: string; access_token?: string };
        }
      ).tokens;
      const authTime = decodeJwtPayload(tokens?.id_token || tokens?.access_token || '')?.auth_time;
      if (typeof authTime === 'number' && authTime > 0) sinceMs = authTime * 1000;
    } catch {
      return { snapshot: null, error: null };
    }

    const files = collectCodexSessionFiles(options?.home, sinceMs);
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

/**
 * The access token to use for a READ-ONLY Claude usage fetch, or null when the
 * stored token is within the refresh leeway.
 *
 * Returns null instead of refreshing on purpose. Claude's refresh token is
 * single-use and rotates server-side on every refresh; with one account signed
 * into several machines, refreshing here would stampede that one token and
 * silently invalidate every other holder — the RUSH-1822 failure, except in the
 * usage path (fired in the background by the SWR cache and by `agents run`'s
 * default "balanced" rotation on every unpinned run) rather than the health
 * probe. So a usage read must never rotate: a near-expiry token yields "no usage
 * right now" instead of a fleet-wide logout. Mirrors {@link probeClaudeStatus};
 * the single legitimate refresh belongs to the actual claude run, never a read.
 * Pure — unit-tested.
 */
export function claudeUsageAccessTokenNoRefresh(
  oauth: Pick<ClaudeOauthCredentials, 'accessToken' | 'expiresAt'>,
): string | null {
  if (claudeAccessTokenNeedsRefresh(oauth.expiresAt ?? null)) return null;
  const token = oauth.accessToken?.trim();
  return token ? token : null;
}

/** Fetch Claude usage via the Anthropic OAuth usage API. */
async function getClaudeUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    // accessTokenCache: this is the every-60s watchdog hot path and usage needs
    // only the access token, so it reads ONLY the file-based setup-token and never
    // the interactive login (reading that ACL-bound token and firing it at the
    // usage API is what got it revoked — RUSH-1822). No setup-token => null =>
    // "usage pending". fileOnly additionally forbids the ACL keychain path.
    const oauth = await loadClaudeOauth(options?.home, {
      accessTokenCache: true,
      fileOnly: options?.fileOnly === true,
    });
    if (!oauth?.accessToken) {
      return { snapshot: null, error: usageNoCredentialError('Claude') };
    }

    const requestedOrgId = normalizeString(options?.organizationId);
    const liveOrgId = normalizeString(oauth.organizationUuid);
    if (!isClaudeUsageOrgMatch(requestedOrgId, liveOrgId)) {
      // Not a fault: this home is signed into a different org than the identity
      // being read, so there is nothing to report for it.
      return { snapshot: null, error: null };
    }

    // Read-only: never refresh a single-use token just to read usage (RUSH-1822).
    const accessToken = claudeUsageAccessTokenNoRefresh(oauth);
    if (!accessToken) {
      return { snapshot: null, error: usageExpiredCredentialError('Claude') };
    }

    // Honour a live Retry-After rather than re-arming the penalty (see
    // usage-backoff.ts). No request at all while the window is open.
    const throttledUntil = usageRateLimitedUntil('claude');
    if (throttledUntil) {
      return { snapshot: null, error: usageThrottledError('Claude', throttledUntil) };
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
      if (response.status === 429) {
        noteUsageRateLimited('claude', response.headers.get('retry-after'));
      }
      // Setup-token is user:inference only; usage needs user:profile → 403
      // with a scope-requirement body. Distinct from a real rejection so the
      // UI does not say "unverified" / re-mint (RUSH-2392).
      if (response.status === 403) {
        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch {
          // ignore — fall through to generic rejection
        }
        if (isClaudeUsageScopeDenied(response.status, bodyText)) {
          return { snapshot: null, error: usageHeadlessScopeError('Claude') };
        }
      }
      return { snapshot: null, error: usageRejectedError('Claude', response.status) };
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
  } catch (err) {
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed, which is the bug this file just closed.
    return { snapshot: null, error: usageUnreachableError('Claude', err) };
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
    if (!credPath) return { snapshot: null, error: usageNoCredentialError('Kimi') };

    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const accessToken = cred?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      return { snapshot: null, error: usageNoCredentialError('Kimi') };
    }

    const expiresAt = typeof cred?.expires_at === 'number' ? cred.expires_at : null;
    if (expiresAt !== null && Date.now() / 1000 >= expiresAt) {
      return { snapshot: null, error: usageExpiredCredentialError('Kimi') };
    }

    // Honour a live Retry-After rather than re-arming the penalty (see
    // usage-backoff.ts). No request at all while the window is open.
    const throttledUntil = usageRateLimitedUntil('kimi');
    if (throttledUntil) {
      return { snapshot: null, error: usageThrottledError('Kimi', throttledUntil) };
    }

    const response = await fetch(KIMI_USAGES_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    // 401/403 => expired token, 404 => no Kimi For Coding subscription. Either
    // way there are no bars to draw, and the status is what tells them apart.
    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('kimi', response.headers.get('retry-after'));
      }
      return { snapshot: null, error: usageRejectedError('Kimi', response.status) };
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
  } catch (err) {
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed, which is the bug this file just closed.
    return { snapshot: null, error: usageUnreachableError('Kimi', err) };
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

/** Response shape from Factory.ai's billing limits endpoint (subset we render). */
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
 * Fetch Droid usage via Factory.ai's billing limits API — the same endpoint the
 * droid CLI polls for its token-limit banner. The WorkOS access token comes
 * from the locally decrypted ~/.factory/auth.v2.file (the same credential
 * account identity in agents.ts reads).
 *
 * Deliberately NO token refresh, for a sharper reason than Kimi's: WorkOS
 * refresh tokens are single-use and rotate on every exchange, so refreshing
 * here would race a concurrently running droid session and can permanently
 * invalidate the user's login chain. Droid refreshes its own credential when
 * it runs; if the stored token is expired we skip the live fetch and let the
 * SWR cache serve the last-seen snapshot. This same single-use-rotation property
 * is why `agents apply` refuses to propagate droid credentials across machines
 * (see `isCredentialSafeToPropagate` in `../fleet/auth-sync.ts`).
 */
async function getDroidUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const cred = decryptDroidAuthPayload(options?.home || os.homedir());
    const accessToken = cred?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      return { snapshot: null, error: usageNoCredentialError('Droid') };
    }

    const exp = decodeJwtPayload(accessToken)?.exp;
    if (typeof exp === 'number' && Date.now() / 1000 >= exp) {
      return { snapshot: null, error: usageExpiredCredentialError('Droid') };
    }

    // Honour a live Retry-After rather than re-arming the penalty (see
    // usage-backoff.ts). No request at all while the window is open.
    const throttledUntil = usageRateLimitedUntil('droid');
    if (throttledUntil) {
      return { snapshot: null, error: usageThrottledError('Droid', throttledUntil) };
    }

    const response = await fetch(DROID_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    // 401 => revoked/expired token. No bars to draw, and the status says why.
    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('droid', response.headers.get('retry-after'));
      }
      return { snapshot: null, error: usageRejectedError('Droid', response.status) };
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
  } catch (err) {
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed, which is the bug this file just closed.
    return { snapshot: null, error: usageUnreachableError('Droid', err) };
  }
}

/**
 * Live auth probes — the same authenticated GET the usage fetchers above do,
 * but surfacing the raw HTTP status instead of swallowing 401/expired to null.
 * These back `agents fleet ping` and the fleet auth-health cache: completing a
 * real request is the only proof a token is accepted. The local "signed in"
 * flag cannot tell a revoked-but-unexpired token from a good one. Classification
 * of the returned status into a verdict lives in lib/auth-health.ts (kept there
 * so it stays pure/testable and to avoid an import cycle).
 */
export interface ProviderProbe {
  /** HTTP status of the probe request, or null when no request was made (missing/expired token) or the request threw. */
  status: number | null;
  /** Local credential state observed before the request. */
  token: 'present' | 'missing' | 'expired';
  /** Network/parse error message when status is null but a token was present. */
  error?: string;
  /**
   * Known non-revocation cause for a non-2xx status.
   * `usage_scope` — Anthropic returned 403 because the setup-token lacks
   * `user:profile` (RUSH-2392). Token is valid for inference; usage is unreadable.
   * Auth-health MUST NOT map this to `revoked`.
   */
  reason?: 'usage_scope';
}

/** Probe Claude's OAuth token against the usage endpoint. Never refreshes — reports `expired` for a near-expiry token; see the comment below (RUSH-1822). */
export async function probeClaudeStatus(home?: string, cliVersion?: string | null): Promise<ProviderProbe> {
  // accessTokenCache: the daemon warms this probe every ~3 min per account, so it
  // reads ONLY the file-based setup-token and never the interactive login —
  // transmitting that ACL-bound token to the usage API from a background loop is
  // what got it revoked (RUSH-1822). No setup-token => token 'missing' below.
  const oauth = await loadClaudeOauth(home, { accessTokenCache: true });
  const accessToken = oauth?.accessToken?.trim();
  if (!accessToken) return { status: null, token: 'missing' };
  // Never refresh from a health probe. Claude's refresh token is single-use and
  // rotates on every refresh; with one account signed into several machines the
  // daemon's every-3-min fleet-cache warm (probeLocalFleetAuth -> here) would
  // stampede that one rotating token and silently invalidate every other
  // holder, dropping the fleet to "run /login" (RUSH-1822). Mirror the sibling
  // Kimi/Droid probes, which never refresh: if the stored token is within the
  // refresh leeway of expiry, report the non-fatal `expired` state ("would need
  // a refresh") instead of rotating it, and leave the single legitimate refresh
  // to the run/usage hot path (getClaudeAccessToken).
  if (claudeAccessTokenNeedsRefresh(oauth?.expiresAt ?? null)) {
    return { status: null, token: 'expired' };
  }
  // A probe is a request like any other: while the provider's Retry-After
  // window is open, report the throttle from the recorded state instead of
  // firing again and re-arming it (usage-backoff.ts). This 3-min-cadence
  // probe is what created the loop it now respects.
  if (usageRateLimitedUntil('claude')) return { status: 429, token: 'present' };
  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
        'User-Agent': getClaudeUserAgent(cliVersion),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 429) {
      noteUsageRateLimited('claude', response.headers.get('retry-after'));
    }
    // Setup-token is user:inference only; usage needs user:profile → 403.
    // That is NOT a revocation — the account still runs (RUSH-2392).
    if (response.status === 403) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        // Body unreadable: fall through to a bare 403 (classified as revoked).
      }
      if (isClaudeUsageScopeDenied(response.status, bodyText)) {
        return {
          status: 403,
          token: 'present',
          reason: 'usage_scope',
          error: USAGE_HEADLESS_SCOPE_MARKER,
        };
      }
    }
    return { status: response.status, token: 'present' };
  } catch (err) {
    return { status: null, token: 'present', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Probe Kimi's OAuth token against the /usages endpoint. Never refreshes (single-use rotation — see getKimiUsageInfo). */
export async function probeKimiStatus(home?: string): Promise<ProviderProbe> {
  const credPath = resolveKimiCredentialPath(home);
  if (!credPath) return { status: null, token: 'missing' };
  let accessToken: string | undefined;
  let expiresAt: number | null = null;
  try {
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    accessToken = typeof cred?.access_token === 'string' ? cred.access_token : undefined;
    expiresAt = typeof cred?.expires_at === 'number' ? cred.expires_at : null;
  } catch {
    return { status: null, token: 'missing' };
  }
  if (!accessToken) return { status: null, token: 'missing' };
  if (expiresAt !== null && Date.now() / 1000 >= expiresAt) return { status: null, token: 'expired' };
  // A probe is a request like any other: while the provider's Retry-After
  // window is open, report the throttle from the recorded state instead of
  // firing again and re-arming it (usage-backoff.ts). This 3-min-cadence probe
  // is what created the loop it now respects. It sits AFTER the local
  // missing/expired checks — as in probeClaudeStatus and probeDroidStatus — so
  // a genuinely broken credential is never misreported as merely throttled.
  if (usageRateLimitedUntil('kimi')) return { status: 429, token: 'present' };
  try {
    const response = await fetch(KIMI_USAGES_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 429) {
      noteUsageRateLimited('kimi', response.headers.get('retry-after'));
    }
    return { status: response.status, token: 'present' };
  } catch (err) {
    return { status: null, token: 'present', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Probe Droid's WorkOS token against the billing-limits endpoint. Never refreshes (single-use rotation — see getDroidUsageInfo). */
export async function probeDroidStatus(home?: string): Promise<ProviderProbe> {
  const cred = decryptDroidAuthPayload(home || os.homedir());
  const accessToken = cred?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) return { status: null, token: 'missing' };
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp === 'number' && Date.now() / 1000 >= exp) return { status: null, token: 'expired' };
  // A probe is a request like any other: while the provider's Retry-After
  // window is open, report the throttle from the recorded state instead of
  // firing again and re-arming it (usage-backoff.ts). This 3-min-cadence
  // probe is what created the loop it now respects.
  if (usageRateLimitedUntil('droid')) return { status: 429, token: 'present' };
  try {
    const response = await fetch(DROID_USAGE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 429) {
      noteUsageRateLimited('droid', response.headers.get('retry-after'));
    }
    return { status: response.status, token: 'present' };
  } catch (err) {
    return { status: null, token: 'present', error: err instanceof Error ? err.message : String(err) };
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

/**
 * Collect Codex JSONL session files sorted newest-first.
 *
 * `sinceMs` drops files modified before it. Codex session transcripts are not
 * tagged with the account that wrote them, so this mtime floor is how usage is
 * kept account-scoped: a session older than the current login belongs to a
 * prior account (see {@link getCodexUsageInfo}).
 */
function collectCodexSessionFiles(home?: string, sinceMs?: number): string[] {
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
    if (sinceMs !== undefined && stat.mtimeMs < sinceMs) continue;
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
  return [rateLimits.primary, rateLimits.secondary]
    .map(normalizeCodexWindow)
    .filter((window): window is UsageWindow => window !== null)
    .sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
}

/** Normalize a single Codex rate-limit window. */
function normalizeCodexWindow(window: CodexRateLimitWindow | null | undefined): UsageWindow | null {
  const usedPercent = normalizePercent(window?.used_percent);
  if (usedPercent === null) return null;

  const windowMinutes = normalizeWindowMinutes(window?.window_minutes);
  const { key, label, shortLabel } = classifyCodexWindow(windowMinutes);

  return {
    key,
    label,
    shortLabel,
    usedPercent,
    resetsAt: parseDateValue(window?.resets_at),
    windowMinutes,
  };
}

/** Codex assigns quota windows to primary/secondary by plan, so duration carries their meaning. */
function classifyCodexWindow(windowMinutes: number | null): Pick<UsageWindow, 'key' | 'label' | 'shortLabel'> {
  if (windowMinutes !== null && windowMinutes >= 28 * 24 * 60) {
    return { key: 'month', label: 'Current month', shortLabel: 'M' };
  }
  if (windowMinutes !== null && windowMinutes >= 7 * 24 * 60) {
    return { key: 'week', label: 'Current week', shortLabel: 'W' };
  }
  return { key: 'session', label: 'Current session', shortLabel: 'S' };
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

// ── Stale no-ACL Claude OAuth cache eviction (retired subsystem) ──
//
// Earlier versions cached Claude's OAuth ACCESS token in a device-local no-ACL
// keychain item so a read-only usage/probe read wouldn't pop the macOS Touch ID
// prompt that the ACL-bound source item (`Claude Code-credentials-<hash>`) forces.
// That cache is retired: read-only probes now authenticate ONLY with a file-based
// setup-token and never read the interactive login (see loadClaudeOauth), so
// nothing populates the cache anymore. deleteCachedClaudeOauth remains — a
// credential rotation still evicts a stale item an earlier version may have
// written, so an old no-ACL copy of the interactive token can't linger.
const CLAUDE_OAUTH_CACHE_PREFIX = 'agents-cli.claude-oauth-cache.';

/** The no-ACL cache item name for a Claude keychain service (hashed to stay tidy). */
function claudeOauthCacheItem(service: string): string {
  const hash = createHash('sha256').update(service).digest('hex').slice(0, 16);
  return `${CLAUDE_OAUTH_CACHE_PREFIX}${hash}`;
}

/**
 * Evict any no-ACL access-token cache item so a source rotation or sign-out is
 * reflected immediately. The cache itself is retired — read-only probes no longer
 * read or write it (loadClaudeOauth returns a file-based setup-token or nothing) —
 * but this eviction remains so a credential rotation still clears a stale cache
 * item that an earlier agents-cli version may have written no-ACL.
 */
function deleteCachedClaudeOauth(service: string): void {
  try {
    deleteKeychainToken(claudeOauthCacheItem(service));
  } catch {
    /* best-effort — cache is an optimization */
  }
}

/**
 * Load a version home's Claude OAuth credential from the two stores Claude Code
 * uses, tried in order:
 *
 *  1. The OS keychain (`getKeychainToken`). Canonical on macOS — Claude Code
 *     writes the token to the login keychain and we read it via `/usr/bin/security`.
 *  2. `<home>/.claude/.credentials.json`. On a headless Linux box (the
 *     `agents view --device <linux>` case) there is no reachable Secret Service, so
 *     the Claude CLI stores its OAuth token in this plaintext file instead. The
 *     keychain read above finds nothing on that platform, so we fall back to the
 *     file. Same wrapped `{ claudeAiOauth }` shape, so one parser handles both.
 *
 * Without step 2 the live usage fetch got no token on Linux, so `agents view`
 * (run remotely over SSH by `--device`) rendered no usage bars even though the
 * account + plan — read from the plaintext `.claude.json` — showed fine.
 *
 * `opts.accessTokenCache` marks a read-only, access-token-only consumer (the
 * usage fetch and the auth-health probe). Such a caller authenticates ONLY with
 * a file-based setup-token and, when none is provisioned, gets `null` — it never
 * reads Claude Code's interactive login (transmitting that ACL-bound OAuth token
 * to Anthropic's API is what gets it revoked; see the branch body and
 * docs/credential-management.md). It is OFF by default so full-credential
 * callers that refresh (`isClaudeAuthValid` -> `getClaudeAccessToken`) still
 * read the interactive login. Rush Cloud dispatch does not call this helper
 * at all (SING-1b: the account manifest is email-only; RUSH-2359 removed the
 * leftover blob reader that used to send the interactive login).
 *
 * `opts.fileOnly` skips the ACL keychain read entirely — setup-token and
 * `.credentials.json` only. Used by the daemon usage refresher so a background
 * tick can never pop Touch ID.
 */
export async function loadClaudeOauth(
  home?: string,
  opts?: { accessTokenCache?: boolean; fileOnly?: boolean }
): Promise<ClaudeOauthCredentials | null> {
  // Read-only usage/probe callers (accessTokenCache) authenticate ONLY with a
  // file-based setup-token from the `auth` bundle — never Claude Code's
  // interactive login. The usage endpoint accepts any sk-ant-oat01 bearer, and
  // the file-based token never pops Touch ID. When no setup-token is provisioned
  // the probe reports unprovisioned rather than reading the interactive
  // credential (see below) — that is the whole point of this branch.
  if (opts?.accessTokenCache === true) {
    const setupToken = resolveClaudeSetupToken(home);
    if (setupToken) {
      // No expiresAt: a setup-token is long-lived and non-rotating, and a null
      // expiry reads as "still fresh" (claudeAccessTokenNeedsRefresh) so the
      // probe never reports it expired or tries to refresh it. The endpoint is
      // the source of truth if it has actually been revoked.
      return { accessToken: setupToken };
    }
    // No provisioned setup-token: a read-only usage/health probe MUST NOT fall
    // through to Claude Code's interactive login credential. The daemon's usage
    // (~60s) and auth-health (~3min) warms would otherwise read the ACL-bound
    // OAuth token and transmit it to api.anthropic.com/api/oauth/usage — an
    // interactive credential used programmatically, which Anthropic flags and
    // revokes (the fleet-wide-logout class, RUSH-1822), and which violates the
    // invariant that the interactive/rotating login is untouchable
    // (docs/credential-management.md). Report unprovisioned (-> probe
    // token 'missing' -> auth-health 'unconfigured', benign for rotation); seed a
    // setup-token via the mint-auth path to restore usage/probe for the account.
    return null;
  }

  // Full-credential callers (isClaudeAuthValid -> getClaudeAccessToken)
  // legitimately read the interactive login to run/refresh Claude. Rush Cloud
  // dispatch does not (SING-1b / RUSH-2359). The OS keychain/keyring step is
  // macOS/Linux-only; Windows and any
  // fileOnly caller skip to the .credentials.json read below (the Claude CLI
  // stores its OAuth token in that file too). An injected test backend makes the
  // keychain path exercisable anywhere, so the platform check yields to it.
  if (
    !opts?.fileOnly
    && (process.platform === 'darwin' || process.platform === 'linux' || isKeychainBackendOverridden())
  ) {
    const service = getClaudeKeychainService(home);
    try {
      const fromKeychain = parseClaudeOauthPayload(getKeychainToken(service));
      if (fromKeychain) return fromKeychain;
    } catch {
      // No keychain item, or no reachable keyring (headless Linux) — fall through.
    }
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
 * Exported for regression tests; not part of the public command surface.
 */
export async function saveClaudeOauth(
  home: string | undefined,
  credentials: ClaudeOauthCredentials
): Promise<boolean> {
  // Windows not yet supported. An injected test backend is the exception, for
  // the same reason as the loadClaudeOauth guard above: it makes the keychain
  // path exercisable anywhere, and without it this returns before the rotated
  // credential is written OR a stale no-ACL cache item an earlier version wrote
  // is evicted (deleteCachedClaudeOauth) — leaving that stale item behind.
  if (process.platform !== 'darwin' && process.platform !== 'linux' && !isKeychainBackendOverridden()) {
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
    // A new credential rotation means any cached access token is stale.
    deleteCachedClaudeOauth(service);
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
  try {
    ensureLockTarget(cachePath, '{}');
    withFileLock(cachePath, () => {
      // Re-read under the lock so a concurrent daemon tick / agents view
      // refresh cannot drop another account's row (lost update).
      const cache = readClaudeUsageCacheFile(cachePath);
      cache[usageKey] = serializeClaudeUsageSnapshot(snapshot);
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    });
  } catch {
    /* best-effort cache write — lock busy or disk full */
  }
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
    atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
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

/**
 * Deserialize a cached snapshot, dropping windows whose reset time has passed.
 *
 * An expired window is UNKNOWN, not 0%: the counter reset, and anything may
 * have burned since. Zeroing-but-keeping it (the previous behavior) rendered a
 * weeks-frozen cache as "S: 0% (now)" with `deriveUsageStatusFromSnapshot` →
 * 'available', so a genuinely rate-limited account read as an idle dispatch
 * candidate (RUSH-2858). Dropping mirrors the Grok collector, and an all-expired
 * snapshot deserializes to null so `readClaudeUsageCache` deletes the entry and
 * callers surface "usage unavailable" plus the recorded throttle reason.
 */
function deserializeClaudeUsageSnapshot(
  snapshot: CachedUsageSnapshot,
  now: Date
): UsageSnapshot | null {
  const capturedAt = parseDateValue(snapshot.capturedAt);
  const windows = snapshot.windows
    .map((window) => ({
      key: window.key,
      label: window.label,
      shortLabel: window.shortLabel,
      usedPercent: window.usedPercent,
      resetsAt: parseDateValue(window.resetsAt),
      windowMinutes: window.windowMinutes,
    }))
    .filter((window) => isCachedUsageWindowFresh(window, capturedAt, now));

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

  if (!claudeAccessTokenNeedsRefresh(oauth.expiresAt ?? null)) {
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
export function renderBar(usedPercent: number, length: number, minimumVisible = 0): string {
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
export function getUsageColor(usedPercent: number): (text: string) => string {
  if (usedPercent >= 100) return chalk.red;
  if (usedPercent >= 80) return chalk.yellow;
  return chalk.cyan;
}

/** Format a percentage value with at most one decimal place. */
function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Compact "time until reset" hint for the inline usage bars: "5m", "2h", "3d",
 * or "now" once elapsed. Deliberately coarse (single unit, whole numbers) so it
 * fits after a bar without wrapping the row — the detailed section
 * (`formatResetAt`) carries the precise clock time.
 */
function formatResetHint(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
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

/** Parse the latest billing info from Grok's unified log. */
async function getGrokUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const base = options?.home || os.homedir();
    const logPath = path.join(base, '.grok', 'logs', 'unified.jsonl');
    if (!fs.existsSync(logPath)) return { snapshot: null, error: null };

    const match = await readLatestGrokBilling(logPath);
    if (!match) return { snapshot: null, error: null };

    // Grok has no live usage API (`network: false`) — bars are last-seen from
    // this machine's unified.jsonl only. Drop windows whose billing period has
    // already ended so a stale 100% does not paint "rate-limited" after reset,
    // and so an expired 92% on one box cannot disagree with a fresh reading on
    // another. Missing `creditUsagePercent` never reaches here as a 0% bar
    // (see readLatestGrokBilling).
    const now = new Date();
    const windows = match.windows.filter((window) =>
      isCachedUsageWindowFresh(window, match.capturedAt, now)
    );

    return {
      snapshot: {
        source: 'last_seen',
        sourceLabel: 'last seen in Grok logs',
        capturedAt: match.capturedAt,
        windows,
        plan: match.subscriptionTier,
      },
      error: null,
    };
  } catch {
    return { snapshot: null, error: null };
  }
}

/**
 * Muse Code usage.
 *
 * Prefer live Meta Model API rate-limit headers when a key is available
 * (META_API_KEY / MODEL_API_KEY / ~/.config/muse/auth.json). Fall back to
 * aggregating `model_completed.usage` from local session.jsonl logs under
 * ~/.local/share/muse/sessions for a last-7-days token window.
 */
async function getMuseUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const base = options?.home || os.homedir();
    const live = await probeMuseRateLimits(base);
    if (live) return { snapshot: live, error: null };

    const local = await readMuseLocalSessionUsage(base);
    if (!local) return { snapshot: null, error: null };
    return { snapshot: local, error: null };
  } catch {
    return { snapshot: null, error: null };
  }
}

/** Resolve a Muse API key from env or auth.json without logging the value. */
function resolveMuseApiKey(base: string): string | null {
  const envKey = process.env.META_API_KEY?.trim() || process.env.MODEL_API_KEY?.trim();
  if (envKey) return envKey;
  const authPath = path.join(base, '.config', 'muse', 'auth.json');
  try {
    if (!fs.existsSync(authPath)) return null;
    const data = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as Record<string, unknown>;
    if (typeof data.access_token === 'string' && data.access_token) return data.access_token;
    if (typeof data.api_key === 'string' && data.api_key) return data.api_key;
    for (const slot of Object.values(data)) {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue;
      const entry = slot as Record<string, unknown>;
      if (typeof entry.access_token === 'string' && entry.access_token) return entry.access_token;
      if (typeof entry.api_key === 'string' && entry.api_key) return entry.api_key;
    }
  } catch {
    /* unreadable auth */
  }
  return null;
}

/**
 * Probe Meta Model API for rate-limit headers. Uses GET /v1/models (no token
 * spend). Returns null when unauthenticated or the headers are absent.
 */
async function probeMuseRateLimits(base: string): Promise<UsageSnapshot | null> {
  if (usageRateLimitedUntil('muse')) return null;
  const key = resolveMuseApiKey(base);
  if (!key) return null;
  try {
    const response = await fetch('https://api.meta.ai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 429) {
      noteUsageRateLimited('muse', response.headers.get('retry-after'));
      return null;
    }
    if (!response.ok) return null;

    const limitTokens = headerNumber(response.headers, 'x-ratelimit-limit-tokens');
    const remainingTokens = headerNumber(response.headers, 'x-ratelimit-remaining-tokens');
    const limitRequests = headerNumber(response.headers, 'x-ratelimit-limit-requests');
    const remainingRequests = headerNumber(response.headers, 'x-ratelimit-remaining-requests');

    const windows: UsageWindow[] = [];
    if (limitTokens !== null && remainingTokens !== null && limitTokens > 0) {
      const used = Math.max(0, Math.min(100, ((limitTokens - remainingTokens) / limitTokens) * 100));
      windows.push({
        key: 'session',
        label: 'Tokens (current window)',
        shortLabel: 'Tok',
        usedPercent: used,
        resetsAt: null,
        windowMinutes: 1,
      });
    }
    if (limitRequests !== null && remainingRequests !== null && limitRequests > 0) {
      const used = Math.max(0, Math.min(100, ((limitRequests - remainingRequests) / limitRequests) * 100));
      windows.push({
        key: 'session',
        label: 'Requests (current window)',
        shortLabel: 'Req',
        usedPercent: used,
        resetsAt: null,
        windowMinutes: 1,
      });
    }
    if (windows.length === 0) return null;
    return {
      source: 'live',
      sourceLabel: 'Meta Model API rate limits',
      capturedAt: new Date(),
      windows,
      plan: 'Meta Model API',
    };
  } catch {
    return null;
  }
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Aggregate Muse session token usage from local session.jsonl files for the
 * last 7 days. Scales the bar against 10M tokens (soft visibility scale — Meta
 * is pay-as-you-go with no hard local cap).
 */
async function readMuseLocalSessionUsage(base: string): Promise<UsageSnapshot | null> {
  const root = path.join(base, '.local', 'share', 'muse', 'sessions');
  if (!fs.existsSync(root)) return null;

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let latestAt: Date | null = null;
  let files = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (ent.name !== 'session.jsonl') continue;
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) continue;
        files++;
        if (!latestAt || st.mtime > latestAt) latestAt = st.mtime;
        const content = fs.readFileSync(full, 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          let raw: any;
          try {
            raw = JSON.parse(line);
          } catch {
            continue;
          }
          const event = raw?.payload?.event ?? raw?.payload;
          if (!event || event.kind !== 'model_completed') continue;
          const usage = event.usage;
          if (!usage || typeof usage !== 'object') continue;
          if (typeof usage.input_tokens === 'number') inputTokens += usage.input_tokens;
          if (typeof usage.output_tokens === 'number') outputTokens += usage.output_tokens;
          if (typeof usage.cached_tokens === 'number') cachedTokens += usage.cached_tokens;
        }
      } catch {
        /* skip unreadable session */
      }
    }
  };
  walk(root);

  const total = inputTokens + outputTokens + cachedTokens;
  if (total === 0 && files === 0) return null;

  // Soft 10M-token scale for the bar (pay-as-you-go has no hard local cap).
  const softCap = 10_000_000;
  const usedPercent = Math.max(0, Math.min(100, (total / softCap) * 100));
  const formatK = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return {
    source: 'last_seen',
    sourceLabel: `local Muse sessions · ${formatK(total)} tokens (7d)`,
    capturedAt: latestAt,
    windows: [
      {
        key: 'week',
        label: 'Local tokens (7d)',
        shortLabel: '7d',
        usedPercent,
        resetsAt: null,
        windowMinutes: 7 * 24 * 60,
      },
    ],
    plan: 'Meta Model API',
  };
}

interface GrokBillingMatch {
  capturedAt: Date | null;
  subscriptionTier?: string | null;
  windows: UsageWindow[];
}

async function readLatestGrokBilling(filePath: string): Promise<GrokBillingMatch | null> {
  return new Promise((resolve) => {
    let latest: GrokBillingMatch | null = null;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.msg === 'billing: fetched credits config' && parsed.ctx?.config) {
          const config = parsed.ctx.config;
          const windows: UsageWindow[] = [];

          if (config.currentPeriod?.end && typeof config.creditUsagePercent === 'number') {
            // `creditUsagePercent` is Grok's weekly credit consumption (0-100);
            // the billing period's `end` is when that window resets.
            // Do NOT coerce a missing percent to 0 — a new period often lands a
            // billing line before the gauge is populated, and inventing 0% makes
            // `agents view` disagree across devices (and looks like a fresh week).
            const rawPercent = config.creditUsagePercent;
            windows.push({
              key: 'week',
              label: 'Current week',
              shortLabel: 'W',
              usedPercent: Math.max(0, Math.min(100, rawPercent)),
              resetsAt: parseDateValue(config.currentPeriod.end),
              windowMinutes: inferWindowMinutes('week'),
            });
          }

          latest = {
            capturedAt: parseDateValue(parsed.ts),
            subscriptionTier: parsed.ctx.subscriptionTier || null,
            windows,
          };
        }
      } catch {
        /* malformed session line */
      }
    });

    rl.on('close', () => resolve(latest));
    rl.on('error', () => resolve(latest));
  });
}

/** Per-model bucket in Cursor's /api/usage response. */
interface CursorUsageModel {
  numRequests?: number | null;
  maxRequestUsage?: number | null;
}

/** Response shape from Cursor's dashboard usage endpoint. */
export interface CursorUsageResponse {
  /** The premium ("fast request") bucket the plan meters. */
  'gpt-4'?: CursorUsageModel | null;
  /** ISO timestamp the monthly request window resets from. */
  startOfMonth?: string | null;
  [model: string]: CursorUsageModel | string | null | undefined;
}

/**
 * Normalize Cursor's /api/usage payload into the common UsageWindow shape.
 *
 * Only free / legacy request-capped plans carry a `maxRequestUsage` on the
 * premium ("gpt-4") bucket — that's the fast-request cap the plan meters, and it
 * maps cleanly to a monthly window. Usage-based plans report `maxRequestUsage:
 * null` (no request cap — spend is metered in dollars instead), so they have no
 * bar to draw here and return no windows rather than a misleading empty gauge.
 */
export function normalizeCursorUsage(data: CursorUsageResponse): UsageWindow[] {
  const premium = data['gpt-4'];
  if (!premium || typeof premium !== 'object') return [];
  const max = premium.maxRequestUsage;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return [];
  const used = typeof premium.numRequests === 'number' ? premium.numRequests : 0;

  const startOfMonth =
    typeof data.startOfMonth === 'string' ? parseDateValue(data.startOfMonth) : null;
  // The request quota resets one calendar month after the period start. Guard the
  // month-end overflow: setMonth on a day the target month lacks (Jan 31 -> Feb 31)
  // rolls forward into the month after (Mar 3), so clamp back to the intended
  // month's last day.
  let resetsAt: Date | null = null;
  if (startOfMonth) {
    resetsAt = new Date(startOfMonth);
    const intendedMonth = (resetsAt.getMonth() + 1) % 12;
    resetsAt.setMonth(resetsAt.getMonth() + 1);
    if (resetsAt.getMonth() !== intendedMonth) resetsAt.setDate(0);
  }

  return [
    {
      key: 'month',
      label: 'Current month',
      shortLabel: 'M',
      usedPercent: Math.max(0, Math.min(100, (used / max) * 100)),
      resetsAt,
      windowMinutes: inferWindowMinutes('month'),
    },
  ];
}

/** Per-window plan usage percentages Cursor's dashboard breaks usage into (Auto+Composer / API / Total). */
interface CursorPlanUsage {
  autoPercentUsed?: number | null;
  apiPercentUsed?: number | null;
  totalPercentUsed?: number | null;
}

/** Response shape from Cursor's dashboard current-period-usage endpoint (subset we render). */
export interface CursorPeriodUsageResponse {
  planUsage?: CursorPlanUsage | null;
  /** ISO timestamp, or a unix-ms string, marking the end of the current billing cycle. */
  billingCycleEnd?: string | number | null;
}

/** Response shape from Cursor's usage-summary endpoint (subset we render). */
export interface CursorUsageSummaryResponse {
  /** True on a plan with no consumption cap; only tiered self-serve plans populate the percent fields. */
  isUnlimited?: boolean | null;
  individualUsage?: {
    plan?: CursorPlanUsage | null;
  } | null;
  billingCycleEnd?: string | number | null;
}

/**
 * Normalize a single Cursor percent-based window (auto/api/total), or null when
 * the percent is not a finite number — the "no empty gauges" rule.
 * `windowMinutes` stays null: every window shares one billing-cycle reset
 * (`resetsAt`, from the explicit `billingCycleEnd`), not an inferred cadence, so
 * inferring one from the (repurposed) `session`/`week`/`month` key would let the
 * SWR cache zero the bar out long before the real reset.
 */
function normalizeCursorPercentWindow(
  percent: number | null | undefined,
  key: UsageWindowKey,
  label: string,
  shortLabel: string,
  resetsAt: Date | null,
): UsageWindow | null {
  const usedPercent = normalizePercent(percent);
  if (usedPercent === null) return null;
  return { key, label, shortLabel, usedPercent, resetsAt, windowMinutes: null };
}

/**
 * Normalize Cursor's dashboard `get-current-period-usage` payload — the
 * primary usage source, giving the same Auto+Composer / API / Total breakdown
 * the web dashboard shows.
 */
export function normalizeCursorPeriodUsage(data: CursorPeriodUsageResponse): UsageWindow[] {
  const resetsAt = parseDateValue(data.billingCycleEnd);
  const plan = data.planUsage;
  const windows = [
    normalizeCursorPercentWindow(plan?.autoPercentUsed, 'session', 'Auto + Composer', 'A', resetsAt),
    normalizeCursorPercentWindow(plan?.apiPercentUsed, 'week', 'API', 'API', resetsAt),
    normalizeCursorPercentWindow(plan?.totalPercentUsed, 'month', 'Total', 'T', resetsAt),
  ];
  return windows.filter((window): window is UsageWindow => window !== null);
}

/**
 * Normalize Cursor's `usage-summary` fallback payload — the same Auto/API/Total
 * breakdown nested under `individualUsage.plan`, used when the primary
 * dashboard endpoint returns no usable `planUsage` (seen on some
 * enterprise/team accounts). An unlimited plan (`isUnlimited: true`) with no
 * usable percent has nothing to draw and returns no windows, rather than a
 * misleading empty gauge.
 */
export function normalizeCursorUsageSummary(data: CursorUsageSummaryResponse): UsageWindow[] {
  const resetsAt = parseDateValue(data.billingCycleEnd);
  const plan = data.individualUsage?.plan;
  const windows = [
    normalizeCursorPercentWindow(plan?.autoPercentUsed, 'session', 'Auto + Composer', 'A', resetsAt),
    normalizeCursorPercentWindow(plan?.apiPercentUsed, 'week', 'API', 'API', resetsAt),
    normalizeCursorPercentWindow(plan?.totalPercentUsed, 'month', 'Total', 'T', resetsAt),
  ];
  return windows.filter((window): window is UsageWindow => window !== null);
}

/** Read Cursor's OAuth access token + config-file subject from the local CLI config/auth files. */
function readCursorCredentials(base: string): { cfgSub: string | null; accessToken: string } | null {
  try {
    const cfgPath = path.join(base, '.cursor', 'cli-config.json');
    const authPath = path.join(base, '.config', 'cursor', 'auth.json');
    if (!fs.existsSync(cfgPath) || !fs.existsSync(authPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const cfgSub = typeof cfg?.authInfo?.authId === 'string' ? cfg.authInfo.authId : null;
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    const accessToken = auth?.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    return { cfgSub, accessToken };
  } catch {
    return null;
  }
}

/**
 * Resolve the OAuth subject Cursor expects in the `WorkosCursorSessionToken`
 * cookie: the access token's own JWT `sub` claim first (the subject that
 * actually signed the token in hand), falling back to the subject
 * `cli-config.json` recorded at login when the token carries no usable `sub`.
 */
function resolveCursorSubject(accessToken: string, cfgSub: string | null): string | null {
  const jwtSub = normalizeString(decodeJwtPayload(accessToken)?.sub);
  return jwtSub || cfgSub;
}

/**
 * POST the dashboard current-period-usage endpoint and normalize its windows.
 * Returns null on any network/auth failure so the caller falls through to the
 * next source — only a genuine empty-windows response distinguishes "no usage
 * to report" from "couldn't reach this source".
 */
async function fetchCursorPeriodWindows(cookie: string): Promise<UsageWindow[] | null> {
  try {
    const response = await fetch(CURSOR_PERIOD_USAGE_URL, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://cursor.com',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('cursor', response.headers.get('retry-after'));
      }
      return null;
    }
    const data = (await response.json()) as CursorPeriodUsageResponse;
    return normalizeCursorPeriodUsage(data);
  } catch {
    return null;
  }
}

/**
 * GET the usage-summary fallback endpoint and normalize its windows. Same
 * null-on-failure contract as {@link fetchCursorPeriodWindows}.
 */
async function fetchCursorUsageSummaryWindows(cookie: string): Promise<UsageWindow[] | null> {
  try {
    const response = await fetch(CURSOR_USAGE_SUMMARY_URL, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('cursor', response.headers.get('retry-after'));
      }
      return null;
    }
    const data = (await response.json()) as CursorUsageSummaryResponse;
    return normalizeCursorUsageSummary(data);
  } catch {
    return null;
  }
}

/**
 * Fetch Cursor usage. Cursor authenticates every one of these requests with a
 * `WorkosCursorSessionToken` cookie of the form `<oauth-subject>::<access-token>`
 * (the same pair the web dashboard sends), not a bearer header, so all three
 * sources below share one resolved cookie.
 *
 * Three sources, tried in order, because no single endpoint carries usable data
 * for every plan shape:
 *
 *  1. `get-current-period-usage` — the primary source, and the richest: the
 *     Auto+Composer / API / Total percent breakdown the dashboard itself shows.
 *  2. `usage-summary` — some enterprise/team accounts return no usable
 *     `planUsage` from (1); this nests the same three percentages under
 *     `individualUsage.plan` instead.
 *  3. The legacy `/api/usage` request-cap endpoint — the original source,
 *     kept as the final fallback for free/legacy plans that predate the
 *     percent-based breakdown above and only ever exposed a monthly request cap.
 *
 * The first source to yield a non-empty window list wins; a source that errors
 * or returns no usable numbers falls through to the next rather than surfacing
 * an error — only the last resort's own response/error is surfaced when every
 * source comes up empty, so a plan enrolled in exactly one billing model still
 * renders instead of reporting three swallowed failures.
 */
async function getCursorUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const base = options?.home || os.homedir();
    const creds = readCursorCredentials(base);
    if (!creds) return { snapshot: null, error: usageNoCredentialError('Cursor') };

    const exp = decodeJwtPayload(creds.accessToken)?.exp;
    if (typeof exp === 'number' && Date.now() / 1000 >= exp) {
      return { snapshot: null, error: usageExpiredCredentialError('Cursor') };
    }

    const sub = resolveCursorSubject(creds.accessToken, creds.cfgSub);
    if (!sub) return { snapshot: null, error: usageNoCredentialError('Cursor') };

    const throttledUntil = usageRateLimitedUntil('cursor');
    if (throttledUntil) {
      return { snapshot: null, error: usageThrottledError('Cursor', throttledUntil) };
    }

    const cookie = `WorkosCursorSessionToken=${sub}%3A%3A${creds.accessToken}`;

    const periodWindows = await fetchCursorPeriodWindows(cookie);
    if (periodWindows && periodWindows.length > 0) {
      return {
        snapshot: { source: 'live', sourceLabel: 'live account data', capturedAt: new Date(), windows: periodWindows },
        error: null,
      };
    }

    const summaryWindows = await fetchCursorUsageSummaryWindows(cookie);
    if (summaryWindows && summaryWindows.length > 0) {
      return {
        snapshot: { source: 'live', sourceLabel: 'live account data', capturedAt: new Date(), windows: summaryWindows },
        error: null,
      };
    }

    const url = `${CURSOR_USAGE_URL}?user=${encodeURIComponent(sub)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    // 401/redirect => revoked/expired session. No bars to draw, and the status
    // says why.
    if (!response.ok) {
      if (response.status === 429) {
        noteUsageRateLimited('cursor', response.headers.get('retry-after'));
      }
      return { snapshot: null, error: usageRejectedError('Cursor', response.status) };
    }

    const data = (await response.json()) as CursorUsageResponse;
    return {
      snapshot: {
        source: 'live',
        sourceLabel: 'live account data',
        capturedAt: new Date(),
        windows: normalizeCursorUsage(data),
      },
      error: null,
    };
  } catch (err) {
    // A thrown request (timeout, DNS, TLS, a malformed payload) is a failed
    // read like any other — staying silent here would hand the caller a stale
    // snapshot to render as confirmed, which is the bug this file just closed.
    return { snapshot: null, error: usageUnreachableError('Cursor', err) };
  }
}

// ---------------------------------------------------------------------------
// Antigravity (`agy`) usage — Google Code Assist per-model quota buckets
// ---------------------------------------------------------------------------

const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Production Code Assist endpoint first; the daily track is where `agy` itself
// points when the account is enrolled in the daily channel (its log shows
// daily-cloudcode-pa), so fall back to it when prod rejects the call.
const ANTIGRAVITY_QUOTA_URLS = [
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
];
// The public installed-app OAuth client the released `agy` binary itself
// ships (Google installed-app clients are non-confidential by design — the
// same client community tooling uses). Needed because a Google token refresh
// requires the client id/secret pair the login was minted under.
const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';
/** Refresh leeway — treat an access token expiring within a minute as expired. */
const ANTIGRAVITY_REFRESH_LEEWAY_MS = 60 * 1000;

/** The OAuth token `agy` stores (inside `{ token: … }`) in the OS keyring or file. */
interface AntigravityOauthToken {
  access_token?: string | null;
  refresh_token?: string | null;
  /** RFC3339 expiry timestamp for the access token. */
  expiry?: string | null;
}

/** One per-model quota bucket from the :retrieveUserQuota response. */
export interface AntigravityQuotaBucket {
  modelId?: string | null;
  tokenType?: string | null;
  remainingFraction?: number | null;
  resetTime?: string | null;
}

/** Response shape from the Code Assist :retrieveUserQuota endpoint. */
export interface AntigravityQuotaResponse {
  buckets?: AntigravityQuotaBucket[] | null;
}

/**
 * Parse a stored `agy` OAuth payload into its token. Handles both on-disk
 * shapes: the raw `{ token: {…} }` JSON (Linux file fallback) and the
 * `go-keyring-base64:<base64>` wrapper zalando/go-keyring writes into the
 * macOS Keychain item (service `gemini`, account `antigravity`). Never throws
 * (malformed input => null).
 */
export function parseAntigravityOauthPayload(raw: string): AntigravityOauthToken | null {
  try {
    let text = raw.trim();
    if (text.startsWith('go-keyring-base64:')) {
      text = Buffer.from(text.slice('go-keyring-base64:'.length), 'base64').toString('utf-8');
    }
    const token = JSON.parse(text)?.token;
    if (!token || typeof token !== 'object') return null;
    if (typeof token.access_token !== 'string' && typeof token.refresh_token !== 'string') {
      return null;
    }
    return token as AntigravityOauthToken;
  } catch {
    return null;
  }
}

/**
 * True when the stored access token is expired (or inside the refresh leeway).
 * A missing/unparseable expiry is treated as still-fresh — the quota call
 * below is the source of truth if the token is actually dead (401 => render
 * nothing), and we never want to force a refresh without evidence.
 */
export function antigravityTokenNeedsRefresh(
  expiry: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!expiry) return false;
  const ms = Date.parse(expiry);
  if (Number.isNaN(ms)) return false;
  return nowMs + ANTIGRAVITY_REFRESH_LEEWAY_MS >= ms;
}

/**
 * Resolve the `agy` OAuth credential file. agy is a self-updating global
 * install (no per-version homes), but check the passed home first and then the
 * active location under the real HOME — mirrors resolveKimiCredentialPath.
 * Present only on Linux without a Secret Service daemon; macOS logins live in
 * the Keychain instead.
 */
function resolveAntigravityCredentialPath(home?: string): string | null {
  const rel = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'];
  const perHome = path.join(home || os.homedir(), ...rel);
  try { if (fs.existsSync(perHome)) return perHome; } catch { /* unreadable */ }
  const active = path.join(process.env.AGENTS_REAL_HOME || os.homedir(), ...rel);
  if (active !== perHome) {
    try { if (fs.existsSync(active)) return active; } catch { /* unreadable */ }
  }
  return null;
}

/**
 * Load the stored `agy` OAuth token: the file fallback first, then the OS
 * keyring (macOS Keychain / Linux Secret Service — go-keyring's two stores;
 * the probe command pair mirrors antigravityOsKeyringProbe in agents.ts, with
 * `-w` on macOS to read the secret value, not just metadata). Returns null on
 * Windows or when no readable credential exists. Honors the
 * AGENTS_NO_KEYCHAIN_PROBE=1 test guard.
 */
async function loadAntigravityOauth(home?: string): Promise<AntigravityOauthToken | null> {
  const credPath = resolveAntigravityCredentialPath(home);
  if (credPath) {
    try {
      const parsed = parseAntigravityOauthPayload(fs.readFileSync(credPath, 'utf-8'));
      if (parsed) return parsed;
    } catch { /* unreadable file — fall through to the keyring */ }
  }

  if (process.env.AGENTS_NO_KEYCHAIN_PROBE === '1') return null;
  const probe =
    process.platform === 'darwin'
      ? { cmd: 'security', args: ['find-generic-password', '-w', '-s', 'gemini', '-a', 'antigravity'] }
      : process.platform === 'linux'
        ? { cmd: 'secret-tool', args: ['lookup', 'service', 'gemini', 'username', 'antigravity'] }
        : null;
  if (!probe) return null;
  try {
    const { stdout } = await execFileAsync(probe.cmd, probe.args, { timeout: 5000 });
    return parseAntigravityOauthPayload(stdout);
  } catch {
    return null;
  }
}

/**
 * Refresh an `agy` access token against Google's token endpoint. This is safe
 * from a read path in a way Claude/WorkOS refreshes are NOT: Google's OAuth
 * refresh tokens are stable and non-rotating — a refresh mints a new access
 * token and leaves the refresh token (and every other live access token)
 * valid, so refreshing here cannot invalidate a concurrently running `agy`.
 * We still never write the refreshed token back: `agy` rewrites its own
 * keychain item on launch, and a read-only usage fetch must not mutate the
 * user's credential.
 */
async function refreshAntigravityAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const response = await fetch(ANTIGRAVITY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { access_token?: string };
    return typeof data.access_token === 'string' && data.access_token ? data.access_token : null;
  } catch {
    return null;
  }
}

/**
 * POST :retrieveUserQuota against the Code Assist endpoints in order, returning
 * the first successful bucket list. null when every endpoint rejects (expired
 * token, no quota API for the account) or the network fails.
 */
async function fetchAntigravityQuota(accessToken: string): Promise<AntigravityQuotaBucket[] | null> {
  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as AntigravityQuotaResponse;
      return Array.isArray(data?.buckets) ? data.buckets : [];
    } catch {
      continue;
    }
  }
  return null;
}

/** Compact model tag for the inline bar — 'gemini-2.5-flash-lite' => '2.5FL'. */
export function antigravityModelShortLabel(modelId: string): string {
  const stripped = modelId.replace(/^gemini-/i, '');
  const parts = stripped.split('-').filter(Boolean);
  if (parts.length === 0) return modelId;
  const [version, ...rest] = parts;
  return version + rest.map((part) => (part[0] ? part[0].toUpperCase() : '')).join('');
}

/**
 * Normalize the per-model quota buckets into the common UsageWindow shape —
 * one window per model (`gemini-3.1-pro`, `gemini-2.5-flash`, …), keyed
 * `session` since each bucket is a short-cycle quota with its own reset time.
 * Duplicate buckets for one model keep the LOWEST remaining fraction (the
 * most conservative read). Sorted most-used first so the bar closest to
 * throttling leads the row. `windowMinutes` stays null: the API reports only
 * the reset timestamp, not the window length, and an inferred 5h session
 * length would wrongly zero the SWR cache between resets.
 */
export function normalizeAntigravityWindows(buckets: AntigravityQuotaBucket[]): UsageWindow[] {
  const byModel = new Map<string, { bucket: AntigravityQuotaBucket; remaining: number }>();
  for (const bucket of buckets) {
    const modelId = normalizeString(bucket?.modelId);
    const remaining = bucket?.remainingFraction;
    if (!modelId || typeof remaining !== 'number' || !Number.isFinite(remaining)) continue;
    const existing = byModel.get(modelId);
    if (!existing || remaining < existing.remaining) {
      byModel.set(modelId, { bucket, remaining });
    }
  }

  const windows: UsageWindow[] = [];
  for (const [modelId, { bucket, remaining }] of byModel) {
    const usedPercent = normalizePercent((1 - remaining) * 100);
    if (usedPercent === null) continue;
    windows.push({
      key: 'session',
      label: modelId,
      shortLabel: antigravityModelShortLabel(modelId),
      usedPercent,
      resetsAt: parseDateValue(bucket.resetTime),
      windowMinutes: null,
    });
  }
  windows.sort((a, b) => b.usedPercent - a.usedPercent);
  return windows;
}

/**
 * Fetch Antigravity usage via Google Code Assist's :retrieveUserQuota — the
 * quota API `agy` itself talks to (its log shows the sibling :loadCodeAssist
 * and :fetchAvailableModels calls on the same host). Auth is the stored `agy`
 * OAuth token (OS keyring on macOS, file fallback on Linux), refreshed
 * in-memory when expired — safe because Google's refresh tokens are
 * non-rotating (see refreshAntigravityAccessToken).
 */
async function getAntigravityUsageInfo(options?: UsageOptions): Promise<UsageInfo> {
  try {
    const token = await loadAntigravityOauth(options?.home);
    if (!token) return { snapshot: null, error: null };

    let accessToken = normalizeString(token.access_token);
    if ((!accessToken || antigravityTokenNeedsRefresh(token.expiry)) && token.refresh_token) {
      accessToken = await refreshAntigravityAccessToken(token.refresh_token);
    }
    if (!accessToken) return { snapshot: null, error: null };

    const buckets = await fetchAntigravityQuota(accessToken);
    if (!buckets) return { snapshot: null, error: null };

    const windows = normalizeAntigravityWindows(buckets);
    if (windows.length === 0) return { snapshot: null, error: null };

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
