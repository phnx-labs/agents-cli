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

/**
 * Agents whose OAuth credentials rely on single-use refresh tokens that rotate
 * server-side on every exchange. Copying these credential files across machines
 * is fatal: the first refresh on any box invalidates every other holder's token,
 * collapsing the fleet to a single working login (droid/WorkOS collapsed 10 boxes
 * to 1 overnight — RUSH-1958). Add any newly-discovered single-use-rotation
 * harness here; the predicate below is the one place the propagation decision is
 * made. See also `remote-login.ts` and `usage.ts` for the per-machine-login policy.
 */
export const SINGLE_USE_ROTATING_REFRESH_AGENTS: ReadonlySet<string> = new Set(['droid']);

/** True when `agent`'s portable credential file(s) are safe to copy between
 *  machines. Single-use rotating refresh tokens are never safe; keychain-bound
 *  tokens are handled separately by the caller via {@link KEYCHAIN_BOUND_ON_MAC}. */
export function isCredentialSafeToPropagate(agent: string): boolean {
  return !SINGLE_USE_ROTATING_REFRESH_AGENTS.has(agent);
}

/** True when the agent stores credentials in portable files we can read. This
 *  does NOT mean it is safe to propagate — check {@link isCredentialSafeToPropagate}. */
export function hasPortableAuthFiles(agent: string): boolean {
  return agent in FLEET_AUTH_FILES;
}

/** Which agents `apply` can propagate auth for at all. */
export function isPropagatableAgent(agent: string): boolean {
  return hasPortableAuthFiles(agent) && isCredentialSafeToPropagate(agent);
}

/**
 * The shape of a login flow — enough for `agents fleet login` to drive a remote
 * box's device-code OAuth over SSH and scrape the verification URL + user code.
 *
 * `flowType` decides remotability:
 *  - `device-code` — the remote box prints a URL + short code the human enters in
 *    a browser on THIS machine. The only flow `fleet login` can orchestrate.
 *  - `loopback`    — the CLI opens a browser and listens on 127.0.0.1 on the
 *    remote box; the redirect must reach that box's own loopback, so it can only
 *    be completed with a browser on the same machine. Non-remotable.
 *  - `api-key`     — a pasted key, not an OAuth handshake. Non-remotable.
 *  - `unknown`     — flow not yet characterized (no captured output). Non-remotable
 *    until someone captures the real pattern and fills the regexes.
 */
export type LoginFlowType = 'device-code' | 'loopback' | 'api-key' | 'unknown';

export interface LoginFlow {
  /**
   * The exact command that starts the login flow on the remote box, run as
   * `ssh -tt <box> <loginCommand>`. Bare `<cli>` for agents whose device flow
   * starts on launch (droid, kimi, antigravity), `<cli> login` for
   * codex/grok, `<cli> auth login` for opencode.
   */
  loginCommand: string;
  flowType: LoginFlowType;
  /**
   * Keystrokes sent after launch to force the device-code path when the CLI
   * presents a menu (codex: pick "Sign in with Device Code") or requires a
   * sub-command inside a TUI (kimi: `/login`). Sent verbatim through the PTY,
   * so it must include the submitting CR (`\r`). Absent when the flow needs no
   * steering.
   */
  deviceCodeSelect?: string;
  /** Captures the verification URL from scraped login output (group 1 preferred). */
  verificationUrlRegex?: RegExp;
  /** Captures the user code from scraped login output (group 1 preferred). */
  userCodeRegex?: RegExp;
  /**
   * Home-relative credential file that appears / bumps mtime on success — the
   * completion signal. Mirrors {@link FLEET_AUTH_FILES} (first entry for agents
   * with several).
   */
  successFile: string;
}

/** The success-file for an agent — the primary portable credential (first spec). */
function successFileFor(agent: string): string {
  const specs = FLEET_AUTH_FILES[agent];
  if (!specs || specs.length === 0) throw new Error(`no auth file spec for agent '${agent}'`);
  return specs[0].rel;
}

/**
 * Per-agent login flows, populated from live login-output captures (the only
 * ground truth — no fixtures exist upstream). Agents whose real device-code
 * output has not been captured are marked honestly (`unknown` / no regexes) so
 * `fleet login` flags them non-remotable instead of guessing.
 *
 * Only the `device-code` entries are ones `fleet login` drives; the rest are
 * carried so the command can explain WHY a logged-out pair is not remotable.
 */
export const FLEET_LOGIN_FLOWS: Record<string, LoginFlow> = {
  // droid: launches its TUI and prints, verbatim:
  //   "If the link does not open automatically, please visit
  //    https://auth.factory.ai/device and enter code MJQW-NQRM to complete
  //    authentication." then "Waiting for authentication to complete...".
  droid: {
    loginCommand: 'droid',
    flowType: 'device-code',
    verificationUrlRegex: /please visit\s+(https:\/\/\S+?)\s+and enter code/i,
    userCodeRegex: /enter code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/i,
    successFile: successFileFor('droid'),
  },
  // codex login shows a numbered menu; option 2 ("Sign in with Device Code",
  // "Sign in from another device with a one-time code") is the remotable one.
  // The post-selection URL/code output was not captured this session, so the
  // regexes are best-effort generic device-code patterns — TODO: tighten once a
  // real codex device-code screen is captured.
  codex: {
    loginCommand: 'codex login',
    flowType: 'device-code',
    deviceCodeSelect: '\x1b[B\r', // down-arrow once (to option 2) + Enter
    verificationUrlRegex: /(https:\/\/\S*(?:device|activate|login|auth)\S*)/i,
    userCodeRegex: /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/,
    successFile: successFileFor('codex'),
  },
  // kimi: launch bare `kimi`, then `/login` inside the TUI, which prints
  // "Select a platform and authenticate". Post-selection URL/code not captured —
  // best-effort regexes, TODO: tighten with a real capture.
  kimi: {
    loginCommand: 'kimi',
    flowType: 'device-code',
    deviceCodeSelect: '/login\r',
    verificationUrlRegex: /(https:\/\/\S+)/i,
    userCodeRegex: /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/,
    successFile: successFileFor('kimi'),
  },
  // grok: `grok login`. No captured pattern this session — flowType is
  // device-code (best guess for the remotable path) but regexes are left unset
  // (TODO: capture grok's login output), so scrapeLogin yields nothing until a
  // real pattern is added and driveRemoteLogin will time out rather than guess.
  grok: {
    loginCommand: 'grok login',
    flowType: 'device-code',
    successFile: successFileFor('grok'),
  },
  // antigravity: bare `agy`, Google OAuth. Keychain-bound on macOS and loopback
  // (browser + 127.0.0.1 listener on the box itself) — non-remotable.
  antigravity: {
    loginCommand: 'agy',
    flowType: 'loopback',
    successFile: successFileFor('antigravity'),
  },
  // opencode: `opencode auth login`. No captured pattern — unknown/non-remotable.
  opencode: {
    loginCommand: 'opencode auth login',
    flowType: 'unknown',
    successFile: successFileFor('opencode'),
  },
  // claude: interactive `/login` inside the TUI is a loopback browser flow, and
  // the token is keychain-bound on macOS. A headless `claude setup-token` device
  // variant exists (TODO: wire as a device-code flow with a captured pattern);
  // until then claude is flagged non-remotable.
  claude: {
    loginCommand: 'claude',
    flowType: 'loopback',
    successFile: successFileFor('claude'),
  },
};

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
    if (!specs) continue; // no portable file — caller surfaces separately if desired
    if (!isCredentialSafeToPropagate(agent)) continue; // single-use rotating refresh tokens are never copied
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
