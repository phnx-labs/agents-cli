import { describe, expect, it } from 'vitest';
import { ALL_AGENT_IDS } from '../agents.js';
import { AUTH_BUNDLE_NAME, validateBundleName } from './bundles.js';
import {
  AUTH_STORE_ALIAS,
  RESERVED_STORES,
  assertStorableCredentialKind,
  isReservedStoreName,
  reservedStoreName,
} from './reserved-stores.js';

describe('RESERVED_STORES', () => {
  it('names one __<harness>__ store for every ALL_AGENT_IDS entry', () => {
    expect(Object.keys(RESERVED_STORES).sort()).toEqual([...ALL_AGENT_IDS].sort());
    for (const id of ALL_AGENT_IDS) {
      expect(RESERVED_STORES[id]).toBe(`__${id}__`);
      expect(isReservedStoreName(`__${id}__`)).toBe(true);
      expect(reservedStoreName(id)).toBe(`__${id}__`);
    }
  });

  it('keeps the legacy auth bundle as a readable alias without migrating data', () => {
    expect(AUTH_STORE_ALIAS).toBe('auth');
    expect(AUTH_BUNDLE_NAME).toBe(AUTH_STORE_ALIAS);
    expect(isReservedStoreName('auth')).toBe(true);
    expect(isReservedStoreName('AUTH')).toBe(true);
    expect(isReservedStoreName('prod')).toBe(false);
  });
});

describe('assertStorableCredentialKind', () => {
  it('accepts only setup-token and api-key', () => {
    expect(() => assertStorableCredentialKind('setup-token')).not.toThrow();
    expect(() => assertStorableCredentialKind('api-key')).not.toThrow();
  });

  it('refuses a rotating session with the harness-specific reason', () => {
    expect(() => assertStorableCredentialKind('oauth', 'codex')).toThrow(
      'codex: auth.json is a rotating session; add an API key instead',
    );
    expect(() => assertStorableCredentialKind('refresh', 'droid')).toThrow(/FACTORY_API_KEY/);
    expect(() => assertStorableCredentialKind('native', 'claude')).toThrow(/setup-token/);
    expect(() => assertStorableCredentialKind('session', 'kimi')).toThrow(/log in per device/);
    expect(() => assertStorableCredentialKind('bearer-token')).toThrow(
      /reserved stores accept only a setup-token or an API key/,
    );
  });
});

describe('validateBundleName rejects user names starting with __', () => {
  it('refuses __claude__ and unknown __foo__ on the user path', () => {
    expect(() => validateBundleName('__claude__')).toThrow(/reserved/);
    expect(() => validateBundleName('__foo__')).toThrow(/reserved/);
    expect(() => validateBundleName('prod')).not.toThrow();
    expect(() => validateBundleName('auth')).not.toThrow();
  });

  it('allows a known reserved store only when the CLI opts in', () => {
    expect(() => validateBundleName('__claude__', { allowReservedStore: true })).not.toThrow();
    expect(() => validateBundleName('__foo__', { allowReservedStore: true })).toThrow(/reserved/);
  });
});
