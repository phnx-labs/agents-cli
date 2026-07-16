/**
 * Secret bundles — named sets of environment variables backed by a secret store.
 *
 * Bundle metadata (name, description, vars map) is stored as a JSON blob under
 * `agents-cli.bundles.<name>`; secret values live one per item under
 * `agents-cli.secrets.<bundle>.<key>`. Two backends carry those items:
 *
 *  - `keychain` (default): the macOS Keychain (device-local, Touch ID / device
 *    passcode gated) or Linux libsecret — see src/lib/secrets/index.ts.
 *  - `file`: an AES-256-GCM encrypted-file store keyed by a passphrase
 *    (src/lib/secrets/filestore.ts). Opt-in, for headless / remote runs where
 *    no biometry prompt can be satisfied (e.g. a release on a remote Mac over
 *    SSH). The item-name scheme is identical, so the only difference is where
 *    bytes land. A file-backed bundle is discovered by the presence of its
 *    metadata item in the file store.
 *
 * Cross-machine sync is handled by src/lib/secrets/sync.ts via an explicit
 * encrypted export/import flow; the bundle layer is sync-agnostic.
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
import { fileStore } from './filestore.js';
import { emit } from '../events.js';
import { readMeta } from '../state.js';
import { agentGetSync, agentAutoLoadSync, agentGetMetaSync, agentAutoLoadMetaSync, agentEvictSync, secretsAgentAutoEnabled, DEFAULT_TTL_MS } from './agent.js';
import { createHash } from 'node:crypto';

/** Which store carries a bundle's items. */
export type SecretsBackend = 'keychain' | 'file';

/**
 * Uniform read/write surface over a secret store, so the bundle functions
 * don't branch on backend at every call site.
 */
interface ItemStore {
  has(item: string): boolean;
  get(item: string): string;
  getBatch(items: string[]): Map<string, string>;
  /** `opts.noAcl` writes the item WITHOUT the biometry access control (the
   * `never` prompt-policy). Backends with no ACL concept (file store, test
   * backend) ignore it. */
  set(item: string, value: string, opts?: { noAcl?: boolean }): void;
  delete(item: string): boolean;
  list(prefix: string): string[];
}

const keychainStore: ItemStore = {
  has: hasKeychainToken,
  get: getKeychainToken,
  getBatch: getKeychainTokens,
  set: setKeychainToken,
  delete: deleteKeychainToken,
  list: listKeychainItems,
};

// The file store auto-provisions a machine-local passphrase on Linux (the
// existing headless-libsecret fallback) but NEVER on macOS: a file-backed
// bundle on a Mac must be unlocked with an explicit AGENTS_SECRETS_PASSPHRASE
// supplied per run, so the box holds ciphertext only. assertFileBackendUsable()
// enforces that the passphrase is present before we touch the store.
const FILE_ALLOW_AUTO_PROVISION = process.platform !== 'darwin';

const fileItemStore: ItemStore = {
  has: (item) => fileStore.has(item),
  get: (item) => fileStore.get(item, { allowAutoProvision: FILE_ALLOW_AUTO_PROVISION }),
  getBatch: (items) => {
    const out = new Map<string, string>();
    for (const item of items) {
      try {
        out.set(item, fileStore.get(item, { allowAutoProvision: FILE_ALLOW_AUTO_PROVISION }));
      } catch {
        // Missing/undecryptable item — absent from the map, mirroring
        // getKeychainTokens (caller decides whether that's an error).
      }
    }
    return out;
  },
  set: (item, value) => fileStore.set(item, value, { allowAutoProvision: FILE_ALLOW_AUTO_PROVISION }),
  delete: (item) => fileStore.delete(item),
  list: (prefix) => fileStore.list(prefix),
};

function itemStore(backend: SecretsBackend): ItemStore {
  return backend === 'file' ? fileItemStore : keychainStore;
}

/**
 * Discover a bundle's backend by location: a file-backed bundle's metadata
 * item exists in the encrypted-file store. This is a plain file-existence
 * check — no passphrase, no Touch ID — so it sidesteps the chicken-and-egg of
 * "read metadata to learn where metadata lives." Absent ⇒ keychain.
 */
export function bundleBackend(name: string): SecretsBackend {
  return fileStore.has(BUNDLE_META_PREFIX + name) ? 'file' : 'keychain';
}

/**
 * Guard a file-backed bundle operation. On macOS the file store must be
 * unlocked with an explicit passphrase (env or interactive prompt) — we refuse
 * to silently auto-provision a machine-local key there, so a remote/headless
 * Mac cannot decrypt on its own. Linux keeps the existing auto-provision
 * behavior, so this is a no-op there.
 */
function assertFileBackendUsable(name: string): void {
  if (process.platform !== 'darwin') return;
  if (process.env.AGENTS_SECRETS_PASSPHRASE && process.env.AGENTS_SECRETS_PASSPHRASE.length > 0) return;
  if (process.stdin.isTTY) return;
  throw new Error(
    `File-backed bundle '${name}' needs AGENTS_SECRETS_PASSPHRASE to be set on macOS ` +
    `(no biometry prompt is available headlessly). Set it for this run, e.g.\n` +
    `  AGENTS_SECRETS_PASSPHRASE=… agents secrets exec ${name} -- <command>`
  );
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

/** Per-secret metadata. All fields optional; absent ones omitted at write time. */
export interface VarMeta {
  type?: SecretType;
  /** ISO date 'YYYY-MM-DD'. Always future-dated at write time. */
  expires?: string;
  /** Singular freeform note. */
  note?: string;
}

/**
 * A bundle's prompt policy — how often macOS asks for Touch ID to read it:
 * - `daily` (default): ask once, then hold it silently for up to ~7 days.
 *   (Historical name — the window is now a rolling ~1 week, not one calendar day.)
 *   Eligible for the secrets-agent — the first real keychain read auto-loads it
 *   (auto-cache is on by default) so concurrent runs read it silently, or `unlock`
 *   it explicitly. Held from that unlock (not refreshed on use); re-asks sooner
 *   after sleep, logout, or `agents secrets lock`. A bare screen-lock does NOT
 *   drop it (the login password already gates a locked screen).
 * - `always`: asks every time. Never auto-held — only an explicit `agents
 *   secrets unlock` ever holds it; every other read pops Touch ID. Opt a
 *   high-value bundle into this when you want to confirm every single read.
 * - `never`: stored WITHOUT the biometry access control — reads are fully
 *   silent (no Touch ID, no broker). The least-safe tier: any code running as
 *   the user reads it with no user-presence check. Reserved for low-sensitivity,
 *   automation-only credentials. Writing a `never` item needs the signed helper's
 *   `set-no-acl` path (see keychain-helper.swift); an older pinned helper rejects
 *   it loudly rather than silently downgrading to `always`.
 *
 * The default is configurable via `secrets.policy` in agents.yaml. Stored on disk
 * under the legacy `tier` key (`session` == `daily`, `biometry` == explicit
 * `always`, `none` == `never`, absent == inherit the default) so bundles stay
 * readable across mixed CLI versions on synced machines. The user-facing
 * vocabulary is `policy`/`always`/`daily`/`never`.
 */
export type SecretsPolicy = 'always' | 'daily' | 'never';

/** A named set of environment variable definitions backed by various secret providers. */
export interface SecretsBundle {
  name: string;
  description?: string;
  allow_exec?: boolean;
  /** Which store carries this bundle's items. Absent ⇒ `keychain` (the default). */
  backend?: SecretsBackend;
  /** Prompt policy. Absent ⇒ the configured default (`daily`). Serialized under
   * the legacy `tier` key — see SecretsPolicy. */
  policy?: SecretsPolicy;
  /** ISO 8601 UTC timestamp. Set once on the first writeBundle() for a bundle. */
  created_at?: string;
  /** ISO 8601 UTC timestamp. Refreshed on every writeBundle(). */
  updated_at?: string;
  /** ISO 8601 UTC timestamp. Stamped by resolveBundleEnv (throttled). */
  last_used?: string;
  vars: Record<string, BundleValue>;
  /** Optional per-var metadata, keyed by var name (parallel to `vars`). */
  meta?: Record<string, VarMeta>;
}

export interface LegacyBundleCandidate {
  name: string;
  file: string;
  keys: string[];
}

/** Minimum gap between last_used updates so the keychain isn't written on every secrets injection. */
const LAST_USED_THROTTLE_MS = 60_000;

export const BUNDLE_NAME_PATTERN = /^[a-z0-9][a-z0-9\-_.]{0,48}$/i;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const BUNDLE_META_PREFIX = 'agents-cli.bundles.';
const SECRETS_ITEM_PREFIX = 'agents-cli.secrets.';

export const RESERVED_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'USERNAME', 'SHELL', 'PWD', 'OLDPWD',
  'TERM', 'LANG', 'LC_ALL', 'DISPLAY', 'EDITOR', 'VISUAL',
  'TMPDIR', 'TMP', 'TEMP', 'LOGNAME', 'UID', 'EUID', 'HOSTNAME',
]);

export function bundleToEnvPrefix(name: string): string {
  return name.replace(/[-\.]/g, '_').toUpperCase();
}

export function isReservedEnvName(key: string): boolean {
  return RESERVED_ENV_NAMES.has(key.toUpperCase());
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
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid environment variable name '${key}'. Must match [A-Za-z_][A-Za-z0-9_]*.`);
  }
  if (isLoaderOrInterpreterEnv(key) || isReservedEnvName(key)) {
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
  return itemStore(bundleBackend(name)).has(bundleMetaItem(name));
}

export function readBundle(name: string): SecretsBundle {
  validateBundleName(name);
  const backend = bundleBackend(name);
  if (backend === 'file') assertFileBackendUsable(name);
  let json: string;
  try {
    json = itemStore(backend).get(bundleMetaItem(name));
  } catch (err) {
    // A file-backed bundle whose metadata is on disk but fails to decrypt is a
    // wrong-passphrase error, not a missing bundle — surface that clearly.
    if (backend === 'file' && fileStore.has(bundleMetaItem(name))) {
      throw new Error(
        `Bundle '${name}': failed to decrypt — wrong AGENTS_SECRETS_PASSPHRASE or tampered file store. (${(err as Error).message})`,
      );
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
  // Unknown fields on the JSON (e.g. legacy sync flags) are silently dropped
  // here; the SecretsBundle shape is the only source of truth. `backend` is
  // authoritative from location discovery, not the persisted field.
  const bundle: SecretsBundle = {
    name,
    description: parsed.description,
    allow_exec: Boolean(parsed.allow_exec),
    // Absent ⇒ keychain; only set when file-backed so a keychain bundle
    // round-trips byte-for-byte.
    backend: backend === 'file' ? 'file' : undefined,
    // Legacy wire key: the policy is persisted under `tier` (`session` == `daily`).
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

/** Normalize the persisted prompt policy. The on-disk `tier` key uses legacy
 * tokens for cross-version compatibility: `session` ⇒ `daily`, `biometry` ⇒ an
 * explicit `always`. An absent token ⇒ undefined, which resolves to the
 * configured default policy (`daily`). Persisting an explicit `always` as the
 * legacy `biometry` token keeps older CLIs correct — they don't know `daily`,
 * read `biometry` as undefined, and fall back to their own always default. */
function parsePolicy(raw: unknown): SecretsPolicy | undefined {
  if (raw === 'daily' || raw === 'session') return 'daily';
  if (raw === 'always' || raw === 'biometry') return 'always';
  if (raw === 'never' || raw === 'none') return 'never';
  return undefined;
}

/** The default prompt policy applied to bundles without an explicit per-bundle
 * policy. Configurable via `secrets.policy` in agents.yaml; `daily` (one Touch
 * ID per ~7d) unless the user explicitly opts back into prompt-every-time with
 * `always`. Best-effort: an unreadable config falls back to the `daily` default. */
export function secretsDefaultPolicy(): SecretsPolicy {
  try {
    return readMeta().secrets?.policy === 'always' ? 'always' : 'daily';
  } catch {
    return 'daily';
  }
}

/** The effective prompt policy of a bundle (absent ⇒ the configured default). */
export function bundlePolicy(bundle: SecretsBundle): SecretsPolicy {
  return bundle.policy ?? secretsDefaultPolicy();
}

/** Options for writeBundle. */
export interface WriteBundleOptions {
  /**
   * Skip evicting the bundle from the secrets-agent broker after the write.
   * Only for writers that change nothing the broker serves — today that is
   * stampLastUsed (a usage-telemetry timestamp, fired on every broker HIT):
   * evicting there would make the cache destroy itself on first use. Every
   * mutating writer (add / rotate / remove / rename / policy / import) must
   * leave this unset so a broker-held copy never serves stale values for up
   * to the ~7d hold.
   */
  skipBrokerEviction?: boolean;
}

/**
 * Whether a bundle write should evict the broker-held copy. Pure + exported
 * for regression coverage. Skips when the writer opted out (stampLastUsed),
 * when the broker integration is disabled (AGENTS_SECRETS_NO_AGENT — the same
 * kill-switch the read fast-path honors), or when a test keychain backend is
 * installed (an in-memory backend has no real keychain behind it, and a test
 * writing bundle 'prod' must never evict the user's real 'prod' unlock).
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

export function writeBundle(bundle: SecretsBundle, opts: WriteBundleOptions = {}): void {
  validateBundleName(bundle.name);
  const backend: SecretsBackend = bundle.backend ?? 'keychain';
  if (backend === 'file') assertFileBackendUsable(bundle.name);
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
  // Stamp timestamps on the bundle so callers see what got persisted. created_at
  // is sticky — once set we never overwrite it, including on legacy bundles
  // that already carry one. updated_at always advances.
  const now = new Date().toISOString();
  if (!bundle.created_at) bundle.created_at = now;
  bundle.updated_at = now;
  const payload = {
    // The bundle's own name, persisted since #316: with hashed service names
    // the keychain item name is opaque, so listBundles recovers the display
    // name from this field. Older CLIs drop unknown fields on read — safe.
    name: bundle.name,
    description: bundle.description,
    allow_exec: bundle.allow_exec ? true : undefined,
    backend: backend === 'file' ? 'file' : undefined,
    // Wire format: persist the policy under the legacy `tier` token so older CLI
    // versions on other synced machines keep reading it — `daily`⇒`session`,
    // explicit `always`⇒`biometry`, `never`⇒`none`. An absent policy omits the
    // token entirely and resolves to the configured default (`daily`) on read.
    // An older CLI that doesn't know `none` reads it as undefined and falls back
    // to its own default — safe, since it also lacks the no-ACL write path.
    tier: bundle.policy === 'daily' ? 'session'
      : bundle.policy === 'always' ? 'biometry'
      : bundle.policy === 'never' ? 'none'
      : undefined,
    created_at: bundle.created_at,
    updated_at: bundle.updated_at,
    last_used: bundle.last_used,
    vars: bundle.vars,
    meta,
  };
  const json = JSON.stringify(payload);
  // A `never` bundle's metadata is stored without the biometry ACL too, so
  // `view` and the metadata half of a read resolve silently — the whole point
  // of the tier. On an un-updated pinned helper this write fails loudly (the
  // no-ACL command is missing) rather than silently landing an ACL'd item.
  itemStore(backend).set(bundleMetaItem(bundle.name), json, { noAcl: bundle.policy === 'never' });
  emit('secrets.set', { module: 'secrets', bundle: bundle.name });
  // A broker-held snapshot predates this write; evict it so the next read
  // re-resolves from the keychain instead of serving stale values.
  if (shouldEvictAfterBundleWrite(Boolean(opts.skipBrokerEviction), process.env.AGENTS_SECRETS_NO_AGENT, isKeychainBackendOverridden())) {
    agentEvictSync(bundle.name);
  }
}

export function deleteBundle(name: string): boolean {
  validateBundleName(name);
  const deleted = itemStore(bundleBackend(name)).delete(bundleMetaItem(name));
  if (deleted) {
    emit('secrets.delete', { module: 'secrets', bundle: name });
    if (shouldEvictAfterBundleWrite(false, process.env.AGENTS_SECRETS_NO_AGENT, isKeychainBackendOverridden())) {
      agentEvictSync(name);
    }
  }
  return deleted;
}

/**
 * Parse a stored metadata JSON blob into a SecretsBundle, applying the lenient
 * posture listBundles wants (skip malformed / invalid-key bundles rather than
 * throw). `backend` is authoritative from where the item was found. Returns
 * null to skip.
 *
 * `nameHint` is the name recovered from a cleartext service name (Linux, the
 * file store, pre-re-key items) — authoritative when present, and the only
 * source for legacy metadata that predates the persisted `name` field. With
 * hashed service names (macOS, #316) the hint is undefined and the name comes
 * from the JSON payload written by writeBundle.
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
    backend: backend === 'file' ? 'file' : undefined,
    // Legacy wire key: the policy is persisted under `tier` (`session` == `daily`).
    policy: parsePolicy((parsed as { tier?: unknown }).tier),
    vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
  };
  if (typeof parsed.created_at === 'string') bundle.created_at = parsed.created_at;
  if (typeof parsed.updated_at === 'string') bundle.updated_at = parsed.updated_at;
  if (typeof parsed.last_used === 'string') bundle.last_used = parsed.last_used;
  if (parsed.meta && typeof parsed.meta === 'object') bundle.meta = parsed.meta;
  for (const key of Object.keys(bundle.vars)) {
    if (!ENV_KEY_PATTERN.test(key)) return null;
  }
  return bundle;
}

export function listBundles(): SecretsBundle[] {
  const out: SecretsBundle[] = [];

  // Keychain-backed bundles: batch all metadata reads behind ONE Touch ID
  // prompt instead of N. Bundle metadata items carry user-presence ACLs (same
  // as secret values), so a naive loop over readBundle() spawns a fresh
  // LAContext per item — meaning N biometric prompts for `secrets list`.
  //
  // SKIP this entirely when the keychain backend is routing to the encrypted
  // file store (Linux headless / locked-collection fallback): there,
  // listKeychainItems() returns the SAME items the file enumeration below
  // reads, so running both would list every file-backed bundle twice — once
  // mislabeled `keychain`, once correctly `[file]`. Under the fallback the
  // file store is the single source of truth, so the block below covers all.
  if (!keychainUsesFileFallback()) {
    let keychainServices: string[] = [];
    try {
      keychainServices = listKeychainItems(BUNDLE_META_PREFIX);
    } catch {
      keychainServices = [];
    }
    // With hashed service names (macOS, #316) the enumerated services are
    // opaque (`agents-cli.h.<ns>.m`) — the display name is recovered from the
    // metadata JSON after the batch read below. Cleartext services (Linux,
    // pre-re-key items) still carry the name; it's kept as the parse hint so
    // legacy metadata without the persisted `name` field keeps listing.
    if (keychainServices.length > 0) {
      // Daily-policy fast-path (macOS). Bundle metadata items are biometry-gated,
      // so the getKeychainTokens batch below pops Touch ID on every `secrets
      // list` — the broker/`daily` mechanism only ever covered value reads, not
      // this listing. Serve a broker-cached metadata snapshot when one is held,
      // so only the first list per ~7d prompts. The cache key is a hash of the
      // current keychain name-set (enumerated silently above): add / remove /
      // rename a bundle and the key changes, so the stale snapshot is never
      // served. A same-name metadata edit (e.g. `secrets policy <b> always`)
      // does NOT change the key, so the POLICY column in `secrets list` can lag
      // by up to the hold window (~7d) until the next name-set change or `lock`.
      // This is cosmetic only — enforcement always reads the bundle's live
      // policy (readBundle), never this snapshot, and `secrets view <b>` shows
      // the fresh value immediately. Values are never cached here; metadata only.
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
        const fetched = getKeychainTokens(keychainServices);
        const keychainBundles: SecretsBundle[] = [];
        for (const service of keychainServices) {
          const json = fetched.get(service);
          if (json === undefined) continue;
          const nameHint = service.startsWith(BUNDLE_META_PREFIX)
            ? service.slice(BUNDLE_META_PREFIX.length)
            : undefined;
          const bundle = parseBundleMeta(nameHint, json, 'keychain');
          if (bundle) keychainBundles.push(bundle);
        }
        for (const bundle of keychainBundles) out.push(bundle);
        // Populate the broker for the rest of the hold window (fire-and-forget).
        if (useAgent && keychainBundles.length > 0) {
          agentAutoLoadMetaSync(nameSetHash, keychainBundles, DEFAULT_TTL_MS);
        }
      }
    }
  }

  // File-backed bundles live in the encrypted-file store. Enumeration is a
  // silent directory listing; only decryption needs the passphrase, so a
  // `secrets list` without one still shows the names (values stay sealed).
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
      // No passphrase (or wrong one): surface the bundle by name so it isn't
      // invisible, with empty vars. `agents secrets view` reports the error.
      out.push({ name, backend: 'file', vars: {} });
      continue;
    }
    const bundle = parseBundleMeta(name, json, 'file');
    if (bundle) out.push(bundle);
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

// Bump `bundle.last_used` and persist the bundle, but no more than once per
// throttle window so we don't pay a keychain write on every agent run. Failures
// are swallowed — usage tracking is never allowed to break secret resolution.
// Set AGENTS_NO_USAGE_TRACK=1 to disable the stamp entirely (used by tests).
function stampLastUsed(bundle: SecretsBundle): void {
  if (process.env.AGENTS_NO_USAGE_TRACK) return;
  const nowMs = Date.now();
  if (bundle.last_used) {
    const prev = Date.parse(bundle.last_used);
    if (Number.isFinite(prev) && nowMs - prev < LAST_USED_THROTTLE_MS) return;
  }
  try {
    bundle.last_used = new Date(nowMs).toISOString();
    // skipBrokerEviction: this stamp fires on every broker HIT; letting it
    // evict would make the cache destroy itself on first use.
    writeBundle(bundle, { skipBrokerEviction: true });
  } catch {
    // Swallow — telemetry must never block secret resolution.
  }
}

/** Options for resolveBundleEnv. */
export interface ResolveBundleOptions {
  /**
   * Human-readable label for who is requesting the secrets. Currently
   * informational only — the helper's Touch ID prompt is set by the OS and
   * cannot be reliably customized once we drop the per-batch reason path,
   * but we keep this in the API so call sites stay explicit about who's
   * about to read the bundle.
   */
  caller?: string;
  /**
   * Skip the secrets-agent fast-path and read straight from the keychain
   * (popping Touch ID). Set by callers that must NOT serve a cached snapshot —
   * `unlock` (which populates the agent in the first place) and any flow that
   * needs live values. Also honored via AGENTS_SECRETS_NO_AGENT=1.
   */
  noAgent?: boolean;
  /**
   * Resolve only from an already-unlocked secrets-agent snapshot. If the
   * broker has no snapshot, fail before touching Keychain or any other store.
   * Background processes use this to guarantee they never surface a biometric
   * prompt that nobody can answer.
   */
  agentOnly?: boolean;
  /**
   * Inject only this subset of keys from the bundle. Keys not in this list are
   * silently excluded from the returned env map. An error is thrown if any
   * requested key is absent from the bundle (fail-loud, never silent skip).
   * When absent or empty, all keys are injected (original behaviour).
   */
  keys?: string[];
  /**
   * When true, skip the pre-run expiry check and inject keys even if their
   * `expires` date is in the past. By default any expired key (or a key whose
   * bundle-level expiry has passed) aborts the run before Touch ID is popped.
   */
  allowExpired?: boolean;
}

/**
 * Abort if any of the selected keys has an `expires` date in the past.
 * Bundle-level expiry is not a concept today (expiry is per-key via `meta`),
 * so we iterate only the per-key meta entries.
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
 * Resolve the requested key subset against a bundle's `vars` map. Throws a
 * fail-loud error listing available keys if any requested key is absent. When
 * `requested` is undefined or empty, every key in the bundle is selected.
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

/**
 * Apply the --keys subset + expiry gate to an already-resolved snapshot from
 * the secrets-agent fast-path. The agent stores the FULL bundle env, so a
 * naive fast-path return would silently defeat --keys and inject expired
 * values. Mirrors the slow-path pre-checks in `resolveBundleEnv` /
 * `readAndResolveBundleEnv` and returns a new env whose keys match the subset.
 *
 * Exported for tests; production callers reach it via the fast-path branch in
 * `readAndResolveBundleEnv`.
 */
export function filterAgentHitBySubsetAndExpiry(
  hit: { bundle: SecretsBundle; env: Record<string, string> },
  opts: ResolveBundleOptions,
): { bundle: SecretsBundle; env: Record<string, string> } {
  const selectedKeys = selectRequestedKeys(hit.bundle, opts.keys);
  assertNotExpired(hit.bundle, [...selectedKeys], opts.allowExpired ?? false);
  // When no subset was requested, return the cached env untouched — same
  // reference the agent handed back, so no per-call allocation on the hot path.
  if (!opts.keys?.length) return hit;
  const env: Record<string, string> = {};
  for (const key of selectedKeys) {
    if (key in hit.env) env[key] = hit.env[key];
  }
  return { bundle: hit.bundle, env };
}

/**
 * Guard for remote-bundle callers (`bundle@host` / `--host`) — the SSH
 * resolver in `remoteResolveEnv` does not thread --keys or --allow-expired
 * yet. Silently applying them would inject the full remote env or an expired
 * value, defeating the least-privilege intent, so we fail loud.
 *
 * Exported so `agents run --secrets bundle@host` and `agents secrets exec
 * --host` share the exact same error text; the tests exercise this helper
 * directly instead of driving the whole CLI.
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

// Walk the bundle and produce a flat env map. Every keychain: ref is gathered
// into a single batch read so macOS shows ONE Touch ID prompt for the whole
// bundle — including the metadata fetch that already happened in readBundle
// (the helper's auth context survives across separate invocations only via
// the per-process LAContext, so we still get one prompt for the batch even
// if metadata triggered an earlier one). Literals/env/file/exec refs are
// resolved inline and never reach the keychain.
export function resolveBundleEnv(bundle: SecretsBundle, _opts: ResolveBundleOptions = {}): Record<string, string> {
  stampLastUsed(bundle);

  // Key-subset validation and expiry pre-check.
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
  const fetched = keychainItemsToFetch.length > 0
    ? store.getBatch(keychainItemsToFetch)
    : new Map<string, string>();

  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(bundle.vars)) {
    if (!selectedKeys.has(key)) continue;
    const parsed = parsedByKey.get(key)!;
    if ('literal' in parsed) {
      env[key] = parsed.literal;
      continue;
    }
    if (parsed.ref.provider === 'keychain') {
      const item = secretsKeychainItem(bundle.name, parsed.ref.value);
      const value = fetched.get(item);
      if (value === undefined) {
        throw new Error(
          `Bundle '${bundle.name}' key '${key}': stored item '${item}' not found. ` +
          `Run: agents secrets add ${bundle.name} ${key}`
        );
      }
      env[key] = value;
      continue;
    }
    try {
      env[key] = resolveRef(parsed.ref, {
        allowExec: bundle.allow_exec,
        keychainItemFor: (shortId: string) => secretsKeychainItem(bundle.name, shortId),
      });
    } catch (err) {
      throw new Error(`Bundle '${bundle.name}' key '${key}': ${(err as Error).message}`);
    }
  }
  // `caller` is intentionally unused; see ResolveBundleOptions.
  void _opts.caller;
  return env;
}

/**
 * True when the current process is a background / non-interactive context that
 * must NEVER raise a Keychain biometry prompt on the interactive user's screen —
 * a prompt nobody is watching. Two signals, either sufficient:
 *   - `AGENTS_RUNTIME` is `headless` or `teams` (set on the child env by
 *     `agents run --headless`, scheduled routines, and teammates — see
 *     exec.ts:resolveInteractive, runner.ts, teams/agents.ts).
 *   - neither stdin nor stdout is a TTY (a detached/backgrounded task whose
 *     stdio is redirected to a log — e.g. a release script run in the
 *     background as `( ... ) >log 2>&1 </dev/null`).
 * `AGENTS_SECRETS_NO_PROMPT=1` forces headless-safe; `=0` force-allows a prompt
 * even in a non-TTY context. An interactive `eval "$(agents secrets export X)"`
 * keeps its terminal stdin, so it is NOT classified headless and still prompts.
 *
 * Only **macOS keychain** reads pop an interactive Touch ID sheet — the secrets
 * broker itself is a no-op off darwin (see agent.ts), and libsecret (Linux) /
 * the Windows credential store resolve without any prompt. So off-darwin this
 * ALWAYS returns false: forcing broker-only there would break every headless
 * Linux/Windows read (CI, `agents run --headless`, routines, the Linux-driven
 * release flow) for no benefit — there is no prompt to suppress.
 *
 * A read in a macOS headless context resolves broker-only (agentOnly) and fails
 * fast with an actionable error instead of hijacking Touch ID. This generalizes
 * the per-caller pattern already used by the daemon (daemon.ts:readDaemonClaudeOAuthToken).
 */
export function isHeadlessSecretsContext(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false; // no biometry prompt to suppress off-darwin
  const override = env.AGENTS_SECRETS_NO_PROMPT;
  if (override === '1') return true;
  if (override === '0') return false;
  const runtime = env.AGENTS_RUNTIME;
  if (runtime === 'headless' || runtime === 'teams') return true;
  return !process.stdin.isTTY && !process.stdout.isTTY;
}

/**
 * Read a bundle's metadata AND resolve its env in a single Touch ID prompt.
 *
 * `readBundle` + `resolveBundleEnv` issued two separate `LAContext` calls
 * (metadata read via `get-auth`, then secret values via `get-batch`) which
 * surfaced as two consecutive Touch ID prompts. macOS does not honor
 * "Always Allow" for items protected with `kSecAttrAccessControl`+biometry,
 * so caching at the OS level was never an option. This collapses both reads
 * into one `get-batch` call: we enumerate the bundle's secret items first
 * (silent — `list` returns attrs only and does not trigger biometry) and
 * include the metadata item in the same batch. One prompt, correctly scoped
 * to the bundle name and caller.
 */
export function readAndResolveBundleEnv(
  name: string,
  opts: ResolveBundleOptions = {},
): { bundle: SecretsBundle; env: Record<string, string> } {
  validateBundleName(name);

  const backend = bundleBackend(name);

  // Fast-path: if the secrets-agent holds this bundle (user ran
  // `agents secrets unlock <name>`), return the cached snapshot with no Touch
  // ID. Soft — any failure falls through to the real keychain read below. macOS
  // / keychain only — the agent exists to dedup Touch ID prompts, and a
  // file-backed bundle has none to dedup. The never-unlocked path is a single
  // stat (agentSocketExists) so it costs nothing when the agent isn't running.
  if (backend === 'keychain' && !opts.noAgent && process.env.AGENTS_SECRETS_NO_AGENT !== '1') {
    const hit = agentGetSync(name);
    if (hit) {
      // The agent stores the FULL bundle env. Apply the same subset filter and
      // expiry gate as the slow path — without this, `--secrets-keys X` would
      // silently inject every key and an expired key would flow through after
      // the first cache-populating run.
      const filtered = filterAgentHitBySubsetAndExpiry(hit, opts);
      stampLastUsed(filtered.bundle);
      emit('secrets.get', {
        module: 'secrets',
        bundle: name,
        operation: opts.caller,
        status: 'success',
        source: 'agent',
        keyCount: Object.keys(filtered.env).length,
      });
      return filtered;
    }
  }

  // Only keychain-backed bundles can pop a Touch ID prompt and are the only ones
  // the broker ever holds. A file-backed bundle resolves via passphrase with no
  // prompt, so agentOnly must never block it — the broker never holds file
  // bundles, so the throw would fire unconditionally and break a legitimate read.
  if (opts.agentOnly && backend === 'keychain') {
    throw new Error(
      `Secrets bundle '${name}' is not unlocked in the secrets agent, and this is a ` +
      `headless/background process that must not raise a Touch ID prompt on the ` +
      `interactive user's screen. Run 'agents secrets unlock ${name}' in a terminal ` +
      `first, or set AGENTS_SECRETS_NO_PROMPT=0 to force an interactive prompt.`
    );
  }

  if (backend === 'file') assertFileBackendUsable(name);
  const store = itemStore(backend);

  const metaItem = bundleMetaItem(name);
  const bundleSecretPrefix = `${SECRETS_ITEM_PREFIX}${name}.`;
  let secretItems: string[];
  try {
    secretItems = store.list(bundleSecretPrefix);
  } catch {
    secretItems = [];
  }

  const reason = opts.caller
    ? `read ${name} secrets (for ${opts.caller})`
    : `read ${name} secrets`;

  void reason;
  // secretItems are storage names as enumerated (opaque hashed names on macOS
  // with #316 hashing active, cleartext elsewhere); metaItem is cleartext and
  // hashed inside getBatch. Deduped because the hashed enumeration spans the
  // bundle's whole namespace.
  const fetched = store.getBatch([...new Set([metaItem, ...secretItems])]);

  const json = fetched.get(metaItem);
  if (json === undefined) {
    // For a file-backed bundle the metadata item is on disk (that's how
    // bundleBackend resolved to 'file'); a missing decrypt means the wrong
    // passphrase, not a missing bundle. getBatch swallowed the decrypt error,
    // so distinguish here rather than report a misleading "not found".
    if (backend === 'file' && fileStore.has(metaItem)) {
      throw new Error(
        `Bundle '${name}': failed to decrypt — wrong AGENTS_SECRETS_PASSPHRASE or tampered file store.`,
      );
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
  const bundle: SecretsBundle = {
    name,
    description: parsed.description,
    allow_exec: Boolean(parsed.allow_exec),
    backend: backend === 'file' ? 'file' : undefined,
    // Legacy wire key: the policy is persisted under `tier` (`session` == `daily`).
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

  // Key-subset validation and expiry pre-check (mirrors resolveBundleEnv logic).
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
    emit('secrets.get', {
      module: 'secrets',
      bundle: bundle.name,
      operation: opts.caller,
      status,
      keyCount: keys.length,
      keys,
      keychainKeys,
      kindCounts,
      error: err instanceof Error ? err.message : (err ? String(err) : undefined),
    });
  };

  try {
    const env: Record<string, string> = {};
    for (const [key] of Object.entries(bundle.vars)) {
      if (!selectedKeys.has(key)) continue;
      const p = parsedByKey.get(key)!;
      if ('literal' in p) {
        env[key] = p.literal;
        continue;
      }
      if (p.ref.provider === 'keychain') {
        const item = secretsKeychainItem(bundle.name, p.ref.value);
        // The batch keys results by the names it was ASKED for: the cleartext
        // metaItem, plus enumerated storage names. Look up the cleartext name
        // first (Linux / file store), then its hashed storage alias (macOS).
        const value = fetched.get(item) ?? fetched.get(keychainServiceAlias(item));
        if (value === undefined) {
          throw new Error(
            `Bundle '${bundle.name}' key '${key}': stored item '${item}' not found. ` +
            `Run: agents secrets add ${bundle.name} ${key}`,
          );
        }
        env[key] = value;
        continue;
      }
      try {
        env[key] = resolveRef(p.ref, {
          allowExec: bundle.allow_exec,
          keychainItemFor: (shortId: string) => secretsKeychainItem(bundle.name, shortId),
        });
      } catch (err) {
        throw new Error(`Bundle '${bundle.name}' key '${key}': ${(err as Error).message}`);
      }
    }
    emitReadAudit('success');
    // Auto-cache: this was a real keychain read (the agent fast-path returned
    // earlier on a hit). If the bundle opts into the `daily` policy and the user
    // enabled `secrets.agent.auto`, populate the broker in the background so the
    // next concurrent run reads silently. Skipped when noAgent (e.g. `unlock`,
    // which loads the agent itself). Fire-and-forget — never blocks this read.
    if (
      backend === 'keychain' &&
      !opts.noAgent &&
      process.env.AGENTS_SECRETS_NO_AGENT !== '1' &&
      bundlePolicy(bundle) === 'daily' &&
      secretsAgentAutoEnabled()
    ) {
      agentAutoLoadSync(name, bundle, env, DEFAULT_TTL_MS);
    }
    return { bundle, env };
  } catch (err) {
    emitReadAudit('error', err);
    throw err;
  }
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

/** Options for renameBundle. */
export interface RenameOptions {
  /** When true, overwrite an existing destination bundle (purges its keychain items first). */
  force?: boolean;
}

/**
 * Rename a bundle: move metadata + every keychain-backed value to a new name.
 *
 * Sequence is ordered so the source stays intact if anything in the copy
 * phase fails:
 *   1) read source, validate dest
 *   2) purge dest if --force, refuse otherwise
 *   3) copy each keychain value source -> dest
 *   4) write new bundle metadata
 *   5) delete the old per-key keychain items + old metadata
 *
 * Steps 1-4 are reversible. If 5 partially fails, running `rename` again is
 * a safe no-op for the source items.
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
  // Rename stays within the source's backend. The store carries both the
  // per-key secret items and (via writeBundle/deleteBundle) the metadata.
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

  // Copy phase: read old item, write new item. Old items stay in place
  // until step 5 so a partial failure here leaves the source intact.
  const sourceItems = keychainItemsForBundle(source);
  for (const { key, item: oldItem } of sourceItems) {
    const raw = source.vars[key];
    if (typeof raw !== 'string' || !raw.startsWith('keychain:')) continue;
    const shortId = raw.slice('keychain:'.length);
    const newItem = secretsKeychainItem(newName, shortId);
    const value = store.get(oldItem);
    store.set(newItem, value, { noAcl: bundlePolicy(source) === 'never' });
  }

  // writeBundle preserves source.created_at, refreshes updated_at, and keeps
  // the source backend (spread carries source.backend).
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
 * The store (keychain or encrypted file) that carries a bundle's items. The
 * CLI uses this to read/write/delete per-key items (built with
 * secretsKeychainItem) in the same store as the bundle's metadata, for `add` /
 * `import` / `remove` / `delete`. Pass the bundle's resolved backend
 * (`bundle.backend ?? 'keychain'`).
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
  // `never`-policy bundles write their per-key values without the biometry ACL
  // (same rationale as the metadata write in writeBundle). Wrap `set` so every
  // value the add/import paths write inherits the no-ACL flag; reads, deletes,
  // and existence checks are ACL-independent and pass through untouched.
  if (opts?.noAcl) {
    return { ...store, set: (item, value) => store.set(item, value, { noAcl: true }) };
  }
  return store;
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
