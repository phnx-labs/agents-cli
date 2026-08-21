import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readClaudeCredentialsBlob } from './rush.js';
import { claudeAccountTokenKey } from '../claude-account-token.js';
import { bundleItemStore, keychainRef, writeBundle, type SecretsBundle } from '../secrets/bundles.js';
import { _resetFileStoreForTest } from '../secrets/filestore.js';
import { secretsKeychainItem } from '../secrets/index.js';

// Syntactically valid fake setup-tokens (never real credentials — see RUSH-2359).
const FAKE_SETUP_TOKEN = 'sk-ant-oat01-credentials-blob-test';
const PASS = 'rush-credentials-test-pass';
const EMAIL = 'test-creds@example.com';

let fileDir: string;
let home: string;
let prevNoAgent: string | undefined;
let prevPassphrase: string | undefined;

beforeEach(() => {
  fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rush-creds-store-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rush-creds-home-'));
  // Write a signed-in version home so resolveClaudeSetupToken can find the account email.
  const configDir = path.join(home, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }),
  );
  prevNoAgent = process.env.AGENTS_SECRETS_NO_AGENT;
  prevPassphrase = process.env.AGENTS_SECRETS_PASSPHRASE;
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
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(fileDir, { recursive: true, force: true });
});

function writeAuthBundle(values: Record<string, string>): void {
  const bundle: SecretsBundle = { name: 'auth', backend: 'file', vars: {} };
  for (const [key, value] of Object.entries(values)) {
    bundleItemStore('file').set(secretsKeychainItem('auth', key), value);
    bundle.vars[key] = keychainRef(key);
  }
  writeBundle(bundle);
}

describe('readClaudeCredentialsBlob — setup-token path (RUSH-2359 / incident #1767)', () => {
  it('returns null when no setup-token is provisioned in the auth bundle', async () => {
    const blob = await readClaudeCredentialsBlob(home);
    expect(blob).toBeNull();
  });

  it('returns serialised oauth JSON containing the setup-token when provisioned', async () => {
    writeAuthBundle({ [claudeAccountTokenKey(EMAIL)]: FAKE_SETUP_TOKEN });

    const blob = await readClaudeCredentialsBlob(home);
    expect(blob).not.toBeNull();
    const parsed = JSON.parse(blob!);
    expect(parsed.accessToken).toBe(FAKE_SETUP_TOKEN);
  });

  it('returns null for a rotating OAuth blob written to .credentials.json', async () => {
    const credsPath = path.join(home, '.claude', '.credentials.json');
    fs.writeFileSync(
      credsPath,
      JSON.stringify({ accessToken: 'rotating-oauth-abc', refreshToken: 'refresh-xyz' }),
    );

    const blob = await readClaudeCredentialsBlob(home);
    expect(blob).toBeNull();
  });

  it('returns null for a TTY/ANSI banner — the exact payload that caused #1767', async () => {
    const credsPath = path.join(home, '.claude', '.credentials.json');
    fs.writeFileSync(
      credsPath,
      '\x1b[2J\x1b[HClaude Code — sign in\nsetup-token: fake-banner-payload\n',
    );

    const blob = await readClaudeCredentialsBlob(home);
    expect(blob).toBeNull();
  });

  it('returns null when auth bundle token has an invalid shape', async () => {
    writeAuthBundle({ [claudeAccountTokenKey(EMAIL)]: 'not-a-setup-token' });

    const blob = await readClaudeCredentialsBlob(home);
    expect(blob).toBeNull();
  });
});
