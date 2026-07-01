import { describe, it, expect } from 'vitest';
import { assertValidSshTarget, bundleEnvToDotenv, quoteWin32ExecArg } from './secrets.js';
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

// `agents secrets exec` spawns with shell:true on win32; cmd.exe does no quoting
// of its own, so args must be quoted here or a spaced path splits into two args.
describe('quoteWin32ExecArg', () => {
  it('leaves simple args untouched', () => {
    expect(quoteWin32ExecArg('npm')).toBe('npm');
    expect(quoteWin32ExecArg('--version')).toBe('--version');
    expect(quoteWin32ExecArg('sk-proj-AbC123_xyz.789')).toBe('sk-proj-AbC123_xyz.789');
  });

  it('quotes args containing spaces so they stay a single argument', () => {
    expect(quoteWin32ExecArg('hello world')).toBe('"hello world"');
    expect(quoteWin32ExecArg('C:\\Program Files\\node\\node.exe'))
      .toBe('"C:\\Program Files\\node\\node.exe"');
  });

  it('quotes cmd metacharacters so the shell treats them literally', () => {
    expect(quoteWin32ExecArg('a&b')).toBe('"a&b"');
    expect(quoteWin32ExecArg('a|b')).toBe('"a|b"');
    expect(quoteWin32ExecArg('a>b')).toBe('"a>b"');
  });

  it('escapes embedded double quotes (CommandLineToArgvW rules)', () => {
    expect(quoteWin32ExecArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('doubles a run of backslashes that precedes a quote', () => {
    // a\"b -> the backslash before the quote is doubled, the quote escaped.
    expect(quoteWin32ExecArg('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('doubles trailing backslashes before the closing quote (when quoting)', () => {
    // Space forces quoting; the trailing backslash must be doubled so it does
    // not escape the closing quote. Input `a b\` -> `"a b\\"`.
    expect(quoteWin32ExecArg('a b\\')).toBe('"a b\\\\"');
    // Interior backslashes NOT before a quote stay literal. Input `two\\ end`
    // (2 backslashes) -> `"two\\ end"` (still 2).
    expect(quoteWin32ExecArg('two\\\\ end')).toBe('"two\\\\ end"');
  });

  it('leaves a lone trailing backslash unquoted (no trigger char)', () => {
    expect(quoteWin32ExecArg('ends\\')).toBe('ends\\');
  });

  it('turns an empty arg into an explicit ""', () => {
    expect(quoteWin32ExecArg('')).toBe('""');
  });
});
