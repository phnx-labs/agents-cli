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
 *  - `vault`: a single age-encrypted ~/.agents/vault.age file unlocked by
 *    `agents login`; intended for user-managed cross-machine file sync.
 *
 * Server-backed cross-machine sync is handled by src/lib/secrets/sync.ts via
 * an explicit encrypted export/import flow; the bundle layer also supports the
 * local vault backend for user-managed file sync.
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
import { emit } from '../events.js';
import { emitSecretAudit } from './audit.js';
import { readMeta, getHelpersDir } from '../state.js';
import { assertNameActiveInResourceProfile, filterNamesForActiveResourceProfile } from '../resource-profiles.js';
import { agentGetSync, agentAutoLoadSync, agentGetMetaSync, agentAutoLoadMetaSync, agentEvictSync, secretsAgentAutoEnabled, secretsHoldMs } from './agent.js';
import { GLOBAL_HARNESS } from './scope.js';
import { resolveSession, deleteSession } from './session-store.js';
import { createHash } from 'node:crypto';

/** Which store carries a bundle's items. */
export type SecretsBackend = 'keychain' | 'file' | 'vault';

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

// The file store auto-provisions a stable machine-local passphrase on EVERY
// platform (macOS included) — a 0600 key file, encryption-at-rest with the same
// posture as an SSH key — so `agents secrets` "just works" with no passphrase to
// set, type, or remember, and no Touch ID. Set AGENTS_SECRETS_PASSPHRASE to opt
// into an off-disk key.
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
 * Discover a bundle's backend by location: a file-backed bundle's metadata
 * item exists in the encrypted-file store. This is a plain file-existence
 * check — no passphrase, no Touch ID — so it sidesteps the chicken-and-egg of
 * "read metadata to learn where metadata lives." Absent ⇒ keychain.
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
  throw new Error(`Synced bundle '${name}' needs an active login. Run: agents login`);
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
 * - `hold` (default): ask once, then serve it silently for the configured hold
 *   duration (`secrets.agent.holdMs`, 7d by default). Named for what it does —
 *   it was called `daily`, which stated a period it never had.
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
 * under the legacy `tier` key (`session` == `hold`, `biometry` == explicit
 * `always`, `none` == `never`, absent == inherit the default) so bundles stay
 * readable across mixed CLI versions on synced machines. The user-facing
 * vocabulary is `policy`/`always`/`hold`/`never`.
 */
export type SecretsPolicy = 'always' | 'hold' | 'never';

/** A named set of environment variable definitions backed by various secret providers. */
export interface SecretsBundle {
  name: string;
  description?: string;
  allow_exec?: boolean;
  /** Which store carries this bundle's items. Absent ⇒ `keychain` (the default). */
  backend?: SecretsBackend;
  /** Prompt policy. Absent ⇒ the configured default (`hold`). Serialized under
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
export const BUNDLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)?$/;
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

/**
 * Thrown by `readBundle` for the one state `readBundleIfDecryptable` may treat
 * as "present but permanently unreadable": file-store ciphertext on disk that
 * will not decrypt with the passphrase in effect (lost/rotated key or a tampered
 * store). It is deliberately narrow — a bundle that is merely *locked for this
 * run* (headless macOS without `AGENTS_SECRETS_PASSPHRASE`, or a vault that is
 * not logged in) is recoverable and must not be collapsed into this.
 */
export class BundleUndecryptableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleUndecryptableError';
  }
}

/**
 * Read a bundle, or return null when its metadata is present but genuinely
 * cannot be decrypted — a lost or rotated file-store passphrase, or a tampered
 * file store (signalled by `BundleUndecryptableError`).
 *
 * Deleting such a bundle is the only way out of that state, and deletion needs
 * no plaintext, so it must not be gated behind a successful decrypt. Every other
 * failure rethrows: a genuinely missing bundle ("not found"), and — critically —
 * a bundle that is only *temporarily locked* for this run (headless macOS with no
 * `AGENTS_SECRETS_PASSPHRASE`, or a not-logged-in vault). Collapsing that
 * recoverable "set the env / log in" state into "unreadable, safe to delete"
 * would let `secrets delete <name> --yes` silently destroy a perfectly healthy
 * bundle from a cron/launchd run that merely forgot to export the passphrase.
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
    // Bundle metadata carries no biometry ACL (SEC-4), so this read is silent
    // even in a headless context — attest that to the raw-read storm guard so
    // a headless `readBundle` never trips the fail-fast. (A legacy
    // pre-metadata-heal ACL'd metadata item can still prompt once; it heals on
    // the next interactive read.)
    json = backend === 'keychain'
      ? getKeychainToken(bundleMetaItem(name), { silentNoAcl: true })
      : itemStore(backend).get(bundleMetaItem(name));
  } catch (err) {
    // A file-backed bundle whose metadata is on disk but fails to decrypt is a
    // wrong-passphrase error, not a missing bundle — surface that clearly.
    if (backend === 'file' && fileStore.has(bundleMetaItem(name))) {
      throw new BundleUndecryptableError(
        `Bundle '${name}': failed to decrypt — wrong AGENTS_SECRETS_PASSPHRASE or tampered file store. (${(err as Error).message})`,
      );
    }
    if (vaultExists() && !getVaultSession().loggedIn) {
      throw new Error(`Synced secrets are locked. Run: agents login`);
    }
    // Distinguish a genuinely-absent bundle from a present-but-unreadable one
    // (a locked login keychain, or a legacy ACL'd metadata item before first
    // unlock). `has` counts an unreadable item as present, so a metadata item
    // that exists but could not be read must not report as "not found" — an
    // existence answer and a read answer may not contradict (RUSH-2253).
    if (backend === 'keychain') {
      let present: boolean;
      try {
        present = hasKeychainToken(bundleMetaItem(name));
      } catch (probeErr) {
        // Keychain unreachable (RUSH-2235 fail-loud): neither absent nor
        // add-the-key — surface the reachability failure, not a false absence.
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
  // Unknown fields on the JSON (e.g. legacy sync flags) are silently dropped
  // here; the SecretsBundle shape is the only source of truth. `backend` is
  // authoritative from location discovery, not the persisted field.
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

/** Normalize the persisted prompt policy. The on-disk `tier` key uses legacy
 * tokens for cross-version compatibility: `session` ⇒ `hold`, `biometry` ⇒ an
 * explicit `always`. An absent token ⇒ undefined, which resolves to the
 * configured default policy (`hold`). Persisting an explicit `always` as the
 * legacy `biometry` token keeps older CLIs correct — they don't know `hold`,
 * read `biometry` as undefined, and fall back to their own always default. */
function parsePolicy(raw: unknown): SecretsPolicy | undefined {
  if (raw === 'hold' || raw === 'daily' || raw === 'session') return 'hold';
  if (raw === 'always' || raw === 'biometry') return 'always';
  if (raw === 'never' || raw === 'none') return 'never';
  return undefined;
}

/** The default prompt policy applied to bundles without an explicit per-bundle
 * policy. Configurable via `secrets.policy` in agents.yaml; `hold` (one Touch ID
 * per hold window — `secrets.agent.holdMs`, 7d by default) unless the user
 * explicitly opts back into prompt-every-time with `always`. Best-effort: an
 * unreadable config falls back to the `hold` default. */
export function secretsDefaultPolicy(): SecretsPolicy {
  try {
    return readMeta().secrets?.policy === 'always' ? 'always' : 'hold';
  } catch {
    return 'hold';
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

interface PreparedBundleWrite {
  backend: SecretsBackend;
  metadataItem: string;
  metadataJson: string;
}

function prepareBundleWrite(bundle: SecretsBundle): PreparedBundleWrite {
  validateBundleName(bundle.name);
  const backend: SecretsBackend = bundle.backend ?? 'keychain';
  if (backend === 'vault') assertVaultBackendUsable(bundle.name);
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
    backend: backend === 'keychain' ? undefined : backend,
    // Wire format: persist the policy under the legacy `tier` token so older CLI
    // versions on other synced machines keep reading it — `hold`⇒`session`,
    // explicit `always`⇒`biometry`, `never`⇒`none`. An absent policy omits the
    // token entirely and resolves to the configured default (`hold`) on read.
    // An older CLI that doesn't know `none` reads it as undefined and falls back
    // to its own default — safe, since it also lacks the no-ACL write path.
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
  // A broker-held snapshot predates this write; evict it so the next read
  // re-resolves from the keychain instead of serving stale values.
  if (shouldEvictAfterBundleWrite(Boolean(opts.skipBrokerEviction), process.env.AGENTS_SECRETS_NO_AGENT, isKeychainBackendOverridden())) {
    agentEvictSync(bundle.name);
    // Also drop any durable session snapshot, or a broker restart would rehydrate
    // the stale env after a rotate/rename (session-store.ts).
    deleteSession(bundle.name);
  }
}

export function writeBundle(bundle: SecretsBundle, opts: WriteBundleOptions = {}): void {
  const prepared = prepareBundleWrite(bundle);
  // Bundle metadata (name, description, policy, var names + refs, and any
  // non-sensitive `--value` literals) is stored WITHOUT the biometry ACL at
  // EVERY tier. It is non-sensitive by contract — the real secret values live in
  // separate agents-cli.secrets.* items that keep the bundle's policy ACL — so a
  // no-ACL metadata item is what lets `secrets list` and crabbox's `agents
  // devices list` enumerate bundles with no Touch ID prompt (RUSH-1759). On an
  // un-updated pinned helper this write fails loudly (the no-ACL command is
  // missing) rather than silently landing an ACL'd item.
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
    // Only the keychain backend has a biometry ACL. Secret VALUE items carry the
    // bundle's policy ACL (`never` ⇒ no-ACL); the metadata item is ALWAYS no-ACL
    // (see writeBundle). The two must NOT ride one batch flag — a single noAcl
    // over both would either strip biometry off the real secrets or re-ACL the
    // metadata. Write the values first, then the metadata last: bundle discovery
    // keys on the metadata item's presence, so metadata-last means a partial
    // write reads as "no bundle yet", never as a bundle with missing values.
    if (items.size > 0) {
      store.setBatch(new Map(items), { noAcl: bundle.policy === 'never' });
    }
    store.set(prepared.metadataItem, prepared.metadataJson, { noAcl: true });
    addBundleToMetaIndex(bundle.name);
  } else {
    // file / vault: no ACL concept (noAcl is ignored), so one batched write is
    // both correct and cheaper — e.g. a single age re-encrypt for the vault.
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

// Sentinel marking the one-time RUSH-1759 metadata-ACL heal as done. Lives under
// the regenerable helpers dir (same tree as the secrets-agent runtime state), so
// a cache wipe just re-runs the heal — harmless, since it is idempotent.
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
    // Best effort — a missing sentinel just means the (idempotent) heal re-runs
    // on the next broker-miss listing.
  }
}

// ── No-ACL bundle-metadata name index (kills the enumeration Touch ID storm) ──
// listBundles cannot ask the keychain for "just the metadata items": with hashed
// service names (#316) the metadata names are opaque (`agents-cli.h.<ns>.m`), so
// listKeychainItems(BUNDLE_META_PREFIX) falls back to a BROAD `agents-cli.` scan
// that also MATCHES the ACL'd secret VALUE items. On some machines macOS
// evaluates those value ACLs during that attributes-only scan and pops a generic
// "Agents CLI needs to authenticate" sheet — on EVERY launch (session-title
// generation, `agents devices list`, every agent run), because listBundles runs
// on essentially every secrets touch. Neither UIFail nor LAContext can list the
// no-ACL items while skipping the ACL'd ones (both return nothing), so the fix is
// to NOT do the broad scan: keep a per-machine index of the metadata items'
// STORAGE names in the regenerable helpers dir and read THAT (a silent file read)
// instead. The index holds opaque hashes only — no cleartext bundle names, so it
// leaks nothing #316 didn't already. It self-heals: absent/unbuilt → listBundles
// rebuilds it from the one-time broad scan; a stale entry only makes `secrets
// list` cosmetically incomplete and never affects a resolve-by-name (which
// computes the hashed name directly, never through this index).
function bundleMetaIndexPath(): string {
  // Test-only override (mirrors AGENTS_DAEMON_DIR): redirect to a fork-private
  // temp so unit tests never touch the real helpers dir. Never set in prod.
  return (
    process.env.AGENTS_SECRETS_META_INDEX_FILE ||
    path.join(getHelpersDir(), 'secrets-agent', 'bundle-meta-index.json')
  );
}

// Changes iff the service-name hashing key changes (the #316 re-key, or a
// cleartext<->hashed transition). Stamped into the index so an index built under
// an OLD key reads as absent and is rebuilt — otherwise a re-key would leave
// stale hashed names that resolve to nothing and make every bundle "vanish".
function metaIndexFingerprint(): string {
  return keychainServiceAlias(`${BUNDLE_META_PREFIX}meta-index-fingerprint`);
}

function readBundleMetaIndex(): string[] | null {
  // A test-installed in-memory keychain is NOT the real store this index mirrors;
  // reading (and later writing) the real ~/.agents index from a mock-backend test
  // would leak fixture bundle names into a developer's live cache. Same guard the
  // sibling healKeychainBundleMetadataAclOnce uses — treat the index as absent so
  // listBundles falls back to the (mock) scan.
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
    // Atomic write (unique temp + rename) so a concurrent reader/writer never
    // sees a half-written file. The read-modify-write in add/remove can still
    // race two concurrent BUNDLE mutations and drop an entry, but that only makes
    // a `secrets list` cosmetically incomplete (never a resolve-by-name) and
    // self-heals on the next rebuild — an acceptable trade for rare bundle edits.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // Best effort — a missing index just means listBundles rebuilds it from the
    // one-time broad scan on the next enumeration.
  }
}

// Append a metadata item's STORAGE name to an ALREADY-BUILT index. No-op when the
// index has not been built yet (null): never create a one-entry index that would
// hide every OTHER bundle — listBundles builds the complete index on its first
// scan, and this newly-written bundle is included in that scan.
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
 * Re-write already-read keychain bundle metadata items WITHOUT the biometry ACL.
 * `metaJsonByName` maps bundle name → the exact metadata JSON listBundles just
 * batch-read, so writing it back only flips the ACL (via the helper's
 * delete-then-add `set-no-acl`) — contents and updated_at are preserved and no
 * extra keychain read is issued. Exported for tests. Returns the count healed.
 */
export function healKeychainBundleMetadata(metaJsonByName: Map<string, string>): number {
  let healed = 0;
  for (const [name, json] of metaJsonByName) {
    try {
      // Cleartext meta-item name → hashed by keychainStore.set (#316) to the same
      // service the read enumerated, so this overwrites the existing item in
      // place, no-ACL. A per-item failure (e.g. a pinned helper without
      // set-no-acl) must not abort the rest.
      keychainStore.set(bundleMetaItem(name), json, { noAcl: true });
      healed++;
    } catch {
      /* keep healing the remaining items */
    }
  }
  return healed;
}

/**
 * One-time driver around healKeychainBundleMetadata (RUSH-1759). macOS + real
 * keychain only — libsecret/CredMan have no biometry ACL to shed, and a test
 * backend has no real keychain — and gated by a sentinel so it runs at most
 * once. Best-effort: a heal failure never breaks bundle listing.
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
        // Metadata enumeration must stay silent in ANY context (SEC-11):
        // bundle metadata items are no-ACL by contract (SEC-4), so attest that
        // to the raw-read storm guard — a headless `listBundles` (session
        // start, crabbox env, devices fan-out) must never fail fast on the
        // guard nor pop a sheet. (A legacy pre-heal ACL'd metadata item can
        // still prompt once; it heals on the next interactive scan.)
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
        // Populate the broker for the rest of the hold window (fire-and-forget).
        // Same configurable cap as the value read-path — otherwise `secrets list`
        // would keep serving a stale metadata snapshot for 7d even when the user
        // capped the hold at 24h via secrets.agent.holdMs.
        if (useAgent && keychainBundles.length > 0) {
          agentAutoLoadMetaSync(nameSetHash, keychainBundles, secretsHoldMs());
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
  /** Harness type whose unlock may be reused (claude, codex, kimi, ...). */
  agent?: string;
  /** Human duration rendered in the Touch ID prompt. */
  duration?: string;
  /** Explicitly permit this agent request to raise interactive authentication. */
  interactiveUnlock?: boolean;
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
  /**
   * `process` projects dotted account keys like `GITHUB_USERNAME.personal` to
   * the shell-safe base env name (`GITHUB_USERNAME`). Direct value lookups and
   * backup/export flows use `storage` to preserve the exact bundle key names.
   */
  keyMode?: 'process' | 'storage';
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
  const env = projectResolvedEnv(hit.bundle, hit.env, selectedKeys, opts.keyMode);
  // When no subset/projection was requested, return the cached env untouched —
  // same reference the agent handed back, so no per-call allocation on the hot path.
  if (env === hit.env) return hit;
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

/**
 * A declared `keychain:` ref resolved to NO value in the batch read. Classify
 * genuinely-absent vs present-but-unreadable before choosing the error, so a
 * read can never contradict what `agents secrets view` reports (RUSH-2248,
 * RUSH-2253). `view`'s "stored" badge comes from `hasKeychainToken` — the exact
 * existence probe used here — which counts a biometry-ACL'd or locked-keychain
 * item (`errSecInteractionNotAllowed`) as present. So:
 *
 *   - present  ⇒ the item exists but this context could not read it (keychain
 *     locked, or Touch ID not granted). Report HOW to unlock; NEVER
 *     "add the key", whose remediation (`secrets add`) would overwrite a good
 *     secret.
 *   - absent   ⇒ genuinely not stored on this machine — the honest "not found"
 *     with the `secrets add` remediation.
 *   - probe throws ⇒ the keychain itself is unreachable (RUSH-2235 fail-loud):
 *     neither absent nor add-the-key — surface the reachability failure verbatim.
 *
 * Only the keychain backend has a locked/biometry state; a file/vault miss is
 * genuinely absent.
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
 * Resolve every selected key of an already-read bundle into a flat env map,
 * given a pre-fetched keychain batch. The single per-key resolution loop shared
 * by `resolveBundleEnv` and `readAndResolveBundleEnv` so the keychain lookup and
 * the missing-item classification can never diverge again (RUSH-2252: the two
 * paths drifted — one did the hashed-alias fallback lookup and one did not, and
 * only one classified a missing item honestly).
 *
 * The keychain lookup tries the cleartext name first (Linux / file store), then
 * its hashed storage alias (macOS with #316 hashing active) — the batch keys its
 * results by the names it was ASKED for, which for the metadata + declared keys
 * is the cleartext form and for an enumerated leftover is the hashed form.
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
  // keychainStore.getBatch IS getKeychainTokens — call it directly so a
  // `never`-policy bundle (no biometry ACL on its items) attests `silentNoAcl`
  // and stays readable in a headless context, while an ACL'd policy hits the
  // raw-read storm guard and fails fast there.
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
  // `caller` is intentionally unused; see ResolveBundleOptions.
  void _opts.caller;
  return env;
}

/**
 * True when the current process is a background / non-interactive context that
 * must NEVER raise a Keychain biometry prompt on the interactive user's screen.
 * Re-exported from ./headless.js — the detector lives there so the raw-read
 * path in index.ts can share it without a bundles↔index import cycle. See that
 * module for the full contract.
 */
export { isHeadlessSecretsContext } from './headless.js';

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
  assertNameActiveInResourceProfile('secrets', name);

  const backend = bundleBackend(name);

  // Fast-path: if the secrets-agent holds this bundle (user ran
  // `agents secrets unlock <name>`), return the cached snapshot with no Touch
  // ID. Soft — any failure falls through to the real keychain read below. macOS
  // / keychain only — the agent exists to dedup Touch ID prompts, and a
  // file-backed bundle has none to dedup. The never-unlocked path is a single
  // stat (agentSocketExists) so it costs nothing when the agent isn't running.
  if (backend === 'keychain' && !opts.noAgent && process.env.AGENTS_SECRETS_NO_AGENT !== '1') {
    // The scope this reader asks under. Falls back to the GLOBAL scope, not to a
    // literal `'cli'` harness — the broker and the durable store both resolve
    // own-harness → global (bundleScopeChain), so an unscoped unlock is visible
    // here whether this process was launched by an agent or typed in a terminal.
    const harness = opts.agent || process.env.AGENTS_AGENT_NAME || GLOBAL_HARNESS;
    const hit = agentGetSync(name, harness);
    if (hit) {
      const denied = (opts.keys ?? []).filter((key) => hit.lease && !hit.lease.keys.includes(key));
      if (denied.length > 0) {
        emitSecretAudit({ event: 'secrets.lease-denied', bundle: name, operation: opts.caller, source: 'agent', status: 'error', keys: denied, keyCount: denied.length, agent: harness, error: 'key outside lease scope' });
        throw new Error(`Secret lease '${hit.lease?.id}' does not grant key(s): ${denied.join(', ')}`);
      }
      // The agent stores a full unlock or a scoped lease env. Apply the same subset filter and
      // expiry gate as the slow path — without this, `--secrets-keys X` would
      // silently inject every key and an expired key would flow through after
      // the first cache-populating run.
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

    // Durable-session fallback (Correction B). After a daemon restart / agents-cli
    // upgrade the broker RAM is empty, so the fast-path above misses — but the
    // unlock persisted a no-ACL session item (session-store.ts) that reads with NO
    // Touch ID. Serve from it and re-warm the broker, so a warm bundle stays warm
    // across restart — this fixes BOTH the interactive re-prompt and the headless
    // throw below (which now fires only when there is genuinely no session).
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
      // Re-warm the broker with the remaining TTL so later reads hit RAM and
      // `agents secrets status` is honest. Re-warm under the scope the grant was
      // MADE in (resolved.harness), never the asking scope — re-warming a global
      // grant as `claude` would silently narrow it for every other harness.
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

  // Never/no-ACL bundles remain prompt-free regardless. Every ordinary caller
  // sets agentOnly; only the unlock handler opts into interactive authentication.
  const interactiveUnlock = opts.interactiveUnlock ?? false;
  // A `never`-policy bundle's items carry no biometry ACL, so once the policy
  // check below proves that, the batch read is silent even in a headless
  // context — attest it to the raw-read storm guard via `silentNoAcl`.
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

  if (backend === 'vault') assertVaultBackendUsable(name);
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

  // secretItems are storage names as enumerated (opaque hashed names on macOS
  // with #316 hashing active, cleartext elsewhere); metaItem is cleartext and
  // hashed inside getBatch. Deduped because the hashed enumeration spans the
  // bundle's whole namespace.
  const fetched = backend === 'keychain'
    ? getKeychainTokens([...new Set([metaItem, ...secretItems])], {
        agent: opts.agent || process.env.AGENTS_AGENT_NAME || 'Agents CLI',
        bundle: name,
        // The session that triggered the read, so a Touch ID prompt is
        // attributable when several agents run at once. Exported by exec.ts.
        sessionId: process.env.AGENT_SESSION_ID || process.env.AGENTS_SESSION_ID,
        reason: opts.caller ? `to ${opts.caller}` : reason,
        duration: opts.duration || humanUnlockDuration(secretsHoldMs()),
        defaultPolicy: secretsDefaultPolicy(),
        forceDuration: Boolean(opts.duration),
        silentNoAcl: verifiedNoAclBundle,
      })
    : store.getBatch([...new Set([metaItem, ...secretItems])]);

  const json = fetched.get(metaItem);
  if (json === undefined) {
    if (vaultExists() && !getVaultSession().loggedIn) {
      throw new Error(`Synced secrets are locked. Run: agents login`);
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

  // RUSH-2252: complete the read set from the bundle's DECLARED keys, not only
  // from the enumeration above. `store.list()` derives the batch by enumerating
  // the bundle's namespace, and that enumeration is lossy by construction — the
  // macOS helper's `list` omits every biometry-ACL'd item
  // (`kSecUseAuthenticationUISkip`) and skips the whole data-protection pass when
  // the keychain is locked, so a `hold`-policy bundle's value items never appear
  // and a present secret reads as "not found" (RUSH-2248). A declared key whose
  // item did not enumerate is therefore absent from `fetched`; read those exact
  // items directly — a point read DOES evaluate the ACL, so it triggers Touch ID
  // and returns the value the enumeration could not see. The enumeration still
  // earns its place (it catches hashed/aliased storage names and stale leftovers
  // not named in the metadata), so this is a UNION, not a replacement.
  //
  // One Touch ID sheet is preserved: the items missing from `fetched` are exactly
  // the ACL'd ones the enumeration dropped, so the first batch (metadata plus any
  // no-ACL / `never` items) raised no sheet, and this second batch raises the
  // single sheet that covers all of them. When the enumeration is healthy every
  // declared item is already in `fetched`, `missingDeclared` is empty, and this
  // is skipped entirely — zero behavior change and no extra spawn on the hot path.
  if (backend === 'keychain') {
    const missingDeclared: string[] = [];
    for (const key of keychainKeys) {
      const p = parsedByKey.get(key)!;
      if (!('ref' in p) || p.ref.provider !== 'keychain') continue;
      const item = secretsKeychainItem(bundle.name, p.ref.value);
      if (fetched.get(item) === undefined && fetched.get(keychainServiceAlias(item)) === undefined) {
        missingDeclared.push(item);
      }
    }
    if (missingDeclared.length > 0) {
      const declaredFetched = getKeychainTokens([...new Set(missingDeclared)], {
        agent: opts.agent || process.env.AGENTS_AGENT_NAME || 'Agents CLI',
        bundle: name,
        sessionId: process.env.AGENT_SESSION_ID || process.env.AGENTS_SESSION_ID,
        reason: opts.caller ? `to ${opts.caller}` : reason,
        duration: opts.duration || humanUnlockDuration(secretsHoldMs()),
        // The policy is known now (metadata parsed), so the prompt names the real
        // duration instead of the pre-read default the first batch had to guess.
        defaultPolicy: bundlePolicy(bundle),
        forceDuration: Boolean(opts.duration),
        silentNoAcl: verifiedNoAclBundle,
      });
      for (const [k, v] of declaredFetched) fetched.set(k, v);
    }
  }

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
    // Shared per-key resolver: same keychain lookup (cleartext name, then hashed
    // storage alias) and same missing-item classification as resolveBundleEnv, so
    // the two paths can never diverge again (RUSH-2252, RUSH-2253).
    const env = assembleBundleEnv(bundle, selectedKeys, parsedByKey, fetched, opts.keyMode, backend);
    emitReadAudit('success');
    // Auto-cache: this was a real keychain read (the agent fast-path returned
    // earlier on a hit). If the bundle opts into the `daily` policy and the user
    // enabled `secrets.agent.auto`, populate the broker so the next concurrent
    // run reads silently. Skipped when noAgent (e.g. `unlock`, which loads the
    // agent itself). When a broker is already up this warms it synchronously
    // (bounded ~3s) so `daily` reliably sticks; only a cold-start broker uses the
    // detached fire-and-forget path (see agentAutoLoadSync). The costly Touch ID
    // prompt already happened, so the bounded wait is invisible.
    if (
      backend === 'keychain' &&
      !opts.noAgent &&
      process.env.AGENTS_SECRETS_NO_AGENT !== '1' &&
      bundlePolicy(bundle) === 'hold' &&
      secretsAgentAutoEnabled() &&
      canCacheResolvedEnv(bundle, selectedKeys, opts.keyMode)
    ) {
      agentAutoLoadSync(name, bundle, env, secretsHoldMs(), opts.agent || process.env.AGENTS_AGENT_NAME || GLOBAL_HARNESS);
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

/**
 * Reconcile a bundle's keychain-backed VALUE items to its CURRENT policy, then
 * write the (always no-ACL) metadata.
 *
 * `writeBundle` only rewrites the metadata item, so a policy change alone leaves
 * every value item carrying the ACL it was created with — and macOS gates each
 * read on the ITEM's ACL, not the bundle's declared tier (spec SEC-19). Without
 * this reconcile, `agents secrets policy <b> never` reports "silent" while the
 * still-ACL'd value keeps popping Touch ID on every read, forever.
 *
 *   hold/always -> never  strips the biometry ACL (helper `set-no-acl`: delete+add)
 *   never -> hold/always  re-attaches it (helper `set`)
 *
 * The current values are read in ONE batch, so the reconcile costs at most a
 * single Touch ID — the last prompt a hold->never bundle will ever raise (a
 * never->* flip reads silently, since the items are already no-ACL). No-op on the
 * ACL to write for non-keychain backends (file/vault have no biometry concept),
 * and a metadata-only write when the bundle has no keychain-backed values.
 */
export function reAclBundleItems(bundle: SecretsBundle): void {
  if ((bundle.backend ?? 'keychain') !== 'keychain') {
    // No biometry ACL off the keychain backend — only metadata needs persisting.
    writeBundle(bundle);
    return;
  }
  const store = itemStore('keychain');
  // keychainItemsForBundle already returns ONLY keychain-backed value items
  // (via parseBundleValue), so no extra ref-shape filtering here.
  const entries = keychainItemsForBundle(bundle);
  if (entries.length === 0) {
    // Literal/ref-only bundle: nothing to re-ACL, just refresh metadata.
    writeBundle(bundle);
    return;
  }
  // One batched read = at most one Touch ID for the whole reconcile.
  const values = store.getBatch(entries.map((e) => e.item));
  const rewrite = new Map<string, string>();
  for (const { item } of entries) {
    const value = values.get(item);
    // A key present in metadata but with no readable value item is real
    // corruption, not something to silently skip (no fallbacks — fail loud).
    if (value === undefined) {
      throw new Error(
        `Cannot change policy for '${bundle.name}': a keychain value is missing or unreadable. Rotate that key, then retry.`,
      );
    }
    rewrite.set(item, value);
  }
  // writeBundleWithItems re-stores each value with { noAcl: policy === 'never' }
  // and the metadata no-ACL (metadata-last), and evicts any broker-held copy.
  writeBundleWithItems(bundle, rewrite);
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
