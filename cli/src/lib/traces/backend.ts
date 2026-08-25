/**
 * TracesBackend — token-source seam for `agents traces sync`.
 *
 * Managed path: signed in to Phoenix (`readSession() != null`), no BYO
 * override. Token is the Phoenix access_token; endpoint is the live
 * `traces.agents-cli.sh` Worker. Zero Cloudflare setup.
 *
 * BYO path (future): TRACES_BASE_URL + TRACES_WRITE_TOKEN env vars. Not
 * exposed in the CLI for M1 — follow-on milestone, same pattern as
 * `agents artifacts setup`.
 */

import { readSession } from '../identity/client.js';

export const DEFAULT_TRACES_DOMAIN = 'traces.agents-cli.sh';

export interface TracesBackend {
  /** Public base URL of the traces Worker, no trailing slash. */
  baseUrl: string;
  /** Bearer sent as `Authorization`. Phoenix access_token. */
  token: string;
  /** Phoenix userId — the R2 namespace prefix. */
  userId: string;
}

/**
 * Resolve the backend for the current machine. Throws when not signed in.
 *
 * BYO override env vars (for testing / self-hosted):
 *   AGENTS_TRACES_BASE_URL — Worker URL, no trailing slash
 *   AGENTS_TRACES_WRITE_TOKEN — static write token (bypasses Phoenix auth)
 */
export function resolveTracesBackend(): TracesBackend {
  const envBase = (process.env['AGENTS_TRACES_BASE_URL'] ?? '').replace(/\/+$/, '').trim();
  const envToken = (process.env['AGENTS_TRACES_WRITE_TOKEN'] ?? '').trim();

  if (envBase && envToken) {
    return { baseUrl: envBase, token: envToken, userId: 'byo' };
  }

  const session = readSession();
  if (!session) {
    throw new Error("Not signed in. Run 'agents auth login' to sync traces to your Phoenix account.");
  }
  if (!session.access_token) {
    throw new Error("Session has no access token. Run 'agents auth login' again.");
  }
  const userId = (session.userId ?? '').trim();
  if (!userId) {
    throw new Error("Signed in but the session has no user id. Run 'agents auth login' again.");
  }
  return {
    baseUrl: managedTracesBaseUrl(),
    token: session.access_token,
    userId,
  };
}

export function managedTracesBaseUrl(): string {
  return `https://${DEFAULT_TRACES_DOMAIN}`;
}
