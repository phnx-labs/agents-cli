/**
 * Passphrase-encrypted file store for secrets — platform-neutral.
 *
 * An AES-256-GCM encrypted-file store under `~/.agents/.cache/secrets/`. The
 * encryption key is scrypt-derived from a passphrase read from
 * `AGENTS_SECRETS_PASSPHRASE` (preferred) or a machine-local key the store
 * auto-provisions on first use. One `<item>.enc` JSON file per item, mode 0600.
 *
 * Two callers, one policy: the store silently auto-provisions a stable
 * machine-local key (a 0600 file under `~/.agents/.secrets-key/`) on EVERY
 * platform, so it works out of the box with no passphrase to set or remember and
 * never pops a prompt or Touch ID sheet.
 *  - Linux (src/lib/secrets/linux.ts): the headless fallback when the default
 *    Secret Service collection is locked.
 *  - macOS/Windows file-backed bundles (src/lib/secrets/bundles.ts): an explicit,
 *    opt-in non-biometry backend for headless/remote runs.
 * Set AGENTS_SECRETS_PASSPHRASE to opt into a key held off disk instead (e.g. to
 * share one bundle's ciphertext across boxes under a common key).
 *
 * The item-name scheme is shared with the keychain backend so a file-backed
 * item and its keychain twin carry identical names:
 *   `agents-cli.bundles.<name>` and `agents-cli.secrets.<bundle>.<key>`.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KeychainBackend } from './index.js';

// ---------- file store location ----------

let fileDirOverride: string | null = null;
let passphraseDirOverride: string | null = null;
let cachedPassphrase: string | null = null;
let warnedAutoPassphrase = false;

export function fileDir(): string {
  return fileDirOverride ?? path.join(os.homedir(), '.agents', '.cache', 'secrets');
}

function ensureFileDir(): void {
  fs.mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
}

// ---------- passphrase ----------


/**
 * Directory for the auto-provisioned machine-local passphrase. Kept outside
 * `fileDir()` so a scan of the encrypted store never co-locates key + ciphertext.
 */
function passphraseDir(): string {
  return passphraseDirOverride ?? path.join(os.homedir(), '.agents', '.secrets-key');
}

function ensurePassphraseDir(): void {
  fs.mkdirSync(passphraseDir(), { recursive: true, mode: 0o700 });
}

/** Path of the auto-provisioned machine-local passphrase (not an `.enc` item). */
function passphraseFilePath(): string {
  return path.join(passphraseDir(), 'passphrase');
}

/** Legacy co-located path — read-only for machines provisioned before #479. */
function legacyPassphraseFilePath(): string {
  return path.join(fileDir(), '.passphrase');
}

/** True if a machine-local passphrase has already been provisioned. */
export function machinePassphraseExists(): boolean {
  return readMachinePassphrase() !== null;
}

function readMachinePassphrase(): string | null {
  for (const fp of [passphraseFilePath(), legacyPassphraseFilePath()]) {
    try {
      const p = fs.readFileSync(fp, 'utf8').trim();
      if (p.length > 0) return p;
    } catch {
      // try next location
    }
  }
  return null;
}

/**
 * Provision (or read back) a stable machine-local passphrase for the encrypted
 * file store, so `agents secrets` works out of the box on a headless box where
 * the keyring is locked and no AGENTS_SECRETS_PASSPHRASE is set.
 *
 * Security model: this is encryption-at-rest with the key held in a 0600 file —
 * the same posture as an SSH private key, and identical to the common
 * "export AGENTS_SECRETS_PASSPHRASE=… in ~/.zshenv (chmod 600)" workaround. The
 * keyring (key in a daemon's locked memory) is stronger but is unavailable
 * without a graphical/unlocked session. For an off-disk key, set
 * AGENTS_SECRETS_PASSPHRASE (it always takes precedence) or unlock the keyring.
 */
function provisionMachinePassphrase(): string {
  const existing = readMachinePassphrase();
  if (existing) return existing;

  ensurePassphraseDir();
  const generated = randomBytes(32).toString('base64');
  const fp = passphraseFilePath();
  try {
    // wx: fail if a concurrent process created it first (then we read theirs).
    fs.writeFileSync(fp, generated, { mode: 0o600, flag: 'wx' });
  } catch {
    const raced = readMachinePassphrase();
    if (raced) return raced;
    throw new Error(`Failed to provision machine-local passphrase at ${fp}.`);
  }
  if (!warnedAutoPassphrase) {
    warnedAutoPassphrase = true;
    process.stderr.write(
      `[agents] keyring locked and no AGENTS_SECRETS_PASSPHRASE set; provisioned a ` +
      `machine-local passphrase at ${fp} (mode 0600). Set AGENTS_SECRETS_PASSPHRASE ` +
      `for a key held off disk.\n`
    );
  }
  return generated;
}

/**
 * Resolve the passphrase for the encrypted file store.
 *
 * Order: AGENTS_SECRETS_PASSPHRASE > previously-provisioned machine-local key >
 * a freshly auto-provisioned machine-local key. It NEVER prompts and NEVER
 * hard-fails — the file store must work on every platform (macOS included)
 * without the user setting, typing, or remembering a passphrase. Provisioning
 * writes a 0600 key file (encryption-at-rest, same posture as an SSH key); set
 * AGENTS_SECRETS_PASSPHRASE to opt into an off-disk key.
 */
export function getPassphrase(): string {
  if (cachedPassphrase !== null) return cachedPassphrase;
  const env = process.env.AGENTS_SECRETS_PASSPHRASE;
  if (env && env.length > 0) {
    cachedPassphrase = env;
    return env;
  }
  // A previously-provisioned machine-local passphrase is this machine's stable
  // file-store key — prefer it so interactive and headless runs always agree.
  const onDisk = readMachinePassphrase();
  if (onDisk) {
    cachedPassphrase = onDisk;
    return onDisk;
  }
  // No env passphrase and no machine-local key yet: silently provision a stable
  // machine-local key (a 0600 file) on EVERY platform, macOS included. This is
  // encryption-at-rest with an on-disk key — the same posture as an SSH private
  // key — so the file store "just works" without the user ever setting, typing,
  // or remembering a passphrase, and never pops a prompt or a Touch ID sheet.
  // Set AGENTS_SECRETS_PASSPHRASE to opt into an off-disk key instead.
  cachedPassphrase = provisionMachinePassphrase();
  return cachedPassphrase;
}

// ---------- AES-256-GCM ----------

/** Encrypted-file on-disk shape. Exported for tests. */
export interface EncFile {
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

/** Encrypt plaintext under a passphrase using AES-256-GCM with a random
 *  scrypt salt and a random 96-bit IV. Exported for tests. */
export function encryptForFallback(plaintext: string, passphrase: string): EncFile {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/** Decrypt an EncFile under a passphrase. Throws on wrong key or tampered
 *  ciphertext (auth-tag mismatch). Exported for tests. */
export function decryptForFallback(enc: EncFile, passphrase: string): string {
  const salt = Buffer.from(enc.salt, 'hex');
  const iv = Buffer.from(enc.iv, 'hex');
  const authTag = Buffer.from(enc.authTag, 'hex');
  const ciphertext = Buffer.from(enc.ciphertext, 'hex');
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// ---------- file backend ----------

function fileFor(item: string): string {
  return path.join(fileDir(), `${item}.enc`);
}

function fileHas(item: string): boolean {
  return fs.existsSync(fileFor(item));
}

function fileGet(item: string): string {
  const fp = fileFor(item);
  if (!fs.existsSync(fp)) {
    throw new Error(`Secret '${item}' not found in encrypted store.`);
  }
  const raw = fs.readFileSync(fp, 'utf8');
  let parsed: EncFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Encrypted secret file ${fp} is corrupt (not valid JSON).`);
  }
  try {
    return decryptForFallback(parsed, getPassphrase());
  } catch {
    throw new Error(
      `Failed to decrypt '${item}'. Wrong AGENTS_SECRETS_PASSPHRASE or tampered file.`
    );
  }
}

function fileSet(item: string, value: string): void {
  ensureFileDir();
  const enc = encryptForFallback(value, getPassphrase());
  fs.writeFileSync(fileFor(item), JSON.stringify(enc), { mode: 0o600 });
}

function fileDelete(item: string): boolean {
  const fp = fileFor(item);
  if (!fs.existsSync(fp)) return true; // idempotent, matches secret-tool clear
  fs.unlinkSync(fp);
  return true;
}

function fileList(prefix: string): string[] {
  const dir = fileDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.slice(0, -'.enc'.length))
    .filter((name) => name.startsWith(prefix));
}

/** True if the fallback dir has any committed encrypted items. */
export function fileStoreHasItems(): boolean {
  try {
    return fs.readdirSync(fileDir()).some((e) => e.endsWith('.enc'));
  } catch {
    return false;
  }
}

/** Low-level file-store ops, exported so callers (linux fallback, macOS
 *  file-backed bundles) can opt into or out of passphrase auto-provision. */
export const fileStore = {
  has: fileHas,
  get: fileGet,
  set: fileSet,
  delete: fileDelete,
  list: fileList,
};

/** File-only KeychainBackend (exported for tests; the Linux backend uses these
 *  ops with auto-provision allowed). */
export const fileBackend: KeychainBackend = {
  has: fileHas,
  get: (item: string) => fileGet(item),
  set: (item: string, value: string) => fileSet(item, value),
  delete: fileDelete,
  list: fileList,
};

/** Resolved passphrase directory (exported for integration tests). */
export function resolvePassphraseDir(): string {
  return passphraseDir();
}

/** Test-only: reset module state (file dir + cached passphrase). */
export function _resetFileStoreForTest(opts: {
  fileDir?: string | null;
  passphraseDir?: string | null;
  passphrase?: string | null;
} = {}): void {
  fileDirOverride = opts.fileDir ?? null;
  if (opts.passphraseDir !== undefined) {
    passphraseDirOverride = opts.passphraseDir;
  } else if (opts.fileDir) {
    // Hermetic sibling when only the store dir is overridden (linux.test.ts).
    passphraseDirOverride = path.resolve(opts.fileDir, '..', `${path.basename(opts.fileDir)}-key`);
  } else {
    passphraseDirOverride = null;
  }
  cachedPassphrase = opts.passphrase ?? null;
  warnedAutoPassphrase = false;
}
