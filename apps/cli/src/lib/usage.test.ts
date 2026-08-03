import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { claudeAccessTokenNeedsRefresh, claudeUsageAccessTokenNoRefresh, loadClaudeOauth, saveClaudeOauth, getClaudeKeychainService, swrWindowMsFor, getUsageInfo, formatUsageSummary, usageNoCredentialError, usageExpiredCredentialError, usageRejectedError, probeClaudeStatus, probeKimiStatus } from './usage.js';
import { noteUsageRateLimited, setUsageBackoffDirForTest } from './usage-backoff.js';
import { setKeychainToken, setKeychainBackendForTest, secretsKeychainItem, type KeychainBackend } from './secrets/index.js';
import { writeBundle, keychainRef, bundleItemStore } from './secrets/bundles.js';
import { _resetFileStoreForTest } from './secrets/filestore.js';

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
 * The Touch ID storm fix: `loadClaudeOauth` reads Claude's ACL-bound keychain item
 * (one prompt per read on macOS). We cache the access token in a no-ACL item so the
 * source read happens at most once per token lifetime, shared across processes.
 * Here the in-memory keychain backend (the sanctioned test seam) counts source reads
 * by payload shape — the source item wraps `claudeAiOauth`, the cache item does not.
 */
describe('loadClaudeOauth no-ACL access-token cache', () => {
  /** Counting backend: tracks reads of the source (ACL) item and no-ACL cache writes,
   *  identified by value shape so the test is agnostic to keychain name hashing. */
  class CountingBackend implements KeychainBackend {
    store = new Map<string, string>();
    sourceReads = 0;
    noAclCacheWrites = 0;
    has(item: string) { return this.store.has(item); }
    get(item: string) {
      const v = this.store.get(item);
      if (v === undefined) throw new Error(`missing ${item}`);
      if (v.includes('"claudeAiOauth"')) this.sourceReads += 1;
      return v;
    }
    set(item: string, value: string, opts?: { noAcl?: boolean }) {
      if (opts?.noAcl && value.includes('"cacheExpiresAt"')) this.noAclCacheWrites += 1;
      this.store.set(item, value);
    }
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

  it('reads the ACL source once, then serves the no-ACL cache (no repeat prompt)', async () => {
    const mem = new CountingBackend();
    const prev = setKeychainBackendForTest(mem);
    try {
      seedSource(Date.now() + 60 * 60 * 1000); // fresh: 1h out

      const first = await loadClaudeOauth(HOME, { accessTokenCache: true });
      const second = await loadClaudeOauth(HOME, { accessTokenCache: true });

      expect(first?.accessToken).toBe('tok-live');
      expect(second?.accessToken).toBe('tok-live');
      // The source (prompting) item is read exactly once across both loads.
      expect(mem.sourceReads).toBe(1);
      // The cache was populated via the no-ACL write path.
      expect(mem.noAclCacheWrites).toBe(1);
      // The cache deliberately omits the refresh token (minimal no-ACL exposure);
      // the first read comes straight from source and still carries it.
      expect(first?.refreshToken).toBe('refresh-secret');
      expect(second?.refreshToken).toBeNull();
    } finally {
      setKeychainBackendForTest(prev);
    }
  });

  it('re-reads the source when the cached token has expired (never serves a stale token)', async () => {
    const mem = new CountingBackend();
    const prev = setKeychainBackendForTest(mem);
    try {
      seedSource(Date.now() - 60 * 1000); // already expired

      await loadClaudeOauth(HOME, { accessTokenCache: true });
      await loadClaudeOauth(HOME, { accessTokenCache: true });

      // Every load evicts the expired cache entry and reads the source again.
      expect(mem.sourceReads).toBe(2);
    } finally {
      setKeychainBackendForTest(prev);
    }
  });

  it('without the opt-in, returns the full credential and never caches (cloud-export contract)', async () => {
    // readClaudeCredentialsBlob / isClaudeAuthValid call loadClaudeOauth WITHOUT
    // the cache flag: they must always get the ACL-read credential WITH the refresh
    // token. Regression guard for the Rush Cloud token-export path.
    const mem = new CountingBackend();
    const prev = setKeychainBackendForTest(mem);
    try {
      seedSource(Date.now() + 60 * 60 * 1000);

      const first = await loadClaudeOauth(HOME); // default: no cache
      const second = await loadClaudeOauth(HOME);

      // Full refresh token every time — never dropped.
      expect(first?.refreshToken).toBe('refresh-secret');
      expect(second?.refreshToken).toBe('refresh-secret');
      // No no-ACL cache is ever written on the default path.
      expect(mem.noAclCacheWrites).toBe(0);
      // Every default read goes to the ACL source (no cache short-circuit).
      expect(mem.sourceReads).toBe(2);
    } finally {
      setKeychainBackendForTest(prev);
    }
  });

  it('evicts the no-ACL cache when the source credential is rotated', async () => {
    // A refresh (getClaudeAccessToken -> saveClaudeOauth) writes a new source token.
    // The cache must be invalidated so the next cached caller sees the rotated token,
    // not the stale cached access token.
    const mem = new CountingBackend();
    const prev = setKeychainBackendForTest(mem);
    try {
      seedSource(Date.now() + 60 * 60 * 1000);

      const first = await loadClaudeOauth(HOME, { accessTokenCache: true });
      expect(first?.accessToken).toBe('tok-live');

      await saveClaudeOauth(HOME, {
        accessToken: 'tok-rotated',
        refreshToken: 'refresh-secret',
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: ['user:inference'],
      });

      const second = await loadClaudeOauth(HOME, { accessTokenCache: true });
      expect(second?.accessToken).toBe('tok-rotated');
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
});

describe('swrWindowMsFor — a routing decision does not get day-old data', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('defaults to the full stale-while-revalidate window for display callers', () => {
    // `agents view` rendering a slightly old bar costs nothing, so it stays off
    // the network exactly as before.
    expect(swrWindowMsFor(undefined)).toBe(DAY);
  });

  it('shortens the window for a caller that is about to route on the number', () => {
    // The measured failure: a 26h-old snapshot read as "48% used" while the
    // account was at its weekly cap. Five minutes is inside the window; a day
    // is not, so the read blocks on a live fetch instead of serving the cache.
    expect(swrWindowMsFor(5 * 60 * 1000)).toBe(5 * 60 * 1000);
    expect(swrWindowMsFor(5 * 60 * 1000)).toBeLessThan(26 * 60 * 60 * 1000);
  });

  it('never lets a caller opt into MORE staleness than the cache policy allows', () => {
    expect(swrWindowMsFor(7 * DAY)).toBe(DAY);
  });

  it('treats an unusable age as no opinion — the caller simply did not ask', () => {
    expect(swrWindowMsFor(Number.NaN)).toBe(DAY);
    expect(swrWindowMsFor(Number.POSITIVE_INFINITY)).toBe(DAY);
  });

  it('clamps a negative age to zero — that IS an opinion: never serve the cache', () => {
    expect(swrWindowMsFor(-1)).toBe(0);
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

  it('names an expired credential — the state a usage read can never heal', async () => {
    // A usage read never refreshes (RUSH-1822), so this account stays unreadable
    // until a real claude run rotates the token. Saying so is the whole point.
    setKeychainToken(
      getClaudeKeychainService(home),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tok-stale', refreshToken: 'r', expiresAt: Date.now() - 60_000 },
      })
    );

    const usage = await getUsageInfo('claude', { home });

    expect(usage.snapshot).toBeNull();
    expect(usage.error).toBe(usageExpiredCredentialError('Claude'));
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
    // A HEALTHY, unexpired credential — this is the case that matters. The
    // credential checks ahead of the guard make no request, so they run first
    // and correctly win for a home that has none; the guard exists to stop the
    // request that a good credential would otherwise make into a live penalty.
    const mem = new MemBackend();
    const prevBackend = setKeychainBackendForTest(mem);
    try {
      setKeychainToken(
        getClaudeKeychainService(home),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'tok-fresh', refreshToken: 'r', expiresAt: Date.now() + 60 * 60 * 1000 },
        })
      );
      // The exact header the endpoint sent on yosemite-s1.
      noteUsageRateLimited('claude', '2678');

      const usage = await getUsageInfo('claude', { home });

      expect(usage.snapshot).toBeNull();
      expect(usage.error).toContain('rate-limited this machine');
      expect(usage.error).toContain('not retrying');
    } finally {
      setKeychainBackendForTest(prevBackend);
    }
  });

  it('lets the read through once the window has passed', async () => {
    noteUsageRateLimited('claude', '1', { now: Date.now() - 60_000 });

    const usage = await getUsageInfo('claude', { home });

    // Falls through to the ordinary credential check for this empty home.
    expect(usage.error).toBe(usageNoCredentialError('Claude'));
  });
});

describe('the throttle guard covers every provider, not just Claude', () => {
  // The review that forced this: with only Claude tested, two real bugs shipped
  // through — Cursor's error `return` was left unconditional by a braceless
  // `if` (so every 200 would have failed), and Kimi's probe guard sat AHEAD of
  // its missing/expired credential checks, misreporting a broken credential as
  // merely throttled. Per-provider coverage is what catches that class.
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

describe('no response-status branch hides an unconditional return', () => {
  // The defect this pins, found in review and not by any behavioural test:
  // inserting a 429-recording block into Cursor's one-liner
  // `if (!response.ok) return {...};` left a braceless `if`, so the error return
  // escaped the condition and EVERY 200 would have failed the read. tsc compiled
  // it without complaint.
  //
  // A behavioural test cannot reach that line — it needs a real 200 from a live
  // provider, and this repo does not mock. So the assertion is structural: it
  // reads the shipped source and fails against the pre-fix text, which is what a
  // regression test has to do.
  it('braces every `if (!response.ok)` in the usage fetches', () => {
    const src = fs.readFileSync(new URL('./usage.ts', import.meta.url), 'utf-8');
    const lines = src.split('\n');
    const offenders: string[] = [];

    lines.forEach((line, idx) => {
      const m = line.match(/if\s*\(!response\.ok\)\s*(.*)$/);
      if (!m) return;
      const tail = m[1].trim();
      // Either it opens a block, or it is a complete single statement on the
      // same line. A bare `if (...) if (...) {` — the shape that shipped — is
      // neither, and is what this catches.
      const ok = tail === '{' || (tail.startsWith('return') && tail.endsWith(';'));
      if (!ok) offenders.push(`usage.ts:${idx + 1}: ${line.trim()}`);
    });

    expect(offenders).toEqual([]);
  });
});
