/**
 * Remote sync for secrets bundles — backend-agnostic.
 *
 * Replaces the previous "leave it to iCloud Keychain" model with explicit
 * push/pull. Bundle contents (vars + secret values) are encrypted client-side
 * with AES-256-GCM under a key derived from a user-supplied passphrase via
 * PBKDF2-SHA256; only the resulting ciphertext envelope is handed to the
 * transport. The transport itself is a pluggable `SyncBackend` (see
 * `sync-backend.ts`) — the Rush driver (`drivers/rush.ts`, api.prix.dev) is the
 * default for backwards compatibility, swappable via `setSyncBackend`. Plaintext
 * never leaves this module; the backend only ever sees ciphertext + KDF params.
 */

import * as crypto from 'crypto';
import {
  deleteKeychainToken,
  getKeychainToken,
  hasKeychainToken,
  secretsKeychainItem,
  setKeychainToken,
} from './index.js';
import {
  readBundle,
  writeBundle,
  keychainItemsForBundle,
  validateBundleName,
  type SecretsBundle,
} from './bundles.js';
import { rushSyncBackend } from './drivers/rush.js';
import type { SyncBackend, SyncEnvelope, RemoteBundleSummary, EncryptedEnvelope } from './sync-backend.js';
import { emit } from '../events.js';

// Re-export the envelope + summary types so existing importers of this module
// keep resolving them from here.
export type { EncryptedEnvelope, RemoteBundleSummary } from './sync-backend.js';

// PBKDF2 cost. 600k SHA-256 iters matches OWASP 2023+ guidance and keeps a
// passphrase prompt under a second on the hardware the CLI targets.
const PBKDF2_ITER = 600_000;
export const MIN_PASSPHRASE_LEN = 12;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

/**
 * Active transport backend. Defaults to the Rush driver for backwards
 * compatibility with bundles already pushed to api.prix.dev; `setSyncBackend`
 * swaps it (a future Supabase driver, or an in-memory double in tests). The
 * crypto + snapshot/restore below stay backend-agnostic — the backend only
 * ever moves ciphertext envelopes, never plaintext.
 */
let backend: SyncBackend = rushSyncBackend;

/** Override the sync transport. Returns the previous backend (restore in tests). */
export function setSyncBackend(next: SyncBackend): SyncBackend {
  const prev = backend;
  backend = next;
  return prev;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
}

/** Encrypt a JSON-serializable payload with a passphrase. */
export function encryptBlob(plaintext: string, passphrase: string): EncryptedEnvelope {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters.`);
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: 'pbkdf2-sha256',
    iter: PBKDF2_ITER,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/** Decrypt an envelope. Throws on bad passphrase (auth tag mismatch). */
export function decryptBlob(envelope: EncryptedEnvelope, passphrase: string): string {
  if (envelope.v !== 1 || envelope.kdf !== 'pbkdf2-sha256') {
    throw new Error(`Unsupported envelope version (v${envelope.v}, kdf=${envelope.kdf}).`);
  }
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
  } catch {
    throw new Error('Decryption failed — wrong passphrase or corrupt blob.');
  }
}

/** The plaintext we serialize before encrypting: bundle metadata + secret values. */
export interface BundleSnapshot {
  bundle: SecretsBundle;
  /** keychain shortId -> plaintext value. Only present for keychain: refs. */
  secrets: Record<string, string>;
}

function snapshotBundle(name: string): BundleSnapshot {
  const bundle = readBundle(name);
  const secrets: Record<string, string> = {};
  for (const { key, item } of keychainItemsForBundle(bundle)) {
    if (!hasKeychainToken(item)) {
      throw new Error(`Bundle '${name}' key '${key}': keychain item '${item}' missing — cannot push incomplete bundle.`);
    }
    const raw = bundle.vars[key];
    if (typeof raw !== 'string' || !raw.startsWith('keychain:')) continue;
    const shortId = raw.slice('keychain:'.length);
    secrets[shortId] = getKeychainToken(item);
  }
  return { bundle, secrets };
}

/** Prior state of one keychain item a restore is about to overwrite. */
interface PriorItem {
  item: string;
  /** Whether the item already existed before the restore touched it. */
  existed: boolean;
  /** Its value when it existed (undefined for items that didn't exist). */
  value?: string;
}

/**
 * Materialize a decrypted snapshot locally, atomically.
 *
 * A naive "set each secret, then write metadata" is not crash-safe: if one
 * `setKeychainToken` throws midway, the keychain is left with a half-applied
 * set — some items carry the pulled values, others the old ones — and the
 * bundle metadata may never be written, leaving orphaned/wrong items readable.
 *
 * So we snapshot the PRIOR value of every item we're about to touch, apply all
 * writes, and on ANY failure roll back to exactly the pre-restore state
 * (restore previously-existing items, delete items that didn't exist) before
 * rethrowing. Metadata is committed only after every secret write succeeds; if
 * that final write fails, the secret writes are rolled back too. Either the
 * whole pull lands or the keychain is untouched.
 */
function restoreSnapshot(snap: BundleSnapshot): void {
  const bundle = snap.bundle;
  validateBundleName(bundle.name);

  // Capture the pre-restore state of every item so a partial failure can be
  // undone. hasKeychainToken never prompts; getKeychainToken reads the existing
  // value via the same path the rest of the module uses.
  const priors: PriorItem[] = [];
  for (const shortId of Object.keys(snap.secrets)) {
    const item = secretsKeychainItem(bundle.name, shortId);
    if (hasKeychainToken(item)) {
      priors.push({ item, existed: true, value: getKeychainToken(item) });
    } else {
      priors.push({ item, existed: false });
    }
  }

  // Best-effort reversal to the captured pre-restore state. Each item is
  // reverted independently so one failure doesn't abort the rest of the
  // rollback. Reversal writes hit the SAME backend that just failed the restore
  // (a locked/erroring keyring is the realistic trigger), so a reversal can
  // itself throw — those items are collected and returned so the caller can
  // report an INCOMPLETE rollback instead of falsely claiming a clean one.
  const rollback = (): string[] => {
    const stillDirty: string[] = [];
    for (const prior of priors) {
      try {
        if (prior.existed) setKeychainToken(prior.item, prior.value!);
        else deleteKeychainToken(prior.item);
      } catch {
        // Keep undoing the remaining items, but remember this one couldn't be
        // reverted — it may now hold an orphaned or wrong value.
        stillDirty.push(prior.item);
      }
    }
    return stillDirty;
  };

  try {
    for (const [shortId, value] of Object.entries(snap.secrets)) {
      const item = secretsKeychainItem(bundle.name, shortId);
      setKeychainToken(item, value);
    }
  } catch (err) {
    throw new Error(rollbackFailureMessage(bundle.name, 'writing secrets', err as Error, rollback()));
  }

  // Commit metadata last. If it fails, undo the secret writes so nothing
  // partial lingers.
  try {
    writeBundle(bundle);
  } catch (err) {
    throw new Error(rollbackFailureMessage(bundle.name, 'writing metadata', err as Error, rollback()));
  }
}

/**
 * Build the error thrown when a restore fails. When the rollback reverted every
 * touched item (`dirty` empty) we truthfully say the keychain is back to the
 * pre-restore state. When some reversal writes ALSO failed we must NOT claim a
 * clean rollback — the message names the still-dirty items so the user knows the
 * keychain is half-restored and which secrets to check.
 */
function rollbackFailureMessage(name: string, phase: string, err: Error, dirty: string[]): string {
  if (dirty.length === 0) {
    return `Restore of bundle '${name}' failed while ${phase}; ` +
      `rolled back to the pre-restore state. (${err.message})`;
  }
  return `Restore of bundle '${name}' failed while ${phase}, and the rollback was INCOMPLETE — ` +
    `these keychain items could not be reverted and may hold orphaned or wrong values: ${dirty.join(', ')}. ` +
    `(original error: ${err.message})`;
}

/** Options for pushBundle. */
export interface PushOptions {
  passphrase: string;
}

/** Push a local bundle to the remote. Encrypts client-side; the backend only sees ciphertext. */
export async function pushBundle(name: string, opts: PushOptions): Promise<{ updated_at: string }> {
  validateBundleName(name);
  const snap = snapshotBundle(name);
  // Push reads every plaintext value and uploads the (client-side-encrypted)
  // bundle off-machine — the most sensitive read there is. It bypasses
  // readAndResolveBundleEnv, so audit it explicitly. Values never enter the
  // payload; only the bundle name and how many keys were read.
  emit('secrets.get', {
    module: 'secrets',
    bundle: name,
    operation: 'sync push',
    source: 'sync-push',
    status: 'success',
    keyCount: Object.keys(snap.secrets).length,
  });
  const envelope = encryptBlob(JSON.stringify(snap), opts.passphrase);
  const updated_at = new Date().toISOString();
  const payload: SyncEnvelope = { envelope, updated_at };
  await backend.putEnvelope(name, payload);
  return { updated_at };
}

/** Options for pullBundle. */
export interface PullOptions {
  passphrase: string;
  /** When true, overwrite an existing local bundle. */
  force?: boolean;
}

/** Pull a bundle by name from the remote and materialize it locally. */
export async function pullBundle(name: string, opts: PullOptions): Promise<SecretsBundle> {
  validateBundleName(name);
  const data = await backend.getEnvelope(name);
  if (!data) {
    throw new Error(`Remote bundle '${name}' not found.`);
  }
  const plaintext = decryptBlob(data.envelope, opts.passphrase);
  const snap = JSON.parse(plaintext) as BundleSnapshot;
  if (!snap || !snap.bundle || snap.bundle.name !== name) {
    throw new Error(`Decrypted payload for '${name}' is malformed (bundle name mismatch).`);
  }
  // existence check is the caller's responsibility; we trust opts.force.
  if (!opts.force) {
    const { bundleExists } = await import('./bundles.js');
    if (bundleExists(name)) {
      throw new Error(`Local bundle '${name}' already exists. Re-run with --force to overwrite.`);
    }
  }
  restoreSnapshot(snap);
  return snap.bundle;
}

/** Delete a bundle on the remote. */
export async function deleteRemoteBundle(name: string): Promise<boolean> {
  validateBundleName(name);
  return backend.deleteEnvelope(name);
}

/** List bundles currently stored on the remote for this user. */
export async function listRemoteBundles(): Promise<RemoteBundleSummary[]> {
  return backend.listEnvelopes();
}
