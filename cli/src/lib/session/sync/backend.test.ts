import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeSession, clearSession, sessionFilePath } from '../../identity/client.js';
import { resolveSessionsBackend, shouldUseManagedSessions, SESSIONS_BACKEND_ENV } from './backend.js';
import { DEFAULT_SESSIONS_DOMAIN } from './managed-config.js';
import { clearR2ConfigCache, SYNC_BUNDLE } from './config.js';
import { setKeychainBackendForTest, type KeychainBackend } from '../../secrets/index.js';
import { writeBundle, type SecretsBundle } from '../../secrets/bundles.js';

// resolveSessionsBackend routes managed-vs-BYO through the shared selection
// policy (lib/storage/selection). MANAGED-FIRST: a signed-in user resolves to the
// managed Phoenix store even with an r2.backups bundle present; only an explicit
// --byo / env / write-token override flips to BYO. Real session file + real
// keychain seam, no mocking of the decision.

class MemBackend implements KeychainBackend {
  store = new Map<string, string>();
  has(item: string) { return this.store.has(item); }
  get(item: string) {
    const v = this.store.get(item);
    if (v === undefined) throw new Error(`missing ${item}`);
    return v;
  }
  set(item: string, value: string) { this.store.set(item, value); }
  delete(item: string) { return this.store.delete(item); }
  list(prefix: string) { return [...this.store.keys()].filter(k => k.startsWith(prefix)); }
}

const ENV_PREV = process.env[SESSIONS_BACKEND_ENV];
let prevBackend: KeychainBackend | null = null;

function writeR2Bundle(): void {
  const b: SecretsBundle = {
    name: SYNC_BUNDLE,
    policy: 'never',
    vars: { R2_ACCOUNT_ID: 'acct', R2_BUCKET_NAME: 'mybucket', R2_ACCESS_KEY_ID: 'ak', R2_SECRET_ACCESS_KEY: 'sk' },
  };
  writeBundle(b);
}

describe('resolveSessionsBackend — managed-first selection', () => {
  beforeEach(() => {
    fs.rmSync(path.dirname(sessionFilePath()), { recursive: true, force: true });
    delete process.env[SESSIONS_BACKEND_ENV];
    prevBackend = setKeychainBackendForTest(new MemBackend());
    process.env.AGENTS_SECRETS_NO_AGENT = '1';
    clearR2ConfigCache();
  });
  afterEach(() => {
    clearSession();
    setKeychainBackendForTest(prevBackend);
    delete process.env.AGENTS_SECRETS_NO_AGENT;
    if (ENV_PREV === undefined) delete process.env[SESSIONS_BACKEND_ENV];
    else process.env[SESSIONS_BACKEND_ENV] = ENV_PREV;
    clearR2ConfigCache();
  });

  it('managed for a signed-in session — the managed Worker + userId namespace', () => {
    writeSession({ access_token: 'pid_token', userId: 'user-1', email: 'dev@example.com' });
    const backend = resolveSessionsBackend();
    expect(backend.kind).toBe('managed');
    if (backend.kind !== 'managed') throw new Error('unreachable');
    expect(backend.baseUrl).toBe(`https://${DEFAULT_SESSIONS_DOMAIN}`);
    expect(backend.token).toBe('pid_token');
    expect(backend.userId).toBe('user-1');
    expect(shouldUseManagedSessions()).toBe(true);
  });

  it('a present r2.backups bundle is NOT a BYO override — signed-in still resolves managed', () => {
    writeSession({ access_token: 'pid_token', userId: 'user-1', email: 'dev@example.com' });
    writeR2Bundle();
    clearR2ConfigCache();
    const backend = resolveSessionsBackend();
    expect(backend.kind).toBe('managed');
  });

  it('--byo forces the BYO r2.backups bucket even when signed in', () => {
    writeSession({ access_token: 'pid_token', userId: 'user-1', email: 'dev@example.com' });
    writeR2Bundle();
    clearR2ConfigCache();
    const backend = resolveSessionsBackend({ byo: true });
    expect(backend.kind).toBe('byo');
    if (backend.kind !== 'byo') throw new Error('unreachable');
    expect(backend.r2.bucket).toBe('mybucket');
  });

  it('AGENTS_SESSIONS_BACKEND=byo forces BYO even when signed in', () => {
    writeSession({ access_token: 'pid_token', userId: 'user-1', email: 'dev@example.com' });
    writeR2Bundle();
    clearR2ConfigCache();
    process.env[SESSIONS_BACKEND_ENV] = 'byo';
    const backend = resolveSessionsBackend();
    expect(backend.kind).toBe('byo');
  });

  it('signed out WITH an r2.backups bundle resolves BYO', () => {
    clearSession();
    writeR2Bundle();
    clearR2ConfigCache();
    const backend = resolveSessionsBackend();
    expect(backend.kind).toBe('byo');
  });

  it('signed out with NO bundle fails loud, hinting BOTH managed sign-in and BYO', () => {
    clearSession();
    clearR2ConfigCache();
    expect(() => resolveSessionsBackend()).toThrow(/agents auth login/);
    expect(() => resolveSessionsBackend()).toThrow(/r2\.backups/);
  });
});
