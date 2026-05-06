/**
 * Secret bundles -- named sets of keychain-backed environment variables.
 *
 * Bundle metadata (name, description, vars map) is stored in the macOS
 * Keychain as a JSON blob under `agents-cli.bundles.<name>`. Bundles created
 * with `--icloud-sync` write the metadata to the iCloud-synced keychain so
 * the full bundle definition (not just secret values) propagates across
 * the user's Macs. Nothing about secrets ever lives in plaintext on disk.
 *
 * Secret values keep their old layout: one keychain item per key under
 * `agents-cli.secrets.<bundle>.<key>`, sync-state matching the bundle's
 * `icloud_sync` flag.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getUserSecretsDir } from '../state.js';
import {
  deleteKeychainToken,
  getKeychainToken,
  hasKeychainToken,
  listKeychainItems,
  parseBundleValue,
  resolveRef,
  secretsKeychainItem,
  setKeychainToken,
  type BundleValue,
  type SecretRef,
} from './index.js';

/** A named set of environment variable definitions backed by various secret providers. */
export interface SecretsBundle {
  name: string;
  description?: string;
  allow_exec?: boolean;
  /** When true, keychain-backed values and bundle metadata sync via iCloud Keychain. */
  icloud_sync?: boolean;
  vars: Record<string, BundleValue>;
}

const BUNDLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,48}$/i;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUNDLE_META_PREFIX = 'agents-cli.bundles.';

/** Validate a bundle name against the allowed pattern. Throws on invalid input. */
export function validateBundleName(name: string): void {
  if (!BUNDLE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid bundle name '${name}'. Use letters, digits, dash, underscore (max 48 chars).`);
  }
}

export function validateEnvKey(key: string): void {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid environment variable name '${key}'. Must match [A-Za-z_][A-Za-z0-9_]*.`);
  }
}

function bundleMetaItem(name: string): string {
  return BUNDLE_META_PREFIX + name;
}

export function bundleExists(name: string): boolean {
  validateBundleName(name);
  return hasKeychainToken(bundleMetaItem(name));
}

export function readBundle(name: string): SecretsBundle {
  validateBundleName(name);
  let json: string;
  try {
    json = getKeychainToken(bundleMetaItem(name));
  } catch {
    throw new Error(`Secrets bundle '${name}' not found.`);
  }
  let parsed: Partial<SecretsBundle>;
  try {
    parsed = JSON.parse(json) as Partial<SecretsBundle>;
  } catch {
    throw new Error(`Bundle '${name}' is malformed.`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Bundle '${name}' is malformed.`);
  }
  const bundle: SecretsBundle = {
    name,
    description: parsed.description,
    allow_exec: Boolean(parsed.allow_exec),
    icloud_sync: Boolean(parsed.icloud_sync),
    vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
  };
  for (const key of Object.keys(bundle.vars)) {
    validateEnvKey(key);
  }
  return bundle;
}

export function writeBundle(bundle: SecretsBundle): void {
  validateBundleName(bundle.name);
  for (const key of Object.keys(bundle.vars)) {
    validateEnvKey(key);
  }
  const payload = {
    description: bundle.description,
    allow_exec: bundle.allow_exec ? true : undefined,
    icloud_sync: bundle.icloud_sync ? true : undefined,
    vars: bundle.vars,
  };
  const json = JSON.stringify(payload);
  setKeychainToken(bundleMetaItem(bundle.name), json, Boolean(bundle.icloud_sync));
}

export function deleteBundle(name: string): boolean {
  validateBundleName(name);
  return deleteKeychainToken(bundleMetaItem(name));
}

export function listBundles(): SecretsBundle[] {
  let services: string[];
  try {
    services = listKeychainItems(BUNDLE_META_PREFIX);
  } catch {
    return [];
  }
  const names = services
    .map((s) => s.slice(BUNDLE_META_PREFIX.length))
    .filter((n) => BUNDLE_NAME_PATTERN.test(n));
  const out: SecretsBundle[] = [];
  for (const name of names) {
    try {
      out.push(readBundle(name));
    } catch {
      // Skip malformed bundles; surfaced via `agents secrets view <name>`.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Classify each var for UI rendering.
export interface BundleEntryInfo {
  key: string;
  kind: 'literal' | 'keychain' | 'env' | 'file' | 'exec';
  detail: string; // ref target, or empty for literal
}

export function describeBundle(bundle: SecretsBundle): BundleEntryInfo[] {
  const out: BundleEntryInfo[] = [];
  for (const [key, raw] of Object.entries(bundle.vars)) {
    const parsed = parseBundleValue(raw);
    if ('literal' in parsed) {
      out.push({ key, kind: 'literal', detail: '' });
    } else {
      out.push({ key, kind: parsed.ref.provider, detail: parsed.ref.value });
    }
  }
  return out;
}

// Walk the bundle and produce a flat env map. Keychain refs are translated via
// the bundle-scoped naming scheme so two bundles with the same short ID never
// collide. Throws on the first missing secret so `agents run` fails loudly
// rather than silently injecting empty strings.
export function resolveBundleEnv(bundle: SecretsBundle): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(bundle.vars)) {
    const parsed = parseBundleValue(raw);
    if ('literal' in parsed) {
      env[key] = parsed.literal;
      continue;
    }
    try {
      env[key] = resolveRef(parsed.ref, {
        allowExec: bundle.allow_exec,
        iCloudSync: bundle.icloud_sync,
        keychainItemFor: (shortId: string) => secretsKeychainItem(bundle.name, shortId),
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (parsed.ref.provider === 'keychain' && /not found/.test(msg)) {
        throw new Error(
          `${msg} Run: agents secrets add ${bundle.name} ${key}`
        );
      }
      throw new Error(`Bundle '${bundle.name}' key '${key}': ${msg}`);
    }
  }
  return env;
}

// Build a keychain ref expression from a bundle+key pair, for storage in the bundle metadata.
export function keychainRef(key: string): string {
  return `keychain:${key}`;
}

// Iterate all keychain-backed keys in a bundle for cleanup on rm/unset.
export function keychainItemsForBundle(bundle: SecretsBundle): Array<{ key: string; item: string }> {
  const items: Array<{ key: string; item: string }> = [];
  for (const [key, raw] of Object.entries(bundle.vars)) {
    const parsed = parseBundleValue(raw);
    if ('ref' in parsed && parsed.ref.provider === 'keychain') {
      items.push({ key, item: secretsKeychainItem(bundle.name, parsed.ref.value) });
    }
  }
  return items;
}

// Parse a dotenv string into key=value pairs, preserving last-wins on duplicates.
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (ENV_KEY_PATTERN.test(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * One-shot migration: move legacy `~/.agents/secrets/<name>.yml` definitions
 * into the keychain. Idempotent — re-runs after the dir is gone are no-ops.
 * Called eagerly at the top of every `agents secrets` subcommand. Skipped on
 * the latency-sensitive `agents run` path.
 */
export function migrateLegacyBundles(): void {
  const dir = getUserSecretsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const ymls = entries.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  if (ymls.length === 0) {
    try { fs.rmdirSync(dir); } catch { /* not empty or already gone */ }
    return;
  }
  let migrated = 0;
  for (const entry of ymls) {
    const file = path.join(dir, entry);
    const name = entry.replace(/\.(yml|yaml)$/, '');
    try {
      validateBundleName(name);
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = yaml.parse(raw) as Partial<SecretsBundle> | null;
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      const bundle: SecretsBundle = {
        name,
        description: parsed.description,
        allow_exec: Boolean(parsed.allow_exec),
        icloud_sync: Boolean(parsed.icloud_sync),
        vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
      };
      writeBundle(bundle);
      fs.unlinkSync(file);
      migrated++;
    } catch {
      // Leave malformed YAMLs in place so the user can inspect them.
    }
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
  if (migrated > 0) {
    console.log(`Migrated ${migrated} legacy bundle${migrated === 1 ? '' : 's'} from ~/.agents/secrets/ into keychain.`);
  }
}

export type { SecretRef };
