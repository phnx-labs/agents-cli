import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  KeychainBackend,
  setKeychainBackendForTest,
  setKeychainServiceHashingForTest,
} from './index.js';
import type { SecretsBundle } from './bundles.js';
import {
  selectRehydratable,
  pruneOnSleep,
  pruneExpired,
  upsertEntry,
  removeEntry,
  saveSession,
  loadSession,
  deleteSession,
  deleteAllSessions,
  rehydrateSessions,
  pruneSessionsOnSleep,
  readIndex,
  type SessionIndex,
  type SessionEntry,
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
    expect(Object.keys(readIndex().bundles)).toEqual(['apple.com']);
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
    expect(Object.keys(readIndex().bundles)).toEqual(['dur']);
  });

  it('deleteAllSessions clears everything', () => {
    saveSession('a', entry('a', now(), false));
    saveSession('b', entry('b', now(), true));
    deleteAllSessions();
    expect(readIndex().bundles).toEqual({});
    expect(loadSession('a')).toBeNull();
    expect(loadSession('b')).toBeNull();
  });
});

function now(): number { return Date.now() + FAR; }
