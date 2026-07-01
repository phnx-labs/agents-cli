/**
 * Cross-platform secure credential storage.
 *
 * macOS: every keychain operation goes through the signed `Agents CLI.app`
 * helper. The helper attaches a biometry-or-passcode access control to every
 * item it writes, so the OS itself gates decryption with Touch ID. A single
 * LAContext lives for the helper's process lifetime, so a batch read pops
 * Touch ID once and reuses the assertion for every item in the same batch.
 * No /usr/bin/security fast path: that path bypasses the helper's ACL,
 * exposes items to the legacy password sheet, and would defeat the model.
 *
 * Linux: libsecret (GNOME Keyring) via the `secret-tool` CLI. No biometry —
 * items are unlocked when the keyring is open.
 *
 * Windows: not supported.
 *
 * Items are device-local: the biometry access control requires the OS to
 * treat them as bound to this device, so cross-machine propagation goes
 * through the explicit export/import flow in src/lib/secrets/sync.ts
 * rather than the system's cloud-keychain path.
 */

import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linuxBackend, usesFileFallback as linuxUsesFileFallback } from './linux.js';
import { getKeychainHelperPath } from './install-helper.js';

const SERVICE_PREFIX = 'agents-cli';
const SECRETS_ITEM_PREFIX = `${SERVICE_PREFIX}.secrets.`;
const BUNDLES_ITEM_PREFIX = `${SERVICE_PREFIX}.bundles.`;

/** Supported secret resolution backends. */
export type SecretProvider = 'keychain' | 'env' | 'file' | 'exec';

/** A typed reference to a secret, consisting of a provider and a provider-specific value. */
export interface SecretRef {
  provider: SecretProvider;
  value: string;
}

const REF_PATTERN = /^(keychain|env|file|exec):(.+)$/s;

/**
 * A bundle value: either a string (literal or provider-prefixed ref) or
 * an object `{value: string}` used to escape a literal that would otherwise
 * be parsed as a ref (e.g. a URL that happens to start with 'env:').
 */
export type BundleValue = string | { value: string };

/** Parse a bundle value into either a literal string or a typed secret ref. */
export function parseBundleValue(raw: BundleValue): { literal: string } | { ref: SecretRef } {
  if (typeof raw === 'object' && raw !== null && typeof (raw as any).value === 'string') {
    return { literal: (raw as { value: string }).value };
  }
  if (typeof raw !== 'string') {
    throw new Error(`Invalid bundle value (expected string or {value: string}): ${JSON.stringify(raw)}`);
  }
  const match = REF_PATTERN.exec(raw);
  if (!match) return { literal: raw };
  return { ref: { provider: match[1] as SecretProvider, value: match[2] } };
}

/** Serialize a secret ref back to its `provider:value` string form. */
export function serializeRef(ref: SecretRef): string {
  return `${ref.provider}:${ref.value}`;
}

function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error(
      'agents secrets requires macOS Keychain or Linux libsecret.\n' +
      'Windows is not supported — use environment variables or a .env file instead.\n' +
      'WSL2 is supported (libsecret via gnome-keyring).'
    );
  }
}

function isLinux(): boolean {
  return process.platform === 'linux';
}

/** Build the keychain item name for a profile provider token. */
export function profileKeychainItem(provider: string): string {
  return `${SERVICE_PREFIX}.${provider}.token`;
}

/** Build the keychain item name for a secrets-bundle key. */
export function secretsKeychainItem(bundle: string, key: string): string {
  return `${SECRETS_ITEM_PREFIX}${bundle}.${key}`;
}

function keychainItemRequiresUserPresence(item: string): boolean {
  return item.startsWith(SECRETS_ITEM_PREFIX) || item.startsWith(BUNDLES_ITEM_PREFIX);
}

/**
 * Test seam: lets bundle storage tests swap the keychain backend for an
 * in-memory map without touching the user's real keychain. Mocking is
 * justified here because the alternative (touching real keychain in unit
 * tests) is destructive and would require an interactive Keychain unlock.
 */
export interface KeychainBackend {
  has(item: string): boolean;
  get(item: string): string;
  set(item: string, value: string): void;
  delete(item: string): boolean;
  list(prefix: string): string[];
}

let backend: KeychainBackend | null = null;

/** Install a custom keychain backend (test only). Returns the previous backend so callers can restore. */
export function setKeychainBackendForTest(b: KeychainBackend | null): KeychainBackend | null {
  const prev = backend;
  backend = b;
  return prev;
}

/**
 * Items whose name does NOT start with `agents-cli.` belong to another
 * application (e.g. Anthropic's `Claude Code-credentials-*`). Their ACL
 * trusts THEIR writer, not our signed helper, so routing them through our
 * helper produces a legacy password sheet. `/usr/bin/security` reads them
 * silently because it's in the default trusted-app list on most user-owned
 * keychain items. And we MUST NOT JIT-migrate them — the owning app
 * expects to re-write the item with its own ACL design.
 */
function isOurItem(item: string): boolean {
  return item.startsWith('agents-cli.');
}

/** Check if a keychain/keyring item exists. Never prompts for biometry. */
export function hasKeychainToken(item: string): boolean {
  if (backend) return backend.has(item);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.has(item);
  if (!isOurItem(item)) {
    return spawnSync('/usr/bin/security', ['find-generic-password', '-a', os.userInfo().username, '-s', item], {
      stdio: ['ignore', 'ignore', 'ignore'],
    }).status === 0;
  }
  const bin = getKeychainHelperPath();
  return spawnSync(bin, ['has', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;
}

/**
 * Retrieve a secret value from the keychain/keyring. Throws if not found.
 *
 * On macOS this triggers Touch ID (or reuses an assertion held by an earlier
 * call in the same process). For bundles, prefer getKeychainTokens() so a
 * single biometric prompt covers every key in the batch.
 */
export function getKeychainToken(item: string): string {
  if (backend) return backend.get(item);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.get(item);
  if (!isOurItem(item)) {
    const sec = spawnSync('/usr/bin/security', ['find-generic-password', '-a', os.userInfo().username, '-s', item, '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (sec.status === 0) {
      const token = sec.stdout?.toString().trim();
      if (token) return token;
    }
    throw new Error(`Keychain item '${item}' not found.`);
  }
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['get', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 1) throw new Error(`Keychain item '${item}' not found.`);
  if (result.status === 4) throw new Error(`Touch ID cancelled while reading '${item}'.`);
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to read keychain item '${item}'.`);
  }
  const token = result.stdout?.toString();
  if (!token) throw new Error(`Keychain item '${item}' exists but is empty.`);
  return token;
}

/**
 * Batch-read multiple keychain items behind a single Touch ID prompt. The
 * macOS helper holds one LAContext for its whole process: the first protected
 * item triggers Touch ID, every later item in the same invocation reuses the
 * assertion. Missing items are absent from the returned map (caller decides
 * whether that's an error).
 *
 * On Linux or when a test backend is installed, falls back to individual
 * lookups — no biometric prompt path on those platforms.
 */
export function getKeychainTokens(items: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (items.length === 0) return result;
  if (backend) {
    for (const item of items) {
      try { result.set(item, backend.get(item)); } catch { /* missing — skip */ }
    }
    return result;
  }
  assertSupportedPlatform();
  if (isLinux()) {
    for (const item of items) {
      try { result.set(item, linuxBackend.get(item)); } catch { /* missing — skip */ }
    }
    return result;
  }
  const bin = getKeychainHelperPath();
  const child = spawnSync(bin, ['get-batch', os.userInfo().username, ...items], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.status === 4) {
    throw new Error(`Touch ID cancelled while reading ${items.length} keychain item(s).`);
  }
  if (child.status !== 0) {
    const msg = child.stderr?.toString().trim();
    throw new Error(msg || `Failed to batch-read ${items.length} keychain items.`);
  }
  const out = child.stdout?.toString() ?? '';
  // Output is a sequence of records, one per service in input order:
  //   "V <service>\n<value>\n"   (present)
  //   "M <service>\n"            (missing)
  // Service names are validated newline/'='-free by setKeychainToken below
  // and values are rejected if they contain newlines — so splitting on '\n'
  // and walking line-by-line is unambiguous.
  const lines = out.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '' && i === lines.length - 1) break;
    if (line.startsWith('V ')) {
      const service = line.slice(2);
      const value = lines[i + 1] ?? '';
      result.set(service, value);
      i += 2;
    } else if (line.startsWith('M ')) {
      i += 1;
    } else if (line === '') {
      i += 1;
    } else {
      throw new Error(`Malformed get-batch output line: ${JSON.stringify(line)}`);
    }
  }
  return result;
}

/** Store or update a secret value in the keychain/keyring. Device-local; biometry-gated on macOS. */
export function setKeychainToken(item: string, value: string): void {
  if (backend) { backend.set(item, value); return; }
  assertSupportedPlatform();
  if (!value || !value.trim()) throw new Error('Secret value is empty.');
  if (/[\r\n]/.test(value)) throw new Error('Secret value contains newlines, which are not supported.');
  if (/[\x00=\r\n]/.test(item)) throw new Error('Secret item name contains invalid characters.');

  if (isLinux()) { linuxBackend.set(item, value); return; }

  // Bare (non-`agents-cli.`) items are written WITHOUT the biometry ACL so
  // they round-trip with the no-prompt read path in getKeychainToken (which
  // also uses /usr/bin/security for non-our items). This is what lets a
  // SessionStart hook read e.g. `linear-api-key` silently on every launch.
  // Routing these through the helper would attach a Touch ID ACL that the
  // /usr/bin/security read can't satisfy without popping the legacy password
  // sheet. -U upserts so repeated sets overwrite in place.
  if (!isOurItem(item)) {
    const sec = spawnSync('/usr/bin/security', [
      'add-generic-password', '-U',
      '-a', os.userInfo().username,
      '-s', item,
      '-w', value,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (sec.status !== 0) {
      const msg = sec.stderr?.toString().trim();
      throw new Error(msg || `Failed to write keychain item '${item}'.`);
    }
    return;
  }

  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['set', item, os.userInfo().username], {
    input: value,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to write keychain item '${item}'.`);
  }
}

/** Delete a keychain/keyring item. Returns true if it existed. Never prompts for biometry. */
export function deleteKeychainToken(item: string): boolean {
  if (backend) return backend.delete(item);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.delete(item);
  const bin = getKeychainHelperPath();
  return spawnSync(bin, ['delete', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;
}

/**
 * True when the active keychain backend transparently routes reads/writes to
 * the encrypted-file store instead of the OS credential store. This only
 * happens on Linux under the headless / locked-collection fallback
 * (src/lib/secrets/linux.ts); macOS and the test backend always return false.
 *
 * Callers that ALSO enumerate the file store directly (e.g. `listBundles`)
 * use this to avoid double-counting: under the fallback `listKeychainItems`
 * and the direct file enumeration return the same items.
 */
export function keychainUsesFileFallback(): boolean {
  if (backend) return false;
  if (isLinux()) return linuxUsesFileFallback();
  return false;
}

/** Enumerate keychain/keyring item names starting with the given prefix. */
export function listKeychainItems(prefix: string): string[] {
  if (backend) return backend.list(prefix);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.list(prefix);
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['list', prefix], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to enumerate keychain items with prefix '${prefix}'.`);
  }
  const out = result.stdout?.toString() || '';
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * One-time upgrade for a keychain item that was written by a previous helper
 * generation with a trusted-app ACL. The helper reads the legacy item
 * (which may pop the password sheet once), then deletes and re-adds it with
 * the biometry access control. Returns true if the item was rewritten, false
 * if no item by that name exists. macOS only — Linux backends have no ACL
 * concept, so the call is a no-op there.
 */
export function migrateKeychainItem(item: string): boolean {
  if (backend) return backend.has(item);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.has(item);
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['migrate-acl', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const msg = result.stderr?.toString().trim();
  throw new Error(msg || `Failed to migrate keychain item '${item}'.`);
}

/** Options controlling how secret refs are resolved. */
export interface ResolveOptions {
  /** Translate a short keychain ID to a fully namespaced item name. */
  keychainItemFor?: (shortId: string) => string;
  /** Allow exec: refs. When false (default), exec refs throw. */
  allowExec?: boolean;
  /** Restrict env: refs to this allowlist. When undefined, any env var may be read. */
  envAllowlist?: string[];
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/** Resolve a secret ref to its plaintext value using the appropriate provider. */
export function resolveRef(ref: SecretRef, opts: ResolveOptions = {}): string {
  switch (ref.provider) {
    case 'keychain': {
      const item = opts.keychainItemFor ? opts.keychainItemFor(ref.value) : ref.value;
      return getKeychainToken(item);
    }
    case 'env': {
      const name = ref.value;
      if (opts.envAllowlist && !opts.envAllowlist.includes(name)) {
        throw new Error(`env: ref '${name}' not in allowlist.`);
      }
      const val = process.env[name];
      if (val === undefined) {
        throw new Error(`env: ref '${name}' not set in parent environment.`);
      }
      return val;
    }
    case 'file': {
      const target = expandHome(ref.value);
      if (!fs.existsSync(target)) {
        throw new Error(`file: ref '${ref.value}' does not exist.`);
      }
      return fs.readFileSync(target, 'utf-8').trim();
    }
    case 'exec': {
      if (!opts.allowExec) {
        throw new Error(
          `exec: ref '${ref.value}' blocked. Set 'allow_exec: true' in the bundle to enable.`
        );
      }
      // shell: false — the bundle author controls the command; no injection
      // from secret identifiers. Parse a simple space-separated command.
      const parts = ref.value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, '')) || [];
      if (parts.length === 0) {
        throw new Error(`exec: ref '${ref.value}' is empty.`);
      }
      const [cmd, ...args] = parts;
      try {
        return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (err: any) {
        throw new Error(`exec: ref '${ref.value}' failed: ${err.message}`);
      }
    }
  }
}
