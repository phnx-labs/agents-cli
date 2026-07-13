import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assertValidSshTarget,
  assertNeverPolicyAcknowledged,
  buildRemoteUnlockArgs,
  buildSecretsExecEnv,
  bundleEnvToDotenv,
  parseImportSource,
  parsePolicyOpt,
  quoteWin32ExecArg,
  readImportDotenv,
  renderPolicyCol,
} from './secrets.js';
import { parseDotenv, type SecretsBundle } from '../lib/secrets/bundles.js';

describe('parseImportSource', () => {
  it('treats a plain value as a .env path, including stdin', () => {
    expect(parseImportSource({ from: '.env.prod' })).toEqual({ kind: 'dotenv', path: '.env.prod' });
    expect(parseImportSource({ from: '-' })).toEqual({ kind: 'dotenv', path: '-' });
    // Explicit path escape for a file literally named like a source keyword.
    expect(parseImportSource({ from: './icloud' })).toEqual({ kind: 'dotenv', path: './icloud' });
  });

  it('parses the 1password scheme with and without an inline vault', () => {
    expect(parseImportSource({ from: '1password:Private' })).toEqual({ kind: '1password', vault: 'Private' });
    expect(parseImportSource({ from: '1password:' })).toEqual({ kind: '1password', vault: undefined });
    expect(parseImportSource({ from: '1password' })).toEqual({ kind: '1password', vault: undefined });
    // A vault name containing a colon survives (only the first colon splits).
    expect(parseImportSource({ from: '1password:Team: Shared' })).toEqual({ kind: '1password', vault: 'Team: Shared' });
  });

  it('parses the icloud source', () => {
    expect(parseImportSource({ from: 'icloud' })).toEqual({ kind: 'icloud' });
  });

  it('maps the deprecated --from-1password --vault pair onto the 1password source', () => {
    expect(parseImportSource({ from1password: true, vault: 'Personal' })).toEqual({ kind: '1password', vault: 'Personal' });
    expect(parseImportSource({ from1password: true })).toEqual({ kind: '1password', vault: undefined });
  });

  it('rejects missing and conflicting sources', () => {
    expect(() => parseImportSource({})).toThrow(/--from <source>/);
    expect(() => parseImportSource({ from: '.env', from1password: true })).toThrow(/mutually exclusive/);
  });
});

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

describe('parsePolicyOpt', () => {
  it('accepts the three policies and their legacy aliases', () => {
    expect(parsePolicyOpt('always')).toBe('always');
    expect(parsePolicyOpt('biometry')).toBe('always');
    expect(parsePolicyOpt('daily')).toBe('daily');
    expect(parsePolicyOpt('session')).toBe('daily');
    // The whole point of #421: `never` (and its `none` alias) is now accepted,
    // not rejected by the old stub.
    expect(parsePolicyOpt('never')).toBe('never');
    expect(parsePolicyOpt('none')).toBe('never');
    expect(parsePolicyOpt('NEVER')).toBe('never');
  });

  it('throws on an unknown policy', () => {
    expect(() => parsePolicyOpt('sometimes')).toThrow(/Invalid policy/);
  });
});

describe('assertNeverPolicyAcknowledged', () => {
  it('is a no-op for non-never policies regardless of flags', () => {
    expect(assertNeverPolicyAcknowledged('always', { interactive: false })).toBe('ok');
    expect(assertNeverPolicyAcknowledged('daily', { interactive: false })).toBe('ok');
    expect(assertNeverPolicyAcknowledged(undefined, { interactive: false })).toBe('ok');
  });

  it('REQUIRES confirmation for never: headless without --i-understand is rejected', () => {
    // This is the guard — a headless `create --policy never` must not silently
    // downgrade a bundle's protection.
    expect(() => assertNeverPolicyAcknowledged('never', { interactive: false }))
      .toThrow(/Refusing to set the 'never' prompt-policy/);
  });

  it('accepts never when --i-understand is passed (headless opt-in)', () => {
    expect(assertNeverPolicyAcknowledged('never', { iUnderstand: true, interactive: false })).toBe('ok');
  });

  it('defers to an interactive prompt for never in a TTY', () => {
    expect(assertNeverPolicyAcknowledged('never', { interactive: true })).toBe('prompt');
  });
});

describe('renderPolicyCol', () => {
  const bundle = (policy: SecretsBundle['policy']): SecretsBundle => ({ name: 'b', vars: {}, policy });

  it('marks a never bundle distinctly and loudly', () => {
    const never = renderPolicyCol(bundle('never'));
    expect(never).toMatch(/never/);
    expect(never).toMatch(/NO ACL/i);
    // Distinct from the other tiers — the marking is not shared.
    expect(never).not.toBe(renderPolicyCol(bundle('always')));
    expect(never).not.toBe(renderPolicyCol(bundle('daily')));
  });

  it('does not label always/daily bundles as never', () => {
    expect(renderPolicyCol(bundle('always'))).not.toMatch(/never/i);
    expect(renderPolicyCol(bundle('daily'))).not.toMatch(/never/i);
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

describe('buildSecretsExecEnv', () => {
  it('strips AGENTS_SECRETS_PASSPHRASE and loader-hijack vars from the child env', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      AGENTS_SECRETS_PASSPHRASE: 'master-key',
      LD_PRELOAD: '/evil.so',
      NODE_OPTIONS: '--require /evil',
      DYLD_INSERT_LIBRARIES: '/evil.dylib',
    };
    const secretEnv = { API_KEY: 'sk-live', AGENTS_SECRETS_PASSPHRASE: 'bundle-leak' };
    const child = buildSecretsExecEnv(parent, secretEnv);
    expect(child.API_KEY).toBe('sk-live');
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/home/user');
    expect(child.AGENTS_SECRETS_PASSPHRASE).toBeUndefined();
    expect(child.LD_PRELOAD).toBeUndefined();
    expect(child.NODE_OPTIONS).toBeUndefined();
    expect(child.DYLD_INSERT_LIBRARIES).toBeUndefined();
  });

  it('bundle vars override sanitized parent vars but not the stripped master key', () => {
    const child = buildSecretsExecEnv(
      { PATH: '/old', AGENTS_SECRETS_PASSPHRASE: 'parent' },
      { PATH: '/new/from-bundle' },
    );
    expect(child.PATH).toBe('/new/from-bundle');
    expect(child.AGENTS_SECRETS_PASSPHRASE).toBeUndefined();
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

describe('readImportDotenv', () => {
  it('reads a .env from a filesystem path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-import-'));
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, 'A="1"\nB="two words"\n');
    try {
      expect(readImportDotenv(p)).toBe('A="1"\nB="two words"\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // POSIX-only by design, NOT a harness dodge: `--from -` (readStdinSync ->
  // fs.readSync(0)) is the POSIX way `export --host` pipes a .env into a remote
  // `import`. On Windows the export deliberately does NOT use `--from -` — the
  // npm `agents.ps1` shim doesn't forward piped stdin to node, so it routes
  // through the temp-file bridge in `buildWindowsStdinImportCommand` instead
  // (verified end-to-end: 13 keys -> win-mini; unit-tested by the decoded-script
  // assertions in remote-cmd.test.ts). So this test exercises the POSIX branch on
  // the POSIX CI legs; the Windows branch is covered by that separate test.
  it.skipIf(process.platform === 'win32')('reads the .env from stdin when passed "-"', ({ skip }) => {
    // The in-process fd 0 can't be swapped, so exercise the real helper end to
    // end in a child process with piped stdin. Run it with `bun` (repo-standard,
    // on CI PATH): bun executes TS natively with no ESM loader hook — cleaner
    // than the old `node --import tsx`, whose loader also failed to register on
    // Windows.
    //
    // Belt-and-suspenders: the release matrix showed `it.skipIf` failing to keep
    // this test off Windows runners, so also call the runtime skip explicitly.
    if (process.platform === 'win32') {
      skip();
      return;
    }
    const srcUrl = new URL('./secrets.ts', import.meta.url).href;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-stdin-'));
    const probe = path.join(dir, 'probe.ts');
    fs.writeFileSync(
      probe,
      `import { readImportDotenv } from ${JSON.stringify(srcUrl)};\n` +
        `process.stdout.write(JSON.stringify(readImportDotenv('-')));\n`,
    );
    try {
      const res = spawnSync('bun', [probe], { input: 'A="1"\nB="two words"\n', encoding: 'utf-8' });
      expect(res.status, res.stderr).toBe(0);
      // readStdinSync trims trailing whitespace; parseDotenv is line-based so a
      // single trailing newline is immaterial — the KEY="VALUE" lines round-trip.
      expect(JSON.parse(res.stdout)).toBe('A="1"\nB="two words"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildRemoteUnlockArgs (unlock --host wiring)', () => {
  it('forwards explicit bundle names', () => {
    expect(buildRemoteUnlockArgs(['a', 'b'], {})).toEqual(['unlock', 'a', 'b']);
  });

  it('passes --ttl through verbatim for the remote to parse', () => {
    expect(buildRemoteUnlockArgs(['a'], { ttl: '8h' })).toEqual(['unlock', 'a', '--ttl', '8h']);
  });

  it('forwards --all instead of the (empty) name list', () => {
    expect(buildRemoteUnlockArgs([], { all: true, ttl: '30m' })).toEqual(['unlock', '--all', '--ttl', '30m']);
  });

  it('--all wins over any stray names', () => {
    expect(buildRemoteUnlockArgs(['x'], { all: true })).toEqual(['unlock', '--all']);
  });
});
