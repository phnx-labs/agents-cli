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

import { detectServices, serviceForUrl, loginsForProfile } from './login-detection.js';

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
