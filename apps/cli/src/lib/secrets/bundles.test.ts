import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  filterAgentHitBySubsetAndExpiry,
  assertRemoteBundleFlagsUnsupported,
  isHeadlessSecretsContext,
  listBundles,
  readAndResolveBundleEnv,
  readBundle,
  shouldEvictAfterBundleWrite,
  writeBundle,
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

describe('readAndResolveBundleEnv agent-only reads', () => {
  it('fails before touching Keychain when the broker has no unlocked snapshot', () => {
    let keychainCalls = 0;
    const fail = () => { keychainCalls++; throw new Error('keychain must not be read'); };
    const backend: KeychainBackend = {
      has: fail,
      get: fail,
      set: fail,
      delete: fail,
      list: fail,
    };
    const previousBackend = setKeychainBackendForTest(backend);
    const previousNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    try {
      expect(() => readAndResolveBundleEnv('claude', { caller: 'daemon', agentOnly: true }))
        .toThrow("Secrets bundle 'claude' is not unlocked in the secrets agent");
      expect(keychainCalls).toBe(0);
    } finally {
      setKeychainBackendForTest(previousBackend);
      if (previousNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
      else process.env.AGENTS_SECRETS_NO_AGENT = previousNoAgent;
    }
  });
});

describe('isHeadlessSecretsContext', () => {
  it('is true for headless/teams runtime and false for a terminal runtime', () => {
    expect(isHeadlessSecretsContext({ AGENTS_RUNTIME: 'headless' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isHeadlessSecretsContext({ AGENTS_RUNTIME: 'teams' } as NodeJS.ProcessEnv)).toBe(true);
    // terminal runtime with the current process's TTY state is not forced headless
    // by the env alone; the explicit override is the deterministic lever below.
  });

  it('honors AGENTS_SECRETS_NO_PROMPT override (1 forces headless-safe, 0 force-allows)', () => {
    expect(isHeadlessSecretsContext({ AGENTS_SECRETS_NO_PROMPT: '1', AGENTS_RUNTIME: 'terminal' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isHeadlessSecretsContext({ AGENTS_SECRETS_NO_PROMPT: '0', AGENTS_RUNTIME: 'headless' } as NodeJS.ProcessEnv)).toBe(false);
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
