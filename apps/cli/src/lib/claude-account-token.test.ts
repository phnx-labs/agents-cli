import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  claudeAccountTokenKey,
  isValidClaudeSetupToken,
  resolveClaudeSetupToken,
} from './claude-account-token.js';
import { buildExecEnv } from './exec.js';
import { bundleItemStore, keychainRef, writeBundle, type SecretsBundle } from './secrets/bundles.js';
import { _resetFileStoreForTest } from './secrets/filestore.js';
import { secretsKeychainItem } from './secrets/index.js';
import { getVersionHomePath } from './versions.js';

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
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
    expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
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
