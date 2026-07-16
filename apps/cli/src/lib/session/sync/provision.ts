/**
 * Provisioning for cross-machine session sync: write the `r2.backups` secrets
 * bundle and probe R2 connectivity. Pure logic — no prompts, no Commander — so
 * it is unit-testable against the in-memory keychain seam. The interactive flow
 * that collects the values lives in the command layer
 * (`commands/sync-provision.ts`).
 */

import {
  bundleExists,
  readBundle,
  writeBundle,
  bundleItemStore,
  keychainRef,
  type SecretsBundle,
} from '../../secrets/bundles.js';
import { secretsKeychainItem } from '../../secrets/index.js';
import { SYNC_BUNDLE, loadR2Config, clearR2ConfigCache } from './config.js';
import { R2Client } from './r2.js';
import { generateSyncEncKey, resolveSyncEncKey } from './transcript-crypto.js';
import { machineId } from '../../machine-id.js';

/** Values a caller has already collected for the sync bundle. */
export interface ProvisionInput {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional S3 endpoint override (MinIO / non-R2). Default derived from accountId. */
  endpoint?: string;
  /**
   * Shared transcript-encryption key for a machine JOINING an existing fabric —
   * paste the key the first machine generated. Omit on the first machine to mint
   * a fresh one. Ignored if the bundle already carries a key (never overwritten).
   */
  encKey?: string;
}

export type EncKeyAction = 'generated' | 'reused' | 'provided';

/**
 * Create or update the `r2.backups` bundle from already-collected values.
 *
 * The four R2 credentials are always (over)written. The encryption key is
 * handled carefully: an existing key is REUSED, never overwritten (overwriting
 * would orphan every transcript peers already encrypted under it); otherwise a
 * caller-supplied `encKey` is stored, or a fresh one minted on the first machine.
 */
export function writeSyncBundle(input: ProvisionInput): { encKeyAction: EncKeyAction } {
  // Validate a joining machine's pasted key up front so a bad paste fails here,
  // not silently at the next sync.
  if (input.encKey) resolveSyncEncKey({ syncEncKey: input.encKey });

  const bundle: SecretsBundle = bundleExists(SYNC_BUNDLE)
    ? readBundle(SYNC_BUNDLE)
    : { name: SYNC_BUNDLE, description: 'Cross-machine session-sync R2 credentials', vars: {} };

  const store = bundleItemStore(bundle.backend);
  const setKey = (key: string, value: string): void => {
    store.set(secretsKeychainItem(SYNC_BUNDLE, key), value);
    bundle.vars[key] = keychainRef(key);
  };

  setKey('R2_ACCOUNT_ID', input.accountId);
  setKey('R2_BUCKET_NAME', input.bucketName);
  setKey('R2_ACCESS_KEY_ID', input.accessKeyId);
  setKey('R2_SECRET_ACCESS_KEY', input.secretAccessKey);
  if (input.endpoint) setKey('R2_ENDPOINT', input.endpoint);

  let encKeyAction: EncKeyAction;
  if (bundle.vars['R2_SYNC_ENC_KEY']) {
    encKeyAction = 'reused';
  } else if (input.encKey) {
    setKey('R2_SYNC_ENC_KEY', input.encKey);
    encKeyAction = 'provided';
  } else {
    setKey('R2_SYNC_ENC_KEY', generateSyncEncKey());
    encKeyAction = 'generated';
  }

  writeBundle(bundle);
  clearR2ConfigCache(); // so the next loadR2Config() sees the just-written values
  return { encKeyAction };
}

/** The shared encryption key currently stored (for display when handing it to peers). */
export function readStoredEncKey(): string | null {
  clearR2ConfigCache();
  try {
    return loadR2Config().syncEncKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Prove the configured bundle can read AND write its bucket: put a throwaway
 * object, read it back, delete it. Returns a structured result instead of
 * throwing so the caller (setup) never crashes on a bad credential. The probe
 * key lives OUTSIDE the `sessions/` prefix so it can never be mistaken for a
 * machine manifest by the pull path.
 */
export async function probeR2Connectivity(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    clearR2ConfigCache();
    const cfg = loadR2Config();
    const r2 = new R2Client(cfg);
    const key = `.agents-provision-probe/${machineId()}.txt`;
    const token = `agents-sync-probe-${machineId()}`;
    await r2.put(key, token, 'text/plain');
    const got = await r2.get(key);
    await r2.delete(key);
    if (got !== token) return { ok: false, error: 'wrote a probe object but read back different bytes' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
