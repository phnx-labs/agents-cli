/**
 * Cross-platform secure credential storage.
 *
 * macOS: Uses Keychain via signed Swift helper (Agents CLI.app) or `security` CLI.
 * Linux: Uses libsecret (GNOME Keyring) via `secret-tool` CLI.
 * Windows: Not yet supported.
 *
 * The .app embeds a provisioning profile that grants the application-identifier
 * + keychain-access-groups entitlement macOS requires for kSecAttrSynchronizable
 * writes (iCloud Keychain). For device-local writes the helper is invoked with
 * the `nosync` arg.
 */

import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linuxBackend } from './linux.js';

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
      'Secure credential storage requires macOS or Linux. ' +
      'On Windows, use environment variables or .env files instead.'
    );
  }
}

function isLinux(): boolean {
  return process.platform === 'linux';
}

function isMacOS(): boolean {
  return process.platform === 'darwin';
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

// Resolve the bundled, signed-and-notarized Agents CLI.app shipped
// alongside the compiled JS. The .app embeds a provisioning profile that
// grants the application-identifier + keychain-access-groups entitlements
// macOS requires for kSecAttrSynchronizable writes. Bare CLI binaries
// (ad-hoc or Developer ID) cannot do this; only an .app with an embedded
// profile can. So compile-on-first-use is not possible — the binary must
// be prebuilt by `scripts/build-keychain-helper.sh` and shipped.
function ensureKeychainHelper(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const binPath = path.join(here, 'Agents CLI.app', 'Contents', 'MacOS', 'Agents CLI');
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `Keychain helper missing at ${binPath}. ` +
      'This npm package was built without the signed helper bundle. Reinstall agents-cli.'
    );
  }
  return binPath;
}

/**
 * Test seam: lets bundle storage tests swap the keychain backend for an
 * in-memory map without touching the user's real keychain. Mocking is
 * justified here because the alternative (touching real keychain in unit
 * tests) is destructive and would require an interactive Keychain unlock.
 */
export interface KeychainBackend {
  has(item: string, sync: boolean): boolean;
  get(item: string, sync: boolean): string;
  set(item: string, value: string, sync: boolean): void;
  delete(item: string, sync: boolean): boolean;
  list(prefix: string): string[];
}

let backend: KeychainBackend | null = null;

/** Install a custom keychain backend (test only). Returns the previous backend so callers can restore. */
export function setKeychainBackendForTest(b: KeychainBackend | null): KeychainBackend | null {
  const prev = backend;
  backend = b;
  return prev;
}

// Backend routing: non-sync items go through /usr/bin/security with an empty
// trusted-app ACL; existing items written by older versions retain their ACL.
// Sync items must go through the signed .app — only the .app
// holds the keychain-access-groups entitlement macOS requires for
// kSecAttrSynchronizable. Enumeration also goes through the .app because the
// security CLI doesn't expose listing by service prefix.

/** Check if a keychain/keyring item exists. */
export function hasKeychainToken(item: string, sync = false): boolean {
  if (backend) return backend.has(item, sync);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.has(item, sync);
  // macOS: Try security first (no prompts for local items), fall back to binary for synced items.
  if (spawnSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', item, '-w'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0) return true;
  // Fallback: binary searches both synced and non-synced via kSecAttrSynchronizableAny
  const bin = ensureKeychainHelper();
  return spawnSync(bin, ['has', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;
}

/** Retrieve a secret value from the keychain/keyring. Throws if not found. */
export function getKeychainToken(item: string, sync = false): string {
  if (backend) return backend.get(item, sync);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.get(item, sync);
  // macOS: read through the signed helper FIRST. The helper holds the
  // keychain-access-group entitlement (so it reads iCloud-synced items) and
  // supplies an LAContext for items protected by kSecAttrAccessControl.
  //
  // Bare `security` is only a fallback for when the helper bundle is absent
  // (e.g. a dev build without the .app). It must NOT be tried first: macOS
  // shows the "security wants to access … enter keychain password" sheet on any
  // item whose ACL doesn't list `security`, which is every item we write. That
  // security-first ordering is exactly what made bundle reads prompt on every
  // `secrets exec`.
  let bin: string;
  try {
    bin = ensureKeychainHelper();
  } catch {
    // Helper bundle missing — degrade to security. Reads items security created
    // without a prompt; restrictive items may still prompt (dev-build only).
    const secResult = spawnSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', item, '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (secResult.status === 0) {
      const token = secResult.stdout?.toString().trim();
      if (token) return token;
    }
    throw new Error(`Keychain item '${item}' not found.`);
  }
  // Helper searches both synced and non-synced via kSecAttrSynchronizableAny.
  const args = keychainItemRequiresUserPresence(item)
    ? ['get-auth', item, os.userInfo().username, '--reason', 'read agents-cli secrets']
    : ['get', item, os.userInfo().username];
  const result = spawnSync(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 1) throw new Error(`Keychain item '${item}' not found.`);
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to read keychain item '${item}'.`);
  }
  const token = result.stdout?.toString().trim();
  if (!token) throw new Error(`Keychain item '${item}' exists but is empty.`);
  return token;
}

/**
 * Read multiple keychain items, returning a Map keyed by item name. Missing or
 * unreadable items are simply absent from the map (the caller decides whether a
 * given key was required).
 *
 * On macOS this uses the signed helper's `get-batch` command so one LAContext
 * can satisfy all protected item reads for the bundle.
 */
export function getKeychainTokensBatch(items: string[], sync = false, reason = 'read agents-cli secrets'): Map<string, string> {
  const result = new Map<string, string>();
  if (backend) {
    for (const item of items) {
      try {
        result.set(item, backend.get(item, sync));
      } catch {
        // Missing or unreadable — skip; the caller reports which key is missing.
      }
    }
    return result;
  }
  assertSupportedPlatform();
  if (isLinux()) {
    for (const item of items) {
      try {
        result.set(item, linuxBackend.get(item, sync));
      } catch {
        // Missing or unreadable — skip; the caller reports which key is missing.
      }
    }
    return result;
  }
  let bin: string;
  try {
    bin = ensureKeychainHelper();
  } catch {
    for (const item of items) {
      try {
        result.set(item, getKeychainToken(item, sync));
      } catch {
        // Missing or unreadable — skip; the caller reports which key is missing.
      }
    }
    return result;
  }
  const proc = spawnSync(bin, ['get-batch', os.userInfo().username, '--reason', reason, ...items], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (proc.status !== 0) return result;
  const out = proc.stdout?.toString() || '';
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const item = line.slice(0, tab);
    const encoded = line.slice(tab + 1);
    result.set(item, Buffer.from(encoded, 'base64').toString('utf8'));
  }
  return result;
}

/** Store or update a secret value in the keychain/keyring. iCloud-synced when sync=true (macOS only). */
export function setKeychainToken(item: string, value: string, sync = false): void {
  if (backend) { backend.set(item, value, sync); return; }
  assertSupportedPlatform();
  if (!value || !value.trim()) throw new Error('Secret value is empty.');
  if (/[\r\n]/.test(value)) throw new Error('Secret value contains newlines, which are not supported.');
  if (/[\x00=\r\n]/.test(item)) throw new Error('Secret item name contains invalid characters.');

  if (isLinux()) { linuxBackend.set(item, value, sync); return; }

  // macOS path. Both sync and non-sync writes go through the .app helper so
  // the item picks up kSecAttrAccessControl user-presence protection. The
  // helper takes an optional `nosync` arg for device-local writes; sync writes
  // get kSecAttrSynchronizable=true by default.
  const bin = ensureKeychainHelper();
  const args = ['set', item, os.userInfo().username];
  if (!sync) args.push('nosync');
  const result = spawnSync(bin, args, {
    input: value,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to write keychain item '${item}'.`);
  }
}

/** Delete a keychain/keyring item. Returns true if it existed. */
export function deleteKeychainToken(item: string, sync = false): boolean {
  if (backend) return backend.delete(item, sync);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.delete(item, sync);
  // macOS: Try security first (no prompts for local items), fall back to binary for synced items.
  if (!sync && spawnSync('security', ['delete-generic-password', '-a', os.userInfo().username, '-s', item], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0) return true;
  // Fallback: binary deletes synced items via kSecAttrSynchronizableAny
  const bin = ensureKeychainHelper();
  return spawnSync(bin, ['delete', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;
}

/** Enumerate keychain/keyring item names starting with the given prefix. */
export function listKeychainItems(prefix: string): string[] {
  if (backend) return backend.list(prefix);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.list(prefix);
  // macOS path
  const bin = ensureKeychainHelper();
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

/** Options controlling how secret refs are resolved. */
export interface ResolveOptions {
  /** Translate a short keychain ID to a fully namespaced item name. */
  keychainItemFor?: (shortId: string) => string;
  /** Allow exec: refs. When false (default), exec refs throw. */
  allowExec?: boolean;
  /** Restrict env: refs to this allowlist. When undefined, any env var may be read. */
  envAllowlist?: string[];
  /** Read keychain refs from the iCloud-synced keychain backend. */
  iCloudSync?: boolean;
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
      return getKeychainToken(item, opts.iCloudSync);
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
