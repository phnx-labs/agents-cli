import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  bundleToEnvPrefix,
  describeBundle,
  isLoaderOrInterpreterEnv,
  isReservedEnvName,
  keychainItemsForBundle,
  parseDotenv,
  resolveBundleEnv,
  validateBundleName,
  validateEnvKey,
  type SecretsBundle,
} from '../bundles.js';

// resolveBundleEnv stamps last_used via writeBundle. These tests construct
// bundles inline (no test backend installed) so the stamp must be disabled to
// keep them off the real keychain.
const originalNoTrack = process.env.AGENTS_NO_USAGE_TRACK;
beforeAll(() => { process.env.AGENTS_NO_USAGE_TRACK = '1'; });
afterAll(() => {
  if (originalNoTrack === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = originalNoTrack;
});

describe('validation', () => {
  it('validateBundleName accepts lowercase letters, digits, dash, underscore, dot', () => {
    expect(() => validateBundleName('prod-stripe_1')).not.toThrow();
    expect(() => validateBundleName('A')).not.toThrow();
    expect(() => validateBundleName('github.com')).not.toThrow();
    expect(() => validateBundleName('api.example.org')).not.toThrow();
  });

  it('validateBundleName rejects names starting with a special char', () => {
    expect(() => validateBundleName('-bad')).toThrow();
    expect(() => validateBundleName('_bad')).toThrow();
  });

  it('validateEnvKey matches parseExecEnv conventions', () => {
    expect(() => validateEnvKey('MY_KEY')).not.toThrow();
    expect(() => validateEnvKey('_private')).not.toThrow();
    expect(() => validateEnvKey('1starts_with_digit')).toThrow();
    expect(() => validateEnvKey('KEY-WITH-DASH')).toThrow();
  });

  it('validateEnvKey rejects reserved loader and interpreter env vars', () => {
    expect(isLoaderOrInterpreterEnv('LD_PRELOAD')).toBe(true);
    expect(isLoaderOrInterpreterEnv('dyld_insert_libraries')).toBe(true);
    expect(isLoaderOrInterpreterEnv('NODE_OPTIONS')).toBe(true);
    expect(isLoaderOrInterpreterEnv('APP_TOKEN')).toBe(false);
    expect(() => validateEnvKey('LD_PRELOAD')).toThrow(/reserved/);
    expect(() => validateEnvKey('DYLD_INSERT_LIBRARIES')).toThrow(/reserved/);
    expect(() => validateEnvKey('NODE_OPTIONS')).toThrow(/reserved/);
    expect(() => validateEnvKey('path')).toThrow(/reserved/);
  });

  it('bundleToEnvPrefix converts bundle names to valid env prefixes', () => {
    expect(bundleToEnvPrefix('github')).toBe('GITHUB');
    expect(bundleToEnvPrefix('github.com')).toBe('GITHUB_COM');
    expect(bundleToEnvPrefix('my-prod')).toBe('MY_PROD');
    expect(bundleToEnvPrefix('api.example.org')).toBe('API_EXAMPLE_ORG');
    expect(bundleToEnvPrefix('test-bundle.v2')).toBe('TEST_BUNDLE_V2');
  });

  it('isReservedEnvName detects system env vars', () => {
    expect(isReservedEnvName('PATH')).toBe(true);
    expect(isReservedEnvName('HOME')).toBe(true);
    expect(isReservedEnvName('USERNAME')).toBe(true);
    expect(isReservedEnvName('USER')).toBe(true);
    expect(isReservedEnvName('SHELL')).toBe(true);
    expect(isReservedEnvName('path')).toBe(true);
    expect(isReservedEnvName('MY_CUSTOM_VAR')).toBe(false);
    expect(isReservedEnvName('API_KEY')).toBe(false);
  });
});

describe('parseDotenv', () => {
  it('parses simple KEY=VALUE lines', () => {
    expect(parseDotenv('A=1\nB=two')).toEqual({ A: '1', B: 'two' });
  });

  it('skips comments and blank lines', () => {
    expect(parseDotenv('# comment\n\nA=1\n')).toEqual({ A: '1' });
  });

  it('strips matching quotes around values', () => {
    expect(parseDotenv('A="quoted"\nB=\'quoted2\'')).toEqual({ A: 'quoted', B: 'quoted2' });
  });

  it('accepts `export` prefix', () => {
    expect(parseDotenv('export GH_TOKEN=abc')).toEqual({ GH_TOKEN: 'abc' });
  });

  it('last-wins on duplicate keys', () => {
    expect(parseDotenv('A=1\nA=2')).toEqual({ A: '2' });
  });

  it('ignores invalid key names', () => {
    expect(parseDotenv('1BAD=x\nA=1')).toEqual({ A: '1' });
  });
});

describe('describeBundle + resolveBundleEnv', () => {
  function b(vars: Record<string, any>, extra: Partial<SecretsBundle> = {}): SecretsBundle {
    return { name: 'unit', vars, ...extra };
  }

  it('classifies each var by kind', () => {
    const bundle = b({
      A: 'literal-val',
      B: 'keychain:MY_KEY',
      C: 'env:HOME',
      D: 'file:/tmp/x',
      E: 'exec:echo hi',
      F: { value: 'keychain:escaped' },
    });
    const info = describeBundle(bundle);
    const byKey = Object.fromEntries(info.map((e) => [e.key, e.kind]));
    expect(byKey).toEqual({
      A: 'literal',
      B: 'keychain',
      C: 'env',
      D: 'file',
      E: 'exec',
      F: 'literal',
    });
  });

  it('resolveBundleEnv inlines literals and resolves env: refs', () => {
    process.env.__AGENTS_RESOLVE_TEST = 'resolved-value';
    try {
      const bundle = b({ STATIC: 'x', DYN: 'env:__AGENTS_RESOLVE_TEST' });
      expect(resolveBundleEnv(bundle)).toEqual({ STATIC: 'x', DYN: 'resolved-value' });
    } finally {
      delete process.env.__AGENTS_RESOLVE_TEST;
    }
  });

  it('keychainItemsForBundle enumerates keychain-backed keys only', () => {
    const bundle = b({
      A: 'literal',
      B: 'keychain:KEY_B',
      C: 'env:SHELL',
      D: 'keychain:KEY_D',
    });
    const items = keychainItemsForBundle(bundle);
    expect(items.map((i) => i.key).sort()).toEqual(['B', 'D']);
    expect(items.find((i) => i.key === 'B')?.item).toBe('agents-cli.secrets.unit.KEY_B');
  });
});

describe('resolveBundleEnv -- keys subset injection', () => {
  function b(vars: Record<string, any>, extra: Partial<SecretsBundle> = {}): SecretsBundle {
    return { name: 'sub', vars, ...extra };
  }

  it('injects only the requested keys', () => {
    const bundle = b({ A: 'alpha', B: 'beta', C: 'gamma' });
    const env = resolveBundleEnv(bundle, { keys: ['A', 'C'] });
    expect(env).toEqual({ A: 'alpha', C: 'gamma' });
    expect(env).not.toHaveProperty('B');
  });

  it('injects all keys when keys option is absent', () => {
    const bundle = b({ X: 'x', Y: 'y' });
    expect(resolveBundleEnv(bundle)).toEqual({ X: 'x', Y: 'y' });
  });

  it('throws a clear error when a requested key is absent from the bundle', () => {
    const bundle = b({ REAL: 'value' });
    expect(() => resolveBundleEnv(bundle, { keys: ['REAL', 'MISSING'] }))
      .toThrow(/does not contain key\(s\): MISSING/);
  });

  it('includes the available keys in the missing-key error', () => {
    const bundle = b({ FOO: 'f', BAR: 'b' });
    expect(() => resolveBundleEnv(bundle, { keys: ['NOPE'] }))
      .toThrow(/Available: /);
  });

  it('treats an empty keys array as inject-all (no keys requested = all)', () => {
    const bundle = b({ P: 'p', Q: 'q' });
    expect(resolveBundleEnv(bundle, { keys: [] })).toEqual({ P: 'p', Q: 'q' });
  });
});

describe('resolveBundleEnv -- expiry pre-run abort', () => {
  function b(vars: Record<string, any>, extra: Partial<SecretsBundle> = {}): SecretsBundle {
    return { name: 'exp', vars, ...extra };
  }

  const yesterday = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);

  it('aborts when a selected key is expired', () => {
    const bundle = b(
      { SECRET: 'val' },
      { meta: { SECRET: { expires: yesterday } } },
    );
    expect(() => resolveBundleEnv(bundle)).toThrow(/expired on/);
  });

  it('includes the key name in the expiry error', () => {
    const bundle = b(
      { MY_KEY: 'v' },
      { meta: { MY_KEY: { expires: yesterday } } },
    );
    expect(() => resolveBundleEnv(bundle)).toThrow(/MY_KEY/);
  });

  it('does not abort when the key is not yet expired', () => {
    const bundle = b(
      { FRESH: 'value' },
      { meta: { FRESH: { expires: tomorrow } } },
    );
    expect(resolveBundleEnv(bundle)).toEqual({ FRESH: 'value' });
  });

  it('does not abort when allowExpired is true', () => {
    const bundle = b(
      { STALE: 'val' },
      { meta: { STALE: { expires: yesterday } } },
    );
    expect(resolveBundleEnv(bundle, { allowExpired: true })).toEqual({ STALE: 'val' });
  });

  it('only checks expiry on selected keys (not excluded ones)', () => {
    const bundle = b(
      { WANTED: 'w', OLD: 'o' },
      { meta: { OLD: { expires: yesterday } } },
    );
    // Requesting only WANTED; OLD is expired but excluded — no abort.
    expect(resolveBundleEnv(bundle, { keys: ['WANTED'] })).toEqual({ WANTED: 'w' });
  });

  it('aborts if a requested key is expired even with other healthy keys', () => {
    const bundle = b(
      { FRESH: 'f', STALE: 's' },
      { meta: { STALE: { expires: yesterday } } },
    );
    expect(() => resolveBundleEnv(bundle, { keys: ['FRESH', 'STALE'] })).toThrow(/expired on/);
  });
});
