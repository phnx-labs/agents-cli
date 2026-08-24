/**
 * ShareBackend — the token-source seam for `agents artifacts share`.
 *
 * Two legitimate principals, picked once at publish time:
 *   - **managed**: the caller is signed in to Phoenix (`readSession()`), no
 *     explicit BYO override. Token is the Phoenix access_token; endpoint is
 *     the already-live `share.agents-cli.sh`. Zero Cloudflare setup.
 *   - **byo**: the existing static WRITE_TOKEN path (`readShareConfig()` +
 *     `readWriteToken()`). Unchanged for power users / custom domains / fleet
 *     injection of `SHARE_WRITE_TOKEN`.
 *
 * Dispatch is not a fallback: signed-in AND no BYO override → managed;
 * otherwise BYO. Fail loud when neither principal can authenticate.
 *
 * Explicit BYO override (any one is enough):
 *   - `opts.byo === true`
 *   - `opts.writeToken` (a caller-supplied static token, including tests)
 *   - `AGENTS_SHARE_BACKEND=byo`
 */

import { readSession, type PhoenixSession } from '../identity/client.js';
import {
  DEFAULT_SHARE_DOMAIN,
  readShareConfig,
  readWriteToken,
  readWriteTokenEnv,
  type ShareConfig,
} from './config.js';

export type ShareBackendKind = 'managed' | 'byo';

export interface ShareBackend {
  kind: ShareBackendKind;
  /** Public base URL of the share Worker, no trailing slash. */
  baseUrl: string;
  /** Bearer sent as `Authorization`. Phoenix access_token or WRITE_TOKEN. */
  token: string;
  /** URL namespace prefix (`<namespace>/<slug>`). Phoenix userId or GitHub username. */
  namespace: string;
}

export interface ResolveShareBackendOpts {
  /** Force the BYO Cloudflare path even when signed in. */
  byo?: boolean;
  /** Override the namespace (BYO: GitHub username; ignored on managed — the
   * worker 403s a Phoenix PUT whose first segment is not the verified userId). */
  githubUser?: string;
  /** DI seam — a static write token selects BYO. */
  writeToken?: string;
  /** DI seam — persisted BYO endpoint config. */
  config?: ShareConfig;
  /** DI seam — override `readSession()`. `null` means signed out. */
  session?: PhoenixSession | null;
  /**
   * When false, BYO may resolve without a WRITE_TOKEN. Public GET routes
   * (list / revisions / status) don't need one; publish and delete do.
   * Default true.
   */
  requireToken?: boolean;
}

/** Env var that forces the BYO path. Value must be exactly `byo`. */
export const SHARE_BACKEND_ENV = 'AGENTS_SHARE_BACKEND';

/** URL-safe namespace: lowercase `[a-z0-9-]+`. Matches the Worker's sanitize.
 *
 * Phoenix userId is expected to already be `[a-z0-9-]+` (UUIDs sanitize
 * losslessly). This is URL-safety, not collision-resistance: two ids that
 * differ only in case or punctuation would share a prefix. */
export function sanitizeShareNamespace(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function managedShareBaseUrl(): string {
  return `https://${DEFAULT_SHARE_DOMAIN}`;
}

/**
 * Pick the principal. Signed-in (`readSession() != null`) AND no explicit BYO
 * override → managed; otherwise BYO.
 */
export function shouldUseManaged(opts: ResolveShareBackendOpts = {}): boolean {
  if (opts.byo === true) return false;
  if (opts.writeToken) return false;
  if ((process.env[SHARE_BACKEND_ENV] ?? '').trim().toLowerCase() === 'byo') return false;
  const session = opts.session === undefined ? readSession() : opts.session;
  return session != null;
}

export function resolveShareBackend(opts: ResolveShareBackendOpts = {}): ShareBackend {
  if (shouldUseManaged(opts)) {
    const session = opts.session === undefined ? readSession() : opts.session;
    if (!session) {
      throw new Error("Not signed in. Run 'agents auth login'.");
    }
    return resolveManagedBackend(session);
  }
  return resolveByoBackend(opts);
}

function resolveManagedBackend(session: PhoenixSession): ShareBackend {
  if (!session.access_token) {
    throw new Error("Not signed in. Run 'agents auth login'.");
  }
  const namespace = sanitizeShareNamespace(session.userId ?? '');
  if (!namespace) {
    throw new Error("Signed in but the session has no user id. Run 'agents auth login' again.");
  }
  return {
    kind: 'managed',
    baseUrl: managedShareBaseUrl(),
    token: session.access_token,
    namespace,
  };
}

function resolveByoBackend(opts: ResolveShareBackendOpts): ShareBackend {
  const cfg = opts.config ?? readShareConfig();
  if (!cfg) {
    throw new Error(
      "Not set up yet. Run 'agents auth login' to publish on the managed endpoint (zero Cloudflare setup), or 'agents artifacts setup' / 'agents artifacts share join' for your own Cloudflare.",
    );
  }
  const token =
    opts.writeToken ??
    (opts.requireToken === false ? (readWriteTokenEnv() ?? '') : readWriteToken());
  // Namespace is the GitHub username. An explicit --github-user is sanitized
  // here; otherwise publish fills it via resolveShareUsername (gh/git config).
  const namespace = opts.githubUser ? sanitizeShareNamespace(opts.githubUser) : '';
  return {
    kind: 'byo',
    baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    token,
    namespace,
  };
}
