import { describe, it, expect } from 'vitest';

import { scopeHeldEnv } from './secrets.js';

/**
 * `agents secrets unlock --keys` folds the deleted `secrets lease` surface into
 * unlock: with --keys the broker holds ONLY the resolved subset behind a lease;
 * without it, the whole bundle is held exactly as before. scopeHeldEnv is the
 * command's single scoping seam — these pin the real decision on the real path
 * (createSecretLease + selectLeasedEnv), not a mock.
 */
describe('scopeHeldEnv — unlock holds the whole bundle, or just --keys', () => {
  const env = { TOKEN: 't', USER: 'u', ADMIN: 'a' };

  it('holds the WHOLE bundle and mints no lease when --keys is absent', () => {
    const { heldEnv, lease } = scopeHeldEnv({
      bundle: 'prod', env, keys: null, ttlMs: 60_000, harness: '*', sleepPersist: false,
    });
    expect(heldEnv).toEqual(env);
    expect(lease).toBeUndefined();
  });

  it('holds ONLY the requested keys behind a lease when --keys is given', () => {
    const { heldEnv, lease } = scopeHeldEnv({
      bundle: 'prod', env, keys: 'TOKEN,USER', ttlMs: 60_000, harness: 'claude', sleepPersist: true,
    });
    expect(heldEnv).toEqual({ TOKEN: 't', USER: 'u' });
    expect(lease?.keys).toEqual(['TOKEN', 'USER']);
    expect(lease?.harness).toBe('claude');
    expect(lease?.sleepPersist).toBe(true);
  });

  it('fails closed on an unknown key', () => {
    expect(() => scopeHeldEnv({
      bundle: 'prod', env, keys: 'TOKEN,NOPE', ttlMs: 60_000, harness: '*', sleepPersist: false,
    })).toThrow('Unknown secret lease key(s): NOPE');
  });

  it('fails closed on an empty key subset', () => {
    expect(() => scopeHeldEnv({
      bundle: 'prod', env, keys: '', ttlMs: 60_000, harness: '*', sleepPersist: false,
    })).toThrow('requires at least one key');
  });
});
