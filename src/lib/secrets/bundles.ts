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
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
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

/** Allowed values for a secret's `type` metadata field. */
export const SECRET_TYPES = [
  'api-key',
  'token',
  'password',
  'url',
  'database-url',
  'ssh-key',
  'certificate',
  'webhook',
  'note',
] as const;
export type SecretType = typeof SECRET_TYPES[number];

/** Per-secret metadata. All fields optional; absent ones omitted at write time. */
export interface VarMeta {
  type?: SecretType;
  /** ISO date 'YYYY-MM-DD'. Always future-dated at write time. */
  expires?: string;
  /** Singular freeform note. */
  note?: string;
}

/** A named set of environment variable definitions backed by various secret providers. */
export interface SecretsBundle {
  name: string;
  description?: string;
  allow_exec?: boolean;
  /** When true, keychain-backed values and bundle metadata sync via iCloud Keychain. */
  icloud_sync?: boolean;
  vars: Record<string, BundleValue>;
  /** Optional per-var metadata, keyed by var name (parallel to `vars`). */
  meta?: Record<string, VarMeta>;
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

/** Assert that `t` is one of the known SECRET_TYPES. Throws with the allowed list otherwise. */
export function validateSecretType(t: string): asserts t is SecretType {
  if (!(SECRET_TYPES as readonly string[]).includes(t)) {
    throw new Error(`Invalid type '${t}'. One of: ${SECRET_TYPES.join(', ')}.`);
  }
}

/**
 * Validate an `expires` value. Accepts strict 'YYYY-MM-DD' only and rejects
 * any date <= now. We compare against end-of-day UTC for the chosen date so
 * "today" is treated as past (per spec).
 */
export function validateExpiresFutureDated(iso: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Invalid --expires '${iso}'. Use YYYY-MM-DD.`);
  }
  const target = new Date(iso + 'T23:59:59Z');
  if (Number.isNaN(target.getTime())) throw new Error(`Invalid --expires date '${iso}'.`);
  if (target.getTime() <= Date.now()) {
    throw new Error(`--expires must be future-dated. Got '${iso}'.`);
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
  if (parsed.meta && typeof parsed.meta === 'object') {
    bundle.meta = parsed.meta;
  }
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
  // Strip empty/all-undefined meta entries so the JSON stays tidy.
  let meta: Record<string, VarMeta> | undefined;
  if (bundle.meta) {
    for (const [key, m] of Object.entries(bundle.meta)) {
      const cleaned: VarMeta = {};
      if (m.type) cleaned.type = m.type;
      if (m.expires) cleaned.expires = m.expires;
      if (m.note) cleaned.note = m.note;
      if (Object.keys(cleaned).length > 0) {
        if (!meta) meta = {};
        meta[key] = cleaned;
      }
    }
  }
  const payload = {
    description: bundle.description,
    allow_exec: bundle.allow_exec ? true : undefined,
    icloud_sync: bundle.icloud_sync ? true : undefined,
    vars: bundle.vars,
    meta,
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

/** Options for rotateBundleSecret. */
export interface RotateOptions {
  /** New plaintext value to write into keychain (replaces the old one). */
  newValue: string;
  /** When true, drop existing meta for this key. Mutually exclusive with `meta`. */
  clearMeta?: boolean;
  /** Patch to merge into existing meta. Undefined fields preserve current values. */
  meta?: Partial<VarMeta>;
}

/**
 * Rotate a keychain-backed secret in `bundle`. Errors if `key` is not present
 * in the bundle (use `add` to introduce a new key). Preserves existing meta
 * unless `clearMeta` or a `meta` patch is supplied.
 */
export function rotateBundleSecret(bundle: SecretsBundle, key: string, opts: RotateOptions): void {
  validateBundleName(bundle.name);
  validateEnvKey(key);
  if (!(key in bundle.vars)) {
    throw new Error(`Key '${key}' not in bundle '${bundle.name}'. Use 'agents secrets add' to add a new key.`);
  }
  const raw = bundle.vars[key];
  // We only rotate keychain-backed values. Literals/refs aren't "secrets" in
  // the same sense — pivot the user back to add/remove.
  if (typeof raw !== 'string' || !raw.startsWith('keychain:')) {
    throw new Error(`Key '${key}' in bundle '${bundle.name}' is not keychain-backed; cannot rotate.`);
  }
  const shortId = raw.slice('keychain:'.length);
  const item = secretsKeychainItem(bundle.name, shortId);
  setKeychainToken(item, opts.newValue, bundle.icloud_sync);

  if (opts.clearMeta) {
    if (bundle.meta) delete bundle.meta[key];
  } else if (opts.meta && Object.keys(opts.meta).length > 0) {
    if (!bundle.meta) bundle.meta = {};
    const current = bundle.meta[key] ?? {};
    const patched: VarMeta = { ...current };
    if (opts.meta.type !== undefined) patched.type = opts.meta.type;
    if (opts.meta.expires !== undefined) patched.expires = opts.meta.expires;
    if (opts.meta.note !== undefined) patched.note = opts.meta.note;
    bundle.meta[key] = patched;
  }
  writeBundle(bundle);
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
 * One-shot migration: move legacy YAML bundles into the keychain. Scans both
 * `~/.agents/secrets/` and `~/.agents-system/secrets/` — past versions of the
 * CLI sometimes wrote bundles into the system repo even though that's never
 * been a legitimate location. After migration the directories are removed so
 * the system repo never carries a `secrets/` subdir again.
 *
 * Idempotent: re-runs after the dirs are gone are no-ops. Called eagerly at
 * the top of every `agents secrets` subcommand. Skipped on the latency-
 * sensitive `agents run` path.
 */
export function migrateLegacyBundles(): void {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.agents', 'secrets'),
    path.join(home, '.agents-system', 'secrets'),
  ];
  let migrated = 0;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const ymls = entries.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    for (const entry of ymls) {
      const file = path.join(dir, entry);
      const name = entry.replace(/\.(yml|yaml)$/, '');
      try {
        validateBundleName(name);
        const raw = fs.readFileSync(file, 'utf-8');
        const parsed = yaml.parse(raw) as Partial<SecretsBundle> | null;
        if (!parsed || typeof parsed !== 'object') continue;
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
    } catch { /* not empty or already gone */ }
  }
  if (migrated > 0) {
    console.log(`Migrated ${migrated} legacy bundle${migrated === 1 ? '' : 's'} into keychain.`);
  }
}

export type { SecretRef };
