/**
 * Linux secret storage via libsecret (GNOME Keyring / Secret Service API).
 *
 * Primary backend: `secret-tool` CLI (libsecret-tools package).
 *
 * Headless fallback: when the default Secret Service collection is locked
 * (common on server-class Linux — no graphical login means the keyring
 * passphrase never enters the daemon, so `secret-tool store` fails with
 * "Cannot create an item in a locked collection"), we transparently switch
 * to the AES-256-GCM encrypted-file store in ./filestore.ts. The decision is
 * cached per process; one stderr line is emitted the first time the fallback
 * activates.
 *
 * Secrets stored via secret-tool use:
 *   service = "agents-cli"
 *   account = username
 *   item    = the secret identifier
 */

import { spawnSync } from 'child_process';
import * as os from 'os';
import type { KeychainBackend } from './index.js';
import {
  fileStore,
  fileDir,
  fileStoreHasItems,
  machinePassphraseExists,
  _resetFileStoreForTest,
} from './filestore.js';

// Re-exported so existing importers (and tests) can keep reaching these via
// './linux.js'. The implementations live in ./filestore.ts.
export {
  encryptForFallback,
  decryptForFallback,
  fileBackend,
  type EncFile,
} from './filestore.js';

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

/**
 * Decide which backend a given op should use. Activates file fallback if
 * `secret-tool` is missing and `AGENTS_SECRETS_PASSPHRASE` is set, OR if a
 * previous run already committed to the file fallback (encrypted items on
 * disk). The latter check is what makes the fallback persistent across the
 * many short-lived `agents secrets ...` Node processes a user invokes.
 */
function preflight(): 'file' | 'secret-tool' {
  if (useFileFallback) return 'file';
  if (fileStoreHasItems()) {
    activateFileFallback();
    return 'file';
  }
  if (!checkedAvailability) {
    isAvailable = secretToolAvailable();
    checkedAvailability = true;
  }
  if (!isAvailable) {
    // No secret-tool. Route to the encrypted-file fallback whenever a passphrase
    // source exists or can be auto-provisioned: an explicit
    // AGENTS_SECRETS_PASSPHRASE, an already-provisioned machine-local passphrase,
    // or a headless context (no TTY) where getPassphrase() auto-provisions one.
    // Only an INTERACTIVE session with none of these gets the install hint —
    // installing libsecret is the better fix when someone is at the keyboard.
    if (process.env.AGENTS_SECRETS_PASSPHRASE || machinePassphraseExists() || !process.stdin.isTTY) {
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

/**
 * True when secret operations currently route to the encrypted-file store
 * instead of the Secret Service (the headless / locked-collection fallback).
 *
 * Runs the same `preflight()` decision every read and write uses, so it can't
 * drift from where bytes actually land. `preflight()` throws only in the
 * interactive / no-secret-tool / no-passphrase case — where nothing is stored
 * — so treat that as "not on the file path".
 *
 * `listBundles()` needs this: under the fallback the keychain enumeration
 * (`linuxBackend.list`) and the file enumeration read the SAME store, so
 * without this signal every file-backed bundle would be listed twice.
 */
export function usesFileFallback(): boolean {
  try {
    return preflight() === 'file';
  } catch {
    return false;
  }
}

// ---------- secret-tool ops with fallback ----------

/** secret-tool lookup attributes:
 *   service=agents-cli account=<user> item=<itemName> */
export function hasSecretToolToken(item: string): boolean {
  if (preflight() === 'file') return fileStore.has(item);
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
    return fileStore.has(item);
  }
  return false;
}

export function getSecretToolToken(item: string): string {
  if (preflight() === 'file') return fileStore.get(item);
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
    return fileStore.get(item);
  }
  throw new Error(`Secret '${item}' not found in keyring.`);
}

export function setSecretToolToken(item: string, value: string): void {
  if (!value || !value.trim()) throw new Error('Secret value is empty.');
  if (preflight() === 'file') return fileStore.set(item, value);

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
    fileStore.set(item, value);
    return;
  }
  throw new Error(
    `Failed to store secret '${item}': ${stderr || 'unknown error'}\n` +
    'Make sure GNOME Keyring or another Secret Service provider is running,\n' +
    'or set AGENTS_SECRETS_PASSPHRASE to use the encrypted-file fallback.'
  );
}

export function deleteSecretToolToken(item: string): boolean {
  if (preflight() === 'file') return fileStore.delete(item);
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
    return fileStore.delete(item);
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
  if (preflight() === 'file') return fileStore.list(prefix);
  const result = spawnSync('secret-tool', [
    'search',
    '--all',
    'service', SERVICE,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    if (isLockedCollectionError(stderr)) {
      activateFileFallback();
      return fileStore.list(prefix);
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
 *  passphrase / fallback decisions across each other. File-store state (file
 *  dir + cached passphrase) lives in ./filestore.ts and is reset there. */
export function _resetForTest(opts: {
  fileDir?: string | null;
  forceFileFallback?: boolean;
  passphrase?: string | null;
} = {}): void {
  _resetFileStoreForTest({ fileDir: opts.fileDir ?? null, passphrase: opts.passphrase ?? null });
  useFileFallback = opts.forceFileFallback ?? false;
  warnedFallback = false;
  checkedAvailability = false;
  isAvailable = false;
}
