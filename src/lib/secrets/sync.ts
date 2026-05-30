/**
 * Remote sync client for secrets bundles.
 *
 * Replaces the previous "leave it to iCloud Keychain" model with explicit
 * push/pull against api.prix.dev. Bundle contents (vars + secret values) are
 * encrypted client-side with AES-256-GCM under a key derived from a
 * user-supplied passphrase via PBKDF2-SHA256. Plaintext never leaves the
 * machine — api.prix.dev only ever sees the ciphertext + KDF parameters.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
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

const PROXY_BASE = 'https://api.prix.dev';
const USER_YAML = path.join(os.homedir(), '.rush', 'user.yaml');
const BUNDLE_ENDPOINT = '/api/v1/secrets/bundles';

// PBKDF2 cost. 600k SHA-256 iters matches OWASP 2023+ guidance and keeps a
// passphrase prompt under a second on the hardware the CLI targets.
const PBKDF2_ITER = 600_000;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

/** Envelope for an encrypted bundle. All byte fields are base64. */
export interface EncryptedEnvelope {
  v: 1;
  kdf: 'pbkdf2-sha256';
  iter: number;
  salt: string;
  iv: string;
  ct: string;
  tag: string;
}

interface PushPayload {
  envelope: EncryptedEnvelope;
  updated_at: string;
}

interface RemoteBundleSummary {
  name: string;
  updated_at: string;
}

interface RushUserYaml {
  session?: {
    access_token?: string;
  };
}

function readRushToken(): string {
  if (!fs.existsSync(USER_YAML)) {
    throw new Error('Not logged in to Rush. Run `rush login` first.');
  }
  const raw = fs.readFileSync(USER_YAML, 'utf-8');
  const data = yaml.parse(raw) as RushUserYaml;
  const token = data?.session?.access_token;
  if (!token) {
    throw new Error('No session token in ~/.rush/user.yaml. Run `rush login` first.');
  }
  return token;
}

async function api(method: string, endpoint: string, body?: unknown): Promise<Response> {
  const token = readRushToken();
  const url = endpoint.startsWith('http') ? endpoint : `${PROXY_BASE}${endpoint}`;
  return fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
}

/** Encrypt a JSON-serializable payload with a passphrase. */
export function encryptBlob(plaintext: string, passphrase: string): EncryptedEnvelope {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.');
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

/** Push a local bundle to api.prix.dev. Encrypts client-side; server only sees ciphertext. */
export async function pushBundle(name: string, opts: PushOptions): Promise<{ updated_at: string }> {
  validateBundleName(name);
  const snap = snapshotBundle(name);
  const envelope = encryptBlob(JSON.stringify(snap), opts.passphrase);
  const updated_at = new Date().toISOString();
  const payload: PushPayload = { envelope, updated_at };
  const res = await api('PUT', `${BUNDLE_ENDPOINT}/${encodeURIComponent(name)}`, payload);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Push failed (${res.status} ${res.statusText}): ${body}`);
  }
  return { updated_at };
}

/** Options for pullBundle. */
export interface PullOptions {
  passphrase: string;
  /** When true, overwrite an existing local bundle. */
  force?: boolean;
}

/** Pull a bundle by name from api.prix.dev and materialize it locally. */
export async function pullBundle(name: string, opts: PullOptions): Promise<SecretsBundle> {
  validateBundleName(name);
  const res = await api('GET', `${BUNDLE_ENDPOINT}/${encodeURIComponent(name)}`);
  if (res.status === 404) {
    throw new Error(`Remote bundle '${name}' not found on api.prix.dev.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Pull failed (${res.status} ${res.statusText}): ${body}`);
  }
  const data = await res.json() as PushPayload;
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
  const res = await api('DELETE', `${BUNDLE_ENDPOINT}/${encodeURIComponent(name)}`);
  if (res.status === 404) return false;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Delete failed (${res.status} ${res.statusText}): ${body}`);
  }
  return true;
}

/** List bundles currently stored on api.prix.dev for this user. */
export async function listRemoteBundles(): Promise<RemoteBundleSummary[]> {
  const res = await api('GET', BUNDLE_ENDPOINT);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`List failed (${res.status} ${res.statusText}): ${body}`);
  }
  const data = await res.json() as { bundles?: RemoteBundleSummary[] };
  return data.bundles ?? [];
}
