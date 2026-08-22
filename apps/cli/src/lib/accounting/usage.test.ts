import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeAccessTokenNeedsRefresh,
  claudeUsageAccessTokenNoRefresh,
  loadClaudeOauth,
  getClaudeKeychainService,
  getUsageInfo,
  getUsageInfoForIdentity,
  writeClaudeUsageCache,
  readClaudeUsageCache,
  pruneExpiredClaudeUsageCacheEntry,
  noteClaudeSessionLimit,
  noteClaudeOutOfCredits,
  clearClaudeAccountRefusal,
  parseClaudeSessionLimitReset,
  deriveUsageStatusFromSnapshot,
  setClaudeUsageCachePathForTest,
  deriveUsageHeadroom,
  formatUsageSummary,
  usageNoCredentialError,
  usageExpiredCredentialError,
  usageRejectedError,
  usageHeadlessScopeError,
  isUsageHeadlessScopeError,
  isClaudeUsageScopeDenied,
  USAGE_HEADLESS_SCOPE_MARKER,
  probeClaudeStatus,
  probeKimiStatus,
  type UsageSnapshot,
} from './usage.js';
import type { AccountInfo } from '../agents.js';
import { noteUsageRateLimited, setUsageBackoffDirForTest } from '../usage-backoff.js';
import { setKeychainToken, setKeychainBackendForTest, secretsKeychainItem, type KeychainBackend } from '../secrets/index.js';
import { writeBundle, keychainRef, bundleItemStore } from '../secrets/bundles.js';
import { _resetFileStoreForTest } from '../secrets/filestore.js';

const LEEWAY_MS = 5 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed epoch ms so the tests are deterministic

describe('claudeAccessTokenNeedsRefresh', () => {
  it('treats a missing expiry as still-fresh (never force a refresh)', () => {
    // A token with no known expiry must not trigger a refresh — that is what
    // kept the health probe from rotating tokens with an unknown lifetime.
    expect(claudeAccessTokenNeedsRefresh(null, NOW)).toBe(false);
    expect(claudeAccessTokenNeedsRefresh(undefined, NOW)).toBe(false);
  });

  it('is false while the token is comfortably in the future', () => {
    expect(claudeAccessTokenNeedsRefresh(NOW + LEEWAY_MS + 60_000, NOW)).toBe(false);
  });

  it('is true once the token is within the refresh leeway of expiry', () => {
    // The stampede fix depends on this comparison direction: a near-expiry
    // token reports `expired` from the probe (non-fatal) instead of refreshing.
    expect(claudeAccessTokenNeedsRefresh(NOW + LEEWAY_MS - 1, NOW)).toBe(true);
  });

  it('is true exactly at the leeway boundary (>=, not >)', () => {
    expect(claudeAccessTokenNeedsRefresh(NOW + LEEWAY_MS, NOW)).toBe(true);
  });

  it('is true for an already-expired token', () => {
    expect(claudeAccessTokenNeedsRefresh(NOW - 60_000, NOW)).toBe(true);
  });
});

describe('claudeUsageAccessTokenNoRefresh', () => {
  // Uses the real Date.now() internally (via claudeAccessTokenNeedsRefresh), so
  // express expiries relative to now.
  const now = Date.now();

  it('returns the token when it is comfortably fresh', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: now + 60 * 60 * 1000 })).toBe('tok-abc');
  });

  it('returns the token when the expiry is unknown (never forces a refresh)', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: null })).toBe('tok-abc');
  });

  it('returns null (NOT a rotating refresh) for a near-expiry token', () => {
    // The regression this guards: a usage read must never rotate Claude's
    // single-use refresh token. A token within the 5-min leeway yields "no usage
    // now" (null) instead of refreshing and logging every other fleet box out.
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: now + 60_000 })).toBeNull();
  });

  it('returns null for an already-expired token (still never refreshes)', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: 'tok-abc', expiresAt: now - 60_000 })).toBeNull();
  });

  it('returns null for a missing/empty access token', () => {
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: '', expiresAt: now + 60 * 60 * 1000 })).toBeNull();
    expect(claudeUsageAccessTokenNoRefresh({ accessToken: '   ', expiresAt: now + 60 * 60 * 1000 })).toBeNull();
  });
});

/**
 * Read-only usage/probe callers (accessTokenCache) authenticate ONLY with a
 * file-based setup-token and NEVER read Claude Code's interactive login. Reading
 * that ACL-bound OAuth token and transmitting it to Anthropic's usage API from
 * the daemon's warm loop is what got it revoked (the fleet-wide-logout class,
 * RUSH-1822). Here the in-memory keychain backend (the sanctioned test seam)
 * counts reads of the source item — the interactive login wraps `claudeAiOauth`.
 */
describe('loadClaudeOauth accessTokenCache never reads the interactive login', () => {
  /** Counting backend: tracks reads of the source (ACL/interactive) item,
   *  identified by value shape so the test is agnostic to keychain name hashing. */
  class CountingBackend implements KeychainBackend {
    store = new Map<string, string>();
    sourceReads = 0;
    has(item: string) { return this.store.has(item); }
    get(item: string) {
      const v = this.store.get(item);
      if (v === undefined) throw new Error(`missing ${item}`);
      if (v.includes('"claudeAiOauth"')) this.sourceReads += 1;
      return v;
    }
    set(item: string, value: string) { this.store.set(item, value); }
    delete(item: string) { return this.store.delete(item); }
    list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
  }

  const HOME = '/tmp/agents-cli-usage-cache-test';
  const service = getClaudeKeychainService(HOME);
  const seedSource = (expiresAt: number) =>
    setKeychainToken(
      service,
      JSON.stringify({
        organizationUuid: 'org-1',
        claudeAiOauth: { accessToken: 'tok-live', refreshToken: 'refresh-secret', expiresAt, scopes: ['user:inference'] },
      })
    );

  it('returns null and never reads the interactive login when no setup-token is provisioned', async () => {
    // The revocation fix: with no file-based setup-token, a probe/usage caller
    // (accessTokenCache) must report unprovisioned rather than fall through to the
    // interactive OAuth credential. Before the fix this read the source item and
    // handed it to the usage probe, which fired it at api.anthropic.com.
    const mem = new CountingBackend();
    const prev = setKeychainBackendForTest(mem);
    try {
      seedSource(Date.now() + 60 * 60 * 1000); // a live interactive login IS present

      const oauth = await loadClaudeOauth(HOME, { accessTokenCache: true });

      expect(oauth).toBeNull();
      // The interactive (ACL/prompting) login was never read.
      expect(mem.sourceReads).toBe(0);
    } finally {
      setKeychainBackendForTest(prev);
    }
  });

  it('without the opt-in, returns the full interactive credential with its refresh token (run/cloud-export contract)', async () => {
    // isClaudeAuthValid calls loadClaudeOauth WITHOUT accessTokenCache: it
    // legitimately reads the interactive credential WITH the refresh token to
    // run/refresh Claude. Regression guard for that path.
    // NOTE: Rush Cloud dispatch does not call loadClaudeOauth at all (SING-1b
    // email-only manifest; RUSH-2359 deleted the leftover blob reader).
    const mem = new CountingBackend();
    const prev = setKeychainBackendForTest(mem);
    try {
      seedSource(Date.now() + 60 * 60 * 1000);

      const first = await loadClaudeOauth(HOME); // default: full-credential caller
      const second = await loadClaudeOauth(HOME);

      // Full refresh token every time — never dropped.
      expect(first?.refreshToken).toBe('refresh-secret');
      expect(second?.refreshToken).toBe('refresh-secret');
      // Each read goes to the interactive source (no probe short-circuit here).
      expect(mem.sourceReads).toBe(2);
    } finally {
      setKeychainBackendForTest(prev);
    }
  });
});

describe('loadClaudeOauth — file-based `auth` setup-token (Touch-ID-free usage read)', () => {
  const EMAIL = 'muqsit@trp.so';
  const SETUP_TOKEN = 'sk-ant-oat01-setup-tok-xyz';
  const PASS = 'usage-setup-token-pass';
  // email -> claudeAccountTokenKey(email): upper, @->_AT_, .->_DOT_.
  const KEY = 'CLAUDE_CODE_OAUTH_TOKEN_MUQSIT_AT_TRP_DOT_SO';
  let restore: KeychainBackend | null = null;
  let home: string;
  let fileDir: string;
  let prevNoAgent: string | undefined;

  // A keychain backend that THROWS on read — proves the usage path never falls
  // through to a keychain read once the file-based setup-token resolves.
  function makeThrowingKeychain(): KeychainBackend {
    return {
      has: () => false,
      get: (item) => { throw new Error(`keychain read of '${item}' — usage must not touch the keychain`); },
      set: () => { /* no-op */ },
      delete: () => false,
      list: () => [],
    };
  }

  beforeEach(() => {
    restore = setKeychainBackendForTest(makeThrowingKeychain());
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-home-'));
    fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-fstore-'));
    prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    _resetFileStoreForTest({ fileDir, passphrase: PASS });
    // Reserved FILE-BASED `auth` bundle carrying the per-account setup-token.
    bundleItemStore('file').set(secretsKeychainItem('auth', KEY), SETUP_TOKEN);
    writeBundle({ name: 'auth', backend: 'file', vars: { [KEY]: keychainRef(KEY) } });
    // The account's .claude.json so the resolver maps home -> email -> KEY.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
    );
  });

  afterEach(() => {
    setKeychainBackendForTest(restore);
    _resetFileStoreForTest({});
    delete process.env.AGENTS_SECRETS_PASSPHRASE;
    if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
    else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(fileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('serves the file-based setup-token to accessTokenCache callers, no keychain read', async () => {
    const oauth = await loadClaudeOauth(home, { accessTokenCache: true });
    expect(oauth?.accessToken).toBe(SETUP_TOKEN);
    // Non-rotating: no expiry => reads as fresh, probe never reports expired.
    expect(oauth?.expiresAt ?? null).toBeNull();
  });

  it('ignores the setup-token for full-credential callers (accessTokenCache off)', async () => {
    // Run/export callers need the real keychain credential (with refresh token),
    // never the access-token-only setup-token — so this path does NOT short out.
    // With no keychain item and no .credentials.json, that resolves to null.
    const oauth = await loadClaudeOauth(home);
    expect(oauth).toBeNull();
  });

  it('an accessTokenCache caller with no setup-token reads NEITHER the keychain NOR .credentials.json', async () => {
    // Strip the email so resolveClaudeSetupToken cannot map home -> setup-token KEY,
    // and drop an interactive token in .credentials.json. A probe/usage caller
    // (accessTokenCache) must still report unprovisioned — the interactive login is
    // untouchable, whether it lives in the keychain or the file (the RUSH-1822 fix).
    fs.writeFileSync(path.join(home, '.claude', '.claude.json'), JSON.stringify({}));
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'interactive-file-token', expiresAt: Date.now() + 3_600_000 } }),
    );
    // makeThrowingKeychain is installed — reaching the ACL keychain would throw.
    const oauth = await loadClaudeOauth(home, { accessTokenCache: true, fileOnly: true });
    expect(oauth).toBeNull();
  });
});

describe('deriveUsageHeadroom — projects minutes-to-cap from the session burn rate', () => {
  const sessionSnap = (usedPercent: number, capturedAtMs: number): UsageSnapshot => ({
    source: 'live',
    sourceLabel: 'live',
    capturedAt: new Date(capturedAtMs),
    windows: [
      { key: 'session', label: '5h', shortLabel: 'S', usedPercent, resetsAt: null, windowMinutes: 300 },
      { key: 'week', label: 'Week', shortLabel: 'W', usedPercent: 40, resetsAt: null, windowMinutes: 10080 },
    ],
  });

  it('projects minutes to the cap from the burn between two samples', () => {
    // 50% -> 70% over 10 minutes = 2%/min; 30% headroom remains => 15 minutes.
    const curr = sessionSnap(70, NOW);
    const headroom = deriveUsageHeadroom(curr, { capturedAt: NOW - 10 * 60_000, usedPercent: 50 });
    expect(headroom.status).toBe('available');
    expect(headroom.minutesToLimit).toBeCloseTo(15, 5);
  });

  it('reports 0 minutes when a blocking window is already maxed', () => {
    const maxed = sessionSnap(100, NOW);
    expect(deriveUsageHeadroom(maxed, { capturedAt: NOW - 60_000, usedPercent: 90 })).toEqual({
      status: 'rate_limited',
      minutesToLimit: 0,
    });
  });

  it('does not project a cap when usage is flat or falling (a reset / idle)', () => {
    const curr = sessionSnap(50, NOW);
    // Flat since prev: no burn to project from.
    expect(deriveUsageHeadroom(curr, { capturedAt: NOW - 10 * 60_000, usedPercent: 50 }).minutesToLimit).toBeNull();
    // Fell (window reset): also not "projected to cap".
    expect(deriveUsageHeadroom(curr, { capturedAt: NOW - 10 * 60_000, usedPercent: 80 }).minutesToLimit).toBeNull();
  });

  it('has no projection without a prior sample or a session window', () => {
    expect(deriveUsageHeadroom(sessionSnap(60, NOW), null).minutesToLimit).toBeNull();
    const noSession: UsageSnapshot = {
      source: 'live', sourceLabel: 'live', capturedAt: new Date(NOW),
      windows: [{ key: 'week', label: 'Week', shortLabel: 'W', usedPercent: 60, resetsAt: null, windowMinutes: 10080 }],
    };
    expect(deriveUsageHeadroom(noSession, { capturedAt: NOW - 60_000, usedPercent: 10 }).minutesToLimit).toBeNull();
  });

  it('returns a null status for an empty/absent snapshot', () => {
    expect(deriveUsageHeadroom(null)).toEqual({ status: null, minutesToLimit: null });
  });
});

describe('readOnly — the `agents run` routing hot path never blocks on the network', () => {
  // The measured cold-start stall: collectRunCandidates passed maxAgeMs=5min, so
  // a snapshot older than that fell through to a blocking live provider fetch —
  // one HTTP round trip per account added to `agents run` startup. readOnly
  // serves the cache and NEVER fetches. Deterministic + no network: the seam
  // points the cache at a tmpdir and no live call is made on any assertion.
  let cacheDir: string;
  let prevPath: string | null;
  const usageKey = 'claude:org=readonly-test';

  const staleButUnexpired = (): UsageSnapshot => ({
    // Captured 30 minutes ago: far past USAGE_DECISION_MAX_AGE_MS (5min) so the
    // router will treat it as unverified — but the week window has not expired,
    // so deserialization keeps the number rather than zeroing it.
    source: 'live',
    sourceLabel: 'live',
    capturedAt: new Date(Date.now() - 30 * 60 * 1000),
    windows: [
      {
        key: 'week',
        label: 'Current week',
        shortLabel: 'W',
        usedPercent: 91,
        resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        windowMinutes: 10080,
      },
    ],
  });

  const claudeInput = () => ({
    agentId: 'claude' as const,
    // A network provider (claude) with a usage key but no reachable token here —
    // so if readOnly wrongly fell through to getUsageInfo it would hit the
    // keychain, fail, and stamp an error; error===null proves the short-circuit.
    info: { usageKey } as unknown as AccountInfo,
  });

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-ro-'));
    prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(prevPath);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('serves a STALE cached snapshot without a live fetch', async () => {
    writeClaudeUsageCache(usageKey, staleButUnexpired());

    const usage = await getUsageInfoForIdentity(claudeInput());

    // The cache is returned verbatim (no network refetch, no error), even though
    // it is well past the routing freshness bar — routing around it is
    // isUsageVerified's job, not a blocking refresh's.
    expect(usage.snapshot?.windows[0]?.usedPercent).toBe(91);
    expect(usage.error).toBeNull();
  });

  it('reports "stale" for an absent snapshot instead of dialing the provider', async () => {
    const usage = await getUsageInfoForIdentity(claudeInput());

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe('stale');
  });
});

describe('expired cached windows are unknown, not 0%', () => {
  // The two-week freeze (2026-08-05..20): Anthropic 429'd every account's
  // usage read, the cache never refreshed, and the deserializer zeroed each
  // expired window but KEPT it — so `agents view` drew "S: 0% (now)" and
  // deriveUsageStatusFromSnapshot said 'available' for accounts that were
  // actually rate-limited (RUSH-2858). Expired windows must be dropped, and an
  // all-expired snapshot must read as no-data so the honest "usage unavailable"
  // path renders instead.
  let cacheDir: string;
  let prevPath: string | null;
  const usageKey = 'claude:org=expired-window-test';

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-exp-'));
    prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(prevPath);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const window = (over: Partial<UsageSnapshot['windows'][number]>): UsageSnapshot['windows'][number] => ({
    key: 'week',
    label: 'Current week',
    shortLabel: 'W',
    usedPercent: 91,
    resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    windowMinutes: 10080,
    ...over,
  });

  it('drops an expired window and keeps a fresh one', () => {
    writeClaudeUsageCache(usageKey, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      windows: [
        // Session window reset an hour ago: whatever burned since is unknown.
        window({ key: 'session', shortLabel: 'S', usedPercent: 100, resetsAt: new Date(Date.now() - 60 * 60 * 1000), windowMinutes: 300 }),
        window({}),
      ],
    });

    const snapshot = readClaudeUsageCache(usageKey);

    expect(snapshot?.windows.map((w) => w.key)).toEqual(['week']);
    expect(snapshot?.windows[0]?.usedPercent).toBe(91);
  });

  it('deserializes an all-expired snapshot to null and deletes the cache entry', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    writeClaudeUsageCache(usageKey, {
      source: 'live',
      sourceLabel: 'live',
      capturedAt: twoWeeksAgo,
      windows: [
        window({ key: 'session', shortLabel: 'S', usedPercent: 100, resetsAt: new Date(twoWeeksAgo.getTime() + 5 * 60 * 60 * 1000), windowMinutes: 300 }),
        window({ resetsAt: new Date(twoWeeksAgo.getTime() + 4 * 24 * 60 * 60 * 1000) }),
      ],
    });

    expect(readClaudeUsageCache(usageKey)).toBeNull();

    // Self-cleaning: the dead entry is gone, not resurrected on the next read.
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, 'claude-usage.json'), 'utf-8'));
    expect(raw[usageKey]).toBeUndefined();
  });
});

describe('observed Claude session limits', () => {
  let cacheDir: string;
  let prevPath: string | null;
  const usageKey = 'claude:org=session-limited-test';

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-session-limit-'));
    prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'claude-usage.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(prevPath);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('parses the real Claude refusal and persists it independently of usage windows', () => {
    const now = Date.parse('2026-08-20T17:00:00-07:00');
    const reset = parseClaudeSessionLimitReset(
      "You've hit your session limit · resets 6:20pm (America/Los_Angeles)",
      now,
    );
    expect(reset?.toISOString()).toBe('2026-08-21T01:20:00.000Z');

    const persistedReset = new Date(Date.now() + 60 * 60 * 1000);
    noteClaudeSessionLimit(usageKey, persistedReset);
    const snapshot = readClaudeUsageCache(usageKey, undefined, new Date(now));
    expect(snapshot?.windows).toEqual([]);
    expect(snapshot?.unavailable).toEqual({ reason: 'session_limit', resetsAt: persistedReset });
    expect(deriveUsageStatusFromSnapshot(snapshot)).toBe('rate_limited');
    expect(formatUsageSummary('Max', snapshot)).toContain('session-limited');
  });

  it('drops the observed limit after its reset', () => {
    const reset = new Date(NOW + 60_000);
    noteClaudeSessionLimit(usageKey, reset);
    expect(readClaudeUsageCache(usageKey, undefined, new Date(NOW + 60_001))).toBeNull();
  });

  it('stale expiry cleanup cannot erase a newer session-limit write', () => {
    const reset = new Date(Date.now() + 60 * 60 * 1000);
    noteClaudeSessionLimit(usageKey, reset);

    // Models a reader that observed an expired row before the real-run writer
    // replaced it: cleanup executes afterward and must re-read under its lock.
    pruneExpiredClaudeUsageCacheEntry(usageKey, undefined, new Date());

    expect(readClaudeUsageCache(usageKey)?.unavailable).toEqual({
      reason: 'session_limit',
      resetsAt: reset,
    });
  });
});

describe('explicit refresh publication', () => {
  let cacheDir: string;
  let home: string;
  let prevPath: string | null;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-publish-'));
    home = path.join(cacheDir, 'home');
    fs.mkdirSync(path.join(home, '.grok', 'logs'), { recursive: true });
    prevPath = setClaudeUsageCachePathForTest(path.join(cacheDir, 'usage.json'));
  });

  afterEach(() => {
    setClaudeUsageCachePathForTest(prevPath);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('publishes a local-log snapshot for the next cache-only reader', async () => {
    const now = Date.now();
    fs.writeFileSync(path.join(home, '.grok', 'logs', 'unified.jsonl'), JSON.stringify({
      ts: new Date(now - 60 * 60_000).toISOString(),
      msg: 'billing: fetched credits config',
      ctx: {
        config: {
          creditUsagePercent: 37,
          currentPeriod: {
            type: 'USAGE_PERIOD_TYPE_WEEKLY',
            start: new Date(now - 24 * 60 * 60_000).toISOString(),
            end: new Date(now + 6 * 24 * 60 * 60_000).toISOString(),
          },
        },
        subscriptionTier: 'SuperGrok Heavy',
      },
    }) + '\n');

    const input = {
      agentId: 'grok' as const,
      home,
      cliVersion: null,
      info: { usageKey: 'grok:user=publication-test' } as AccountInfo,
    };
    const refreshed = await getUsageInfoForIdentity(input, { forceRefresh: true });
    const cached = await getUsageInfoForIdentity(input);

    expect(refreshed.snapshot?.source).toBe('last_seen');
    expect(cached.snapshot?.windows.find((window) => window.key === 'week')?.usedPercent).toBe(37);
    expect(cached.error).toBeNull();
  });
});

describe('a Claude usage read reports WHY it produced no snapshot', () => {
  // Both of these returned `error: null` before, which is what let an account
  // nobody could read render exactly like a healthy one: the caller fell back to
  // the SWR cache and drew its bars as fact. On yosemite-s1 that hid five
  // accounts whose stored token had expired — one of them eleven days earlier —
  // behind a cache frozen for 26h, and balanced routing launched into an account
  // that was already at its weekly cap.
  //
  // Neither path reaches the network: both return before the fetch, so these
  // exercise the real code path with no live call.

  /** Keychain backend holding exactly what the test seeds — nothing else. */
  class MemBackend implements KeychainBackend {
    store = new Map<string, string>();
    has(item: string) { return this.store.has(item); }
    get(item: string) {
      const v = this.store.get(item);
      if (v === undefined) throw new Error(`missing ${item}`);
      return v;
    }
    set(item: string, value: string) { this.store.set(item, value); }
    delete(item: string) { return this.store.delete(item); }
    list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
  }

  let home: string;
  let prevBackend: KeychainBackend | null;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-err-'));
    prevBackend = setKeychainBackendForTest(new MemBackend());
  });

  afterEach(() => {
    setKeychainBackendForTest(prevBackend);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('names a missing credential instead of returning a silent null', async () => {
    const usage = await getUsageInfo('claude', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe(usageNoCredentialError('Claude'));
  });

  it('reports unprovisioned even when an interactive login is present — the probe never reads it', async () => {
    // A usage read authenticates only with a file-based setup-token and never
    // touches Claude Code's interactive login (reading it and firing it at
    // api.anthropic.com is what got the token revoked — RUSH-1822). So an account
    // with only an interactive credential (here an expired one) reads the same as
    // an empty home: no usable PROBE credential, unprovisioned.
    setKeychainToken(
      getClaudeKeychainService(home),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tok-stale', refreshToken: 'r', expiresAt: Date.now() - 60_000 },
      })
    );

    const usage = await getUsageInfo('claude', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe(usageNoCredentialError('Claude'));
  });
});

describe('formatUsageSummary marks bars the live read could not confirm', () => {
  const snapshot = {
    source: 'cache' as const,
    sourceLabel: 'cached',
    capturedAt: new Date(NOW),
    windows: [
      { key: 'week' as const, label: 'Current week', shortLabel: 'W', usedPercent: 48, resetsAt: null, windowMinutes: 10080 },
    ],
  };

  it('draws the bars AND says they are unverified', () => {
    // The incident in one assertion: a cached "48%" must never render the same
    // as a confirmed one. The number still shows — it is the last thing we saw,
    // and hiding it would be worse — but it no longer reads as current.
    const out = formatUsageSummary(null, snapshot, 3, { unverified: true });

    expect(out).toContain('48%');
    expect(out).toContain('unverified');
  });

  it('stays clean when the reading was confirmed', () => {
    const out = formatUsageSummary(null, snapshot, 3);

    expect(out).toContain('48%');
    expect(out).not.toContain('unverified');
  });

  it('names the headless scope gap instead of unverified (RUSH-2392)', () => {
    // Setup-token accounts used to read as "unverified" — the worst-looking
    // state for the best-provisioned headless credentials. Prefer the scope
    // phrase so operators do not re-mint.
    const out = formatUsageSummary(null, snapshot, 3, { headless: true, unverified: true });

    expect(out).toContain('48%');
    expect(out).toContain(USAGE_HEADLESS_SCOPE_MARKER);
    expect(out).not.toContain('unverified');
  });

  it('shows the headless marker with no bars when usage cannot populate', () => {
    const out = formatUsageSummary(null, null, 3, { headless: true, unavailable: true });

    expect(out).toContain(USAGE_HEADLESS_SCOPE_MARKER);
    // Prefer the headless phrase over the bare generic "usage unavailable".
    expect(out).toContain('(headless)');
    expect(out).not.toMatch(/usage unavailable(?! \(headless\))/);
  });
});

describe('Claude setup-token usage-scope detection (RUSH-2392)', () => {
  it('detects Anthropic user:profile scope denials on 403', () => {
    const body =
      '{"type":"error","error":{"type":"permission_error","message":"OAuth token does not meet scope requirement user:profile"}}';
    expect(isClaudeUsageScopeDenied(403, body)).toBe(true);
    expect(isClaudeUsageScopeDenied(403, 'scope requirement missing')).toBe(true);
  });

  it('does not treat bare 403 or other statuses as the scope gap', () => {
    expect(isClaudeUsageScopeDenied(403, '')).toBe(false);
    expect(isClaudeUsageScopeDenied(403, null)).toBe(false);
    expect(isClaudeUsageScopeDenied(401, 'user:profile')).toBe(false);
    expect(isClaudeUsageScopeDenied(200, 'user:profile')).toBe(false);
    expect(isClaudeUsageScopeDenied(403, 'forbidden')).toBe(false);
  });

  it('builds a detectable headless-scope error string', () => {
    const err = usageHeadlessScopeError('Claude');
    expect(isUsageHeadlessScopeError(err)).toBe(true);
    expect(err).toContain(USAGE_HEADLESS_SCOPE_MARKER);
    expect(err).toContain('user:profile');
    expect(isUsageHeadlessScopeError(usageRejectedError('Claude', 403))).toBe(false);
  });
});

describe('every networked provider names the same three failures', () => {
  // The review that caught this: wiring only Claude would leave `agents view
  // --refresh` reporting Claude accounts while silently presenting stale Kimi,
  // Droid, and Cursor readings as confirmed — all four share one cache fallback
  // in getUsageInfoForIdentity, so a silent null in any of them reproduces the
  // exact bug this change exists to close.
  const NETWORKED = ['Claude', 'Kimi', 'Droid', 'Cursor'];

  it('says which agent could not be read, so a fleet row is actionable', () => {
    for (const agent of NETWORKED) {
      expect(usageNoCredentialError(agent)).toContain(agent);
      expect(usageExpiredCredentialError(agent)).toContain(agent);
      expect(usageRejectedError(agent, 401)).toContain(agent);
    }
  });

  it('distinguishes a rejected read from a throttled one', () => {
    // 429 is the machine being rate-limited on the usage endpoint, not a dead
    // credential — re-authing would not fix it, so the two must not read alike.
    expect(usageRejectedError('Claude', 429)).toContain('429');
    expect(usageRejectedError('Claude', 429)).toContain('rate-limiting');
    expect(usageRejectedError('Claude', 401)).toContain('401');
    expect(usageRejectedError('Claude', 401)).not.toContain('rate-limiting');
  });

  it('says an expired credential will not heal on its own', () => {
    // The yosemite-s1 state: a usage read never refreshes, so the account stays
    // unreadable until the agent itself runs. The message has to say so, or the
    // obvious next action (re-auth) is not obvious.
    expect(usageExpiredCredentialError('Droid')).toContain('never refreshes');
  });
});

describe('a usage read that THROWS is still a failed read', () => {
  // The re-review caught this: every provider swallowed a thrown request into
  // `error: null`, so a timeout, a TLS failure, or a payload that will not parse
  // handed the caller a stale snapshot to render as confirmed — the same silence
  // as an expired token, through a different door.
  //
  // Driven through a real provider fetch (Kimi) with a credential file that
  // cannot be parsed: JSON.parse throws inside the try, so the catch is the code
  // under test and no network call is made.
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-usage-throw-'));
    const dir = path.join(home, '.kimi-code', 'credentials');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kimi-code.json'), '{ not json');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('names the agent and carries the cause, instead of returning null', async () => {
    const usage = await getUsageInfo('kimi', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBeTruthy();
    expect(usage.error).toContain('Kimi');
  });
});

describe('a recorded Retry-After actually suppresses the read', () => {
  /** Keychain backend holding exactly what the test seeds — nothing else. */
  class MemBackend implements KeychainBackend {
    store = new Map<string, string>();
    has(item: string) { return this.store.has(item); }
    get(item: string) {
      const v = this.store.get(item);
      if (v === undefined) throw new Error(`missing ${item}`);
      return v;
    }
    set(item: string, value: string) { this.store.set(item, value); }
    delete(item: string) { return this.store.delete(item); }
    list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
  }

  // End-to-end through the real getUsageInfo path: with a penalty recorded, the
  // read must return the throttled error WITHOUT making a request. That is the
  // whole fix — the old code fired again 3 minutes into a 45-minute window and
  // re-armed the penalty, so the box never recovered and its cache froze.
  let home: string;
  let dir: string;
  let prevPath: string | null;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-throttle-'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-throttle-cache-'));
    prevPath = setUsageBackoffDirForTest(dir);
  });

  afterEach(() => {
    setUsageBackoffDirForTest(prevPath);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('short-circuits the usage read while the window is open', async () => {
    // A HEALTHY probe credential — this is the case that matters. The credential
    // checks ahead of the guard make no request, so they run first and correctly
    // win for a home that has none; the guard exists to stop the request that a
    // good credential would otherwise make into a live penalty. The probe reads
    // only a file-based setup-token (never the interactive login — RUSH-1822), so
    // provision one here.
    const EMAIL = 'throttle@trp.so';
    const KEY = 'CLAUDE_CODE_OAUTH_TOKEN_THROTTLE_AT_TRP_DOT_SO';
    const PASS = 'throttle-setup-token-pass';
    const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-fstore-'));
    const prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
    _resetFileStoreForTest({ fileDir, passphrase: PASS });
    bundleItemStore('file').set(secretsKeychainItem('auth', KEY), 'sk-ant-oat01-throttle-tok-xyz');
    writeBundle({ name: 'auth', backend: 'file', vars: { [KEY]: keychainRef(KEY) } });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
    );
    try {
      // The exact header the endpoint sent on yosemite-s1.
      noteUsageRateLimited('claude', '2678');

      const usage = await getUsageInfo('claude', { home });

      expect(usage.snapshot).toBeNull();
      expect(usage.error).toContain('rate-limited this machine');
      expect(usage.error).toContain('not retrying');
    } finally {
      _resetFileStoreForTest({});
      delete process.env.AGENTS_SECRETS_PASSPHRASE;
      if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
      else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
      fs.rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it('lets the read through once the window has passed', async () => {
    noteUsageRateLimited('claude', '1', { now: Date.now() - 60_000 });

    const usage = await getUsageInfo('claude', { home });

    // Falls through to the ordinary credential check for this empty home.
    expect(usage.error).toBe(usageNoCredentialError('Claude'));
  });
});

describe('the throttle guard is exercised beyond Claude', () => {
  // The review that forced this: with only Claude tested, two real bugs got
  // through — Cursor's error `return` was left unconditional by a braceless
  // `if` (so every 200 would have failed), and Kimi's probe guard sat AHEAD of
  // its missing/expired credential checks, misreporting a broken credential as
  // merely throttled.
  //
  // What this actually covers is Claude and Kimi end-to-end, not all four. Droid
  // and Cursor are guarded and recorded identically (see the four
  // usageRateLimitedUntil / noteUsageRateLimited pairs in usage.ts) but are not
  // driven here: Droid's credential is AES-GCM encrypted with an on-disk key, so
  // there is no cheap way to seed one without mocking, which this repo does not
  // do. Naming that is better than a describe() title implying coverage that is
  // not present.
  let home: string;
  let dir: string;
  let prevPath: string | null;
  let prevRealHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-throttle-all-'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-throttle-all-cache-'));
    prevPath = setUsageBackoffDirForTest(dir);
    // resolveKimiCredentialPath falls back to the ACTIVE home when the
    // per-version one is absent (sign-in is account-global), so without this the
    // "missing credential" case finds the developer's real Kimi login and the
    // test passes for the wrong reason. AGENTS_REAL_HOME is the seam the code
    // itself reads.
    prevRealHome = process.env.AGENTS_REAL_HOME;
    process.env.AGENTS_REAL_HOME = home;
  });

  afterEach(() => {
    setUsageBackoffDirForTest(prevPath);
    if (prevRealHome === undefined) delete process.env.AGENTS_REAL_HOME;
    else process.env.AGENTS_REAL_HOME = prevRealHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A real, unexpired Kimi credential at the path the resolver looks for. */
  const seedKimi = () => {
    const credDir = path.join(home, '.kimi-code', 'credentials');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      path.join(credDir, 'kimi-code.json'),
      JSON.stringify({ access_token: 'tok-fresh', expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    );
  };

  it('suppresses the Kimi usage read while its window is open', async () => {
    seedKimi();
    noteUsageRateLimited('kimi', '2678');

    const usage = await getUsageInfo('kimi', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toContain('Kimi rate-limited this machine');
  });

  it('does not let a throttle mask a missing Kimi credential in the probe', async () => {
    // The misplacement the reviewer caught: with the guard ahead of the local
    // checks, this returned 429/present and the account read as merely
    // throttled rather than unconfigured.
    noteUsageRateLimited('kimi', '2678');

    const probe = await probeKimiStatus(home);

    expect(probe.token).toBe('missing');
    expect(probe.status).toBeNull();
  });

  it('reports the throttle from the Kimi probe when the credential IS good', async () => {
    seedKimi();
    noteUsageRateLimited('kimi', '2678');

    const probe = await probeKimiStatus(home);

    // 429 without a request: the recorded window is the answer.
    expect(probe.status).toBe(429);
    expect(probe.token).toBe('present');
  });

  it('does not let a throttle mask a missing Claude credential in the probe', async () => {
    noteUsageRateLimited('claude', '2678');

    const probe = await probeClaudeStatus(home);

    expect(probe.token).toBe('missing');
  });

  it("keeps one provider's penalty out of another's read", async () => {
    seedKimi();
    noteUsageRateLimited('claude', '2678');

    const usage = await getUsageInfo('kimi', { home });

    // Kimi is free; it fails on its own terms (a live call it cannot complete
    // in the test environment), never with Claude's throttle message.
    expect(usage.error ?? '').not.toContain('rate-limited this machine');
  });
});

describe('getUsageInfo(codex) — usage is scoped to the current login', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Write auth.json whose id_token carries `auth_time` = the login time. The
  // usage floor comes from that claim, NOT the file mtime — a token refresh
  // rewrites auth.json but leaves auth_time at the real login. `fileMtimeMs`
  // lets a test simulate a refresh (file rewritten later than the login).
  function writeAuth(loginMs: number, fileMtimeMs?: number): void {
    const p = path.join(home, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const payload = Buffer.from(
      JSON.stringify({ auth_time: Math.floor(loginMs / 1000) })
    ).toString('base64url');
    fs.writeFileSync(p, JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }));
    const t = (fileMtimeMs ?? loginMs) / 1000;
    fs.utimesSync(p, t, t);
  }

  function writeSession(mtimeMs: number, usedPercent: number, windowMinutes = 300): void {
    const dir = path.join(home, '.codex', 'sessions', '2026', '08', '05');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `rollout-${mtimeMs}.jsonl`);
    fs.writeFileSync(
      p,
      JSON.stringify({
        timestamp: new Date(mtimeMs).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: { primary: { used_percent: usedPercent, window_minutes: windowMinutes } },
        },
      }) + '\n'
    );
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  }

  const HOUR = 60 * 60 * 1000;

  it('ignores a session written before the current login (prior account is stale)', async () => {
    // Reproduces the bug: log out, log into a different account. The only
    // session on disk predates the new login, so its usage is the OLD account's.
    writeAuth(NOW);
    writeSession(NOW - HOUR, 99);

    const info = await getUsageInfo('codex', { home });
    expect(info.snapshot).toBeNull();
  });

  it('reports a session written after the current login', async () => {
    writeAuth(NOW);
    writeSession(NOW + HOUR, 42);

    const info = await getUsageInfo('codex', { home });
    const session = info.snapshot?.windows.find((w) => w.key === 'session');
    expect(session?.usedPercent).toBe(42);
  });

  it('labels a primary 7-day quota as weekly usage', async () => {
    writeAuth(NOW);
    writeSession(NOW + HOUR, 54, 10_080);

    const info = await getUsageInfo('codex', { home });
    expect(info.snapshot?.windows).toEqual([
      expect.objectContaining({ key: 'week', label: 'Current week', shortLabel: 'W', usedPercent: 54 }),
    ]);
    expect(formatUsageSummary(null, info.snapshot)).toContain('W:');
  });

  it('labels a primary 30-day quota as monthly usage', async () => {
    writeAuth(NOW);
    writeSession(NOW + HOUR, 21, 43_200);

    const info = await getUsageInfo('codex', { home });
    expect(info.snapshot?.windows).toEqual([
      expect.objectContaining({ key: 'month', label: 'Current month', shortLabel: 'M', usedPercent: 21 }),
    ]);
    expect(formatUsageSummary(null, info.snapshot)).toContain('M:');
  });

  it('prefers the current account session over a stale pre-login one', async () => {
    // Old account left a 99% session; the new account then ran a 5% session.
    writeAuth(NOW);
    writeSession(NOW - HOUR, 99);
    writeSession(NOW + HOUR, 5);

    const info = await getUsageInfo('codex', { home });
    const session = info.snapshot?.windows.find((w) => w.key === 'session');
    expect(session?.usedPercent).toBe(5);
  });

  it('reports no usage when no account is signed in (no auth.json)', async () => {
    writeSession(NOW, 99);

    const info = await getUsageInfo('codex', { home });
    expect(info.snapshot).toBeNull();
  });

  it('keeps usage after a token refresh rewrites auth.json (floor is auth_time, not mtime)', async () => {
    // Regression guard: login at NOW, run a session at NOW+1h (42%), then a
    // background token refresh rewrites auth.json with a NOW+2h file mtime. The
    // floor is auth_time (NOW), so the NOW+1h session is still counted — a
    // mtime-based floor (NOW+2h) would wrongly blank the current account.
    writeAuth(NOW, NOW + 2 * HOUR);
    writeSession(NOW + HOUR, 42);

    const info = await getUsageInfo('codex', { home });
    const session = info.snapshot?.windows.find((w) => w.key === 'session');
    expect(session?.usedPercent).toBe(42);
  });
});

describe('getUsageInfo(grok) — last-seen billing from unified.jsonl', () => {
  let home: string;
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-usage-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeBillingLine(opts: {
    tsMs: number;
    percent?: number | null;
    periodStartMs: number;
    periodEndMs: number;
    tier?: string;
  }): void {
    const logDir = path.join(home, '.grok', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const p = path.join(logDir, 'unified.jsonl');
    const config: Record<string, unknown> = {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: new Date(opts.periodStartMs).toISOString(),
        end: new Date(opts.periodEndMs).toISOString(),
      },
    };
    if (opts.percent !== null && opts.percent !== undefined) {
      config.creditUsagePercent = opts.percent;
    }
    const line = JSON.stringify({
      ts: new Date(opts.tsMs).toISOString(),
      msg: 'billing: fetched credits config',
      ctx: { config, subscriptionTier: opts.tier ?? 'X Premium+' },
    });
    fs.appendFileSync(p, line + '\n');
  }

  it('renders the latest in-period creditUsagePercent as the week bar', async () => {
    const now = Date.now();
    writeBillingLine({
      tsMs: now - HOUR,
      percent: 37,
      periodStartMs: now - DAY,
      periodEndMs: now + 6 * DAY,
      tier: 'SuperGrok Heavy',
    });

    const info = await getUsageInfo('grok', { home });
    expect(info.snapshot?.plan).toBe('SuperGrok Heavy');
    expect(info.snapshot?.source).toBe('last_seen');
    const week = info.snapshot?.windows.find((w) => w.key === 'week');
    expect(week?.usedPercent).toBe(37);
  });

  it('does not invent a 0% bar when creditUsagePercent is missing', async () => {
    const now = Date.now();
    // Prior period at 100%, then a new period line with no percent yet — the
    // real fleet case that painted W: 0% on one box while another still
    // showed a stale expired reading.
    writeBillingLine({
      tsMs: now - 2 * HOUR,
      percent: 100,
      periodStartMs: now - 8 * DAY,
      periodEndMs: now - HOUR,
    });
    writeBillingLine({
      tsMs: now - HOUR,
      percent: null,
      periodStartMs: now - HOUR,
      periodEndMs: now + 6 * DAY,
    });

    const info = await getUsageInfo('grok', { home });
    expect(info.snapshot?.windows).toEqual([]);
    expect(info.snapshot?.plan).toBe('X Premium+');
  });

  it('drops expired billing windows so stale 100% is not rate-limited', async () => {
    const now = Date.now();
    writeBillingLine({
      tsMs: now - DAY,
      percent: 100,
      periodStartMs: now - 8 * DAY,
      periodEndMs: now - HOUR,
      tier: 'SuperGrok Heavy',
    });

    const info = await getUsageInfo('grok', { home });
    expect(info.snapshot?.windows).toEqual([]);
    expect(info.snapshot?.plan).toBe('SuperGrok Heavy');
  });
  describe('out_of_credits (tokens/credits exhausted — no clock)', () => {
    const usageKey = 'claude:org=oocred';

    it('persists a clock-less refusal that excludes the account and survives time', () => {
      noteClaudeOutOfCredits(usageKey);
      const snap = readClaudeUsageCache(usageKey, undefined, new Date(Date.now() + 30 * 24 * 3600 * 1000));
      // A month later it is STILL blocking — unlike a session limit, no clock frees it.
      expect(snap?.unavailable).toEqual({ reason: 'out_of_credits' });
      expect(deriveUsageStatusFromSnapshot(snap)).toBe('rate_limited');
      expect(formatUsageSummary('Max', snap)).toContain('out of credits');
    });

    it('is cleared by a successful run (clearClaudeAccountRefusal)', () => {
      noteClaudeOutOfCredits(usageKey);
      expect(readClaudeUsageCache(usageKey)?.unavailable).toEqual({ reason: 'out_of_credits' });
      clearClaudeAccountRefusal(usageKey);
      // Cleared → no longer excluded (no marker, no windows → null snapshot).
      const snap = readClaudeUsageCache(usageKey);
      expect(snap?.unavailable).toBeUndefined();
    });

    it('a session-limit still recovers on its clock, out_of_credits does not', () => {
      const other = 'claude:org=sess-vs-cred';
      noteClaudeSessionLimit(other, new Date(Date.now() + 60_000));
      // past the reset → session limit gone
      expect(readClaudeUsageCache(other, undefined, new Date(Date.now() + 61_000))).toBeNull();
      noteClaudeOutOfCredits(other);
      // out_of_credits ignores the clock entirely
      expect(readClaudeUsageCache(other, undefined, new Date(Date.now() + 10 * 24 * 3600 * 1000))?.unavailable)
        .toEqual({ reason: 'out_of_credits' });
    });
  });

});
