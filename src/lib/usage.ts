/**
 * Usage and rate-limit tracking for Claude and Codex agents.
 *
 * Fetches live usage data from the Anthropic OAuth API (Claude) or parses
 * rate-limit events from Codex session logs. Results are normalized into a
 * common UsageSnapshot shape, cached to disk, and rendered as terminal
 * progress bars for the `agents view` and `agents status` commands.
 */
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { promisify } from 'util';
import chalk from 'chalk';

import type { AccountInfo } from './agents.js';
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

const COMPACT_BAR_LEN = 5;
const USAGE_BAR_LEN = 10;
const FULL = '\u2588';
const EMPTY = '\u2591';

/** Discriminator for usage window types. */
export type UsageWindowKey = 'session' | 'week' | 'sonnet_week';

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

const USAGE_CACHE_FRESH_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Fetch usage for a single identity, with a 2-minute cache fast path.
 * Falls back to cached data when the live fetch fails.
 */
export async function getUsageInfoForIdentity(input: UsageIdentityInput): Promise<UsageInfo> {
  const usageKey = getUsageLookupKey(input.info);

  // Fast path: serve from cache if fresh. Skips the network call entirely.
  if (input.agentId === 'claude' && usageKey) {
    const cached = readClaudeUsageCache(usageKey);
    if (cached?.capturedAt) {
      const ageMs = Date.now() - cached.capturedAt.getTime();
      if (ageMs < USAGE_CACHE_FRESH_MS) {
        return { snapshot: cached, error: null };
      }
    }
  }

  // Cache miss or stale -- make the network call.
  const usage = await getUsageInfo(input.agentId, {
    home: input.home,
    cliVersion: input.cliVersion,
    organizationId: input.info.organizationId,
  });
  if (input.agentId !== 'claude' || !usageKey) {
    return usage;
  }

  if (usage.snapshot?.source === 'live') {
    writeClaudeUsageCache(usageKey, usage.snapshot);
    return usage;
  }

  const cached = readClaudeUsageCache(usageKey);
  if (cached) {
    return { snapshot: cached, error: usage.error };
  }
  return usage;
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
    const windows = snapshot.windows
      .filter((window) => window.key !== 'sonnet_week')
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

/** Load Claude OAuth credentials from the system keychain/keyring. */
export async function loadClaudeOauth(home?: string): Promise<ClaudeOauthCredentials | null> {
  // Windows not yet supported
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return null;
  }

  try {
    const service = getClaudeKeychainService(home);
    const stdout = getKeychainToken(service);

    const payload = JSON.parse(stdout.trim()) as ClaudeKeychainPayload;
    if (typeof payload?.claudeAiOauth?.accessToken !== 'string') return null;
    if (!payload.claudeAiOauth) {
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
