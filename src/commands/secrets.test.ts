import { describe, it, expect } from 'vitest';
import { assertValidSshTarget, bundleEnvToDotenv } from './secrets.js';
import { parseDotenv } from '../lib/secrets/bundles.js';

describe('assertValidSshTarget', () => {
  it('accepts bare ssh-config aliases and user@host', () => {
    expect(() => assertValidSshTarget('yosemite-s0')).not.toThrow();
    expect(() => assertValidSshTarget('yosemite-s1')).not.toThrow();
    expect(() => assertValidSshTarget('muqsit@yosemite-s0')).not.toThrow();
    expect(() => assertValidSshTarget('user@10.0.0.1')).not.toThrow();
    expect(() => assertValidSshTarget('host.example.com')).not.toThrow();
  });

  it('rejects argv-flag injection and shell metacharacters', () => {
    // A leading '-' would be parsed by ssh as a flag rather than a target.
    expect(() => assertValidSshTarget('-oProxyCommand=evil')).toThrow();
    expect(() => assertValidSshTarget('a b')).toThrow();
    expect(() => assertValidSshTarget('a;rm -rf /')).toThrow();
    expect(() => assertValidSshTarget('a$(whoami)')).toThrow();
    expect(() => assertValidSshTarget('a`id`')).toThrow();
    expect(() => assertValidSshTarget('a@b@c')).toThrow();
    expect(() => assertValidSshTarget('')).toThrow();
  });
});

describe('bundleEnvToDotenv', () => {
  it('round-trips arbitrary single-line values through parseDotenv', () => {
    // These are exactly the inputs the naive shell-quoting serializer corrupts:
    // embedded quotes, backslashes, $, spaces, leading/trailing whitespace.
    const env = {
      EMAIL: 'muqsit@getrush.ai',
      PASSWORD: 'p@ss w0rd',
      WITH_SINGLE_QUOTE: "it's a secret",
      WITH_DOUBLE_QUOTE: 'say "hi"',
      WITH_BOTH: `mix'd "quotes"`,
      WITH_BACKSLASH: 'a\\b\\c',
      WITH_DOLLAR: '$HOME/and/$(cmd)',
      WITH_SPACES: '  padded value  ',
      WITH_EQUALS: 'key=val=ue',
      WITH_HASH: 'token#frag',
      EMPTY: '',
    };
    const dotenv = bundleEnvToDotenv(env);
    expect(parseDotenv(dotenv)).toEqual(env);
  });

  it('rejects multi-line values instead of silently corrupting them', () => {
    expect(() => bundleEnvToDotenv({ KEY: 'line1\nline2' })).toThrow(/multi-line/);
    expect(() => bundleEnvToDotenv({ KEY: 'has\rcarriage' })).toThrow(/multi-line/);
  });
});
