/**
 * Best-effort login-state detection for browser profiles.
 *
 * Reads a profile's Chromium cookie store (presence only — never decrypts the
 * Keychain-encrypted values) to tell which login-gated services have a live
 * session in that profile. Powers the `agents browser start` guardrail (warn
 * when an agent opens a logged-out profile for a login-gated URL) and the
 * `agents browser profiles logins` view.
 *
 * Everything here is advisory: any failure (missing DB, locked file, unknown
 * schema) degrades to "no known session" and NEVER throws to callers — browser
 * start must not slow down or break because cookie inspection hiccuped.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../sqlite.js';
import { getBrowserRuntimeDir, listProfiles } from './profiles.js';

/** A login-gated service signature: host substrings + the auth-cookie names
 *  whose presence indicates a live session. */
interface ServiceSignature {
  hosts: string[];
  cookies: string[];
}

/**
 * Known login-gated services. Presence of ANY listed cookie on a matching host
 * (unexpired, or a session cookie) = logged in. Deliberately conservative: a
 * service absent from this map simply never triggers a warning — we do not
 * guess. Each cookie name here is the definitive authenticated-session token for
 * that service (e.g. LinkedIn's `li_at` is only set for a signed-in member;
 * visitor cookies like `bcookie`/`JSESSIONID` are NOT auth). Services whose
 * session is not reliably expressed as a recognizable cookie (e.g. Attio, whose
 * only same-site cookies are third-party analytics) are deliberately omitted so
 * we never emit a false "logged out" warning. Extend as needed.
 */
export const AUTH_SIGNATURES: Record<string, ServiceSignature> = {
  linkedin: { hosts: ['linkedin.com'], cookies: ['li_at'] },
  google: { hosts: ['google.com'], cookies: ['SID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'] },
  x: { hosts: ['x.com', 'twitter.com'], cookies: ['auth_token'] },
  reddit: { hosts: ['reddit.com'], cookies: ['reddit_session', 'token_v2'] },
  github: { hosts: ['github.com'], cookies: ['user_session'] },
};

export interface CookieRow {
  host_key: string;
  name: string;
}

/**
 * Current time as microseconds since 1601-01-01 (Chromium's `expires_utc`
 * epoch), as a BigInt. Chromium expiries routinely exceed 2^53, so this is
 * bound into SQL as a BigInt and the comparison happens IN SQLite — the huge
 * integer never marshals back to JS (node:sqlite throws RangeError if it does).
 * 11644473600000 = ms between 1601-01-01 and 1970-01-01.
 */
function chromeNowMicrosBigInt(): bigint {
  return (BigInt(Date.now()) + 11644473600000n) * 1000n;
}

function hostMatches(hostKey: string, host: string): boolean {
  return hostKey === host || hostKey === '.' + host || hostKey.endsWith('.' + host);
}

/**
 * Pure core: given a profile's (already expiry-filtered) cookie rows, return the
 * services with a live session. Exported for direct unit testing without disk.
 */
export function detectServices(rows: CookieRow[]): string[] {
  const services: string[] = [];
  for (const [service, sig] of Object.entries(AUTH_SIGNATURES)) {
    const found = rows.some(
      (r) => sig.cookies.includes(r.name) && sig.hosts.some((h) => hostMatches(r.host_key, h))
    );
    if (found) services.push(service);
  }
  return services;
}

/** Map a URL to a known login-gated service key, or null. */
export function serviceForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  for (const [service, sig] of Object.entries(AUTH_SIGNATURES)) {
    if (sig.hosts.some((h) => host === h || host.endsWith('.' + h))) return service;
  }
  return null;
}

/**
 * Locate candidate Chromium cookie DBs for a profile. The live runtime dir is
 * keyed by the composite `<profile>@<endpoint>` name, so we scan the browser
 * cache root for `<profile>` and `<profile>@*` dirs and return every cookie DB
 * found (both the legacy `Default/Cookies` and newer `Default/Network/Cookies`),
 * most-recently-modified first.
 */
function cookieDbCandidates(profileName: string): string[] {
  const root = getBrowserRuntimeDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e === profileName || e.startsWith(profileName + '@'));
  const found: { p: string; mtime: number }[] = [];
  for (const d of dirs) {
    for (const rel of [
      ['chrome-data', 'Default', 'Cookies'],
      ['chrome-data', 'Default', 'Network', 'Cookies'],
    ]) {
      const p = path.join(root, d, ...rel);
      try {
        found.push({ p, mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* not present */
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.p);
}

/**
 * Read cookie rows from a Chromium cookie DB. Copies the DB (and any WAL/SHM
 * sidecars) to a temp dir first so a running browser's lock never blocks us and
 * we never touch the live file. Returns [] on any failure.
 */
function readCookieRows(dbPath: string): CookieRow[] {
  let tmpDir: string | null = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cookies-'));
    const tmpDb = path.join(tmpDir, 'Cookies');
    fs.copyFileSync(dbPath, tmpDb);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, tmpDb + suffix);
    }
    const db = new Database(tmpDb);
    try {
      // Filter expiry in SQL (session cookies have expires_utc = 0; otherwise it
      // must be in the future) and select only text columns, so the huge
      // microsecond integer never crosses into JS.
      const rows = db
        .prepare('SELECT host_key, name FROM cookies WHERE expires_utc = 0 OR expires_utc > ?')
        .all(chromeNowMicrosBigInt()) as Array<{ host_key: unknown; name: unknown }>;
      return rows.map((r) => ({
        host_key: String(r.host_key ?? ''),
        name: String(r.name ?? ''),
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup best-effort */
      }
    }
  }
}

/** Services with a live session in the given profile (best-effort; [] if none
 *  detected or the cookie store is unreadable). */
export async function loginsForProfile(profileName: string): Promise<string[]> {
  const candidates = cookieDbCandidates(profileName);
  if (candidates.length === 0) return [];
  const rows = readCookieRows(candidates[0]);
  if (rows.length === 0) return [];
  return detectServices(rows);
}

/** Profile names that have a live session for the given service. */
export async function profilesLoggedInto(service: string): Promise<string[]> {
  const profiles = await listProfiles();
  const out: string[] = [];
  for (const p of profiles) {
    const logins = await loginsForProfile(p.name);
    if (logins.includes(service)) out.push(p.name);
  }
  return out;
}
