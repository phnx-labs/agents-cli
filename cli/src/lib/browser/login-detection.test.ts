import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../sqlite.js';

// getBrowserRuntimeDir/listProfiles are the only two profiles.js symbols the
// detector touches. Point the runtime root at a temp dir so we can drop a real
// Chromium-shaped cookie DB under it and exercise the true SQLite read path.
let TMP = '';
vi.mock('./profiles.js', () => ({
  getBrowserRuntimeDir: () => TMP,
  listProfiles: async () => [{ name: 'comet-local', browser: 'comet', endpoints: [] }],
}));

import {
  detectServices,
  serviceForUrl,
  loginsForProfile,
  accountsForProfile,
  loginsWithAccountsForProfile,
  credKeysForService,
  loginUrlForService,
} from './login-detection.js';

// A far-future Chromium expiry (microseconds since 1601). Deliberately > 2^53 —
// real cookie expiries are, and reading it back as a JS number throws RangeError
// in node:sqlite. The round-trip below proves we never marshal it to JS.
const FUTURE = 14000000000000000;
const EXPIRED = 1; // year 1601 — safely in the past

function makeCookiesDb(dir: string, rows: { host_key: string; name: string; expires_utc: number }[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER)');
  const stmt = db.prepare('INSERT INTO cookies (host_key, name, expires_utc) VALUES (?, ?, ?)');
  for (const r of rows) stmt.run(r.host_key, r.name, r.expires_utc);
  db.close();
}

function makeLoginDb(
  dir: string,
  rows: { origin_url: string; username_value: string; signon_realm: string; blacklisted?: number }[],
): void {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'Login Data'));
  db.exec(
    'CREATE TABLE logins (origin_url TEXT, username_value TEXT, signon_realm TEXT, blacklisted_by_user INTEGER, password_value BLOB)',
  );
  const stmt = db.prepare(
    'INSERT INTO logins (origin_url, username_value, signon_realm, blacklisted_by_user, password_value) VALUES (?, ?, ?, ?, ?)',
  );
  for (const r of rows) stmt.run(r.origin_url, r.username_value, r.signon_realm, r.blacklisted ?? 0, null);
  db.close();
}

describe('detectServices', () => {
  it('detects linkedin from an li_at on .linkedin.com', () => {
    expect(detectServices([{ host_key: '.linkedin.com', name: 'li_at' }])).toEqual(['linkedin']);
  });

  it('does not match an auth cookie on the wrong host', () => {
    expect(detectServices([{ host_key: '.evil.com', name: 'li_at' }])).toEqual([]);
  });

  it('returns [] when only non-auth cookies are present', () => {
    expect(detectServices([{ host_key: '.linkedin.com', name: 'bcookie' }])).toEqual([]);
  });

  it('detects multiple services at once', () => {
    expect(
      detectServices([
        { host_key: '.x.com', name: 'auth_token' },
        { host_key: '.github.com', name: 'user_session' },
      ]).sort()
    ).toEqual(['github', 'x']);
  });
});

describe('serviceForUrl', () => {
  it('maps subdomains to their service', () => {
    expect(serviceForUrl('https://www.linkedin.com/feed/')).toBe('linkedin');
    expect(serviceForUrl('https://gist.github.com/x')).toBe('github');
  });

  it('returns null for unknown hosts and malformed URLs', () => {
    expect(serviceForUrl('https://example.com/')).toBeNull();
    expect(serviceForUrl('not a url')).toBeNull();
  });
});

describe('loginsForProfile (real sqlite round-trip)', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-login-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('reads a real cookie DB (with >2^53 expiries) and reports live sessions', async () => {
    makeCookiesDb(path.join(TMP, 'comet-local@endpoint-0', 'chrome-data', 'Default'), [
      { host_key: '.linkedin.com', name: 'li_at', expires_utc: FUTURE },
      { host_key: '.google.com', name: 'SID', expires_utc: FUTURE },
      { host_key: '.linkedin.com', name: 'bcookie', expires_utc: FUTURE },
      // An EXPIRED github session must NOT count as logged in.
      { host_key: '.github.com', name: 'user_session', expires_utc: EXPIRED },
    ]);

    const logins = await loginsForProfile('comet-local');
    expect(logins.sort()).toEqual(['google', 'linkedin']);
  });

  it('returns [] when the profile has no cookie DB', async () => {
    expect(await loginsForProfile('comet-local')).toEqual([]);
  });
});

describe('credKeysForService / loginUrlForService', () => {
  it('derives the <PREFIX>_USERNAME/_PASSWORD keys from the explicit prefix', () => {
    expect(credKeysForService('linkedin')).toEqual({ user: 'LINKEDIN_USERNAME', pass: 'LINKEDIN_PASSWORD' });
    expect(credKeysForService('x')).toEqual({ user: 'X_USERNAME', pass: 'X_PASSWORD' });
  });
  it('returns null for an unknown service', () => {
    expect(credKeysForService('nope')).toBeNull();
    expect(loginUrlForService('nope')).toBeNull();
  });
  it('exposes a login URL for known services', () => {
    expect(loginUrlForService('github')).toBe('https://github.com/login');
  });
});

describe('account identity (real sqlite Login Data)', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-acct-test-'));
  });
  afterEach(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('maps saved logins to service -> username and skips blacklisted origins', async () => {
    makeLoginDb(path.join(TMP, 'comet-local@endpoint-0', 'chrome-data', 'Default'), [
      { origin_url: 'https://www.linkedin.com/login', username_value: 'muq@example.com', signon_realm: 'https://www.linkedin.com/' },
      { origin_url: 'https://github.com/login', username_value: 'muqsitnawaz', signon_realm: 'https://github.com/' },
      // Blacklisted ("never save") — must not surface.
      { origin_url: 'https://x.com/login', username_value: 'ghost', signon_realm: 'https://x.com/', blacklisted: 1 },
    ]);
    const accounts = await accountsForProfile('comet-local');
    expect(accounts).toEqual({ linkedin: 'muq@example.com', github: 'muqsitnawaz' });
  });

  it('loginsWithAccountsForProfile shows identity only for services with a LIVE cookie session', async () => {
    const dir = path.join(TMP, 'comet-local@endpoint-0', 'chrome-data', 'Default');
    // Live cookie session for linkedin only.
    makeCookiesDb(dir, [{ host_key: '.linkedin.com', name: 'li_at', expires_utc: FUTURE }]);
    // Saved usernames for BOTH linkedin and github — but github has no live cookie.
    makeLoginDb(dir, [
      { origin_url: 'https://www.linkedin.com/login', username_value: 'muq@example.com', signon_realm: 'https://www.linkedin.com/' },
      { origin_url: 'https://github.com/login', username_value: 'muqsitnawaz', signon_realm: 'https://github.com/' },
    ]);
    const rows = await loginsWithAccountsForProfile('comet-local');
    // github excluded (no live session); linkedin present with its identity.
    expect(rows).toEqual([{ service: 'linkedin', username: 'muq@example.com' }]);
  });
});
