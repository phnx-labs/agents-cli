import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  KeychainBackend,
  setKeychainBackendForTest,
  setKeychainServiceHashingForTest,
  setKeychainToken,
  hasKeychainToken,
} from './index.js';
import type { SecretsBundle } from './bundles.js';
import {
  selectRehydratable,
  pruneOnSleep,
  pruneExpired,
  upsertEntry,
  removeEntry,
  saveSession,
  resolveSession,
  loadSession,
  deleteSession,
  deleteAllSessions,
  deleteBundleSessions,
  rehydrateSessions,
  pruneSessionsOnSleep,
  readIndex,
  type SessionIndex,
  type SessionEntry,
  SESSION_INDEX_ITEM,
  SESSION_ITEM_PREFIX,
} from './session-store.js';

const FAR = 10 * 24 * 60 * 60 * 1000; // 10 days out
const bundle = (name: string) => ({ name, description: '', vars: {}, policy: 'daily' } as unknown as SecretsBundle);
const entry = (name: string, expiresAt: number, sleepPersist: boolean): SessionEntry => ({
  bundle: bundle(name),
  env: { TOKEN: `secret-${name}` },
  expiresAt,
  sleepPersist,
});

// ─── Pure core (no backend, any platform) ────────────────────────────────────

describe('session-store pure core', () => {
  const idx = (bundles: SessionIndex['bundles']): SessionIndex => ({ bundles });

  it('selectRehydratable keeps only entries within TTL', () => {
    const now = 1000;
    const i = idx({ a: { expiresAt: 2000, sleepPersist: false }, b: { expiresAt: 500, sleepPersist: true } });
    expect(selectRehydratable(i, now).sort()).toEqual(['a']);
  });

  it('pruneOnSleep keeps sleepPersist=true, reports the rest', () => {
    const i = idx({ a: { expiresAt: FAR, sleepPersist: false }, b: { expiresAt: FAR, sleepPersist: true } });
    const { survivors, deletedNames } = pruneOnSleep(i);
    expect(Object.keys(survivors.bundles)).toEqual(['b']);
    expect(deletedNames).toEqual(['a']);
  });

  it('pruneExpired drops entries past TTL', () => {
    const now = 1000;
    const i = idx({ a: { expiresAt: 2000, sleepPersist: false }, b: { expiresAt: 500, sleepPersist: false } });
    const { survivors, expiredNames } = pruneExpired(i, now);
    expect(Object.keys(survivors.bundles)).toEqual(['a']);
    expect(expiredNames).toEqual(['b']);
  });

  it('upsert/remove are pure and non-mutating', () => {
    const i = idx({ a: { expiresAt: FAR, sleepPersist: false } });
    const up = upsertEntry(i, 'b', { expiresAt: FAR, sleepPersist: true });
    expect(Object.keys(up.bundles).sort()).toEqual(['a', 'b']);
    expect(Object.keys(i.bundles)).toEqual(['a']); // original untouched
    expect(Object.keys(removeEntry(up, 'a').bundles)).toEqual(['b']);
  });
});

// ─── Adapter against an in-memory keychain (Linux-CI safe) ────────────────────

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

// Run the whole adapter suite twice: cleartext names AND #316-hashed names. The
// hashed pass is the Correction-A regression guard — all I/O is by known name, so
// it must round-trip even when `list('agents-cli.session.')` would match nothing.
describe.each([
  { label: 'cleartext names', hash: false },
  { label: 'hashed names (#316)', hash: true },
])('session-store adapter · $label', ({ hash }) => {
  let mem: MemBackend;
  let prev: KeychainBackend | null = null;

  beforeEach(() => {
    mem = new MemBackend();
    prev = setKeychainBackendForTest(mem);
    if (hash) setKeychainServiceHashingForTest(randomBytes(32));
  });
  afterEach(() => {
    if (hash) setKeychainServiceHashingForTest(null);
    setKeychainBackendForTest(prev);
  });

  it('save → load round-trips the full entry by known name', () => {
    saveSession('apple.com', entry('apple.com', FAR + Date.now(), false));
    const got = loadSession('apple.com');
    expect(got?.env.TOKEN).toBe('secret-apple.com');
    expect(got?.bundle.name).toBe('apple.com');
    // index reflects the hold
    expect(Object.keys(readIndex().bundles)).toEqual(['*:apple.com']);
  });

  // The durable twin of the broker's scope chain: after a restart the broker RAM
  // is empty and reads come from here, so if this resolved differently a bundle
  // would work until the daemon bounced and then silently stop.
  it('resolveSession serves a global grant to an agent-scoped reader', () => {
    saveSession('npmjs.com', entry('npmjs.com', FAR + Date.now(), false));
    const got = resolveSession('npmjs.com', Date.now(), 'claude');
    expect(got?.entry.env.TOKEN).toBe('secret-npmjs.com');
    expect(got?.harness).toBe('*');
  });

  it('resolveSession prefers a --for grant over the global one', () => {
    saveSession('prod', entry('prod', FAR + Date.now(), false));
    saveSession('prod', { ...entry('prod', FAR + Date.now(), false), env: { TOKEN: 'narrow' }, harness: 'claude' });
    expect(resolveSession('prod', Date.now(), 'claude')?.entry.env.TOKEN).toBe('narrow');
    expect(resolveSession('prod', Date.now(), 'codex')?.entry.env.TOKEN).toBe('secret-prod');
  });

  it('resolveSession does not leak a --for grant to another harness', () => {
    saveSession('prod', { ...entry('prod', FAR + Date.now(), false), harness: 'claude' });
    expect(resolveSession('prod', Date.now(), 'codex')).toBeNull();
  });

  it('migrates a cli-scoped grant to global so an existing unlock keeps working', () => {
    // `cli` was never a harness — it was the default when AGENTS_AGENT_NAME was
    // unset, i.e. "unlocked from a terminal for general use". Without this
    // migration every grant a user already paid Touch ID for goes unreadable on
    // upgrade.
    saveSession('npmjs.com', { ...entry('npmjs.com', FAR + Date.now(), false), harness: 'cli' });
    expect(Object.keys(readIndex().bundles)).toEqual(['cli:npmjs.com']);
    rehydrateSessions();
    expect(Object.keys(readIndex().bundles)).toEqual(['*:npmjs.com']);
    expect(resolveSession('npmjs.com', Date.now(), 'claude')?.entry.env.TOKEN).toBe('secret-npmjs.com');
  });

  // Review catch: the migration used to overwrite a coexisting global grant with
  // the stale cli one. Real sequence — upgrade, re-run `unlock` (writes global),
  // then the broker restarts and migrates. Overwriting restored a superseded
  // token; if the stale entry had also expired, its expiry rode along and the
  // prune deleted a valid unlock outright.
  it('migration discards a stale cli grant instead of clobbering a fresh global one', () => {
    const now = Date.now();
    saveSession('npmjs.com', { ...entry('npmjs.com', now + FAR, false), env: { TOKEN: 'stale' }, harness: 'cli' });
    saveSession('npmjs.com', { ...entry('npmjs.com', now + FAR, false), env: { TOKEN: 'fresh' }, harness: '*' });
    expect(Object.keys(readIndex().bundles).sort()).toEqual(['*:npmjs.com', 'cli:npmjs.com']);
    rehydrateSessions(now);
    expect(Object.keys(readIndex().bundles)).toEqual(['*:npmjs.com']);
    expect(resolveSession('npmjs.com', now, 'claude')?.entry.env.TOKEN).toBe('fresh');
  });

  it('an expired stale cli grant cannot expire a live global grant', () => {
    const now = Date.now();
    saveSession('npmjs.com', { ...entry('npmjs.com', now + 1000, false), env: { TOKEN: 'stale' }, harness: 'cli' });
    saveSession('npmjs.com', { ...entry('npmjs.com', now + FAR, false), env: { TOKEN: 'fresh' }, harness: '*' });
    rehydrateSessions(now + 5000); // the cli entry is expired by now, the global one is not
    expect(resolveSession('npmjs.com', now + 5000, 'claude')?.entry.env.TOKEN).toBe('fresh');
  });

  it('does not reuse a persisted grant across harness types', () => {
    saveSession('prod', { ...entry('prod', FAR + Date.now(), false), harness: 'claude' });
    expect(loadSession('prod', Date.now(), 'claude')?.env.TOKEN).toBe('secret-prod');
    expect(loadSession('prod', Date.now(), 'codex')).toBeNull();
  });

  it('bundle lock removes every harness grant', () => {
    saveSession('prod', { ...entry('prod', FAR + Date.now(), false), harness: 'claude' });
    saveSession('prod', { ...entry('prod', FAR + Date.now(), false), harness: 'codex' });
    deleteBundleSessions('prod');
    expect(loadSession('prod', Date.now(), 'claude')).toBeNull();
    expect(loadSession('prod', Date.now(), 'codex')).toBeNull();
  });

  it('migrates a pre-harness durable grant into the global scope', () => {
    const expiresAt = FAR + Date.now();
    const legacy = entry('legacy', expiresAt, false);
    setKeychainToken(`${SESSION_ITEM_PREFIX}legacy`, JSON.stringify(legacy), { noAcl: true });
    setKeychainToken(SESSION_INDEX_ITEM, JSON.stringify({
      bundles: { legacy: { expiresAt, sleepPersist: false } },
    }), { noAcl: true });
    const restored = rehydrateSessions();
    expect(restored[0]?.entry.harness).toBe('*');
    expect(loadSession('legacy', Date.now(), '*')?.env.TOKEN).toBe('secret-legacy');
    expect(hasKeychainToken(`${SESSION_ITEM_PREFIX}legacy`)).toBe(false);
  });

  it('delete removes both the blob and the index entry', () => {
    saveSession('npmjs.com', entry('npmjs.com', FAR + Date.now(), true));
    deleteSession('npmjs.com');
    expect(loadSession('npmjs.com')).toBeNull();
    expect(readIndex().bundles).toEqual({});
  });

  it('loadSession drops an expired blob and returns null', () => {
    const now = Date.now();
    saveSession('stale', entry('stale', now + 1000, false));
    expect(loadSession('stale', now + 5000)).toBeNull();
    expect(readIndex().bundles.stale).toBeUndefined(); // pruned on read
  });

  it('rehydrateSessions returns unexpired entries and drops expired', () => {
    const now = Date.now();
    saveSession('live', entry('live', now + FAR, false));
    saveSession('dead', entry('dead', now + 1000, false));
    const out = rehydrateSessions(now + 5000);
    expect(out.map((o) => o.name)).toEqual(['live']);
    expect(out[0].entry.env.TOKEN).toBe('secret-live');
    expect(readIndex().bundles.dead).toBeUndefined();
  });

  it('pruneSessionsOnSleep deletes non-durable, keeps --durable', () => {
    const now = Date.now();
    saveSession('def', entry('def', now + FAR, false));      // default → re-locks on sleep
    saveSession('dur', entry('dur', now + FAR, true));        // --durable → survives
    pruneSessionsOnSleep();
    expect(loadSession('def')).toBeNull();
    expect(loadSession('dur')?.bundle.name).toBe('dur');
    expect(Object.keys(readIndex().bundles)).toEqual(['*:dur']);
  });

  it('deleteAllSessions clears everything', () => {
    saveSession('a', entry('a', now(), false));
    saveSession('b', entry('b', now(), true));
    deleteAllSessions();
    expect(readIndex().bundles).toEqual({});
    expect(loadSession('a')).toBeNull();
    expect(loadSession('b')).toBeNull();
  });

  it('deleteAllSessions removes a pre-harness legacy blob', () => {
    const expiresAt = FAR + Date.now();
    setKeychainToken(`${SESSION_ITEM_PREFIX}legacy-all`, JSON.stringify(entry('legacy-all', expiresAt, false)), { noAcl: true });
    setKeychainToken(SESSION_INDEX_ITEM, JSON.stringify({
      bundles: { 'legacy-all': { expiresAt, sleepPersist: false } },
    }), { noAcl: true });
    deleteAllSessions();
    expect(hasKeychainToken(`${SESSION_ITEM_PREFIX}legacy-all`)).toBe(false);
  });
});

function now(): number { return Date.now() + FAR; }
