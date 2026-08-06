import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildRoutineSpawnEnv } from './runner.js';
import { claudeAccountTokenKey } from './claude-account-token.js';
import { bundleItemStore, keychainRef, writeBundle, type SecretsBundle } from './secrets/bundles.js';
import { _resetFileStoreForTest } from './secrets/filestore.js';
import { secretsKeychainItem } from './secrets/index.js';
import { getVersionHomePath } from './versions.js';

// A routine authenticates through a per-account, non-rotating `claude setup-token`
// (the mint-auth cure for the single-use-refresh-token revocation storm). The daemon
// path builds its spawn env via buildRoutineSpawnEnv, which historically DELETED
// CLAUDE_CODE_OAUTH_TOKEN unconditionally — throwing away a legitimately-provisioned
// setup-token and forcing the routine back onto the rotating login. These tests pin
// the two-flavour rule: KEEP a per-account setup-token, STRIP an inherited ambient one.
const PASS = 'runner-setup-token-test-pass';

let fileDir: string;
let versionDirs: string[] = [];
let prevNoAgent: string | undefined;
let prevPassphrase: string | undefined;
let prevClaudeToken: string | undefined;

beforeEach(() => {
  fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-setup-token-store-'));
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
  for (const dir of versionDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fileDir, { recursive: true, force: true });
});

/** Create a real version home for `version` signed into `email` (writes .claude.json). */
function makeVersionHome(version: string, email: string): void {
  const versionHome = getVersionHomePath('claude', version);
  versionDirs.push(path.dirname(versionHome));
  const configDir = path.join(versionHome, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
}

function writeAuthBundle(values: Record<string, string>): void {
  const bundle: SecretsBundle = { name: 'auth', backend: 'file', vars: {} };
  for (const [key, value] of Object.entries(values)) {
    bundleItemStore('file').set(secretsKeychainItem('auth', key), value);
    bundle.vars[key] = keychainRef(key);
  }
  writeBundle(bundle);
}

describe('buildRoutineSpawnEnv — CLAUDE_CODE_OAUTH_TOKEN handling', () => {
  it('KEEPS a per-account setup-token even when an ambient token is inherited', () => {
    const version = `rush-setup-keep-${process.pid}`;
    const email = 'alpha@example.com';
    makeVersionHome(version, email);
    writeAuthBundle({ [claudeAccountTokenKey(email)]: 'sk-ant-oat01-alpha' });
    // A stale/rotating value inherited from the daemon env must NOT win.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-inherited-ambient';

    const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

    // The routine runs on the non-rotating per-account setup-token, not the ambient one.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-alpha');
  });

  it('STRIPS an inherited ambient token when no per-account setup-token is provisioned', () => {
    const version = `rush-setup-strip-${process.pid}`;
    // Version home is signed in, but the `auth` bundle has no token for this account.
    makeVersionHome(version, 'beta@example.com');
    // Inherited shared/rotating token — the RUSH-1822 fleet-wide-logout path.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-inherited-ambient';

    const env = buildRoutineSpawnEnv({ ...process.env } as Record<string, string>, 'claude', version);

    // No provisioned setup-token → the ambient value is dropped, routine uses the
    // version home's own login instead.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
