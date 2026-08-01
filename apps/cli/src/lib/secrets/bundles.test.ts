import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  filterAgentHitBySubsetAndExpiry,
  assertRemoteBundleFlagsUnsupported,
  canCacheResolvedEnv,
  isHeadlessSecretsContext,
  listBundles,
  readAndResolveBundleEnv,
  readBundle,
  shouldEvictAfterBundleWrite,
  writeBundle,
  writeBundleWithItems,
  healKeychainBundleMetadata,
  type SecretsBundle,
} from './bundles.js';
import {
  deleteKeychainToken,
  secretsKeychainItem,
  setKeychainBackendForTest,
  setKeychainServiceHashingForTest,
  setKeychainToken,
  type KeychainBackend,
} from './index.js';
import { saveSession } from './session-store.js';

/**
 * Regression tests for the two least-privilege bypasses on the
 * `--secrets X --secrets-keys K [--allow-expired]` path.
 *
 * Pre-fix, `readAndResolveBundleEnv`'s secrets-agent fast-path returned the
 * cached snapshot verbatim — so once the broker had the bundle, `--keys`
 * silently injected every key and an expired key silently flowed through.
 * These tests drive the extracted helper (`filterAgentHitBySubsetAndExpiry`)
 * that the fast-path now runs before returning the hit.
 *
 * The remote (`bundle@host`) path also ignored those flags; the shared
 * `assertRemoteBundleFlagsUnsupported` guard now fails loud instead of
 * silently dropping them.
 */

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function agentHit(
  vars: Record<string, string>,
  meta: SecretsBundle['meta'] = undefined,
): { bundle: SecretsBundle; env: Record<string, string> } {
  const bundle: SecretsBundle = {
    name: 'prod',
    vars,
    meta,
  };
  // The broker caches the fully-resolved env — one entry per var, values
  // already fetched from keychain. Mirror that shape here.
  const env: Record<string, string> = {};
  for (const k of Object.keys(vars)) env[k] = `v-${k}`;
  return { bundle, env };
}

describe('filterAgentHitBySubsetAndExpiry (agent fast-path gate)', () => {
  it('returns the cached hit untouched when no --keys / --allow-expired is set', () => {
    const hit = agentHit({ API_KEY: 'k', DB_URL: 'k' });
    const out = filterAgentHitBySubsetAndExpiry(hit, {});
    // Same reference — the hot path should not re-allocate for the default flow.
    expect(out).toBe(hit);
    expect(out.env).toEqual({ API_KEY: 'v-API_KEY', DB_URL: 'v-DB_URL' });
  });

  it('narrows the returned env to the requested subset (least-privilege honoured on fast-path)', () => {
    // Pre-fix: the fast-path returned all 3 keys regardless of `keys`.
    const hit = agentHit({ API_KEY: 'k', DB_URL: 'k', SLACK_TOKEN: 'k' });
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['API_KEY'] });
    expect(Object.keys(out.env).sort()).toEqual(['API_KEY']);
    expect(out.env.API_KEY).toBe('v-API_KEY');
    expect(out.env.DB_URL).toBeUndefined();
    expect(out.env.SLACK_TOKEN).toBeUndefined();
  });

  it('does not return a same-size partial cached env for a different requested subset', () => {
    const hit = agentHit({ API_KEY: 'k', DB_URL: 'k' });
    hit.env = { API_KEY: 'v-API_KEY' };
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['DB_URL'] });
    expect(out.env).toEqual({});
  });

  it('projects a selected account-suffixed key from the cached snapshot', () => {
    const hit = agentHit({
      'GITHUB_USERNAME.personal': 'k',
      'GITHUB_USERNAME.work': 'k',
    });
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['GITHUB_USERNAME.personal'] });
    expect(out.env).toEqual({ GITHUB_USERNAME: 'v-GITHUB_USERNAME.personal' });
  });

  it('preserves exact account-suffixed keys when storage mode is requested', () => {
    const hit = agentHit({ 'GITHUB_USERNAME.personal': 'k' });
    const out = filterAgentHitBySubsetAndExpiry(hit, {
      keys: ['GITHUB_USERNAME.personal'],
      keyMode: 'storage',
    });
    expect(out.env).toEqual({ 'GITHUB_USERNAME.personal': 'v-GITHUB_USERNAME.personal' });
  });

  it('fails loudly when cached account variants collide in process env mode', () => {
    const hit = agentHit({
      'GITHUB_USERNAME.personal': 'k',
      'GITHUB_USERNAME.work': 'k',
    });
    expect(() => filterAgentHitBySubsetAndExpiry(hit, {}))
      .toThrow(/maps multiple keys to 'GITHUB_USERNAME'/);
  });

  it('throws a fail-loud error if a requested key is not in the bundle', () => {
    const hit = agentHit({ API_KEY: 'k' });
    expect(() => filterAgentHitBySubsetAndExpiry(hit, { keys: ['GHOST'] }))
      .toThrow(/does not contain key\(s\): GHOST/);
  });

  it('aborts on an expired key (pre-fix the agent snapshot silently injected it)', () => {
    const hit = agentHit(
      { API_KEY: 'k', DB_URL: 'k' },
      { API_KEY: { expires: YESTERDAY } },
    );
    // No --keys: every key is selected, so the expired one aborts.
    expect(() => filterAgentHitBySubsetAndExpiry(hit, {}))
      .toThrow(/API_KEY' expired on/);
    // Requested a still-valid key: no abort, and DB_URL comes through.
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['DB_URL'] });
    expect(Object.keys(out.env)).toEqual(['DB_URL']);
    // Requested the expired key without --allow-expired: aborts.
    expect(() => filterAgentHitBySubsetAndExpiry(hit, { keys: ['API_KEY'] }))
      .toThrow(/API_KEY' expired on/);
  });

  it('honours --allow-expired: injects the expired key without aborting', () => {
    const hit = agentHit(
      { API_KEY: 'k' },
      { API_KEY: { expires: YESTERDAY } },
    );
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['API_KEY'], allowExpired: true });
    expect(out.env).toEqual({ API_KEY: 'v-API_KEY' });
  });

  it('does not abort on a future expiry', () => {
    const hit = agentHit(
      { API_KEY: 'k' },
      { API_KEY: { expires: TOMORROW } },
    );
    const out = filterAgentHitBySubsetAndExpiry(hit, { keys: ['API_KEY'] });
    expect(out.env).toEqual({ API_KEY: 'v-API_KEY' });
  });
});

describe('canCacheResolvedEnv (broker cache shape)', () => {
  const bundle: SecretsBundle = {
    name: 'github.com',
    vars: {
      'GITHUB_USERNAME.personal': 'keychain:GITHUB_USERNAME.personal',
      'GITHUB_USERNAME.work': 'keychain:GITHUB_USERNAME.work',
    },
  };

  it('does not cache partial storage reads because the broker expects a full bundle env', () => {
    expect(canCacheResolvedEnv(bundle, new Set(['GITHUB_USERNAME.personal']), 'storage')).toBe(false);
  });

  it('allows a full storage snapshot because later reads can project from exact keys', () => {
    expect(canCacheResolvedEnv(bundle, new Set(Object.keys(bundle.vars)), 'storage')).toBe(true);
  });

  it('does not cache process-mode env when account suffixes would be stripped', () => {
    expect(canCacheResolvedEnv(bundle, new Set(Object.keys(bundle.vars)), 'process')).toBe(false);
  });
});

describe('readAndResolveBundleEnv agent-only reads', () => {
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
  let mem: MemBackend;
  let prevBackend: KeychainBackend;
  let prevNoAgent: string | undefined;
  beforeEach(() => {
    mem = new MemBackend();
    prevBackend = setKeychainBackendForTest(mem);
    prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    process.env.AGENTS_SECRETS_NO_AGENT = '1'; // disable the broker fast-path
  });
  afterEach(() => {
    setKeychainBackendForTest(prevBackend);
    if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
    else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
  });

  it('throws for an ACL-gated (daily) bundle with no broker/session snapshot — never raises a Touch ID sheet headlessly', () => {
    writeBundleWithItems(
      { name: 'apple.com', policy: 'daily', vars: { APPLE_TEAM_ID: 'keychain:APPLE_TEAM_ID' } },
      new Map([[secretsKeychainItem('apple.com', 'APPLE_TEAM_ID'), '2HTP252L87']]),
    );
    expect(() => readAndResolveBundleEnv('apple.com', { caller: 'daemon', agentOnly: true }))
      .toThrow("Secrets bundle 'apple.com' is not unlocked in the secrets agent");
  });

  it('resolves a never/no-ACL bundle silently in a headless read — the daemon automation path (no unlock, no session, no throw)', () => {
    // A `never` bundle carries no biometry ACL, so its reads raise no Touch ID
    // sheet — the headless guard must let it through, exactly as the routines
    // daemon reads the `claude` OAuth token at startup (daemon.ts).
    writeBundleWithItems(
      { name: 'claude', policy: 'never', vars: { CLAUDE_CODE_OAUTH_TOKEN: 'keychain:CLAUDE_CODE_OAUTH_TOKEN' } },
      new Map([[secretsKeychainItem('claude', 'CLAUDE_CODE_OAUTH_TOKEN'), 'sk-ant-oat-headless']]),
    );
    const { env } = readAndResolveBundleEnv('claude', { caller: 'daemon', agentOnly: true });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-headless' });
  });
});

describe('isHeadlessSecretsContext', () => {
  it('is true for headless/teams runtime on darwin (where the Touch ID sheet exists)', () => {
    expect(isHeadlessSecretsContext({ AGENTS_RUNTIME: 'headless' } as NodeJS.ProcessEnv, 'darwin')).toBe(true);
    expect(isHeadlessSecretsContext({ AGENTS_RUNTIME: 'teams' } as NodeJS.ProcessEnv, 'darwin')).toBe(true);
  });

  it('is ALWAYS false off-darwin — no biometry prompt to suppress on Linux/Windows', () => {
    // Critical: forcing broker-only off-darwin would break every headless
    // Linux/Windows read (CI, `agents run --headless`, routines, the release flow),
    // because the broker is a no-op off-darwin and the read would throw before the
    // real (prompt-less) backend answers.
    expect(isHeadlessSecretsContext({ AGENTS_RUNTIME: 'headless' } as NodeJS.ProcessEnv, 'linux')).toBe(false);
    expect(isHeadlessSecretsContext({ AGENTS_RUNTIME: 'teams' } as NodeJS.ProcessEnv, 'win32')).toBe(false);
    expect(isHeadlessSecretsContext({ AGENTS_SECRETS_NO_PROMPT: '1' } as NodeJS.ProcessEnv, 'linux')).toBe(false);
  });

  it('honors AGENTS_SECRETS_NO_PROMPT override on darwin (1 forces headless-safe, 0 force-allows)', () => {
    expect(isHeadlessSecretsContext({ AGENTS_SECRETS_NO_PROMPT: '1', AGENTS_RUNTIME: 'terminal' } as NodeJS.ProcessEnv, 'darwin')).toBe(true);
    expect(isHeadlessSecretsContext({ AGENTS_SECRETS_NO_PROMPT: '0', AGENTS_RUNTIME: 'headless' } as NodeJS.ProcessEnv, 'darwin')).toBe(false);
  });
});

describe('assertRemoteBundleFlagsUnsupported (remote bundle guard)', () => {
  const labels = { keysFlag: '--secrets-keys', allowExpiredFlag: '--allow-expired' };

  it('is a no-op when neither flag is set (remote resolve proceeds as before)', () => {
    expect(() => assertRemoteBundleFlagsUnsupported('prod', 'host', {}, labels)).not.toThrow();
    expect(() => assertRemoteBundleFlagsUnsupported('prod', 'host', { keys: [] }, labels)).not.toThrow();
  });

  it('throws a clear error when --keys narrows a remote bundle (pre-fix: silently ignored)', () => {
    expect(() => assertRemoteBundleFlagsUnsupported('prod', 'yosemite', { keys: ['API_KEY'] }, labels))
      .toThrow(/Bundle 'prod@yosemite': --secrets-keys and --allow-expired are not supported for remote/);
  });

  it('throws a clear error when --allow-expired is combined with a remote bundle', () => {
    expect(() => assertRemoteBundleFlagsUnsupported('prod', 'yosemite', { allowExpired: true }, labels))
      .toThrow(/not supported for remote \(bundle@host\) bundles/);
  });

  it('renders the caller-supplied flag labels (secrets exec uses --keys, run uses --secrets-keys)', () => {
    expect(() =>
      assertRemoteBundleFlagsUnsupported('prod', 'yosemite', { keys: ['A'] }, {
        keysFlag: '--keys',
        allowExpiredFlag: '--allow-expired',
      }),
    ).toThrow(/--keys and --allow-expired are not supported/);
  });
});

describe('shouldEvictAfterBundleWrite (writes never leave a stale broker copy)', () => {
  it('evicts after a mutating write (add / rotate / remove / policy)', () => {
    // Pre-fix, only `secrets policy` evicted; a rotate left the broker serving
    // the OLD value for up to the ~7d hold.
    expect(shouldEvictAfterBundleWrite(false, undefined, false)).toBe(true);
  });

  it('skips when the writer opted out (stampLastUsed fires on every broker HIT)', () => {
    expect(shouldEvictAfterBundleWrite(true, undefined, false)).toBe(false);
  });

  it('honors the AGENTS_SECRETS_NO_AGENT kill-switch, same as the read fast-path', () => {
    expect(shouldEvictAfterBundleWrite(false, '1', false)).toBe(false);
    expect(shouldEvictAfterBundleWrite(false, '0', false)).toBe(true);
  });

  it('never touches the real broker while a test keychain backend is installed', () => {
    // A test writing bundle 'prod' must not evict the user's real 'prod' unlock.
    expect(shouldEvictAfterBundleWrite(false, undefined, true)).toBe(false);
  });
});

// ─── Bundle lifecycle under hashed service names (GitHub #316) ──────────────
//
// Same code paths as production macOS with hashing active: the in-memory
// backend stands in for the keychain, the test seam pins the HMAC key, and
// every storage-layer name must be opaque (`agents-cli.h.*`).

describe('bundles under hashed service names (#316)', () => {
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

  let mem: MemBackend;
  let prevBackend: KeychainBackend | null = null;
  const key = randomBytes(32);
  const prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  const prevNoUsage = process.env.AGENTS_NO_USAGE_TRACK;

  beforeEach(() => {
    mem = new MemBackend();
    prevBackend = setKeychainBackendForTest(mem);
    setKeychainServiceHashingForTest(key);
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    process.env.AGENTS_NO_USAGE_TRACK = '1';
  });
  afterEach(() => {
    setKeychainServiceHashingForTest(null);
    setKeychainBackendForTest(prevBackend);
    if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
    else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
    if (prevNoUsage === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
    else process.env.AGENTS_NO_USAGE_TRACK = prevNoUsage;
  });

  function createBundle(name: string, vars: Record<string, string>): void {
    const bundle: SecretsBundle = { name, vars: {} };
    for (const [k, v] of Object.entries(vars)) {
      setKeychainToken(secretsKeychainItem(name, k), v);
      bundle.vars[k] = `keychain:${k}`;
    }
    writeBundle(bundle);
  }

  it('stores metadata and values under opaque names only', () => {
    createBundle('prod', { API_KEY: 'sk-1', DB_URL: 'postgres://x' });
    for (const stored of mem.store.keys()) {
      expect(stored).toMatch(/^agents-cli\.h\./);
      expect(stored).not.toContain('prod');
      expect(stored).not.toContain('API_KEY');
    }
  });

  it('readBundle and readAndResolveBundleEnv round-trip by bundle name (one silent enumeration + one batch)', () => {
    createBundle('prod', { API_KEY: 'sk-1', DB_URL: 'postgres://x' });
    expect(Object.keys(readBundle('prod').vars).sort()).toEqual(['API_KEY', 'DB_URL']);
    const { bundle, env } = readAndResolveBundleEnv('prod', { caller: 'test' });
    expect(bundle.name).toBe('prod');
    expect(env).toEqual({ API_KEY: 'sk-1', DB_URL: 'postgres://x' });
  });

  it('listBundles recovers display names from the persisted metadata JSON', () => {
    createBundle('prod', { API_KEY: 'sk-1' });
    createBundle('hetzner.com', { HCLOUD_TOKEN: 'hc-1' });
    const names = listBundles().map((b) => b.name);
    expect(names).toContain('prod');
    expect(names).toContain('hetzner.com');
  });

  it('deleting a key purges the hashed value item', () => {
    createBundle('prod', { API_KEY: 'sk-1' });
    const item = secretsKeychainItem('prod', 'API_KEY');
    expect(deleteKeychainToken(item)).toBe(true);
    expect(() => readAndResolveBundleEnv('prod', {})).toThrow(/stored item .* not found/);
  });
});

// The durable-session read fallback (Correction B): after a restart the broker
// RAM is empty, so the fast-path misses; a persisted unlock session must satisfy
// the read silently instead of throwing / re-prompting.
describe('durable session read fallback', () => {
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

  let mem: MemBackend;
  let prev: KeychainBackend | null = null;
  const prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  const prevNoUsage = process.env.AGENTS_NO_USAGE_TRACK;

  beforeEach(() => {
    mem = new MemBackend();
    prev = setKeychainBackendForTest(mem);
    // The fallback is gated behind the agent path — do NOT set NO_AGENT here (the
    // other suite does). There is no broker socket in CI, so agentGetSync misses
    // and we fall through to the session store.
    delete process.env.AGENTS_SECRETS_NO_AGENT;
    process.env.AGENTS_NO_USAGE_TRACK = '1';
  });
  afterEach(() => {
    setKeychainBackendForTest(prev);
    if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
    else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
    if (prevNoUsage === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
    else process.env.AGENTS_NO_USAGE_TRACK = prevNoUsage;
  });

  function seed(name: string, vars: Record<string, string>): { bundle: SecretsBundle; env: Record<string, string> } {
    const bundle: SecretsBundle = { name, vars: {} };
    for (const [k, v] of Object.entries(vars)) {
      setKeychainToken(secretsKeychainItem(name, k), v);
      bundle.vars[k] = `keychain:${k}`;
    }
    writeBundle(bundle);
    return readAndResolveBundleEnv(name, { noAgent: true, caller: 'seed' });
  }

  it('a headless read resolves from a live session instead of throwing "not unlocked"', () => {
    const { bundle, env } = seed('apple.com', { APPLE_TEAM_ID: '2HTP252L87' });
    // No session yet → the headless (agentOnly) read must throw.
    expect(() => readAndResolveBundleEnv('apple.com', { agentOnly: true })).toThrow(/not unlocked in the secrets agent/);
    // Persist an unlock → the SAME headless read now resolves silently.
    saveSession('apple.com', { bundle, env, expiresAt: Date.now() + 60_000, sleepPersist: false });
    expect(readAndResolveBundleEnv('apple.com', { agentOnly: true }).env).toEqual({ APPLE_TEAM_ID: '2HTP252L87' });
  });

  it('honors --keys subset from the session snapshot', () => {
    const { bundle, env } = seed('multi', { A: '1', B: '2' });
    saveSession('multi', { bundle, env, expiresAt: Date.now() + 60_000, sleepPersist: true });
    expect(readAndResolveBundleEnv('multi', { agentOnly: true, keys: ['A'] }).env).toEqual({ A: '1' });
  });

  it('an expired session does not satisfy the read', () => {
    const { bundle, env } = seed('stale', { T: 'x' });
    saveSession('stale', { bundle, env, expiresAt: Date.now() - 1000, sleepPersist: true });
    expect(() => readAndResolveBundleEnv('stale', { agentOnly: true })).toThrow(/not unlocked/);
  });
});

// RUSH-1759: bundle metadata (names, policy, refs, non-sensitive literals) is
// non-sensitive by contract, so it is written WITHOUT the biometry ACL at every
// tier — that is what lets `secrets list` / crabbox's `agents devices list`
// enumerate bundles with no Touch ID. Real secret VALUE items still carry the
// bundle's policy ACL. These tests pin that split at the write path, plus the
// one-time heal for metadata that predates the change.
describe('metadata is stored no-ACL at every tier (RUSH-1759)', () => {
  class RecordingBackend implements KeychainBackend {
    store = new Map<string, string>();
    /** Per item: did its last write take the no-ACL (`set-no-acl`) path? */
    noAcl = new Map<string, boolean>();
    has(item: string) { return this.store.has(item); }
    get(item: string) {
      const v = this.store.get(item);
      if (v === undefined) throw new Error(`missing ${item}`);
      return v;
    }
    set(item: string, value: string, opts?: { noAcl?: boolean }) {
      this.store.set(item, value);
      this.noAcl.set(item, Boolean(opts?.noAcl));
    }
    delete(item: string) { this.noAcl.delete(item); return this.store.delete(item); }
    list(prefix: string) { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
  }

  let mem: RecordingBackend;
  let prev: KeychainBackend | null = null;
  const prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  const prevNoUsage = process.env.AGENTS_NO_USAGE_TRACK;
  const META = (name: string) => `agents-cli.bundles.${name}`;

  beforeEach(() => {
    mem = new RecordingBackend();
    // Cleartext names (no hashing seam) so items are asserted by their plain name.
    prev = setKeychainBackendForTest(mem);
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    process.env.AGENTS_NO_USAGE_TRACK = '1';
  });
  afterEach(() => {
    setKeychainBackendForTest(prev);
    if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
    else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
    if (prevNoUsage === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
    else process.env.AGENTS_NO_USAGE_TRACK = prevNoUsage;
  });

  it("writeBundle stores a daily/always bundle's metadata without the biometry ACL", () => {
    writeBundle({ name: 'prod', policy: 'always', vars: { NOTE: { value: 'hello' } } });
    expect(mem.noAcl.get(META('prod'))).toBe(true);
  });

  it('writeBundleWithItems: metadata always no-ACL; value items keep their per-policy ACL', () => {
    writeBundleWithItems(
      { name: 'prod', policy: 'daily', vars: { API_KEY: 'keychain:API_KEY' } },
      new Map([[secretsKeychainItem('prod', 'API_KEY'), 'sk-1']]),
    );
    expect(mem.noAcl.get(META('prod'))).toBe(true); // metadata: no-ACL
    expect(mem.noAcl.get(secretsKeychainItem('prod', 'API_KEY'))).toBe(false); // value: ACL'd (daily)

    writeBundleWithItems(
      { name: 'cron', policy: 'never', vars: { TOKEN: 'keychain:TOKEN' } },
      new Map([[secretsKeychainItem('cron', 'TOKEN'), 't']]),
    );
    expect(mem.noAcl.get(META('cron'))).toBe(true); // metadata: no-ACL
    expect(mem.noAcl.get(secretsKeychainItem('cron', 'TOKEN'))).toBe(true); // value: no-ACL (never)
  });

  it('healKeychainBundleMetadata re-homes each legacy metadata item no-ACL', () => {
    // Simulate metadata written ACL'd by an older CLI.
    for (const name of ['old1', 'old2']) {
      mem.store.set(META(name), JSON.stringify({ name, vars: {} }));
      mem.noAcl.set(META(name), false);
    }
    const healed = healKeychainBundleMetadata(new Map([
      ['old1', mem.get(META('old1'))],
      ['old2', mem.get(META('old2'))],
    ]));
    expect(healed).toBe(2);
    expect(mem.noAcl.get(META('old1'))).toBe(true);
    expect(mem.noAcl.get(META('old2'))).toBe(true);
  });
});
