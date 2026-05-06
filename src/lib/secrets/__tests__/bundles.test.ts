import { describe, it, expect } from 'vitest';
import {
  describeBundle,
  keychainItemsForBundle,
  parseDotenv,
  resolveBundleEnv,
  validateBundleName,
  validateEnvKey,
  type SecretsBundle,
} from '../bundles.js';

describe('validation', () => {
  it('validateBundleName accepts lowercase letters, digits, dash, underscore', () => {
    expect(() => validateBundleName('prod-stripe_1')).not.toThrow();
    expect(() => validateBundleName('A')).not.toThrow();
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
    const bundle = b({ STATIC: 'x', DYN: 'env:__AGENTS_RESOLVE_TEST' });
    expect(resolveBundleEnv(bundle)).toEqual({ STATIC: 'x', DYN: 'resolved-value' });
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
