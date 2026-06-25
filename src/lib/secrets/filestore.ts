/**
 * Passphrase-encrypted file store for secrets — platform-neutral.
 *
 * An AES-256-GCM encrypted-file store under `~/.agents/.cache/secrets/`. The
 * encryption key is scrypt-derived from a passphrase read from
 * `AGENTS_SECRETS_PASSPHRASE` (preferred), a machine-local provisioned key, or
 * a TTY prompt. One `<item>.enc` JSON file per item, mode 0600.
 *
 * Two callers:
 *  - Linux (src/lib/secrets/linux.ts): the headless fallback when the default
 *    Secret Service collection is locked. Auto-provisions a machine-local
 *    passphrase so `agents secrets` works out of the box on a server.
 *  - macOS file-backed bundles (src/lib/secrets/bundles.ts): an explicit,
 *    opt-in non-biometry backend for headless/remote release runs. The bundle
 *    layer guards this path so it only activates with an explicit
 *    AGENTS_SECRETS_PASSPHRASE (or TTY) — never the silent machine-local
 *    auto-provision — so a remote box holds ciphertext only.
 *
 * The item-name scheme is shared with the keychain backend so a file-backed
 * item and its keychain twin carry identical names:
 *   `agents-cli.bundles.<name>` and `agents-cli.secrets.<bundle>.<key>`.
 */

import { execSync } from 'child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KeychainBackend } from './index.js';

// ---------- file store location ----------

let fileDirOverride: string | null = null;
let cachedPassphrase: string | null = null;
let warnedAutoPassphrase = false;

export function fileDir(): string {
  return fileDirOverride ?? path.join(os.homedir(), '.agents', '.cache', 'secrets');
}

function ensureFileDir(): void {
  fs.mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
}

// ---------- passphrase ----------

function readPassphraseFromTty(): string {
  const fd = fs.openSync('/dev/tty', 'r+');
  let echoDisabled = false;
  try {
    fs.writeSync(fd, 'Enter AGENTS_SECRETS_PASSPHRASE: ');
    try {
      execSync('stty -echo < /dev/tty', { stdio: 'ignore' });
      echoDisabled = true;
    } catch {
      // stty not available — fall through; passphrase will echo. Better
      // than refusing to function.
    }
    let pass = '';
    const buf = Buffer.alloc(1);
    while (true) {
      const n = fs.readSync(fd, buf, 0, 1, null);
      if (n === 0) break;
      const ch = buf.toString('utf8', 0, n);
      if (ch === '\n' || ch === '\r') break;
      pass += ch;
    }
    return pass;
  } finally {
    if (echoDisabled) {
      try { execSync('stty echo < /dev/tty', { stdio: 'ignore' }); } catch { /* best effort */ }
    }
    try { fs.writeSync(fd, '\n'); } catch { /* best effort */ }
    fs.closeSync(fd);
  }
}

/** Path of the auto-provisioned machine-local passphrase. Lives alongside the
 *  encrypted items but is never itself an item (no `.enc` suffix, so it's
 *  excluded from list/has/get and from fileFallbackPreviouslyActivated). */
function passphraseFilePath(): string {
  return path.join(fileDir(), '.passphrase');
}

/** True if a machine-local passphrase has already been provisioned. */
export function machinePassphraseExists(): boolean {
  try {
    return fs.readFileSync(passphraseFilePath(), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function readMachinePassphrase(): string | null {
  try {
    const p = fs.readFileSync(passphraseFilePath(), 'utf8').trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
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

  ensureFileDir();
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
 * (interactive) TTY prompt > (headless) auto-provisioned machine-local key.
 *
 * `allowAutoProvision` (default true, used by the Linux fallback) controls the
 * last two steps. macOS file-backed bundles pass `false` so a missing
 * passphrase is a hard, explicit error instead of a silently provisioned
 * on-disk key — the caller (bundles.ts) guards this before we get here.
 */
export function getPassphrase(opts: { allowAutoProvision?: boolean } = {}): string {
  const allowAutoProvision = opts.allowAutoProvision ?? true;
  if (cachedPassphrase !== null) return cachedPassphrase;
  const env = process.env.AGENTS_SECRETS_PASSPHRASE;
  if (env && env.length > 0) {
    cachedPassphrase = env;
    return env;
  }
  // A previously-provisioned machine-local passphrase is this machine's stable
  // file-store key — prefer it for both interactive and headless runs so they
  // always agree (a TTY run won't re-prompt once the file exists).
  const onDisk = readMachinePassphrase();
  if (onDisk) {
    cachedPassphrase = onDisk;
    return onDisk;
  }
  if (!allowAutoProvision) {
    throw new Error(
      'AGENTS_SECRETS_PASSPHRASE is not set. A passphrase is required to decrypt ' +
      'this file-backed secret store.'
    );
  }
  // First run, no env, no provisioned key: prompt when interactive, otherwise
  // (headless — the reported bug) auto-provision instead of hard-failing.
  if (process.stdin.isTTY) {
    const p = readPassphraseFromTty();
    if (!p) throw new Error('No passphrase entered.');
    cachedPassphrase = p;
    return p;
  }
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

function fileGet(item: string, opts: { allowAutoProvision?: boolean } = {}): string {
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
    return decryptForFallback(parsed, getPassphrase(opts));
  } catch {
    throw new Error(
      `Failed to decrypt '${item}'. Wrong AGENTS_SECRETS_PASSPHRASE or tampered file.`
    );
  }
}

function fileSet(item: string, value: string, opts: { allowAutoProvision?: boolean } = {}): void {
  ensureFileDir();
  const enc = encryptForFallback(value, getPassphrase(opts));
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

/** Test-only: reset module state (file dir + cached passphrase). */
export function _resetFileStoreForTest(opts: {
  fileDir?: string | null;
  passphrase?: string | null;
} = {}): void {
  fileDirOverride = opts.fileDir ?? null;
  cachedPassphrase = opts.passphrase ?? null;
  warnedAutoPassphrase = false;
}
