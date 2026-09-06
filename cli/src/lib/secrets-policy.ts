/**
 * Fleet policy for the reserved `auth` bundle (PHNX-3989 CTX-1).
 *
 * The standalone `secrets` engine has no concept of a "reserved" bundle name —
 * that policy is agents-cli's own (the fleet-shared setup-token store), so it
 * lives here rather than in the engine. The one piece of engine state this
 * needs — whether the bundle exists and which backend holds it — is resolved
 * through the process client, never re-implemented.
 */
import { bundleExistsSync, bundleBackendSync } from './secrets-client.js';
import type { SecretsBackend } from './secrets/bundles.js';

/** The one reserved bundle name: the fleet-shared setup-token store. */
export const AUTH_BUNDLE_NAME = 'auth';

/** The reserved `auth` bundle is always file-backed (SEC-GAP-3). */
export const AUTH_BUNDLE_BACKEND: SecretsBackend = 'file';

export const RESERVED_BUNDLE_NAMES = new Set([AUTH_BUNDLE_NAME]);

export function isReservedBundleName(name: string): boolean {
  return RESERVED_BUNDLE_NAMES.has(name.trim().toLowerCase());
}

/**
 * Whether the local reserved `auth` bundle exists and is on the expected
 * (file) backend. `ok: true` on a missing bundle — nothing to be wrong about.
 */
export function inspectReservedAuthBundle(): {
  exists: boolean;
  backend: SecretsBackend | null;
  ok: boolean;
} {
  let exists: boolean;
  try {
    exists = bundleExistsSync(AUTH_BUNDLE_NAME);
  } catch {
    return { exists: false, backend: null, ok: true };
  }
  if (!exists) {
    return { exists: false, backend: null, ok: true };
  }
  const backend = bundleBackendSync(AUTH_BUNDLE_NAME);
  return { exists: true, backend, ok: backend === AUTH_BUNDLE_BACKEND };
}
