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

function restoreSnapshot(snap: BundleSnapshot): void {
  const bundle = snap.bundle;
  validateBundleName(bundle.name);
  for (const [shortId, value] of Object.entries(snap.secrets)) {
    const item = secretsKeychainItem(bundle.name, shortId);
    setKeychainToken(item, value);
  }
  writeBundle(bundle);
}

/** Options for pushBundle. */
export interface PushOptions {
  passphrase: string;
}

/** Push a local bundle to the remote. Encrypts client-side; the backend only sees ciphertext. */
export async function pushBundle(name: string, opts: PushOptions): Promise<{ updated_at: string }> {
  validateBundleName(name);
  const snap = snapshotBundle(name);
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
