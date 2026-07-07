import { describe, it, expect } from 'vitest';
import type { SecretsBundle } from './bundles.js';
import { handleAgentRequest, shouldSelfHealForUpgrade, realBundleCount, shouldWipeOnWatchEvent, META_CACHE_PREFIX, type StoredBundle, type Request } from './agent.js';

/**
 * These tests target the broker's store semantics — the part with real bug
 * surface (lazy expiry on read, lock-one vs lock-all, TTL math, status hiding
 * expired entries). They drive `handleAgentRequest` directly with a controlled
 * `now`, so they're deterministic and need no socket or spawned process. The
 * socket transport itself is thin (newline-framed JSON) and exercised live by
 * the E2E flow; the logic that can corrupt state lives here.
 */

function bundle(name: string): SecretsBundle {
  return { name, vars: {} };
}

function freshStore(): Map<string, StoredBundle> {
  return new Map<string, StoredBundle>();
}

const loadReq = (name: string, env: Record<string, string>, ttlMs: number): Request => ({
  cmd: 'load',
  name,
  bundle: bundle(name),
  env,
  ttlMs,
});

describe('handleAgentRequest', () => {
  it('load then get returns the cached env (a hit, no expiry)', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('prod', { K: 'v' }, 60_000), 1_000);
    const r = handleAgentRequest(store, { cmd: 'get', name: 'prod' }, 2_000);
    expect(r).toEqual({ ok: true, cmd: 'get', hit: true, bundle: bundle('prod'), env: { K: 'v' } });
  });

  it('get on an unknown bundle is a miss', () => {
    const r = handleAgentRequest(freshStore(), { cmd: 'get', name: 'nope' }, 0);
    expect(r).toEqual({ ok: true, cmd: 'get', hit: false });
  });

  it('expires a bundle exactly at its TTL boundary and drops it from the store', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('prod', { K: 'v' }, 1_000), 0); // expiresAt = 1000
    // Just before the boundary: still a hit.
    expect(handleAgentRequest(store, { cmd: 'get', name: 'prod' }, 999)).toMatchObject({ hit: true });
    // At the boundary (now >= expiresAt): a miss, and the entry is evicted.
    expect(handleAgentRequest(store, { cmd: 'get', name: 'prod' }, 1_000)).toMatchObject({ hit: false });
    expect(store.has('prod')).toBe(false);
  });

  it('lock with a name wipes only that bundle', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('a', { K: '1' }, 60_000), 0);
    handleAgentRequest(store, loadReq('b', { K: '2' }, 60_000), 0);
    const r = handleAgentRequest(store, { cmd: 'lock', name: 'a' }, 0);
    expect(r).toEqual({ ok: true, cmd: 'lock', wiped: 1 });
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(true);
  });

  it('lock with no name wipes everything and reports the count', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('a', { K: '1' }, 60_000), 0);
    handleAgentRequest(store, loadReq('b', { K: '2' }, 60_000), 0);
    const r = handleAgentRequest(store, { cmd: 'lock' }, 0);
    expect(r).toEqual({ ok: true, cmd: 'lock', wiped: 2 });
    expect(store.size).toBe(0);
  });

  it('lock of an absent bundle wipes nothing', () => {
    const r = handleAgentRequest(freshStore(), { cmd: 'lock', name: 'ghost' }, 0);
    expect(r).toEqual({ ok: true, cmd: 'lock', wiped: 0 });
  });

  it('status lists live bundles with key counts and hides expired ones', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('live', { A: '1', B: '2' }, 10_000), 0); // expiresAt 10000
    handleAgentRequest(store, loadReq('dead', { C: '3' }, 1_000), 0);          // expiresAt 1000
    const r = handleAgentRequest(store, { cmd: 'status' }, 5_000);
    expect(r.ok).toBe(true);
    if (r.ok && r.cmd === 'status') {
      expect(r.entries).toEqual([{ name: 'live', expiresAt: 10_000, keyCount: 2 }]);
    }
  });

  it('load overwrites an existing bundle and resets its TTL', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('prod', { K: 'old' }, 1_000), 0);   // expiresAt 1000
    handleAgentRequest(store, loadReq('prod', { K: 'new' }, 10_000), 500); // expiresAt 10500
    // Past the original TTL but inside the new one → still a hit with the new value.
    const r = handleAgentRequest(store, { cmd: 'get', name: 'prod' }, 2_000);
    expect(r).toMatchObject({ hit: true, env: { K: 'new' } });
  });

  it('ping reports the protocol version and the running CLI version', () => {
    const r = handleAgentRequest(freshStore(), { cmd: 'ping' }, 0);
    expect(r).toMatchObject({ ok: true, cmd: 'ping' });
    if (r.ok && r.cmd === 'ping') {
      expect(typeof r.version).toBe('number');
      // cliVersion drives staleness detection — a client compares it to its own
      // fresh on-disk read and restarts the broker on mismatch.
      expect(typeof r.cliVersion).toBe('string');
    }
  });
});

describe('secrets list metadata cache (broker-held snapshot)', () => {
  const metaKey = `${META_CACHE_PREFIX}abc123`;

  it('round-trips a metadata snapshot through the same load/get transport', () => {
    const store = freshStore();
    const snapshot = JSON.stringify([{ name: 'prod', vars: {} }, { name: 'stage', vars: {} }]);
    handleAgentRequest(store, loadReq(metaKey, { __snapshot__: snapshot }, 60_000), 0);
    const r = handleAgentRequest(store, { cmd: 'get', name: metaKey }, 1_000);
    expect(r).toMatchObject({ hit: true, env: { __snapshot__: snapshot } });
  });

  it('hides the internal metadata-cache entry from status (not a user bundle)', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq('prod', { K: 'v' }, 60_000), 0);
    handleAgentRequest(store, loadReq(metaKey, { __snapshot__: '[]' }, 60_000), 0);
    const r = handleAgentRequest(store, { cmd: 'status' }, 1_000);
    if (r.ok && r.cmd === 'status') {
      expect(r.entries.map((e) => e.name)).toEqual(['prod']); // metaKey excluded
    }
  });

  it('lock-all still wipes the metadata cache (screen-lock drops it too)', () => {
    const store = freshStore();
    handleAgentRequest(store, loadReq(metaKey, { __snapshot__: '[]' }, 60_000), 0);
    handleAgentRequest(store, { cmd: 'lock' }, 0);
    expect(handleAgentRequest(store, { cmd: 'get', name: metaKey }, 0)).toMatchObject({ hit: false });
  });

  it('realBundleCount excludes the metadata cache so it cannot pin the broker on old code (#435)', () => {
    const store = freshStore();
    // A metadata-only store must read as empty for self-heal / idle-exit.
    handleAgentRequest(store, loadReq(metaKey, { __snapshot__: '[]' }, 60_000), 0);
    expect(store.size).toBe(1);
    expect(realBundleCount(store)).toBe(0);
    // A real unlock counts; the meta entry still does not.
    handleAgentRequest(store, loadReq('prod', { K: 'v' }, 60_000), 0);
    expect(realBundleCount(store)).toBe(1);
  });
});

describe('shouldSelfHealForUpgrade (#435: never wipe a hot cache on upgrade)', () => {
  it('defers the restart while bundles are unlocked, even on a version change', () => {
    // The bug: an in-place `npm i -g` bumped the version, the broker self-healed
    // immediately, wiped the in-memory unlocks, and the next read re-prompted.
    expect(shouldSelfHealForUpgrade(true, 1, '1.20.21', '1.20.22')).toBe(false);
    expect(shouldSelfHealForUpgrade(true, 5, '1.20.21', '1.20.22')).toBe(false);
  });

  it('self-heals once the store is empty and the version changed', () => {
    expect(shouldSelfHealForUpgrade(true, 0, '1.20.21', '1.20.22')).toBe(true);
  });

  it('does not restart when the version is unchanged', () => {
    expect(shouldSelfHealForUpgrade(true, 0, '1.20.22', '1.20.22')).toBe(false);
  });

  it('never self-heals a non-persistent (one-off) broker', () => {
    expect(shouldSelfHealForUpgrade(false, 0, '1.20.21', '1.20.22')).toBe(false);
  });

  it('does not restart on an unknown version on either side (no spurious flap)', () => {
    expect(shouldSelfHealForUpgrade(true, 0, 'unknown', '1.20.22')).toBe(false);
    expect(shouldSelfHealForUpgrade(true, 0, '1.20.22', 'unknown')).toBe(false);
  });
});

describe('shouldWipeOnWatchEvent (screen-lock survives, sleep wipes)', () => {
  it('wipes on SLEEP', () => {
    expect(shouldWipeOnWatchEvent('SLEEP')).toBe(true);
    expect(shouldWipeOnWatchEvent('SLEEP\n')).toBe(true);
  });

  it('does NOT wipe on a bare screen-lock', () => {
    // The whole point of the ~7d hold: locking the screen must not re-prompt.
    expect(shouldWipeOnWatchEvent('LOCK')).toBe(false);
    expect(shouldWipeOnWatchEvent('LOCK\n')).toBe(false);
  });

  it('ignores unrelated / empty helper chatter', () => {
    expect(shouldWipeOnWatchEvent('')).toBe(false);
    expect(shouldWipeOnWatchEvent('UNLOCK')).toBe(false);
    expect(shouldWipeOnWatchEvent('ASLEEPING')).toBe(false); // word-boundary guarded
  });

  it('still wipes when SLEEP arrives batched with a LOCK line', () => {
    expect(shouldWipeOnWatchEvent('LOCK\nSLEEP\n')).toBe(true);
  });
});
