/**
 * Login/token propagation — the "one login instead of ~48 OAuth flows" core of
 * `agents apply`.
 *
 * A source machine that is already signed in to a set of harnesses has portable
 * credential files on disk (verified per-agent locations below). `snapshotAuth`
 * captures those; `materializeAuth` writes them into the corresponding paths on
 * a target device. Transport is the caller's job — `apply` streams the bundle
 * over the existing (encrypted, authenticated) SSH channel via `sshExec`'s
 * stdin `input`, so no app-layer crypto is layered on top of SSH here.
 *
 * Honest boundary: on macOS, claude and antigravity keep their tokens in the
 * login keychain, ACL-bound to the harness process — unreadable by us. Those are
 * classified `bound` and surfaced for a one-time manual login, never faked.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AuthFilePayload, AuthBundle, AuthSnapshotResult } from './types.js';

/** A portable credential file location, relative to $HOME. */
interface AuthFileSpec {
  rel: string;
  mode: number;
}

/**
 * Verified portable auth-file locations per agent (home-relative). Sourced from
 * live inspection of a Linux fleet box + the agent registry. Agents absent here
 * have no portable credential file we can propagate.
 */
export const FLEET_AUTH_FILES: Record<string, AuthFileSpec[]> = {
  claude: [{ rel: '.claude/.credentials.json', mode: 0o600 }],
  codex: [{ rel: '.codex/auth.json', mode: 0o600 }],
  gemini: [{ rel: '.gemini/oauth_creds.json', mode: 0o600 }],
  grok: [{ rel: '.grok/auth.json', mode: 0o600 }],
  kimi: [{ rel: '.kimi-code/credentials/kimi-code.json', mode: 0o600 }],
  opencode: [{ rel: '.local/share/opencode/auth.json', mode: 0o600 }],
  droid: [
    { rel: '.factory/auth.v2.file', mode: 0o600 },
    { rel: '.factory/auth.v2.key', mode: 0o600 },
  ],
  antigravity: [{ rel: '.gemini/antigravity-cli/antigravity-oauth-token', mode: 0o600 }],
};

/** Agents whose macOS credentials live in the ACL-bound login keychain. */
export const KEYCHAIN_BOUND_ON_MAC: ReadonlySet<string> = new Set(['claude', 'antigravity']);

/** Which agents `apply` can propagate auth for at all. */
export function isPropagatableAgent(agent: string): boolean {
  return agent in FLEET_AUTH_FILES;
}

export interface SnapshotOptions {
  /** Home directory to read credential files from. */
  home: string;
  /** Platform of the source machine (`process.platform`). */
  platform: NodeJS.Platform;
}

/**
 * Capture portable credential files for the given agents from a source home.
 * Returns the readable file payloads plus the list of agents whose auth is
 * device-bound (macOS keychain) and therefore cannot be captured. Agents that
 * are simply not signed in (no file on disk) are silently omitted — nothing to
 * propagate, not an error.
 */
export function snapshotAuth(agents: string[], opts: SnapshotOptions): AuthSnapshotResult {
  const files: AuthFilePayload[] = [];
  const bound: string[] = [];

  for (const agent of agents) {
    const specs = FLEET_AUTH_FILES[agent];
    if (!specs) continue; // not propagatable — caller surfaces separately if desired
    if (opts.platform === 'darwin' && KEYCHAIN_BOUND_ON_MAC.has(agent)) {
      bound.push(agent);
      continue;
    }
    for (const spec of specs) {
      const abs = path.join(opts.home, spec.rel);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // not signed in for this agent — nothing to carry
      }
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(abs); // follows symlinks into version homes
      files.push({
        agent,
        rel: spec.rel,
        contentB64: content.toString('base64'),
        mode: (stat.mode & 0o777) || spec.mode,
      });
    }
  }

  return { files, bound };
}

/** Assemble the plaintext bundle shipped to a target. */
export function buildAuthBundle(source: string, files: AuthFilePayload[]): AuthBundle {
  return { v: 1, source, files };
}

export interface MaterializeOptions {
  /** Home directory to write credential files into. */
  home: string;
}

export interface MaterializeResult {
  /** Agent ids that received at least one file. */
  written: string[];
  /** `rel: reason` for any file that failed. */
  errors: string[];
}

/**
 * Write a captured auth bundle into a target home. Parent dirs are created; the
 * captured POSIX mode is restored (0600 for credentials). Writing through an
 * existing symlink lands in the agent's active version home, which is exactly
 * what per-version credential carry-forward expects.
 */
export function materializeAuth(bundle: AuthBundle, opts: MaterializeOptions): MaterializeResult {
  const written = new Set<string>();
  const errors: string[] = [];

  for (const f of bundle.files) {
    const abs = path.join(opts.home, f.rel);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(f.contentB64, 'base64'));
      fs.chmodSync(abs, f.mode || 0o600);
      written.add(f.agent);
    } catch (e) {
      errors.push(`${f.rel}: ${(e as Error).message}`);
    }
  }

  return { written: [...written], errors };
}

/** Parse + validate a bundle received on stdin (the remote `--_recv-auth` path). */
export function parseAuthBundle(raw: string): AuthBundle {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`auth bundle is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof doc !== 'object' || doc === null) throw new Error('auth bundle must be an object.');
  const o = doc as Record<string, unknown>;
  if (o.v !== 1) throw new Error(`unsupported auth bundle version ${JSON.stringify(o.v)}.`);
  if (typeof o.source !== 'string') throw new Error('auth bundle missing source.');
  if (!Array.isArray(o.files)) throw new Error('auth bundle missing files[].');
  for (const f of o.files) {
    if (
      typeof f !== 'object' || f === null ||
      typeof (f as AuthFilePayload).agent !== 'string' ||
      typeof (f as AuthFilePayload).rel !== 'string' ||
      typeof (f as AuthFilePayload).contentB64 !== 'string' ||
      typeof (f as AuthFilePayload).mode !== 'number'
    ) {
      throw new Error('auth bundle has a malformed file entry.');
    }
    // Reject path traversal — rel must stay under $HOME.
    const rel = (f as AuthFilePayload).rel;
    if (rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error(`auth bundle rejected unsafe path: ${rel}`);
    }
  }
  return doc as AuthBundle;
}
