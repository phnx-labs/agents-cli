/**
 * Linux secret storage via libsecret (GNOME Keyring / Secret Service API).
 *
 * Primary backend: `secret-tool` CLI (libsecret-tools package).
 *
 * Headless fallback: when the default Secret Service collection is locked
 * (common on server-class Linux — no graphical login means the keyring
 * passphrase never enters the daemon, so `secret-tool store` fails with
 * "Cannot create an item in a locked collection"), we transparently switch
 * to a file-based AES-256-GCM encrypted store under
 * `~/.agents/.cache/secrets/`. The encryption key is scrypt-derived from a
 * passphrase read from `AGENTS_SECRETS_PASSPHRASE` (preferred) or a TTY
 * prompt. The decision is cached per process; one stderr line is emitted
 * the first time the fallback activates.
 *
 * Secrets stored via secret-tool use:
 *   service = "agents-cli"
 *   account = username
 *   item    = the secret identifier
 *
 * File-fallback layout: one `<item>.enc` JSON file per item, mode 0600.
 */

import { spawnSync, execSync } from 'child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { KeychainBackend } from './index.js';

const SERVICE = 'agents-cli';

// ---------- secret-tool availability ----------

function secretToolAvailable(): boolean {
  const result = spawnSync('which', ['secret-tool'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

let checkedAvailability = false;
let isAvailable = false;

// ---------- file fallback state ----------

let useFileFallback = false;
let warnedFallback = false;
let fileDirOverride: string | null = null;
let cachedPassphrase: string | null = null;

function fileDir(): string {
  return fileDirOverride ?? path.join(os.homedir(), '.agents', '.cache', 'secrets');
}

function activateFileFallback(): void {
  if (useFileFallback) return;
  useFileFallback = true;
  if (!warnedFallback) {
    warnedFallback = true;
    process.stderr.write(
      `[agents] secret-service collection locked, using file-based store at ${fileDir()}\n`
    );
  }
}

function isLockedCollectionError(stderr: string): boolean {
  return /locked collection/i.test(stderr) ||
         /Prompt was dismissed/i.test(stderr);
}

/** True if the fallback dir has any committed encrypted items. Means an
 *  earlier process (this one or another) already routed writes to the file
 *  store, so this process must keep reading/writing from the same store —
 *  otherwise `list` / `get` / `has` would silently miss them. */
function fileFallbackPreviouslyActivated(): boolean {
  try {
    return fs.readdirSync(fileDir()).some((e) => e.endsWith('.enc'));
  } catch {
    return false;
  }
}

/**
 * Decide which backend a given op should use. Activates file fallback if
 * `secret-tool` is missing and `AGENTS_SECRETS_PASSPHRASE` is set, OR if a
 * previous run already committed to the file fallback (encrypted items on
 * disk). The latter check is what makes the fallback persistent across the
 * many short-lived `agents secrets ...` Node processes a user invokes.
 */
function preflight(): 'file' | 'secret-tool' {
  if (useFileFallback) return 'file';
  if (fileFallbackPreviouslyActivated()) {
    activateFileFallback();
    return 'file';
  }
  if (!checkedAvailability) {
    isAvailable = secretToolAvailable();
    checkedAvailability = true;
  }
  if (!isAvailable) {
    if (process.env.AGENTS_SECRETS_PASSPHRASE) {
      activateFileFallback();
      return 'file';
    }
    throw new Error(
      'secret-tool not found. Install libsecret-tools:\n' +
      '  Ubuntu/Debian: sudo apt install libsecret-tools\n' +
      '  Fedora: sudo dnf install libsecret\n' +
      '  Arch: sudo pacman -S libsecret\n' +
      '\n' +
      'Alternative: set AGENTS_SECRETS_PASSPHRASE to use the encrypted-file fallback.'
    );
  }
  return 'secret-tool';
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

function getPassphrase(): string {
  if (cachedPassphrase !== null) return cachedPassphrase;
  const env = process.env.AGENTS_SECRETS_PASSPHRASE;
  if (env && env.length > 0) {
    cachedPassphrase = env;
    return env;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      'Secret-service collection is locked and no AGENTS_SECRETS_PASSPHRASE is set.\n' +
      'Set AGENTS_SECRETS_PASSPHRASE in your environment to use the encrypted-file fallback,\n' +
      'or unlock the keyring (e.g. configure pam_gnome_keyring for SSH login).'
    );
  }
  const p = readPassphraseFromTty();
  if (!p) throw new Error('No passphrase entered.');
  cachedPassphrase = p;
  return p;
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

function ensureFileDir(): void {
  fs.mkdirSync(fileDir(), { recursive: true, mode: 0o700 });
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

/** File-only KeychainBackend (exported for tests; the public surface uses
 *  the secret-tool-with-fallback `linuxBackend` below). */
export const fileBackend: KeychainBackend = {
  has: fileHas,
  get: fileGet,
  set: fileSet,
  delete: fileDelete,
  list: fileList,
};

// ---------- secret-tool ops with fallback ----------

/** secret-tool lookup attributes:
 *   service=agents-cli account=<user> item=<itemName> */
export function hasSecretToolToken(item: string): boolean {
  if (preflight() === 'file') return fileHas(item);
  const user = os.userInfo().username;
  const result = spawnSync('secret-tool', [
    'lookup',
    'service', SERVICE,
    'account', user,
    'item', item,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) {
    return result.stdout?.toString().trim().length > 0;
  }
  const stderr = result.stderr?.toString() ?? '';
  if (isLockedCollectionError(stderr)) {
    activateFileFallback();
    return fileHas(item);
  }
  return false;
}

export function getSecretToolToken(item: string): string {
  if (preflight() === 'file') return fileGet(item);
  const user = os.userInfo().username;
  const result = spawnSync('secret-tool', [
    'lookup',
    'service', SERVICE,
    'account', user,
    'item', item,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) {
    const token = result.stdout?.toString().trim();
    if (!token) throw new Error(`Secret '${item}' exists but is empty.`);
    return token;
  }
  const stderr = result.stderr?.toString() ?? '';
  if (isLockedCollectionError(stderr)) {
    activateFileFallback();
    return fileGet(item);
  }
  throw new Error(`Secret '${item}' not found in keyring.`);
}

export function setSecretToolToken(item: string, value: string): void {
  if (!value || !value.trim()) throw new Error('Secret value is empty.');
  if (preflight() === 'file') return fileSet(item, value);

  const user = os.userInfo().username;
  const label = `agents-cli: ${item}`;

  const result = spawnSync('secret-tool', [
    'store',
    '--label', label,
    'service', SERVICE,
    'account', user,
    'item', item,
  ], { input: value, stdio: ['pipe', 'pipe', 'pipe'] });

  if (result.status === 0) return;

  const stderr = result.stderr?.toString().trim() ?? '';
  if (isLockedCollectionError(stderr)) {
    activateFileFallback();
    fileSet(item, value);
    return;
  }
  throw new Error(
    `Failed to store secret '${item}': ${stderr || 'unknown error'}\n` +
    'Make sure GNOME Keyring or another Secret Service provider is running,\n' +
    'or set AGENTS_SECRETS_PASSPHRASE to use the encrypted-file fallback.'
  );
}

export function deleteSecretToolToken(item: string): boolean {
  if (preflight() === 'file') return fileDelete(item);
  const user = os.userInfo().username;
  const result = spawnSync('secret-tool', [
    'clear',
    'service', SERVICE,
    'account', user,
    'item', item,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) return true;
  const stderr = result.stderr?.toString() ?? '';
  if (isLockedCollectionError(stderr)) {
    activateFileFallback();
    return fileDelete(item);
  }
  // secret-tool clear returns 0 whether the item existed or not.
  // A non-zero exit that isn't a locked-collection error is a real failure;
  // surface that rather than silently swallowing.
  return false;
}

/**
 * Parse the item names out of `secret-tool search --all` output, keeping only
 * those starting with `prefix`. Exported for tests.
 *
 * `output` must be the combined stdout+stderr of the search: libsecret splits
 * the dump across both streams — the value/label/schema lines go to stdout
 * while the `attribute.*` lines (which carry `attribute.item`, the only place
 * the item name is reliably machine-readable) go to stderr (observed on
 * libsecret 0.21.4). Which stream each line lands on has varied across
 * libsecret versions, so callers concatenate both rather than bet on one.
 */
export function parseSecretToolItems(output: string, prefix: string): string[] {
  const items: string[] = [];
  // Parse output format:
  // [/org/freedesktop/secrets/collection/login/1]
  // label = agents-cli: myitem
  // ...
  // attribute.item = myitem
  const itemRegex = /attribute\.item\s*=\s*(.+)/g;
  let match;
  while ((match = itemRegex.exec(output)) !== null) {
    const itemName = match[1].trim();
    if (itemName.startsWith(prefix)) {
      items.push(itemName);
    }
  }
  return [...new Set(items)]; // dedupe
}

/**
 * List secrets by prefix. secret-tool doesn't have a list command,
 * so we use secret-tool search which outputs in a specific format.
 */
export function listSecretToolItems(prefix: string): string[] {
  if (preflight() === 'file') return fileList(prefix);
  const result = spawnSync('secret-tool', [
    'search',
    '--all',
    'service', SERVICE,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    if (isLockedCollectionError(stderr)) {
      activateFileFallback();
      return fileList(prefix);
    }
    return [];
  }

  const output = `${result.stdout?.toString() || ''}\n${result.stderr?.toString() || ''}`;
  return parseSecretToolItems(output, prefix);
}

/** KeychainBackend implementation for Linux. Routes through secret-tool
 *  with a transparent encrypted-file fallback when the default Secret
 *  Service collection is locked (or libsecret-tools is not installed but
 *  AGENTS_SECRETS_PASSPHRASE is set). */
export const linuxBackend: KeychainBackend = {
  has(item: string): boolean {
    return hasSecretToolToken(item);
  },
  get(item: string): string {
    return getSecretToolToken(item);
  },
  set(item: string, value: string): void {
    setSecretToolToken(item, value);
  },
  delete(item: string): boolean {
    return deleteSecretToolToken(item);
  },
  list(prefix: string): string[] {
    return listSecretToolItems(prefix);
  },
};

/** Test-only: reset module state so independent test cases don't bleed
 *  passphrase / fallback decisions across each other. */
export function _resetForTest(opts: {
  fileDir?: string | null;
  forceFileFallback?: boolean;
  passphrase?: string | null;
} = {}): void {
  fileDirOverride = opts.fileDir ?? null;
  useFileFallback = opts.forceFileFallback ?? false;
  warnedFallback = false;
  cachedPassphrase = opts.passphrase ?? null;
  checkedAvailability = false;
  isAvailable = false;
}
