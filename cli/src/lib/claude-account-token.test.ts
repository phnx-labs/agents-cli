import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeAccountTokenKey,
  isValidClaudeSetupToken,
  resolveClaudeSetupToken,
} from './claude-account-token.js';
import { buildExecEnv } from './exec.js';
import {
  ReservedBundleWrongBackendError,
  bundleItemStore,
  keychainRef,
  writeBundle,
  type SecretsBundle,
} from './secrets/bundles.js';
import { _resetFileStoreForTest, fileStore, fileStoreItemPath } from './secrets/filestore.js';
import { secretsKeychainItem, setKeychainBackendForTest, setKeychainServiceHashingForTest, type KeychainBackend } from './secrets/index.js';
import { getVersionHomePath } from './installations/versions.js';

const PASS = 'claude-account-token-test-pass';

let fileDir: string;
let homes: string[] = [];
let versionDirs: string[] = [];
let prevNoAgent: string | undefined;
let prevPassphrase: string | undefined;
let prevClaudeToken: string | undefined;

beforeEach(() => {
  fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-token-store-'));
  homes = [];
  versionDirs = [];
  prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  prevPassphrase = process.env.AGENTS_SECRETS_PASSPHRASE;
  prevClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.AGENTS_SECRETS_NO_AGENT = '1';
  process.env.AGENTS_SECRETS_PASSPHRASE = PASS;
  _resetFileStoreForTest({ fileDir, passphrase: PASS });
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetFileStoreForTest({});
  if (prevNoAgent === undefined) delete process.env.AGENTS_SECRETS_NO_AGENT;
  else process.env.AGENTS_SECRETS_NO_AGENT = prevNoAgent;
  if (prevPassphrase === undefined) delete process.env.AGENTS_SECRETS_PASSPHRASE;
  else process.env.AGENTS_SECRETS_PASSPHRASE = prevPassphrase;
  if (prevClaudeToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevClaudeToken;
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  for (const dir of versionDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fileDir, { recursive: true, force: true });
});

function makeHome(email?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-token-home-'));
  homes.push(home);
  if (email !== undefined) {
    const configDir = path.join(home, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } }),
    );
  }
  return home;
}

function writeAuthBundle(values: Record<string, string>): void {
  const bundle: SecretsBundle = { name: 'auth', backend: 'file', vars: {} };
  for (const [key, value] of Object.entries(values)) {
    bundleItemStore('file').set(secretsKeychainItem('auth', key), value);
    bundle.vars[key] = keychainRef(key);
  }
  writeBundle(bundle);
}

describe('resolveClaudeSetupToken', () => {
  it('refuses a bare shared CLAUDE_CODE_OAUTH_TOKEN as a per-account source', () => {
    const home = makeHome('alpha@example.com');
    writeAuthBundle({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-shared-must-not-resolve' });

    expect(resolveClaudeSetupToken(home)).toBeNull();
  });

  it('returns no token when the version home has no resolvable account email', () => {
    const home = makeHome();
    writeAuthBundle({
      [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
    });

    expect(resolveClaudeSetupToken(home)).toBeNull();
  });

  it('resolves different tokens for different account-bound homes', () => {
    const alphaHome = makeHome('alpha@example.com');
    const betaHome = makeHome('beta@example.com');
    writeAuthBundle({
      [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
      [claudeAccountTokenKey('beta@example.com')]: 'sk-ant-oat01-beta',
    });

    expect(resolveClaudeSetupToken(alphaHome)).toBe('sk-ant-oat01-alpha');
    expect(resolveClaudeSetupToken(betaHome)).toBe('sk-ant-oat01-beta');
  });

  it('decrypts a credential once while its encrypted file fingerprint is unchanged', () => {
    const home = makeHome('alpha@example.com');
    writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha' });
    const decryptBatch = vi.spyOn(fileStore, 'getBatch');
    expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');
    expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');
    expect(decryptBatch).toHaveBeenCalledTimes(1);
  });

  it('caches a missing per-account credential as a negative result', () => {
    const home = makeHome('missing@example.com');
    writeAuthBundle({ [claudeAccountTokenKey('other@example.com')]: 'sk-ant-oat01-other' });
    const decryptBatch = vi.spyOn(fileStore, 'getBatch');

    expect(resolveClaudeSetupToken(home)).toBeNull();
    expect(resolveClaudeSetupToken(home)).toBeNull();
    expect(decryptBatch).not.toHaveBeenCalled();
  });

  it('re-decrypts after the encrypted credential file mtime changes', () => {
    const home = makeHome('alpha@example.com');
    writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha' });
    const decryptBatch = vi.spyOn(fileStore, 'getBatch');
    expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');
    const item = secretsKeychainItem('auth', claudeAccountTokenKey('alpha@example.com'));
    const credentialPath = fileStoreItemPath(item);
    const changed = new Date(Date.now() + 2_000);
    fs.utimesSync(credentialPath, changed, changed);
    expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');
    expect(decryptBatch).toHaveBeenCalledTimes(2);
  });

  it('returns the rotated token instead of a stale cached value', () => {
    const home = makeHome('alpha@example.com');
    writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha' });
    expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');

    writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-rotated' });

    expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-rotated');
  });

  it('never shares a cached token between version homes', () => {
    const alphaHome = makeHome('alpha@example.com');
    const betaHome = makeHome('beta@example.com');
    writeAuthBundle({
      [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
      [claudeAccountTokenKey('beta@example.com')]: 'sk-ant-oat01-beta',
    });
    const decryptBatch = vi.spyOn(fileStore, 'getBatch');
    expect(resolveClaudeSetupToken(alphaHome)).toBe('sk-ant-oat01-alpha');
    expect(resolveClaudeSetupToken(betaHome)).toBe('sk-ant-oat01-beta');
    expect(resolveClaudeSetupToken(alphaHome)).toBe('sk-ant-oat01-alpha');
    expect(resolveClaudeSetupToken(betaHome)).toBe('sk-ant-oat01-beta');
    expect(decryptBatch).toHaveBeenCalledTimes(2);
  });

  it('invalidates a version-home entry when that home changes accounts', () => {
    const home = makeHome('alpha@example.com');
    writeAuthBundle({
      [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
      [claudeAccountTokenKey('beta@example.com')]: 'sk-ant-oat01-beta',
    });
    expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-alpha');

    fs.writeFileSync(
      path.join(home, '.claude', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'beta@example.com' } }),
    );

    expect(resolveClaudeSetupToken(home)).toBe('sk-ant-oat01-beta');
  });

  it('rejects a malformed captured setup-token TTY blob rather than resolving it (#1767)', () => {
    const home = makeHome('alpha@example.com');
    // The #1767 shape: the raw `claude setup-token` TTY stream (ANSI + banner +
    // token) stored as the credential instead of the parsed value. Injecting this
    // as CLAUDE_CODE_OAUTH_TOKEN builds an invalid Authorization header and crashes
    // the run — resolve must refuse it, so the caller falls back to normal login.
    const blob = '\x1b[?2004h\x1b[?1004hWelcome to Claude Code\n  sk-ant-oat01-abcdefghij\n';
    writeAuthBundle({ [claudeAccountTokenKey('alpha@example.com')]: blob });

    expect(resolveClaudeSetupToken(home)).toBeNull();
  });

  it('throws instead of returning null when auth exists on the keychain backend (SEC-GAP-3)', () => {
    const home = makeHome('alpha@example.com');
    const store = new Map<string, string>();
    const mem: KeychainBackend = {
      has: (item) => store.has(item),
      get: (item) => {
        const v = store.get(item);
        if (v === undefined) throw new Error(`missing ${item}`);
        return v;
      },
      set: (item, value) => { store.set(item, value); },
      delete: (item) => store.delete(item),
      list: (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)),
    };
    const prev = setKeychainBackendForTest(mem);
    setKeychainServiceHashingForTest(null);
    try {
      store.set('agents-cli.bundles.auth', JSON.stringify({ name: 'auth', vars: {} }));
      expect(() => resolveClaudeSetupToken(home)).toThrow(ReservedBundleWrongBackendError);
    } finally {
      setKeychainBackendForTest(prev);
    }
  });

  it('buildExecEnv injects the token keyed to the selected version home account', () => {
    const version = `rush-2099-token-test-${process.pid}`;
    const versionHome = getVersionHomePath('claude', version);
    versionDirs.push(path.dirname(versionHome));
    const configDir = path.join(versionHome, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'alpha@example.com' } }),
    );
    writeAuthBundle({
      [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
    });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-shared-must-not-win';

    const env = buildExecEnv({
      agent: 'claude',
      version,
      mode: 'plan',
      effort: 'auto',
      prompt: 'do the thing',
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
    expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
  });

  it('buildExecEnv leaves an interactive run on its own login instead of the setup-token', () => {
    // The `auth` setup-token is the credential for runs with NO human present. An
    // interactive run has one, and overriding their per-version login made
    // `/status` report `Auth token: CLAUDE_CODE_OAUTH_TOKEN` on a personal machine.
    const version = `interactive-token-test-${process.pid}`;
    const versionHome = getVersionHomePath('claude', version);
    versionDirs.push(path.dirname(versionHome));
    const configDir = path.join(versionHome, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'alpha@example.com' } }),
    );
    writeAuthBundle({
      [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
    });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    // No prompt at all -> inferred interactive (the `agents run claude` TUI).
    const inferred = buildExecEnv({ agent: 'claude', version, mode: 'plan', effort: 'auto' });
    expect(inferred.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(inferred.CLAUDE_CONFIG_DIR).toBe(configDir);

    // An explicit --interactive wins even when a prompt is present.
    const explicit = buildExecEnv({
      agent: 'claude',
      version,
      mode: 'plan',
      effort: 'auto',
      prompt: 'do the thing',
      interactive: true,
    });
    expect(explicit.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('buildExecEnv strips an INHERITED copy of our own setup-token on an interactive run', () => {
    // An interactive launch from inside a headless agent's shell inherits that
    // agent's injected token through process.env and would keep authenticating as
    // it — the nested case a gate on injection alone does not cover.
    const version = `interactive-inherited-test-${process.pid}`;
    const versionHome = getVersionHomePath('claude', version);
    versionDirs.push(path.dirname(versionHome));
    const configDir = path.join(versionHome, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'alpha@example.com' } }),
    );
    writeAuthBundle({
      [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
    });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-alpha';

    const env = buildExecEnv({ agent: 'claude', version, mode: 'plan', effort: 'auto' });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('buildExecEnv keeps a token the user exported themselves on an interactive run', () => {
    // Only OUR value is dropped. A deliberately exported token is a different
    // string and must survive, so this is not a blanket env strip.
    const version = `interactive-user-token-test-${process.pid}`;
    const versionHome = getVersionHomePath('claude', version);
    versionDirs.push(path.dirname(versionHome));
    const configDir = path.join(versionHome, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'alpha@example.com' } }),
    );
    writeAuthBundle({
      [claudeAccountTokenKey('alpha@example.com')]: 'sk-ant-oat01-alpha',
    });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-user-exported';

    const env = buildExecEnv({ agent: 'claude', version, mode: 'plan', effort: 'auto' });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-user-exported');
  });
});

describe('isValidClaudeSetupToken', () => {
  it('accepts a clean single-line sk-ant-oat01- token', () => {
    expect(isValidClaudeSetupToken('sk-ant-oat01-alpha')).toBe(true);
    expect(isValidClaudeSetupToken('sk-ant-oat01-AbC_123-xyz')).toBe(true);
  });

  it('rejects a captured TTY blob, wrong prefix, and whitespace/control chars (#1767)', () => {
    expect(isValidClaudeSetupToken('\x1b[?2004hWelcome\n  sk-ant-oat01-abc\n')).toBe(false);
    expect(isValidClaudeSetupToken('sk-ant-oat01-abc\n')).toBe(false);
    expect(isValidClaudeSetupToken('sk-ant-oat01-abc def')).toBe(false);
    expect(isValidClaudeSetupToken('sk-ant-api03-abc')).toBe(false);
    expect(isValidClaudeSetupToken('sk-ant-oat01-')).toBe(false);
    expect(isValidClaudeSetupToken('')).toBe(false);
  });
});
