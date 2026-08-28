/**
 * Secret bundles — named sets of environment variables backed by a secret store.
 * Metadata lives under `agents-cli.bundles.<name>`; values under
 * `agents-cli.secrets.<bundle>.<key>`. Backends: `keychain` (default),
 * `file` (headless/passphrase), and `vault` (age-encrypted, user-synced).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  deleteKeychainToken,
  getKeychainToken,
  getKeychainTokens,
  hasKeychainToken,
  isKeychainBackendOverridden,
  keychainServiceAlias,
  keychainUsesFileFallback,
  listKeychainItems,
  parseBundleValue,
  resolveRef,
  secretsKeychainItem,
  setKeychainToken,
  type BundleValue,
  type SecretRef,
} from './index.js';
import { isHeadlessSecretsContext } from './headless.js';
import { fileStore } from './filestore.js';
import {
  getVaultSession,
  vaultDeleteItem,
  vaultExists,
  vaultGetItems,
  vaultGetItem,
  vaultHasItem,
  vaultListItems,
  vaultSetItems,
  vaultSetItem,
} from './vault.js';
import { emit } from '../feed/events.js';
import { emitSecretAudit } from './audit.js';
import { readMeta, getHelpersDir } from '../state.js';
import { assertNameActiveInResourceProfile, filterNamesForActiveResourceProfile } from '../resource-profiles.js';
import { agentGetSync, agentAutoLoadSync, agentGetMetaSync, agentAutoLoadMetaSync, agentEvictSync, secretsAgentAutoEnabled, secretsHoldMs, isSecretsBrokerEnabled } from './agent.js';
import { GLOBAL_HARNESS } from './scope.js';
import { resolveSession, deleteSession } from './session-store.js';
import { createHash } from 'node:crypto';

/** Which store carries a bundle's items. */
export type SecretsBackend = 'keychain' | 'file' | 'vault';

/**
 * Uniform read/write surface over a secret store so bundle functions stay
 * backend-agnostic.
 */
interface ItemStore {
  has(item: string): boolean;
  get(item: string): string;
  getBatch(items: string[]): Map<string, string>;
  /** `noAcl` skips biometry on keychain; file/test backends ignore it. */
  set(item: string, value: string, opts?: { noAcl?: boolean }): void;
  setBatch(items: Map<string, string>, opts?: { noAcl?: boolean }): void;
  delete(item: string): boolean;
  list(prefix: string): string[];
}

const keychainStore: ItemStore = {
  has: hasKeychainToken,
  get: getKeychainToken,
  getBatch: getKeychainTokens,
  set: setKeychainToken,
  setBatch: (items, opts) => {
    for (const [item, value] of items) setKeychainToken(item, value, opts);
  },
  delete: deleteKeychainToken,
  list: listKeychainItems,
};

// File store auto-provisions a machine-local 0600 key on every platform,
// so `agents secrets` works headless without a passphrase. Override with
// AGENTS_SECRETS_PASSPHRASE.
const fileItemStore: ItemStore = {
  has: (item) => fileStore.has(item),
  get: (item) => fileStore.get(item),
  getBatch: (items) => fileStore.getBatch(items),
  set: (item, value) => fileStore.set(item, value),
  setBatch: (items) => {
    for (const [item, value] of items) {
      fileStore.set(item, value);
    }
  },
  delete: (item) => fileStore.delete(item),
  list: (prefix) => fileStore.list(prefix),
};

const vaultStore: ItemStore = {
  has: vaultHasItem,
  get: vaultGetItem,
  getBatch: vaultGetItems,
  set: (item, value) => vaultSetItem(item, value),
  setBatch: (items) => vaultSetItems(items),
  delete: vaultDeleteItem,
  list: vaultListItems,
};

let keychainAgentOnlyBypassForTest = false;

/** Disable the broker-only guard for in-memory keychain tests. */
export function setKeychainAgentOnlyBypassForTest(bypass: boolean): void {
  keychainAgentOnlyBypassForTest = bypass;
}

function itemStore(backend: SecretsBackend): ItemStore {
  if (backend === 'file') return fileItemStore;
  if (backend === 'vault') return vaultStore;
  return keychainStore;
}

/**
 * Discover a bundle's backend by location. File store is checked first (a plain
 * existence test, no passphrase); absent/locked vault falls back to keychain.
 */
export function bundleBackend(name: string): SecretsBackend {
  const item = BUNDLE_META_PREFIX + name;
  if (fileStore.has(item)) return 'file';
  if (vaultExists() && getVaultSession().loggedIn) {
    try {
      if (vaultHasItem(item)) return 'vault';
    } catch {
      // A vault problem should not hide a keychain/file bundle that already
      // resolved above; exact vault reads surface the decrypt/login error.
    }
  }
  return 'keychain';
}

function assertVaultBackendUsable(name: string): void {
  if (getVaultSession().loggedIn) return;
  throw new Error(`Synced bundle '${name}' needs an active login. Run: agents secrets vault unlock`);
}

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

/** Per-secret metadata; absent fields are omitted at write time. */
export interface VarMeta {
  type?: SecretType;
  /** Future-dated ISO date ('YYYY-MM-DD'). */
  expires?: string;
  note?: string;
}

/**
 * Bundle prompt policy. `hold` (default): one Touch ID per hold window (~7d),
 * then silent via the secrets-agent. `always`: prompt every read. `never`: no
 * biometry ACL — least-safe, automation-only. Configurable via `secrets.policy`;
 * persisted under the legacy `tier` key for cross-version sync.
 */
export type SecretsPolicy = 'always' | 'hold' | 'never';

/** A named set of environment variable definitions backed by secret stores. */
export interface SecretsBundle {
  name: string;
  description?: string;
  allow_exec?: boolean;
  /** Absent ⇒ `keychain`. */
  backend?: SecretsBackend;
  /** Absent ⇒ configured default (`hold`). */
  policy?: SecretsPolicy;
  created_at?: string;
  updated_at?: string;
  last_used?: string;
  vars: Record<string, BundleValue>;
  meta?: Record<string, VarMeta>;
}

export interface LegacyBundleCandidate {
  name: string;
  file: string;
  keys: string[];
}

/** Throttle last_used writes so the keychain isn't touched on every injection. */
const LAST_USED_THROTTLE_MS = 60_000;

export const BUNDLE_NAME_PATTERN = /^[a-z0-9][a-z0-9\-_.]{0,48}$/i;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const BUNDLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)?$/;
export const BUNDLE_META_PREFIX = 'agents-cli.bundles.';
const SECRETS_ITEM_PREFIX = 'agents-cli.secrets.';

export const RESERVED_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'USERNAME', 'SHELL', 'PWD', 'OLDPWD',
  'TERM', 'LANG', 'LC_ALL', 'DISPLAY', 'EDITOR', 'VISUAL',
  'TMPDIR', 'TMP', 'TEMP', 'LOGNAME', 'UID', 'EUID', 'HOSTNAME',
]);

/**
 * Reserved FILE-BACKED bundle for long-lived setup tokens. Must be file-backed;
 * a keychain/vault `auth` bundle is a misconfiguration and is ignored.
 */
export const AUTH_BUNDLE_NAME = 'auth';
export const AUTH_BUNDLE_BACKEND: SecretsBackend = 'file';
export const RESERVED_BUNDLE_NAMES = new Set([AUTH_BUNDLE_NAME]);

export function isReservedBundleName(name: string): boolean {
  return RESERVED_BUNDLE_NAMES.has(name.trim().toLowerCase());
}

/** Thrown when a reserved bundle is written or resolved on the wrong backend. */
export class ReservedBundleWrongBackendError extends Error {
  readonly bundle: string;
  readonly backend: SecretsBackend;
  constructor(bundle: string, backend: SecretsBackend) {
    super(
      `Bundle '${bundle}' is reserved for file-backed setup-tokens (headless, fleet-shareable). ` +
      `A ${backend}-backed '${bundle}' bundle is ignored by usage/probe instead of authenticating. ` +
      `Recreate it as file-backed: agents secrets delete ${bundle} --yes && agents secrets create ${bundle} --backend file`,
    );
    this.name = 'ReservedBundleWrongBackendError';
    this.bundle = bundle;
    this.backend = backend;
  }
}

/** Fail loud when a reserved bundle is on the wrong backend. */
export function assertReservedBundleBackend(name: string, backend: SecretsBackend): void {
  if (!isReservedBundleName(name)) return;
  if (backend !== AUTH_BUNDLE_BACKEND) {
    throw new ReservedBundleWrongBackendError(name, backend);
  }
}

/**
 * Check the reserved `auth` bundle. `ok` is true when absent or file-backed.
 */
export function inspectReservedAuthBundle(): {
  exists: boolean;
  backend: SecretsBackend | null;
  ok: boolean;
} {
  if (!bundleExists(AUTH_BUNDLE_NAME)) {
    return { exists: false, backend: null, ok: true };
  }
  const backend = bundleBackend(AUTH_BUNDLE_NAME);
  return { exists: true, backend, ok: backend === AUTH_BUNDLE_BACKEND };
}

/**
 * After a file-backed import, verify the keys actually decrypt. Import used to
 * report success for ciphertext sealed under a forwarded passphrase this process
 * does not hold.
 */
export function assertFileBundleDecryptable(name: string, keys: string[]): void {
  if (keys.length === 0) return;
  if (bundleBackend(name) !== 'file') return;
  let env: Record<string, string>;
  try {
    ({ env } = readAndResolveBundleEnv(name, { caller: 'import-verify', agentOnly: true, keyMode: 'storage' }));
  } catch (err) {
    throw new Error(
      `Imported '${name}' reported success but the file store could not decrypt it. ` +
      `${(err as Error).message} Typically because AGENTS_SECRETS_PASSPHRASE was forwarded ` +
      `and this process does not hold it. Re-import without that env var.`,
    );
  }
  const missing = keys.filter((k) => {
    const v = env[k];
    return typeof v !== 'string' || v.length === 0;
  });
  if (missing.length === 0) return;
  throw new Error(
    `Imported '${name}' reported success but ${missing.length} key(s) are unreadable ` +
    `(${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}). ` +
    `The destination store could not decrypt them — typically because AGENTS_SECRETS_PASSPHRASE ` +
    `was forwarded and this process does not hold it. Re-import without that env var.`,
  );
}

export function bundleToEnvPrefix(name: string): string {
  return name.replace(/[-\.]/g, '_').toUpperCase();
}

export function isReservedEnvName(key: string): boolean {
  return RESERVED_ENV_NAMES.has(key.toUpperCase());
}

export function bundleKeyToEnvKey(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

export function isLoaderOrInterpreterEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('LD_') ||
    upper.startsWith('DYLD_') ||
    [
      'NODE_OPTIONS',
      'PYTHONPATH',
      'PYTHONSTARTUP',
      'BASH_ENV',
      'ENV',
      'PERL5OPT',
      'RUBYOPT',
      'PROMPT_COMMAND',
      'IFS',
      'CDPATH',
    ].includes(upper);
}

export function sanitizeProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isLoaderOrInterpreterEnv(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Validate a bundle name against the allowed pattern. Throws on invalid input. */
export function validateBundleName(name: string): void {
  if (!BUNDLE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid bundle name '${name}'. Use letters, digits, dash, underscore, dot (max 48 chars).`);
  }
}

export function validateEnvKey(key: string): void {
  if (!BUNDLE_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid bundle key '${key}'. Must match [A-Za-z_][A-Za-z0-9_]* with optional .account suffix.`);
  }
  const envKey = bundleKeyToEnvKey(key);
  if (isLoaderOrInterpreterEnv(envKey) || isReservedEnvName(envKey)) {
    throw new Error(`Env key "${key}" is reserved — cannot be used in a secrets bundle. Reserved keys include PATH, HOME, USER, and dynamic-loader/interpreter vars (LD_*, DYLD_*, NODE_OPTIONS, etc.).`);
  }
}

/** Assert that `t` is one of the known SECRET_TYPES. Throws with the allowed list otherwise. */
export function validateSecretType(t: string): asserts t is SecretType {
  if (!(SECRET_TYPES as readonly string[]).includes(t)) {
    throw new Error(`Invalid type '${t}'. One of: ${SECRET_TYPES.join(', ')}.`);
  }
}

/**
 * Validate a future `expires` date. Accepts strict 'YYYY-MM-DD'; end-of-day UTC
 * means "today" is past.
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
  return itemStore(bundleBackend(name)).has(bundleMetaItem(name));
}

/**
 * Thrown for file-store ciphertext that will not decrypt (lost/rotated key or
 * tampered store). Narrow: temporarily-locked bundles are recoverable and must
 * not be collapsed here.
 */
export class BundleUndecryptableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleUndecryptableError';
  }
}

/**
 * Read a bundle, returning null only when metadata is present but permanently
 * unreadable (`BundleUndecryptableError`). Other failures — including temporary
 * lockout — rethrow so a healthy bundle is never deleted by mistake.
 */
export function readBundleIfDecryptable(name: string): SecretsBundle | null {
  try {
    return readBundle(name);
  } catch (err) {
    if (err instanceof BundleUndecryptableError) return null;
    throw err;
  }
}

export function readBundle(name: string): SecretsBundle {
  validateBundleName(name);
  const backend = bundleBackend(name);
  if (backend === 'vault') assertVaultBackendUsable(name);
  let json: string;
  try {
    // Metadata is no-ACL by contract; attest silentNoAcl so headless reads don't
    // trip the raw-read storm guard. A legacy ACL'd item may prompt once, then heals.
    json = backend === 'keychain'
      ? getKeychainToken(bundleMetaItem(name), { silentNoAcl: true })
      : itemStore(backend).get(bundleMetaItem(name));
  } catch (err) {
    // File-backed metadata that fails to decrypt is a wrong-passphrase error.
    if (backend === 'file' && fileStore.has(bundleMetaItem(name))) {
      throw new BundleUndecryptableError(
        `Bundle '${name}': failed to decrypt — wrong AGENTS_SECRETS_PASSPHRASE or tampered file store. (${(err as Error).message})`,
      );
    }
    if (vaultExists() && !getVaultSession().loggedIn) {
      throw new Error(`Synced secrets are locked. Run: agents secrets vault unlock`);
    }
    // A present-but-unreadable keychain item must not report "not found".
    if (backend === 'keychain') {
      let present: boolean;
      try {
        present = hasKeychainToken(bundleMetaItem(name));
      } catch (probeErr) {
        // Keychain unreachable — fail loud rather than report false absence.
        throw new Error(`Secrets bundle '${name}': ${(probeErr as Error).message}`);
      }
      if (present) {
        throw new Error(
          `Secrets bundle '${name}' is present but its metadata could not be read — the keychain is locked. ` +
          `Unlock it (log in, or reboot then log in) and retry. (${(err as Error).message})`,
        );
      }
    }
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
  // Drop unknown fields; `backend` is authoritative from location discovery.
  const bundle: SecretsBundle = {
    name,
    description: parsed.description,
    allow_exec: Boolean(parsed.allow_exec),
    // Absent ⇒ keychain; only set when non-keychain so a keychain bundle
    // round-trips byte-for-byte.
    backend: backend === 'keychain' ? undefined : backend,
    // Legacy wire key: the policy is persisted under `tier` (`session` == `hold`).
    policy: parsePolicy((parsed as { tier?: unknown }).tier),
    vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
  };
  if (typeof parsed.created_at === 'string') bundle.created_at = parsed.created_at;
  if (typeof parsed.updated_at === 'string') bundle.updated_at = parsed.updated_at;
  if (typeof parsed.last_used === 'string') bundle.last_used = parsed.last_used;
  if (parsed.meta && typeof parsed.meta === 'object') {
    bundle.meta = parsed.meta;
  }
  for (const key of Object.keys(bundle.vars)) {
    validateEnvKey(key);
  }
  return bundle;
}

/** Normalize the persisted `tier` token to the current policy vocabulary. */
function parsePolicy(raw: unknown): SecretsPolicy | undefined {
  if (raw === 'hold' || raw === 'daily' || raw === 'session') return 'hold';
  if (raw === 'always' || raw === 'biometry') return 'always';
  if (raw === 'never' || raw === 'none') return 'never';
  return undefined;
}

/** Default policy for bundles without an explicit one (`secrets.policy`). */
export function secretsDefaultPolicy(): SecretsPolicy {
  try {
    return readMeta().secrets?.policy === 'always' ? 'always' : 'hold';
  } catch {
    return 'hold';
  }
}

/** Effective prompt policy of a bundle. */
export function bundlePolicy(bundle: SecretsBundle): SecretsPolicy {
  return bundle.policy ?? secretsDefaultPolicy();
}

/** Options for writeBundle. */
export interface WriteBundleOptions {
  /**
   * Skip evicting the broker-held copy. Only for no-op writers such as
   * stampLastUsed; mutating writes must evict so stale values aren't served.
   */
  skipBrokerEviction?: boolean;
}

/**
 * Whether a bundle write should evict the broker-held copy. Exported for tests.
 * Skips when the writer opted out, the broker is disabled, or a test backend is
 * active (so tests don't evict the user's real unlocks).
 */
export function shouldEvictAfterBundleWrite(
  skipRequested: boolean,
  noAgentEnv: string | undefined,
  backendOverridden: boolean,
): boolean {
  if (skipRequested) return false;
  if (noAgentEnv === '1') return false;
  if (backendOverridden) return false;
  return true;
}

interface PreparedBundleWrite {
  backend: SecretsBackend;
  metadataItem: string;
  metadataJson: string;
}

function prepareBundleWrite(bundle: SecretsBundle): PreparedBundleWrite {
  validateBundleName(bundle.name);
  const backend: SecretsBackend = bundle.backend ?? 'keychain';
  assertReservedBundleBackend(bundle.name, backend);
  if (backend === 'vault') assertVaultBackendUsable(bundle.name);
  for (const key of Object.keys(bundle.vars)) {
    validateEnvKey(key);
  }
  // Strip empty meta entries so the JSON stays tidy.
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
  // created_at is sticky; updated_at always advances.
  const now = new Date().toISOString();
  if (!bundle.created_at) bundle.created_at = now;
  bundle.updated_at = now;
  const payload = {
    // Persist the display name so hashed keychain items remain listable.
    name: bundle.name,
    description: bundle.description,
    allow_exec: bundle.allow_exec ? true : undefined,
    backend: backend === 'keychain' ? undefined : backend,
    // Legacy wire token for cross-version sync.
    tier: bundle.policy === 'hold' ? 'session'
      : bundle.policy === 'always' ? 'biometry'
      : bundle.policy === 'never' ? 'none'
      : undefined,
    created_at: bundle.created_at,
    updated_at: bundle.updated_at,
    last_used: bundle.last_used,
    vars: bundle.vars,
    meta,
  };
  return {
    backend,
    metadataItem: bundleMetaItem(bundle.name),
    metadataJson: JSON.stringify(payload),
  };
}

function finishBundleWrite(bundle: SecretsBundle, opts: WriteBundleOptions): void {
  emit('secrets.set', { module: 'secrets', bundle: bundle.name });
  // Evict the broker-held snapshot and durable session so the next read resolves fresh.
  if (shouldEvictAfterBundleWrite(Boolean(opts.skipBrokerEviction), process.env.AGENTS_SECRETS_NO_AGENT, isKeychainBackendOverridden())) {
    agentEvictSync(bundle.name);
    deleteSession(bundle.name);
  }
}

export function writeBundle(bundle: SecretsBundle, opts: WriteBundleOptions = {}): void {
  const prepared = prepareBundleWrite(bundle);
  // Metadata is non-sensitive by contract and stored no-ACL so `secrets list`
  // can enumerate without Touch ID. A pinned helper without the no-ACL command
  // fails loudly rather than silently landing an ACL'd item.
  itemStore(prepared.backend).set(prepared.metadataItem, prepared.metadataJson, { noAcl: true });
  if (prepared.backend === 'keychain') addBundleToMetaIndex(bundle.name);
  finishBundleWrite(bundle, opts);
}

export function writeBundleWithItems(
  bundle: SecretsBundle,
  items: Map<string, string>,
  opts: WriteBundleOptions = {},
): void {
  const prepared = prepareBundleWrite(bundle);
  const store = itemStore(prepared.backend);
  if (prepared.backend === 'keychain') {
    // Keychain values carry the policy ACL; metadata is always no-ACL. They cannot
    // share one batch flag, and metadata is written last so partial writes read as
    // "no bundle yet".
    if (items.size > 0) {
      store.setBatch(new Map(items), { noAcl: bundle.policy === 'never' });
    }
    store.set(prepared.metadataItem, prepared.metadataJson, { noAcl: true });
    addBundleToMetaIndex(bundle.name);
  } else {
    // File/vault have no ACL; one batched write is cheaper.
    const batch = new Map(items);
    batch.set(prepared.metadataItem, prepared.metadataJson);
    store.setBatch(batch, { noAcl: bundle.policy === 'never' });
  }
  finishBundleWrite(bundle, opts);
}

export function deleteBundle(name: string): boolean {
  validateBundleName(name);
  const backend = bundleBackend(name);
  const deleted = itemStore(backend).delete(bundleMetaItem(name));
  if (deleted) {
    if (backend === 'keychain') removeBundleFromMetaIndex(name);
    emit('secrets.delete', { module: 'secrets', bundle: name });
    if (shouldEvictAfterBundleWrite(false, process.env.AGENTS_SECRETS_NO_AGENT, isKeychainBackendOverridden())) {
      agentEvictSync(name);
      deleteSession(name); // a deleted bundle must not be rehydratable
    }
  }
  return deleted;
}

/**
 * Parse a stored metadata JSON blob into a SecretsBundle, skipping malformed
 * bundles. `backend` is authoritative. `nameHint` is cleartext (Linux/file/
 * legacy); hashed keychain items recover the name from the persisted payload.
 */
function parseBundleMeta(nameHint: string | undefined, json: string, backend: SecretsBackend): SecretsBundle | null {
  let parsed: Partial<SecretsBundle>;
  try {
    parsed = JSON.parse(json) as Partial<SecretsBundle>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const name = nameHint ?? (typeof parsed.name === 'string' ? parsed.name : undefined);
  if (!name || !BUNDLE_NAME_PATTERN.test(name)) return null;
  const bundle: SecretsBundle = {
    name,
    description: parsed.description,
    allow_exec: Boolean(parsed.allow_exec),
    backend: backend === 'keychain' ? undefined : backend,
    // Legacy wire key: the policy is persisted under `tier` (`session` == `hold`).
    policy: parsePolicy((parsed as { tier?: unknown }).tier),
    vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
  };
  if (typeof parsed.created_at === 'string') bundle.created_at = parsed.created_at;
  if (typeof parsed.updated_at === 'string') bundle.updated_at = parsed.updated_at;
  if (typeof parsed.last_used === 'string') bundle.last_used = parsed.last_used;
  if (parsed.meta && typeof parsed.meta === 'object') bundle.meta = parsed.meta;
  for (const key of Object.keys(bundle.vars)) {
    if (!BUNDLE_KEY_PATTERN.test(key)) return null;
  }
  return bundle;
}

// Sentinel for the one-time metadata-ACL heal. Lives in the regenerable helpers
// dir, so a cache wipe re-runs it harmlessly.
const METADATA_NOACL_SENTINEL = 'bundles-metadata-noacl-healed';

function metadataNoAclSentinelPath(): string {
  return path.join(getHelpersDir(), 'secrets-agent', METADATA_NOACL_SENTINEL);
}

function bundleMetadataAclHealed(): boolean {
  try {
    return fs.existsSync(metadataNoAclSentinelPath());
  } catch {
    return false;
  }
}

function markBundleMetadataAclHealed(): void {
  try {
    const file = metadataNoAclSentinelPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '', 'utf8');
  } catch {
    // Best effort — missing sentinel just re-runs the idempotent heal later.
  }
}

// No-ACL bundle-metadata name index. With hashed service names (#316), listing
// metadata falls back to a broad `agents-cli.` scan that matches ACL'd secret
// values and pops Touch ID. We keep a per-machine index of opaque metadata
// storage names in the regenerable helpers dir to avoid that scan. Stale entries
// only make `secrets list` cosmetically incomplete; resolve-by-name never uses it.
function bundleMetaIndexPath(): string {
  // Test-only redirect so the suite never touches the real helpers dir.
  return (
    process.env.AGENTS_SECRETS_META_INDEX_FILE ||
    path.join(getHelpersDir(), 'secrets-agent', 'bundle-meta-index.json')
  );
}

// Fingerprint invalidates the index when the hashing key changes (#316 re-key),
// so stale storage names don't make bundles "vanish".
function metaIndexFingerprint(): string {
  return keychainServiceAlias(`${BUNDLE_META_PREFIX}meta-index-fingerprint`);
}

function readBundleMetaIndex(): string[] | null {
  // Never read/write the real index from a mock-backend test.
  if (isKeychainBackendOverridden()) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(bundleMetaIndexPath(), 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.services)) return null;
    if (parsed.fp !== metaIndexFingerprint()) return null; // built under a different hashing key
    return parsed.services.every((s: unknown) => typeof s === 'string') ? (parsed.services as string[]) : null;
  } catch {
    return null;
  }
}

function writeBundleMetaIndex(services: string[]): void {
  if (isKeychainBackendOverridden()) return; // never write the real index from a mock-backend test
  try {
    const file = bundleMetaIndexPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = { fp: metaIndexFingerprint(), services: [...new Set(services)].sort() };
    // Atomic write. Concurrent edits may still race and drop an entry, but that
    // only makes `secrets list` cosmetically incomplete and self-heals.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // Best effort — listBundles rebuilds from a broad scan on the next enumeration.
  }
}

// Append a storage name to an already-built index. No-op when null: a one-entry
// index would hide every other bundle until the next rebuild.
function addBundleToMetaIndex(name: string): void {
  const cur = readBundleMetaIndex();
  if (cur === null) return;
  const svc = keychainServiceAlias(bundleMetaItem(name));
  if (!cur.includes(svc)) writeBundleMetaIndex([...cur, svc]);
}

function removeBundleFromMetaIndex(name: string): void {
  const cur = readBundleMetaIndex();
  if (cur === null) return;
  const svc = keychainServiceAlias(bundleMetaItem(name));
  if (cur.includes(svc)) writeBundleMetaIndex(cur.filter((s) => s !== svc));
}

/** Test-only accessors for the metadata-name index. Never called in production. */
export const __metaIndexForTest = {
  read: readBundleMetaIndex,
  write: writeBundleMetaIndex,
  add: addBundleToMetaIndex,
  remove: removeBundleFromMetaIndex,
};

/**
 * Re-write keychain metadata items without the biometry ACL. The caller supplies
 * the JSON already read, so contents are preserved and no extra read is issued.
 * Exported for tests.
 */
export function healKeychainBundleMetadata(metaJsonByName: Map<string, string>): number {
  let healed = 0;
  for (const [name, json] of metaJsonByName) {
    try {
      // keychainStore.set hashes the cleartext name back to the same service,
      // overwriting in place no-ACL. Per-item failures must not abort the rest.
      keychainStore.set(bundleMetaItem(name), json, { noAcl: true });
      healed++;
    } catch {
      /* keep healing the remaining items */
    }
  }
  return healed;
}

/**
 * One-time driver for healKeychainBundleMetadata. macOS + real keychain only;
 * gated by a sentinel. Best-effort: a heal failure never breaks listing.
 */
export function healKeychainBundleMetadataAclOnce(metaJsonByName: Map<string, string>): void {
  if (metaJsonByName.size === 0) return;
  if (process.platform !== 'darwin') return;
  if (isKeychainBackendOverridden()) return;
  if (bundleMetadataAclHealed()) return;
  try {
    if (healKeychainBundleMetadata(metaJsonByName) > 0) markBundleMetadataAclHealed();
  } catch {
    /* never let a heal failure break `secrets list` */
  }
}

export function listBundles(): SecretsBundle[] {
  const out: SecretsBundle[] = [];

  // Batch keychain metadata reads behind one prompt. Skip when the keychain
  // backend is routing to the file fallback to avoid listing file bundles twice.
  if (!keychainUsesFileFallback()) {
    let keychainServices: string[] = [];
    // Prefer the no-ACL metadata-name index (a silent file read) over the broad
    // `agents-cli.` keychain scan — that scan also matches ACL'd secret VALUE
    // items and pops Touch ID on every launch (see the index helpers above).
    // Absent index (first list after upgrade / a cache wipe) → do the one broad
    // scan and build the index from it, so that scan is the LAST one this machine
    // performs.
    const indexedServices = readBundleMetaIndex();
    if (indexedServices !== null) {
      keychainServices = indexedServices;
    } else {
      try {
        keychainServices = listKeychainItems(BUNDLE_META_PREFIX);
        writeBundleMetaIndex(keychainServices);
      } catch {
        keychainServices = [];
      }
    }
    // With hashed service names (macOS, #316) the enumerated services are
    // opaque (`agents-cli.h.<ns>.m`) — the display name is recovered from the
    // metadata JSON after the batch read below. Cleartext services (Linux,
    // pre-re-key items) still carry the name; it's kept as the parse hint so
    // legacy metadata without the persisted `name` field keeps listing.
    if (keychainServices.length > 0) {
      // Serve a broker-cached metadata snapshot so only the first list per hold
      // window prompts. Cache key is the name-set hash; policy edits can lag
      // cosmetically, but enforcement always reads live policy. Values are not cached.
      const useAgent =
        process.env.AGENTS_SECRETS_NO_AGENT !== '1' &&
        !isKeychainBackendOverridden() &&
        secretsAgentAutoEnabled();
      const nameSetHash = createHash('sha256')
        .update([...keychainServices].sort().join('\n'))
        .digest('hex')
        .slice(0, 32);
      const cached = useAgent ? agentGetMetaSync(nameSetHash) : null;
      if (cached) {
        for (const bundle of cached) out.push(bundle);
      } else {
        // Metadata is no-ACL by contract; attest silentNoAcl so headless listing
        // doesn't fail fast or pop a sheet.
        const fetched = getKeychainTokens(keychainServices, { silentNoAcl: true });
        const keychainBundles: SecretsBundle[] = [];
        for (const service of keychainServices) {
          const json = fetched.get(service);
          if (json === undefined) continue;
          const nameHint = service.startsWith(BUNDLE_META_PREFIX)
            ? service.slice(BUNDLE_META_PREFIX.length)
            : undefined;
          const bundle = parseBundleMeta(nameHint, json, 'keychain');
          if (bundle) {
            keychainBundles.push(bundle);
          }
        }
        for (const bundle of keychainBundles) out.push(bundle);
        // Populate the broker using the same hold cap as value reads.
        if (useAgent && keychainBundles.length > 0) {
          agentAutoLoadMetaSync(nameSetHash, keychainBundles, secretsHoldMs());
        }
      }
    }
  }

  // File-backed bundles: enumeration is silent; only decryption needs the passphrase.
  let fileServices: string[] = [];
  try {
    fileServices = fileStore.list(BUNDLE_META_PREFIX);
  } catch {
    fileServices = [];
  }
  const fileNames = fileServices
    .map((s) => s.slice(BUNDLE_META_PREFIX.length))
    .filter((n) => BUNDLE_NAME_PATTERN.test(n));
  for (const name of fileNames) {
    let json: string;
    try {
      json = fileItemStore.get(bundleMetaItem(name));
    } catch {
      // No passphrase: surface the name with empty vars so it isn't invisible.
      out.push({ name, backend: 'file', vars: {} });
      continue;
    }
    const bundle = parseBundleMeta(name, json, 'file');
    if (bundle) out.push(bundle);
  }

  if (getVaultSession().loggedIn && vaultExists()) {
    let vaultServices: string[] = [];
    try {
      vaultServices = vaultListItems(BUNDLE_META_PREFIX);
    } catch {
      vaultServices = [];
    }
    for (const service of vaultServices) {
      const name = service.slice(BUNDLE_META_PREFIX.length);
      if (!BUNDLE_NAME_PATTERN.test(name)) continue;
      let json: string;
      try {
        json = vaultStore.get(bundleMetaItem(name));
      } catch {
        out.push({ name, backend: 'vault', vars: {} });
        continue;
      }
      const bundle = parseBundleMeta(name, json, 'vault');
      if (bundle) out.push(bundle);
    }
  }

  const activeNames = new Set(filterNamesForActiveResourceProfile('secrets', out.map((b) => b.name)));
  return out.filter((bundle) => activeNames.has(bundle.name)).sort((a, b) => a.name.localeCompare(b.name));
}

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

// Bump `last_used` at most once per throttle window. The passed bundle is often
// the broker's snapshot, which can be stale, so re-read the authoritative
// metadata and write ONLY the timestamp. Failures are swallowed.
// Set AGENTS_NO_USAGE_TRACK=1 to disable entirely.
export function stampLastUsed(bundle: SecretsBundle): void {
  if (process.env.AGENTS_NO_USAGE_TRACK) return;
  const nowMs = Date.now();
  if (bundle.last_used) {
    const prev = Date.parse(bundle.last_used);
    if (Number.isFinite(prev) && nowMs - prev < LAST_USED_THROTTLE_MS) return;
  }
  try {
    const fresh = readBundle(bundle.name); // throws if the bundle is gone — swallowed below
    const stamp = new Date(nowMs).toISOString();
    fresh.last_used = stamp;
    bundle.last_used = stamp;
    // Stamping fires on every broker hit; evicting would destroy the cache.
    writeBundle(fresh, { skipBrokerEviction: true });
  } catch {
    // Swallow — telemetry must never block secret resolution.
  }
}

/** Options for resolveBundleEnv. */
export interface ResolveBundleOptions {
  caller?: string;
  /** Harness type whose unlock may be reused. */
  agent?: string;
  /** Duration shown in the Touch ID prompt. */
  duration?: string;
  /** Allow this call to raise an interactive biometric prompt. */
  interactiveUnlock?: boolean;
  /** Skip the broker fast-path and read from the keychain directly. */
  noAgent?: boolean;
  /** Resolve only from an already-unlocked broker snapshot; fail before prompting. */
  agentOnly?: boolean;
  /** Inject only these keys. Errors if any requested key is absent. */
  keys?: string[];
  /** Skip the per-key expiry gate. */
  allowExpired?: boolean;
  /** `process` projects dotted keys to shell-safe env names; `storage` preserves them. */
  keyMode?: 'process' | 'storage';
}

/**
 * Abort if any selected key's per-key `expires` date is in the past.
 */
function assertNotExpired(bundle: SecretsBundle, selectedKeys: string[], allowExpired: boolean): void {
  if (allowExpired) return;
  if (!bundle.meta) return;
  const now = Date.now();
  for (const key of selectedKeys) {
    const meta = bundle.meta[key];
    if (!meta?.expires) continue;
    // expires is 'YYYY-MM-DD'; treat as end-of-day UTC.
    const expiry = new Date(meta.expires + 'T23:59:59Z').getTime();
    if (expiry < now) {
      throw new Error(
        `Bundle '${bundle.name}' key '${key}' expired on ${meta.expires}. ` +
        `Rotate it with: agents secrets rotate ${bundle.name} ${key}` +
        ` (or pass --allow-expired to skip this check).`,
      );
    }
  }
}

/**
 * Select the requested key subset, failing loud if any key is absent.
 */
function selectRequestedKeys(bundle: SecretsBundle, requested: string[] | undefined): Set<string> {
  const req = requested?.length ? requested : undefined;
  if (req) {
    const missing = req.filter((k) => !(k in bundle.vars));
    if (missing.length > 0) {
      const available = Object.keys(bundle.vars).join(', ') || '(none)';
      throw new Error(
        `Bundle '${bundle.name}' does not contain key(s): ${missing.join(', ')}. Available: ${available}.`,
      );
    }
  }
  return new Set(req ?? Object.keys(bundle.vars));
}

function assignResolvedEnvValue(
  env: Record<string, string>,
  bundle: SecretsBundle,
  storageKey: string,
  value: string,
  keyMode: ResolveBundleOptions['keyMode'],
  owners: Map<string, string>,
): void {
  const envKey = keyMode === 'storage' ? storageKey : bundleKeyToEnvKey(storageKey);
  const previous = owners.get(envKey);
  if (previous && previous !== storageKey) {
    throw new Error(
      `Bundle '${bundle.name}' maps multiple keys to '${envKey}': ${previous}, ${storageKey}. ` +
      `Select one account variant with --keys.`,
    );
  }
  owners.set(envKey, storageKey);
  env[envKey] = value;
}

function projectResolvedEnv(
  bundle: SecretsBundle,
  env: Record<string, string>,
  selectedKeys: Set<string>,
  keyMode: ResolveBundleOptions['keyMode'],
): Record<string, string> {
  if (keyMode === 'storage') {
    const out: Record<string, string> = {};
    for (const key of selectedKeys) {
      if (key in env) out[key] = env[key];
    }
    return out;
  }

  let needsProjection = false;
  const owners = new Map<string, string>();
  for (const key of selectedKeys) {
    const envKey = bundleKeyToEnvKey(key);
    if (envKey !== key) needsProjection = true;
    const previous = owners.get(envKey);
    if (previous && previous !== key) {
      throw new Error(
        `Bundle '${bundle.name}' maps multiple keys to '${envKey}': ${previous}, ${key}. ` +
        `Select one account variant with --keys.`,
      );
    }
    owners.set(envKey, key);
  }
  if (!needsProjection) {
    const envKeys = Object.keys(env);
    if (selectedKeys.size === envKeys.length && envKeys.every((key) => selectedKeys.has(key))) return env;
    const out: Record<string, string> = {};
    for (const key of selectedKeys) {
      if (key in env) out[key] = env[key];
    }
    return out;
  }

  const out: Record<string, string> = {};
  for (const key of selectedKeys) {
    if (key in env) out[bundleKeyToEnvKey(key)] = env[key];
  }
  return out;
}

export function canCacheResolvedEnv(bundle: SecretsBundle, selectedKeys: Set<string>, keyMode: ResolveBundleOptions['keyMode']): boolean {
  if (selectedKeys.size !== Object.keys(bundle.vars).length) return false;
  if (keyMode === 'storage') return true;
  for (const key of selectedKeys) {
    if (bundleKeyToEnvKey(key) !== key) return false;
  }
  return true;
}

/**
 * Apply --keys and --allow-expired to a broker snapshot so the fast path
 * mirrors the slow path's gates. Exported for tests.
 */
export function filterAgentHitBySubsetAndExpiry(
  hit: { bundle: SecretsBundle; env: Record<string, string> },
  opts: ResolveBundleOptions,
): { bundle: SecretsBundle; env: Record<string, string> } {
  const selectedKeys = selectRequestedKeys(hit.bundle, opts.keys);
  assertNotExpired(hit.bundle, [...selectedKeys], opts.allowExpired ?? false);
  const env = projectResolvedEnv(hit.bundle, hit.env, selectedKeys, opts.keyMode);
  // Return the cached reference unchanged when no subset/projection was applied.
  if (env === hit.env) return hit;
  return { bundle: hit.bundle, env };
}

/**
 * Fail loud when remote bundle resolution is asked for flags the SSH resolver
 * does not yet thread. Exported so callers share the same error text.
 */
export function assertRemoteBundleFlagsUnsupported(
  bundleName: string,
  host: string,
  opts: { keys?: string[]; allowExpired?: boolean },
  flagLabels: { keysFlag: string; allowExpiredFlag: string },
): void {
  const hasKeys = Array.isArray(opts.keys) && opts.keys.length > 0;
  if (!hasKeys && !opts.allowExpired) return;
  throw new Error(
    `Bundle '${bundleName}@${host}': ${flagLabels.keysFlag} and ${flagLabels.allowExpiredFlag} are not supported for remote (bundle@host) bundles yet. ` +
    `Drop the flag or resolve the bundle locally.`,
  );
}

/**
 * Build the right error for a missing `keychain:` ref. Classifies
 * present-but-unreadable (locked/denied) vs genuinely absent so `view` and reads
 * stay consistent. Only keychain has a locked state; file/vault misses are absent.
 */
function missingBundleKeychainItemError(
  bundleName: string,
  key: string,
  item: string,
  backendKind: SecretsBackend,
): Error {
  if (backendKind === 'keychain') {
    let present: boolean;
    try {
      present = hasKeychainToken(item);
    } catch (err) {
      return new Error(`Bundle '${bundleName}' key '${key}': ${(err as Error).message}`);
    }
    if (present) {
      return new Error(
        `Bundle '${bundleName}' key '${key}': stored item '${item}' is present but could not be read — ` +
        `the keychain is locked or Touch ID was not granted for this read. ` +
        `Run: agents secrets unlock ${bundleName}  (or read it once at an interactive terminal so Touch ID can be granted). ` +
        `Do NOT run 'agents secrets add' — the secret is already stored and adding would overwrite it.`,
      );
    }
  }
  return new Error(
    `Bundle '${bundleName}' key '${key}': stored item '${item}' not found. ` +
    `Run: agents secrets add ${bundleName} ${key}`,
  );
}

/**
 * Shared per-key resolver for `resolveBundleEnv` and `readAndResolveBundleEnv`.
 * Looks up keychain items by cleartext name then hashed alias; classifies misses
 * consistently so the two paths cannot diverge.
 */
function assembleBundleEnv(
  bundle: SecretsBundle,
  selectedKeys: Set<string>,
  parsedByKey: Map<string, { literal: string } | { ref: SecretRef }>,
  fetched: Map<string, string>,
  keyMode: ResolveBundleOptions['keyMode'],
  backendKind: SecretsBackend,
): Record<string, string> {
  const env: Record<string, string> = {};
  const owners = new Map<string, string>();
  for (const [key] of Object.entries(bundle.vars)) {
    if (!selectedKeys.has(key)) continue;
    const parsed = parsedByKey.get(key)!;
    if ('literal' in parsed) {
      assignResolvedEnvValue(env, bundle, key, parsed.literal, keyMode, owners);
      continue;
    }
    if (parsed.ref.provider === 'keychain') {
      const item = secretsKeychainItem(bundle.name, parsed.ref.value);
      const value = fetched.get(item) ?? fetched.get(keychainServiceAlias(item));
      if (value === undefined) {
        throw missingBundleKeychainItemError(bundle.name, key, item, backendKind);
      }
      assignResolvedEnvValue(env, bundle, key, value, keyMode, owners);
      continue;
    }
    try {
      const value = resolveRef(parsed.ref, {
        allowExec: bundle.allow_exec,
        keychainItemFor: (shortId: string) => secretsKeychainItem(bundle.name, shortId),
      });
      assignResolvedEnvValue(env, bundle, key, value, keyMode, owners);
    } catch (err) {
      throw new Error(`Bundle '${bundle.name}' key '${key}': ${(err as Error).message}`);
    }
  }
  return env;
}

// Resolve the bundle into a flat env map, batching keychain refs into one read
// so macOS shows one Touch ID prompt. Literals/env/file/exec refs resolve inline.
export function resolveBundleEnv(bundle: SecretsBundle, _opts: ResolveBundleOptions = {}): Record<string, string> {
  stampLastUsed(bundle);

  const selectedKeys = selectRequestedKeys(bundle, _opts.keys);
  assertNotExpired(bundle, [...selectedKeys], _opts.allowExpired ?? false);

  type Parsed = { literal: string } | { ref: SecretRef };
  const parsedByKey = new Map<string, Parsed>();
  const keychainItemsToFetch: string[] = [];
  for (const [key, raw] of Object.entries(bundle.vars)) {
    if (!selectedKeys.has(key)) continue;
    const parsed = parseBundleValue(raw);
    parsedByKey.set(key, parsed);
    if ('ref' in parsed && parsed.ref.provider === 'keychain') {
      keychainItemsToFetch.push(secretsKeychainItem(bundle.name, parsed.ref.value));
    }
  }

  const store = itemStore(bundle.backend ?? 'keychain');
  // Direct getKeychainTokens so `never`-policy bundles attest silentNoAcl in
  // headless contexts, while ACL'd bundles fail fast.
  const fetched = keychainItemsToFetch.length > 0
    ? (bundle.backend ?? 'keychain') === 'keychain'
      ? getKeychainTokens(keychainItemsToFetch, { silentNoAcl: bundlePolicy(bundle) === 'never' })
      : store.getBatch(keychainItemsToFetch)
    : new Map<string, string>();

  const env = assembleBundleEnv(
    bundle,
    selectedKeys,
    parsedByKey,
    fetched,
    _opts.keyMode,
    bundle.backend ?? 'keychain',
  );
  void _opts.caller; // informational only
  return env;
}

/**
 * True when the current process is a background / non-interactive context that
 * must NEVER raise a Keychain biometry prompt on the interactive user's screen.
 * Re-exported from ./headless.js — the detector lives there so the raw-read
 * path in index.ts can share it without a bundles↔index import cycle. See that
 * module for the full contract.
 */
export { isHeadlessSecretsContext, isAgentInvocationContext } from './headless.js';

/**
 * Read a bundle's metadata AND resolve its env in a single Touch ID prompt.
 * `readBundle` + `resolveBundleEnv` used to issue two LAContext calls (two
 * prompts). This collapses them into one batch that includes the metadata item.
 */
export function readAndResolveBundleEnv(
  name: string,
  opts: ResolveBundleOptions = {},
): { bundle: SecretsBundle; env: Record<string, string> } {
  validateBundleName(name);
  assertNameActiveInResourceProfile('secrets', name);

  const backend = bundleBackend(name);

  // Fast-path: broker-held snapshot ⇒ no Touch ID. Soft: any failure falls
  // through to the real keychain read. macOS/keychain only.
  if (backend === 'keychain' && !opts.noAgent && process.env.AGENTS_SECRETS_NO_AGENT !== '1') {
    // Falls back to GLOBAL so an unscoped unlock is visible in any harness.
    const harness = opts.agent || process.env.AGENTS_AGENT_NAME || GLOBAL_HARNESS;
    const hit = agentGetSync(name, harness);
    if (hit) {
      const denied = (opts.keys ?? []).filter((key) => hit.lease && !hit.lease.keys.includes(key));
      if (denied.length > 0) {
        emitSecretAudit({ event: 'secrets.lease-denied', bundle: name, operation: opts.caller, source: 'agent', status: 'error', keys: denied, keyCount: denied.length, agent: harness, error: 'key outside lease scope' });
        throw new Error(`Secret lease '${hit.lease?.id}' does not grant key(s): ${denied.join(', ')}`);
      }
      // Apply the same subset and expiry gates as the slow path.
      const filtered = filterAgentHitBySubsetAndExpiry(hit, opts);
      stampLastUsed(filtered.bundle);
      emitSecretAudit({
        event: 'secrets.get',
        bundle: name,
        operation: opts.caller,
        status: 'success',
        source: 'agent',
        keyCount: Object.keys(filtered.env).length,
        agent: harness,
      });
      return filtered;
    }

    // Durable-session fallback: after restart the broker RAM is empty, but a
    // no-ACL session item lets us re-warm the broker without Touch ID.
    const resolved = resolveSession(name, Date.now(), harness);
    if (resolved) {
      const session = resolved.entry;
      const denied = (opts.keys ?? []).filter((key) => session.lease && !session.lease.keys.includes(key));
      if (denied.length > 0) {
        emitSecretAudit({ event: 'secrets.lease-denied', bundle: name, operation: opts.caller, source: 'session', status: 'error', keys: denied, keyCount: denied.length, agent: harness, error: 'key outside lease scope' });
        throw new Error(`Secret lease '${session.lease?.id}' does not grant key(s): ${denied.join(', ')}`);
      }
      const filtered = filterAgentHitBySubsetAndExpiry({ bundle: session.bundle, env: session.env }, opts);
      stampLastUsed(filtered.bundle);
      // Re-warm under the scope the grant was made in so a global grant isn't
      // narrowed to the asking harness. No snapshotAt: the session bundle predates
      // this read; claiming freshness would defeat eviction tombstones.
      agentAutoLoadSync(name, session.bundle, session.env, Math.max(1, session.expiresAt - Date.now()), resolved.harness, session.lease);
      emitSecretAudit({
        event: 'secrets.get',
        bundle: name,
        operation: opts.caller,
        status: 'success',
        source: 'session',
        keyCount: Object.keys(filtered.env).length,
        agent: harness,
      });
      return filtered;
    }
  }

  const interactiveUnlock = opts.interactiveUnlock ?? false;
  // A `never`-policy bundle is prompt-free; attest silentNoAcl once verified.
  let verifiedNoAclBundle = false;
  if (opts.agentOnly && backend === 'keychain' && !interactiveUnlock && !keychainAgentOnlyBypassForTest) {
    try { verifiedNoAclBundle = bundlePolicy(readBundle(name)) === 'never'; } catch { /* fail closed */ }
    if (!verifiedNoAclBundle) {
      throw new Error(
        `Secrets bundle '${name}' is not unlocked in the secrets agent. ` +
        `Run 'agents secrets unlock ${name}' in a terminal first — an agent launch ` +
        `never raises a Touch ID sheet on its own.`
      );
    }
  }

  // Fail loud when the broker is disabled and this would otherwise prompt.
  // Never-policy bundles remain silent; vault/file are unaffected.
  if (backend === 'keychain' && !verifiedNoAclBundle && !isSecretsBrokerEnabled() && process.env.AGENTS_SECRETS_NO_AGENT !== '1') {
    throw new Error(
      `Secrets broker is disabled — re-enable with 'agents daemon services enable secrets-broker'. ` +
      `If you meant to read directly from the keychain, set AGENTS_SECRETS_NO_AGENT=1.`
    );
  }

  if (backend === 'vault') assertVaultBackendUsable(name);
  const store = itemStore(backend);

  const metaItem = bundleMetaItem(name);
  const bundleSecretPrefix = `${SECRETS_ITEM_PREFIX}${name}.`;
  let enumeratedSecretItems: string[] = [];
  // Agent-only launches must not enumerate the keychain: hashed names turn a
  // per-bundle prefix into a broad scan that evaluates unrelated ACLs (RUSH-2440).
  // Interactive reads keep the legacy enumeration path.
  if (backend !== 'keychain' || !opts.agentOnly) {
    try {
      enumeratedSecretItems = store.list(bundleSecretPrefix);
    } catch {
      enumeratedSecretItems = [];
    }
  }
  const reason = opts.caller
    ? `read ${name} secrets (for ${opts.caller})`
    : `read ${name} secrets`;

  // Capture snapshotAt before the first read so broker eviction tombstones beat
  // any concurrent load.
  const snapshotAt = Date.now();
  // Fetch metadata (always no-ACL) and derive secret item names from declared
  // keys, eliminating the broad keychain scan that triggered Touch ID (RUSH-2440).
  const metaFetched = backend === 'keychain'
    ? getKeychainTokens([metaItem], { silentNoAcl: true })
    : store.getBatch([...new Set([metaItem, ...enumeratedSecretItems])]);

  const json = metaFetched.get(metaItem);
  if (json === undefined) {
    if (vaultExists() && !getVaultSession().loggedIn) {
      throw new Error(`Synced secrets are locked. Run: agents secrets vault unlock`);
    }
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

  // Derive exact storage names from declared keychain refs. The env key and
  // stored item name may differ, so vars keys alone would read the wrong secret.
  const declaredSecretItems: string[] = [];
  if (parsed.vars && typeof parsed.vars === 'object') {
    for (const raw of Object.values(parsed.vars)) {
      const value = parseBundleValue(raw);
      if ('ref' in value && value.ref.provider === 'keychain') {
        declaredSecretItems.push(secretsKeychainItem(name, value.ref.value));
      }
    }
  }
  const secretItems = [...new Set([...enumeratedSecretItems, ...declaredSecretItems])];

  // Fetch metadata and secret values in one batch.
  const fetched = backend === 'keychain'
    ? getKeychainTokens([...new Set([metaItem, ...secretItems])], {
        agent: opts.agent || process.env.AGENTS_AGENT_NAME || 'Agents CLI',
        bundle: name,
        sessionId: process.env.AGENT_SESSION_ID || process.env.AGENTS_SESSION_ID,
        reason: opts.caller ? `to ${opts.caller}` : reason,
        duration: opts.duration || humanUnlockDuration(secretsHoldMs()),
        defaultPolicy: secretsDefaultPolicy(),
        forceDuration: Boolean(opts.duration),
        silentNoAcl: verifiedNoAclBundle,
      })
    // File/vault: reuse the initial batch to avoid double-decrypting.
    : metaFetched;
  const bundle: SecretsBundle = {
    name,
    description: parsed.description,
    allow_exec: Boolean(parsed.allow_exec),
    backend: backend === 'keychain' ? undefined : backend,
    policy: parsePolicy((parsed as { tier?: unknown }).tier),
    vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
  };
  if (typeof parsed.created_at === 'string') bundle.created_at = parsed.created_at;
  if (typeof parsed.updated_at === 'string') bundle.updated_at = parsed.updated_at;
  if (typeof parsed.last_used === 'string') bundle.last_used = parsed.last_used;
  if (parsed.meta && typeof parsed.meta === 'object') bundle.meta = parsed.meta;
  for (const key of Object.keys(bundle.vars)) {
    validateEnvKey(key);
  }

  const selectedKeys = selectRequestedKeys(bundle, opts.keys);
  assertNotExpired(bundle, [...selectedKeys], opts.allowExpired ?? false);

  stampLastUsed(bundle);

  type Parsed = { literal: string } | { ref: SecretRef };
  const parsedByKey = new Map<string, Parsed>();
  const keychainKeys: string[] = [];
  const kindCounts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(bundle.vars)) {
    if (!selectedKeys.has(key)) continue;
    const p = parseBundleValue(raw);
    parsedByKey.set(key, p);
    const kind = 'literal' in p ? 'literal' : p.ref.provider;
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    if ('ref' in p && p.ref.provider === 'keychain') {
      keychainKeys.push(key);
    }
  }
  const keys = [...selectedKeys].sort();
  keychainKeys.sort();

  const emitReadAudit = (status: 'success' | 'error', err?: unknown) => {
    emitSecretAudit({
      event: 'secrets.get',
      bundle: bundle.name,
      operation: opts.caller,
      status,
      keyCount: keys.length,
      keys,
      keychainKeys,
      kindCounts,
      agent: opts.agent,
      error: err instanceof Error ? err.message : (err ? String(err) : undefined),
    });
  };

  try {
    const env = assembleBundleEnv(bundle, selectedKeys, parsedByKey, fetched, opts.keyMode, backend);
    emitReadAudit('success');
    // Auto-cache into the broker so the next read is silent. Synchronous warm
    // when a broker is already up; cold-start uses the detached path.
    if (
      backend === 'keychain' &&
      !opts.noAgent &&
      process.env.AGENTS_SECRETS_NO_AGENT !== '1' &&
      bundlePolicy(bundle) === 'hold' &&
      secretsAgentAutoEnabled() &&
      canCacheResolvedEnv(bundle, selectedKeys, opts.keyMode)
    ) {
      agentAutoLoadSync(name, bundle, env, secretsHoldMs(), opts.agent || process.env.AGENTS_AGENT_NAME || GLOBAL_HARNESS, undefined, snapshotAt);
    }
    return { bundle, env };
  } catch (err) {
    emitReadAudit('error', err);
    throw err;
  }
}

export function humanUnlockDuration(ms: number): string {
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.round(ms / (60 * 1000)));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
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
 * Rotate a keychain-backed secret. Errors if the key is absent; preserves meta
 * unless cleared or patched.
 */
export function rotateBundleSecret(bundle: SecretsBundle, key: string, opts: RotateOptions): void {
  validateBundleName(bundle.name);
  validateEnvKey(key);
  if (!(key in bundle.vars)) {
    throw new Error(`Key '${key}' not in bundle '${bundle.name}'. Use 'agents secrets add' to add a new key.`);
  }
  const raw = bundle.vars[key];
  // Only keychain-backed values are rotated.
  if (typeof raw !== 'string' || !raw.startsWith('keychain:')) {
    throw new Error(`Key '${key}' in bundle '${bundle.name}' is not keychain-backed; cannot rotate.`);
  }
  const shortId = raw.slice('keychain:'.length);
  const item = secretsKeychainItem(bundle.name, shortId);
  itemStore(bundle.backend ?? 'keychain').set(item, opts.newValue, { noAcl: bundlePolicy(bundle) === 'never' });

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

/**
 * Reconcile keychain value items to the bundle's current policy. macOS gates
 * reads on each item's ACL, not the bundle's declared policy, so a policy change
 * alone would leave stale ACLs. hold/always → never strips ACL; never → *
 * re-attaches it. Non-keychain backends no-op.
 */
export function reAclBundleItems(bundle: SecretsBundle): void {
  if ((bundle.backend ?? 'keychain') !== 'keychain') {
    writeBundle(bundle);
    return;
  }
  const store = itemStore('keychain');
  const entries = keychainItemsForBundle(bundle);
  if (entries.length === 0) {
    writeBundle(bundle);
    return;
  }
  // One batch read ⇒ at most one Touch ID for the whole reconcile.
  const values = store.getBatch(entries.map((e) => e.item));
  const rewrite = new Map<string, string>();
  for (const { item } of entries) {
    const value = values.get(item);
    // A declared key with no readable value is corruption — fail loud.
    if (value === undefined) {
      throw new Error(
        `Cannot change policy for '${bundle.name}': a keychain value is missing or unreadable. Rotate that key, then retry.`,
      );
    }
    rewrite.set(item, value);
  }
  // writeBundleWithItems applies the correct noAcl flag and evicts the broker.
  writeBundleWithItems(bundle, rewrite);
}

/** Options for renameBundle. */
export interface RenameOptions {
  /** Overwrite an existing destination bundle. */
  force?: boolean;
}

/**
 * Rename a bundle: copy metadata + keychain values to the new name, then delete
 * the source. Steps are ordered so a copy-phase failure leaves the source intact.
 */
export function renameBundle(oldName: string, newName: string, opts: RenameOptions = {}): void {
  validateBundleName(oldName);
  validateBundleName(newName);
  if (oldName === newName) {
    throw new Error(`Bundle name unchanged ('${oldName}').`);
  }
  if (!bundleExists(oldName)) {
    throw new Error(`Bundle '${oldName}' not found.`);
  }
  const source = readBundle(oldName);
  const store = itemStore(source.backend ?? 'keychain');

  if (bundleExists(newName)) {
    if (!opts.force) {
      throw new Error(`Bundle '${newName}' already exists. Use --force to overwrite.`);
    }
    const dest = readBundle(newName);
    const destStore = itemStore(dest.backend ?? 'keychain');
    for (const { item } of keychainItemsForBundle(dest)) {
      destStore.delete(item);
    }
    deleteBundle(newName);
  }

  // Copy to the new name, leaving old items in place until cleanup.
  const sourceItems = keychainItemsForBundle(source);
  for (const { key, item: oldItem } of sourceItems) {
    const raw = source.vars[key];
    if (typeof raw !== 'string' || !raw.startsWith('keychain:')) continue;
    const shortId = raw.slice('keychain:'.length);
    const newItem = secretsKeychainItem(newName, shortId);
    const value = store.get(oldItem);
    store.set(newItem, value, { noAcl: bundlePolicy(source) === 'never' });
  }

  const renamed: SecretsBundle = { ...source, name: newName };
  writeBundle(renamed);

  // Cleanup: delete the old per-key items, then the old metadata.
  for (const { item: oldItem } of sourceItems) {
    store.delete(oldItem);
  }
  deleteBundle(oldName);

  emit('secrets.rename', { module: 'secrets', from: oldName, to: newName });
}

/**
 * The item store (keychain or encrypted file) for a bundle's per-key secrets.
 * Pass the resolved backend (`bundle.backend ?? 'keychain'`).
 */
export function bundleItemStore(
  backend: SecretsBackend | undefined,
  opts?: { noAcl?: boolean },
): {
  set(item: string, value: string): void;
  delete(item: string): boolean;
  get(item: string): string;
  has(item: string): boolean;
} {
  const store = itemStore(backend ?? 'keychain');
  // `never`-policy bundles write per-key values without the biometry ACL.
  if (opts?.noAcl) {
    return { ...store, set: (item, value) => store.set(item, value, { noAcl: true }) };
  }
  return store;
}

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
    if (BUNDLE_KEY_PATTERN.test(key)) {
      out[key] = value;
    }
  }
  return out;
}

export async function migrateLegacyBundles(confirmBundle: (candidate: LegacyBundleCandidate) => boolean | Promise<boolean>): Promise<number> {
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
      let parsed: Partial<SecretsBundle> | null;
      try {
        validateBundleName(name);
        const raw = fs.readFileSync(file, 'utf-8');
        parsed = yaml.parse(raw) as Partial<SecretsBundle> | null;
      } catch {
        // Leave malformed YAMLs in place so the user can inspect them.
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const bundle: SecretsBundle = {
        name,
        description: parsed.description,
        allow_exec: Boolean(parsed.allow_exec),
        vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
      };
      const keys = Object.keys(bundle.vars);
      for (const key of keys) {
        validateEnvKey(key);
      }
      const proceed = await confirmBundle({ name, file, keys });
      if (!proceed) continue;
      writeBundle(bundle);
      fs.unlinkSync(file);
      migrated++;
    }
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* not empty or already gone */ }
  }
  return migrated;
}

export type { SecretRef };
