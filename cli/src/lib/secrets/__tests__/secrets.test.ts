import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseBundleValue,
  secretsKeychainItem,
  profileKeychainItem,
  resolveRef,
} from '../index.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('parseBundleValue', () => {
  it('returns a literal for plain strings', () => {
    expect(parseBundleValue('hello')).toEqual({ literal: 'hello' });
  });

  it('parses keychain:foo as a ref', () => {
    expect(parseBundleValue('keychain:STRIPE_KEY')).toEqual({
      ref: { provider: 'keychain', value: 'STRIPE_KEY' },
    });
  });

  it('parses env:VAR as a ref', () => {
    expect(parseBundleValue('env:GH_TOKEN')).toEqual({
      ref: { provider: 'env', value: 'GH_TOKEN' },
    });
  });

  it('parses file:/path as a ref', () => {
    expect(parseBundleValue('file:/tmp/token')).toEqual({
      ref: { provider: 'file', value: '/tmp/token' },
    });
  });

  it('parses exec:cmd as a ref', () => {
    expect(parseBundleValue('exec:op read op://vault/item')).toEqual({
      ref: { provider: 'exec', value: 'op read op://vault/item' },
    });
  });

  it('treats {value: string} as a literal escape hatch', () => {
    // The only reason to use the object form is to store a literal that would
    // otherwise be parsed as a ref.
    expect(parseBundleValue({ value: 'keychain:literal-with-colon' })).toEqual({
      literal: 'keychain:literal-with-colon',
    });
  });

  it('does not treat unknown prefixes as refs', () => {
    // Only the four documented providers trigger ref parsing. Anything else
    // (e.g. "https://") is a literal.
    expect(parseBundleValue('https://example.com')).toEqual({ literal: 'https://example.com' });
  });
});

describe('keychain item namespacing', () => {
  it('secretsKeychainItem scopes by bundle + key', () => {
    expect(secretsKeychainItem('prod', 'CARD_NUMBER')).toBe('agents-cli.secrets.prod.CARD_NUMBER');
    expect(secretsKeychainItem('staging', 'CARD_NUMBER')).toBe('agents-cli.secrets.staging.CARD_NUMBER');
  });

  it('profile and secrets namespaces never collide', () => {
    // Regression guard: both subsystems share a service prefix but must sit in
    // disjoint sub-namespaces so a provider-named bundle can't shadow a
    // profile token.
    expect(profileKeychainItem('openrouter')).not.toBe(secretsKeychainItem('openrouter', 'token'));
  });
});

describe('resolveRef providers', () => {
  it('resolves env: from process.env', () => {
    process.env.__AGENTS_TEST_ENV_VAR = 'hello-from-parent';
    try {
      const value = resolveRef({ provider: 'env', value: '__AGENTS_TEST_ENV_VAR' });
      expect(value).toBe('hello-from-parent');
    } finally {
      delete process.env.__AGENTS_TEST_ENV_VAR;
    }
  });

  it('env: throws when the parent var is unset', () => {
    delete process.env.__AGENTS_TEST_MISSING;
    expect(() => resolveRef({ provider: 'env', value: '__AGENTS_TEST_MISSING' })).toThrow(
      /not set in parent environment/
    );
  });

  it('env: enforces the allowlist when one is set', () => {
    process.env.__AGENTS_TEST_BLOCKED = 'leaky';
    try {
      expect(() =>
        resolveRef({ provider: 'env', value: '__AGENTS_TEST_BLOCKED' }, { envAllowlist: ['SOMETHING_ELSE'] })
      ).toThrow(/not in allowlist/);
    } finally {
      delete process.env.__AGENTS_TEST_BLOCKED;
    }
  });

  it('file: reads and trims the target', () => {
    const file = path.join(os.tmpdir(), `agents-test-${process.pid}.secret`);
    fs.writeFileSync(file, '  value-with-trailing-ws  \n', 'utf-8');
    try {
      expect(resolveRef({ provider: 'file', value: file })).toBe('value-with-trailing-ws');
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('file: throws on a missing path', () => {
    expect(() => resolveRef({ provider: 'file', value: '/nonexistent/agents-test-never' })).toThrow(
      /does not exist/
    );
  });

  it('exec: is blocked unless allowExec is true', () => {
    expect(() => resolveRef({ provider: 'exec', value: 'echo hi' })).toThrow(/blocked/);
  });

  it('exec: runs when allowExec is true', () => {
    const out = resolveRef({ provider: 'exec', value: 'echo agents-exec-ok' }, { allowExec: true });
    expect(out).toBe('agents-exec-ok');
  });
});
