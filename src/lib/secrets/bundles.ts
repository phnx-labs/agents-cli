/**
 * Secret bundles — named sets of keychain-backed environment variables.
 *
 * Bundle metadata (name, description, vars map) is stored in the macOS
 * Keychain as a JSON blob under `agents-cli.bundles.<name>`. Secret values
 * live one per keychain item under `agents-cli.secrets.<bundle>.<key>`.
 * Every item is device-local and gated by Touch ID / device passcode — see
 * src/lib/secrets/index.ts for the access-control story. Nothing about
 * secrets ever lives in plaintext on disk.
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
  listKeychainItems,
  parseBundleValue,
  resolveRef,
  secretsKeychainItem,
  setKeychainToken,
  type BundleValue,
  type SecretRef,
} from './index.js';
import { emit } from '../events.js';
import { agentGetSync, agentAutoLoadSync, secretsAgentAutoEnabled, DEFAULT_TTL_MS } from './agent.js';

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
 * How a bundle interacts with the macOS secrets-agent:
 * - `biometry` (default): only an explicit `agents secrets unlock` populates the
 *   agent; every other read pops Touch ID. Use for high-value bundles you want
 *   to confirm each session.
 * - `session`: eligible for the agent — `unlock`, and (when `secrets.agent.auto`
 *   is enabled) the first real keychain read auto-loads it so concurrent runs
 *   read it silently.
 */
export type SecretsTier = 'biometry' | 'session';

/** A named set of environment variable definitions backed by various secret providers. */
export interface SecretsBundle {
  name: string;
  description?: string;
  allow_exec?: boolean;
  /** Secrets-agent interaction tier. Absent ⇒ `biometry` (the safe default). */
  tier?: SecretsTier;
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

const BUNDLE_NAME_PATTERN = /^[a-z0-9][a-z0-9\-_.]{0,48}$/i;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUNDLE_META_PREFIX = 'agents-cli.bundles.';
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
  // Unknown fields on the JSON (e.g. legacy sync flags) are silently dropped
  // here; the SecretsBundle shape is the only source of truth.
  const bundle: SecretsBundle = {
    name,
    description: parsed.description,
    allow_exec: Boolean(parsed.allow_exec),
    tier: parseTier(parsed.tier),
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

/** Normalize a persisted `tier` value; anything but `session` ⇒ default tier. */
function parseTier(raw: unknown): SecretsTier | undefined {
  return raw === 'session' ? 'session' : undefined;
}

/** The effective tier of a bundle (absent ⇒ `biometry`). */
export function bundleTier(bundle: SecretsBundle): SecretsTier {
  return bundle.tier ?? 'biometry';
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
  // Stamp timestamps on the bundle so callers see what got persisted. created_at
  // is sticky — once set we never overwrite it, including on legacy bundles
  // that already carry one. updated_at always advances.
  const now = new Date().toISOString();
  if (!bundle.created_at) bundle.created_at = now;
  bundle.updated_at = now;
  const payload = {
    description: bundle.description,
    allow_exec: bundle.allow_exec ? true : undefined,
    tier: bundle.tier === 'session' ? 'session' : undefined,
    created_at: bundle.created_at,
    updated_at: bundle.updated_at,
    last_used: bundle.last_used,
    vars: bundle.vars,
    meta,
  };
  const json = JSON.stringify(payload);
  setKeychainToken(bundleMetaItem(bundle.name), json);
  emit('secrets.set', { bundle: bundle.name });
}

export function deleteBundle(name: string): boolean {
  validateBundleName(name);
  const deleted = deleteKeychainToken(bundleMetaItem(name));
  if (deleted) {
    emit('secrets.delete', { bundle: name });
  }
  return deleted;
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
  if (names.length === 0) return [];

  // Batch all metadata reads behind ONE Touch ID prompt instead of N. Bundle
  // metadata items carry user-presence ACLs (same as secret values), so a naive
  // loop over readBundle() spawns a fresh LAContext per item — meaning N
  // biometric prompts for `secrets list`. Sharing a single context across all
  // SecItemCopyMatching calls collapses the prompt to one. Mirrors the pattern
  // already used by resolveBundleEnv for runtime secret injection.
  const itemsToFetch = names.map(bundleMetaItem);
  const fetched = getKeychainTokens(itemsToFetch);

  const out: SecretsBundle[] = [];
  for (const name of names) {
    const json = fetched.get(bundleMetaItem(name));
    if (json === undefined) continue;
    let parsed: Partial<SecretsBundle>;
    try {
      parsed = JSON.parse(json) as Partial<SecretsBundle>;
    } catch {
      // Skip malformed bundles; surfaced via `agents secrets view <name>`.
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const bundle: SecretsBundle = {
      name,
      description: parsed.description,
      allow_exec: Boolean(parsed.allow_exec),
      tier: parseTier(parsed.tier),
      vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
    };
    if (typeof parsed.created_at === 'string') bundle.created_at = parsed.created_at;
    if (typeof parsed.updated_at === 'string') bundle.updated_at = parsed.updated_at;
    if (typeof parsed.last_used === 'string') bundle.last_used = parsed.last_used;
    if (parsed.meta && typeof parsed.meta === 'object') bundle.meta = parsed.meta;
    // Skip bundles with invalid env keys rather than throwing — same lenient
    // posture readBundle had via the outer catch.
    let valid = true;
    for (const key of Object.keys(bundle.vars)) {
      if (!ENV_KEY_PATTERN.test(key)) { valid = false; break; }
    }
    if (!valid) continue;
    out.push(bundle);
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
    writeBundle(bundle);
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

  type Parsed = { literal: string } | { ref: SecretRef };
  const parsedByKey = new Map<string, Parsed>();
  const keychainItemsToFetch: string[] = [];
  for (const [key, raw] of Object.entries(bundle.vars)) {
    const parsed = parseBundleValue(raw);
    parsedByKey.set(key, parsed);
    if ('ref' in parsed && parsed.ref.provider === 'keychain') {
      keychainItemsToFetch.push(secretsKeychainItem(bundle.name, parsed.ref.value));
    }
  }

  const fetched = keychainItemsToFetch.length > 0
    ? getKeychainTokens(keychainItemsToFetch)
    : new Map<string, string>();

  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(bundle.vars)) {
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
          `Bundle '${bundle.name}' key '${key}': keychain item '${item}' not found. ` +
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

  // Fast-path: if the secrets-agent holds this bundle (user ran
  // `agents secrets unlock <name>`), return the cached snapshot with no Touch
  // ID. Soft — any failure falls through to the real keychain read below. macOS
  // only; the never-unlocked path is a single stat (agentSocketExists) so it
  // costs nothing when the agent isn't running.
  if (!opts.noAgent && process.env.AGENTS_SECRETS_NO_AGENT !== '1') {
    const hit = agentGetSync(name);
    if (hit) {
      stampLastUsed(hit.bundle);
      emit('secrets.get', {
        bundle: name,
        caller: opts.caller,
        status: 'success',
        source: 'agent',
        keyCount: Object.keys(hit.env).length,
      });
      return hit;
    }
  }

  const metaItem = bundleMetaItem(name);
  const bundleSecretPrefix = `${SECRETS_ITEM_PREFIX}${name}.`;
  let secretItems: string[];
  try {
    secretItems = listKeychainItems(bundleSecretPrefix);
  } catch {
    secretItems = [];
  }

  const reason = opts.caller
    ? `read ${name} secrets (for ${opts.caller})`
    : `read ${name} secrets`;

  void reason;
  const fetched = getKeychainTokens([metaItem, ...secretItems]);

  const json = fetched.get(metaItem);
  if (json === undefined) {
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
    tier: parseTier(parsed.tier),
    vars: parsed.vars && typeof parsed.vars === 'object' ? parsed.vars : {},
  };
  if (typeof parsed.created_at === 'string') bundle.created_at = parsed.created_at;
  if (typeof parsed.updated_at === 'string') bundle.updated_at = parsed.updated_at;
  if (typeof parsed.last_used === 'string') bundle.last_used = parsed.last_used;
  if (parsed.meta && typeof parsed.meta === 'object') bundle.meta = parsed.meta;
  for (const key of Object.keys(bundle.vars)) {
    validateEnvKey(key);
  }

  stampLastUsed(bundle);

  type Parsed = { literal: string } | { ref: SecretRef };
  const parsedByKey = new Map<string, Parsed>();
  const keychainKeys: string[] = [];
  const kindCounts: Record<string, number> = {};
  for (const [key, raw] of Object.entries(bundle.vars)) {
    const p = parseBundleValue(raw);
    parsedByKey.set(key, p);
    const kind = 'literal' in p ? 'literal' : p.ref.provider;
    kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    if ('ref' in p && p.ref.provider === 'keychain') {
      keychainKeys.push(key);
    }
  }
  const keys = Object.keys(bundle.vars).sort();
  keychainKeys.sort();

  const emitReadAudit = (status: 'success' | 'error', err?: unknown) => {
    emit('secrets.get', {
      bundle: bundle.name,
      caller: opts.caller,
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
      const p = parsedByKey.get(key)!;
      if ('literal' in p) {
        env[key] = p.literal;
        continue;
      }
      if (p.ref.provider === 'keychain') {
        const item = secretsKeychainItem(bundle.name, p.ref.value);
        const value = fetched.get(item);
        if (value === undefined) {
          throw new Error(
            `Bundle '${bundle.name}' key '${key}': keychain item '${item}' not found. ` +
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
    // earlier on a hit). If the bundle opts into the session tier and the user
    // enabled `secrets.agent.auto`, populate the broker in the background so the
    // next concurrent run reads silently. Skipped when noAgent (e.g. `unlock`,
    // which loads the agent itself). Fire-and-forget — never blocks this read.
    if (
      !opts.noAgent &&
      process.env.AGENTS_SECRETS_NO_AGENT !== '1' &&
      bundleTier(bundle) === 'session' &&
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
  setKeychainToken(item, opts.newValue);

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

  if (bundleExists(newName)) {
    if (!opts.force) {
      throw new Error(`Bundle '${newName}' already exists. Use --force to overwrite.`);
    }
    const dest = readBundle(newName);
    for (const { item } of keychainItemsForBundle(dest)) {
      deleteKeychainToken(item);
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
    const value = getKeychainToken(oldItem);
    setKeychainToken(newItem, value);
  }

  // writeBundle preserves source.created_at and refreshes updated_at.
  const renamed: SecretsBundle = { ...source, name: newName };
  writeBundle(renamed);

  // Cleanup: delete the old per-key keychain items, then the old metadata.
  for (const { item: oldItem } of sourceItems) {
    deleteKeychainToken(oldItem);
  }
  deleteBundle(oldName);

  emit('secrets.rename', { from: oldName, to: newName });
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
