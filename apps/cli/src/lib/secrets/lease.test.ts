import { describe, expect, it } from 'vitest';

import {
  MAX_LEASE_MS,
  MIN_LEASE_MS,
  clampLeaseTtlMs,
  createSecretLease,
  selectLeasedEnv,
} from './lease.js';

describe('secret lease model', () => {
  it('normalizes a key subset and exposes only those values before expiry', () => {
    const lease = createSecretLease({
      id: 'lease-1',
      bundle: 'github.com',
      keys: [' TOKEN ', 'USER', 'TOKEN'],
      availableKeys: ['TOKEN', 'USER', 'UNLEASED'],
      ttlMs: 8 * 60 * 60 * 1000,
      now: 1_000,
    });

    expect(lease.keys).toEqual(['TOKEN', 'USER']);
    expect(selectLeasedEnv(lease, { TOKEN: 't', USER: 'u', UNLEASED: 'no' }, lease.expiresAt - 1))
      .toEqual({ TOKEN: 't', USER: 'u' });
    expect(() => selectLeasedEnv(lease, { TOKEN: 't', USER: 'u' }, lease.expiresAt))
      .toThrow("Secret lease 'lease-1' has expired.");
  });

  it('fails closed for empty or unknown key subsets', () => {
    expect(() => createSecretLease({ bundle: 'prod', keys: [], availableKeys: ['A'], ttlMs: MIN_LEASE_MS }))
      .toThrow('requires at least one key');
    expect(() => createSecretLease({ bundle: 'prod', keys: ['B'], availableKeys: ['A'], ttlMs: MIN_LEASE_MS }))
      .toThrow('Unknown secret lease key(s): B');
  });

  it('clamps finite durations to the broker hold limits', () => {
    expect(clampLeaseTtlMs(1)).toBe(MIN_LEASE_MS);
    expect(clampLeaseTtlMs(MAX_LEASE_MS + 1)).toBe(MAX_LEASE_MS);
    expect(() => clampLeaseTtlMs(Number.NaN)).toThrow('positive finite');
  });
});
