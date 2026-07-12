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
 * Windows: Windows Credential Manager (CRED_TYPE_GENERIC,
 * CRED_PERSIST_LOCAL_MACHINE) via a PowerShell P/Invoke shim, with the same
 * AES-256-GCM encrypted-file fallback used on Linux when the credential store
 * is unreachable (no logon session / no powershell.exe). No biometry.
 *
 * Items are device-local: the biometry access control requires the OS to
 * treat them as bound to this device, so cross-machine propagation goes
 * through the explicit export/import flow in src/lib/secrets/sync.ts
 * rather than the system's cloud-keychain path.
 */

import { execFileSync, spawnSync } from 'child_process';
import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linuxBackend, usesFileFallback as linuxUsesFileFallback, importNativeSecretToolItems } from './linux.js';
import { windowsBackend, usesFileFallback as windowsUsesFileFallback, importNativeCredManItems } from './windows.js';
import type { NativeImportReport } from './fallback.js';

export type { NativeImportReport, NativeImportResult, NativeImportStatus } from './fallback.js';
import { getKeychainHelperPath } from './install-helper.js';

const SERVICE_PREFIX = 'agents-cli';
export const SECRETS_ITEM_PREFIX = `${SERVICE_PREFIX}.secrets.`;
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
  if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') {
    throw new Error(
      'agents secrets requires macOS Keychain, Linux libsecret, or Windows Credential Manager.\n' +
      'Use environment variables or a .env file on unsupported platforms.'
    );
  }
}

function isLinux(): boolean {
  return process.platform === 'linux';
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Guard a secret value before it is written to the current platform's primary
 * backend.
 *
 * A value is empty on every platform → always rejected. Embedded newlines are
 * rejected ONLY on darwin: the macOS batch read path (`get-batch`, see
 * getKeychainTokens) is newline-delimited, so a value with a newline would
 * corrupt record framing on read. Linux (secret-tool), Windows (Credential
 * Manager stores the raw UTF-8 blob and emits base64), and the encrypted-file
 * fallback all store raw bytes and round-trip multiline values (PEM / SSH keys)
 * faithfully, so they accept newlines. `platform` is injectable for tests.
 */
export function assertValueStorable(value: string, platform: NodeJS.Platform = process.platform): void {
  if (!value || !value.trim()) throw new Error('Secret value is empty.');
  if (platform === 'darwin' && /[\r\n]/.test(value)) {
    throw new Error('Secret value contains newlines, which are not supported.');
  }
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
  // The hashing state depends on whether a backend is installed — never let a
  // state resolved against the real keychain leak into a backend-driven test.
  hashStateCache = null;
  autoRekeyAttempted = false;
  return prev;
}

/** True when a test backend is installed (real keychain / biometry bypassed).
 * Callers that gate on the live secrets-agent broker use this to stay hermetic —
 * with an in-memory backend there is no real keychain to dedup, so the broker
 * fast-path must not engage. Always false in production (`backend` is null). */
export function isKeychainBackendOverridden(): boolean {
  return backend !== null;
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

// ─── Hashed service names (GitHub #316, Finding 1) ──────────────────────────
//
// The helper's `list` never decrypts and never prompts (by design), which made
// service names enumerable metadata: any same-user process could silently read
// every bundle, key, and provider name (`agents-cli.secrets.<bundle>.<KEY>`,
// `agents-cli.<provider>.token`) and build a target list before ever popping
// Touch ID. To close that, on macOS every item in our namespace is stored
// under an opaque HMAC-SHA256-hashed service name:
//
//   agents-cli.bundles.<name>          → agents-cli.h.<ns>.m
//   agents-cli.secrets.<bundle>.<KEY>  → agents-cli.h.<ns>.k.<kh>
//   agents-cli.<anything else>         → agents-cli.h.o.<ih>
//
// where <ns> = HMAC(key, 'ns\0'+bundle) and <kh>/<ih> are per-item HMACs
// (first 32 hex chars each). The per-bundle <ns> segment is deliberate: a
// bundle's value items keep a common silent-enumerable prefix
// (`agents-cli.h.<ns>.k.`), so readAndResolveBundleEnv still fetches metadata
// + all values in ONE get-batch behind ONE Touch ID — a flat hash of the full
// name would have forced a second prompt on every bundle read. Names still
// start with `agents-cli.`, so the helper's JIT-migration guard and prefix
// gates keep working. What an enumerator learns shrinks to item grouping and
// counts — never a bundle, key, or provider name.
//
// The HMAC key is 32 random bytes in `agents-cli.hmackey`, written through the
// helper's no-ACL path (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
// device-local, access-group-pinned). Deliberately NO user-presence ACL: the
// key protects metadata confidentiality only, and gating it behind Touch ID
// would make every silent operation (list/has) prompt. Per-machine is fine —
// sync re-materializes items locally through the same primitives, so hashed
// names never leave the machine. Deriving the key from machine constants was
// rejected: that would hand any local process a dictionary-confirmation
// oracle without even touching the keychain.
//
// Hashing activates only after the one-time re-key migration
// (rekeyServiceNames below / `agents secrets rekey`) has moved every existing
// cleartext-named item; until then all operations use cleartext names exactly
// as before. The sentinel lives INSIDE the hmackey record — in the keychain,
// not on disk — so it can never desync from the items it describes (e.g. a
// keychain restored from a backup brings its matching state along).

const HASHED_SERVICE_PREFIX = `${SERVICE_PREFIX}.h.`;
export const HMAC_KEY_ITEM = `${SERVICE_PREFIX}.hmackey`;
const HASHED_META_RE = /^agents-cli\.h\.[0-9a-f]{32}\.m$/;

interface HmacKeyRecord {
  v: number;
  /** 64 hex chars — the raw HMAC-SHA256 key. */
  k: string;
  /** True once the one-time re-key has moved every cleartext-named item. */
  migrated: boolean;
  /** Old cleartext services whose hashed copies are verified but whose
   * originals are not yet deleted (crash-resume list; deletes are silent). */
  pendingDeletes?: string[];
}

interface HashState {
  active: boolean;
  key: Buffer | null;
  record: HmacKeyRecord | null;
}

let hashStateCache: HashState | null = null;
let forcedTestKey: Buffer | null = null;
let rawScopeDepth = 0;
let rekeyRunning = false;
let autoRekeyAttempted = false;

/** Force hashed service names on with a fixed key (test only). Pass null to
 * restore lazy production resolution. Composes with setKeychainBackendForTest
 * so unit tests exercise the exact transform production uses. */
export function setKeychainServiceHashingForTest(key: Buffer | null): void {
  forcedTestKey = key;
  hashStateCache = null;
  autoRekeyAttempted = false;
}

/**
 * Run `fn` with service-name hashing suspended: every primitive uses the
 * literal names it is given. For migration flows ONLY — they enumerate raw
 * names from the helper (which may be pre-re-key cleartext leftovers) and must
 * read/delete those exact items, not their hashed transforms.
 */
export function withRawKeychainServiceNames<T>(fn: () => T): T {
  rawScopeDepth++;
  try {
    return fn();
  } finally {
    rawScopeDepth--;
  }
}

function hmacHex32(key: Buffer, input: string): string {
  return createHmac('sha256', key).update(input, 'utf8').digest('hex').slice(0, 32);
}

function bundleNamespaceHash(bundle: string, key: Buffer): string {
  return hmacHex32(key, `ns\0${bundle}`);
}

/** The hashed (storage) service name for a cleartext item name. Exported for
 * the re-key migration and tests; runtime callers go through the primitives,
 * which apply this transparently. */
export function hashedServiceName(item: string, key: Buffer): string {
  if (item.startsWith(BUNDLES_ITEM_PREFIX)) {
    const name = item.slice(BUNDLES_ITEM_PREFIX.length);
    return `${HASHED_SERVICE_PREFIX}${bundleNamespaceHash(name, key)}.m`;
  }
  if (item.startsWith(SECRETS_ITEM_PREFIX)) {
    // Bundle names may contain dots; env keys and wallet ids never do — the
    // LAST dot is the unambiguous bundle/key split.
    const rest = item.slice(SECRETS_ITEM_PREFIX.length);
    const dot = rest.lastIndexOf('.');
    if (dot > 0 && dot < rest.length - 1) {
      const bundle = rest.slice(0, dot);
      const keyName = rest.slice(dot + 1);
      return `${HASHED_SERVICE_PREFIX}${bundleNamespaceHash(bundle, key)}.k.${hmacHex32(key, `kv\0${bundle}\0${keyName}`)}`;
    }
  }
  return `${HASHED_SERVICE_PREFIX}o.${hmacHex32(key, `it\0${item}`)}`;
}

function parseHmacKeyRecord(raw: string): HmacKeyRecord | null {
  try {
    const rec = JSON.parse(raw) as HmacKeyRecord;
    if (rec && typeof rec === 'object' && rec.v === 1 && typeof rec.k === 'string' && /^[0-9a-f]{64}$/.test(rec.k)) {
      return rec;
    }
  } catch {
    /* malformed — treated as absent */
  }
  return null;
}

function readHmacKeyRecord(): HmacKeyRecord | null {
  // HMAC_KEY_ITEM is exempt from the transform, so this routes to the helper
  // (or the test backend) under its literal name. The item is no-ACL, so the
  // read is silent.
  let raw: string;
  try {
    raw = getKeychainToken(HMAC_KEY_ITEM);
  } catch {
    return null;
  }
  return parseHmacKeyRecord(raw);
}

function writeHmacKeyRecord(rec: HmacKeyRecord): void {
  // JSON.stringify drops undefined fields (used to clear pendingDeletes).
  // noAcl: reads of this record must stay prompt-free; an old pinned helper
  // without the set-no-acl path rejects this loudly (see setKeychainToken),
  // which is exactly the "old helper never half-runs the re-key" gate.
  setKeychainToken(HMAC_KEY_ITEM, JSON.stringify(rec), { noAcl: true });
  hashStateCache = null;
}

function resolveHashState(): HashState {
  if (forcedTestKey) return { active: true, key: forcedTestKey, record: null };
  if (hashStateCache) return hashStateCache;
  if (backend || process.platform !== 'darwin' || process.env.AGENTS_SECRETS_HASH_NAMES === '0') {
    hashStateCache = { active: false, key: null, record: null };
    return hashStateCache;
  }
  const record = readHmacKeyRecord();
  const key = record ? Buffer.from(record.k, 'hex') : null;
  // AGENTS_SECRETS_HASH_NAMES=1 forces hashing on before the machine-wide
  // sentinel flips — used to verify a partial (--prefix) re-key end-to-end.
  const active = !!record && (record.migrated || process.env.AGENTS_SECRETS_HASH_NAMES === '1');
  hashStateCache = { active, key, record };
  return hashStateCache;
}

/**
 * The storage-layer service name for `item`: hashed when hashing is active,
 * the item itself otherwise. For callers that mix helper-enumerated
 * (already-hashed) names with computed cleartext names in one lookup map —
 * see readAndResolveBundleEnv.
 */
export function keychainServiceAlias(item: string): string {
  return prepareServiceName(item);
}

function prepareServiceName(item: string, opts?: { autoRekey?: boolean }): string {
  if (rawScopeDepth > 0) return item;
  if (!isOurItem(item)) return item;
  if (item === HMAC_KEY_ITEM || item.startsWith(HASHED_SERVICE_PREFIX)) return item;
  if (opts?.autoRekey) maybeAutoRekey();
  const st = resolveHashState();
  if (!st.active || !st.key) return item;
  return hashedServiceName(item, st.key);
}

interface MappedListPrefix {
  prefix: string;
  filter?: (service: string) => boolean;
}

/**
 * Map a cleartext enumeration prefix to its hashed-storage equivalent. Only
 * two shapes are ever enumerated at sub-namespace granularity (bundle
 * metadata, and one bundle's value items); both map to a broad `agents-cli.`
 * helper query plus a client-side filter. Every mapped filter is a UNION with
 * the original cleartext prefix so mid-migration leftovers (or items written
 * by an older CLI on this machine) stay visible to migration tooling.
 */
function prepareListPrefix(prefix: string): MappedListPrefix {
  if (rawScopeDepth > 0) return { prefix };
  if (!prefix.startsWith(`${SERVICE_PREFIX}.`)) return { prefix };
  if (prefix.startsWith(HASHED_SERVICE_PREFIX)) return { prefix };
  maybeAutoRekey();
  const st = resolveHashState();
  if (!st.active || !st.key) return { prefix };
  if (prefix === BUNDLES_ITEM_PREFIX) {
    return {
      prefix: `${SERVICE_PREFIX}.`,
      filter: (s) => HASHED_META_RE.test(s) || s.startsWith(BUNDLES_ITEM_PREFIX),
    };
  }
  if (prefix.startsWith(SECRETS_ITEM_PREFIX) && prefix.endsWith('.') && prefix.length > SECRETS_ITEM_PREFIX.length + 1) {
    const bundle = prefix.slice(SECRETS_ITEM_PREFIX.length, -1);
    const hashedValuePrefix = `${HASHED_SERVICE_PREFIX}${bundleNamespaceHash(bundle, st.key)}.k.`;
    return {
      prefix: `${SERVICE_PREFIX}.`,
      filter: (s) => s.startsWith(hashedValuePrefix) || s.startsWith(prefix),
    };
  }
  return { prefix };
}

function listCleartextServices(prefixes?: string[]): string[] {
  const all = withRawKeychainServiceNames(() => listKeychainItems(`${SERVICE_PREFIX}.`));
  return all.filter(
    (s) =>
      s.startsWith(`${SERVICE_PREFIX}.`) &&
      !s.startsWith(HASHED_SERVICE_PREFIX) &&
      s !== HMAC_KEY_ITEM &&
      (!prefixes || prefixes.some((p) => s.startsWith(p))),
  );
}

function ensureHmacKeyRecord(markMigratedIfCreating: boolean): HmacKeyRecord {
  const existing = readHmacKeyRecord();
  if (existing) return existing;
  const fresh: HmacKeyRecord = { v: 1, k: randomBytes(32).toString('hex'), migrated: markMigratedIfCreating };
  writeHmacKeyRecord(fresh);
  // If two processes raced the first write, the keychain holds exactly one
  // winner — adopt whatever is stored NOW so both sides converge on a single
  // key before hashing anything under it.
  return readHmacKeyRecord() ?? fresh;
}

/**
 * Guard against a silently-degraded enumeration. The helper's `list` skips the
 * data-protection pass wholesale when the DP keybag is locked (screen lock —
 * see keychain-helper.swift, errSecInteractionNotAllowed handling), returning
 * an EMPTY result even though items exist and no-ACL reads/writes still work.
 * Observed live on macOS 26: `set-no-acl` + `get` succeed while `list` of the
 * just-written item returns nothing. Without this probe, a re-key run in that
 * state would see "zero cleartext items" and wrongly activate hashed naming,
 * making every existing cleartext item invisible after unlock.
 *
 * The probe requires the hmackey record (a DP item that provably exists — the
 * caller just ensured it) to appear in a raw enumeration. Trivially true for
 * the in-memory test backend.
 */
function assertEnumerationTrustworthy(): void {
  const all = withRawKeychainServiceNames(() => listKeychainItems(`${SERVICE_PREFIX}.`));
  if (!all.includes(HMAC_KEY_ITEM)) {
    throw new Error(
      'keychain enumeration is unavailable (locked keybag / screen lock?) — refusing to decide the re-key on an empty listing. Retry while unlocked.',
    );
  }
}

function finishPendingDeletes(rec: HmacKeyRecord): void {
  const pending = rec.pendingDeletes ?? [];
  if (pending.length === 0) return;
  withRawKeychainServiceNames(() => {
    for (const service of pending) deleteKeychainToken(service);
  });
  writeHmacKeyRecord({ ...rec, pendingDeletes: undefined });
}

/**
 * One-shot per process: activate hashing on machines with nothing to move,
 * finish a crash-interrupted delete phase (silent), and run the interactive
 * one-time re-key when cleartext-named items exist and a human is present.
 * Never throws — a failed attempt leaves the process on cleartext names
 * (exact pre-#316 behavior) and the next process retries.
 */
function maybeAutoRekey(): void {
  if (autoRekeyAttempted || rekeyRunning || rawScopeDepth > 0) return;
  autoRekeyAttempted = true;
  if (forcedTestKey || backend) return;
  // Never auto-mutate the developer's real keychain from a test runner.
  if (process.env.VITEST) return;
  if (process.platform !== 'darwin') return;
  if (process.env.AGENTS_SECRETS_NO_AUTO_REKEY === '1') return;
  if (process.env.AGENTS_SECRETS_HASH_NAMES === '0') return;
  const st = resolveHashState();
  if (st.active) {
    if (st.record?.pendingDeletes?.length) {
      try {
        finishPendingDeletes(st.record);
      } catch {
        /* next process retries */
      }
    }
    return;
  }
  let cleartext: string[];
  try {
    cleartext = listCleartextServices();
  } catch {
    return;
  }
  // Moving real items pops Touch ID — only auto-run with a human present. An
  // empty listing still goes through rekeyServiceNames (prompt-free): it
  // verifies the enumeration is trustworthy before activating on "nothing to
  // migrate", so a locked keybag can never masquerade as a fresh machine.
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  if (cleartext.length > 0 && !interactive) return;
  try {
    rekeyServiceNames({ announce: cleartext.length > 0, log: (line) => console.error(line) });
  } catch (err) {
    // Headless processes stay quiet (e.g. locked-keybag probe failures would
    // otherwise spam every background run); a human gets the pointer.
    if (interactive) {
      console.error(
        `agents secrets: one-time re-key did not complete (${(err as Error).message}). ` +
          `Keychain service names remain enumerable; run 'agents secrets rekey' to retry.`,
      );
    }
  }
}

/** One re-keyed (or failed) item, by its old cleartext service name. */
export interface RekeyPlanItem {
  oldService: string;
  newService: string;
  /** Preserve the no-ACL write path for `never`-policy bundle items. */
  noAcl: boolean;
  /** Replacement payload (bundle metadata gets `name` injected); absent = copy verbatim. */
  payload?: string;
}

/**
 * Build the old→new mapping for a set of cleartext services. Bundle metadata
 * is parsed first to (a) recover each bundle's prompt policy — the persisted
 * `tier` token, where `none`/`never` means the item must be re-written through
 * the no-ACL path — and (b) inject the cleartext `name` into the JSON, because
 * after hashing the service name can no longer carry it (listBundles reads it
 * back from the payload). Exported for unit tests.
 */
export function computeRekeyPlan(
  services: string[],
  values: Map<string, string>,
  key: Buffer,
): { items: RekeyPlanItem[]; unreadable: string[] } {
  const items: RekeyPlanItem[] = [];
  const unreadable: string[] = [];
  const noAclBundles = new Set<string>();
  for (const service of services) {
    if (!service.startsWith(BUNDLES_ITEM_PREFIX)) continue;
    const value = values.get(service);
    if (value === undefined) {
      unreadable.push(service);
      continue;
    }
    const name = service.slice(BUNDLES_ITEM_PREFIX.length);
    let payload: string | undefined;
    let noAcl = false;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') {
        const tier = parsed.tier;
        noAcl = tier === 'none' || tier === 'never';
        payload = JSON.stringify({ ...parsed, name });
      }
    } catch {
      /* malformed JSON — copy verbatim, ACL'd */
    }
    if (noAcl) noAclBundles.add(name);
    items.push({ oldService: service, newService: hashedServiceName(service, key), noAcl, payload });
  }
  for (const service of services) {
    if (service.startsWith(BUNDLES_ITEM_PREFIX)) continue;
    const value = values.get(service);
    if (value === undefined) {
      unreadable.push(service);
      continue;
    }
    let noAcl = false;
    if (service.startsWith(SECRETS_ITEM_PREFIX)) {
      const rest = service.slice(SECRETS_ITEM_PREFIX.length);
      const dot = rest.lastIndexOf('.');
      if (dot > 0) noAcl = noAclBundles.has(rest.slice(0, dot));
    }
    items.push({ oldService: service, newService: hashedServiceName(service, key), noAcl });
  }
  return { items, unreadable };
}

/** Outcome of one rekeyServiceNames run. */
export interface RekeyReport {
  /** Old cleartext services whose items now live under hashed names. */
  migrated: string[];
  failed: Array<{ item: string; detail: string }>;
  /** True when hashed naming is on after this run. */
  activated: boolean;
  nothingToDo: boolean;
}

/**
 * The one-time re-key: move every cleartext-named `agents-cli.*` item to its
 * hashed service name. Composed entirely from the existing helper primitives —
 * no new Swift command:
 *
 *   1. Enumerate cleartext services (silent) and batch-read every value behind
 *      ONE Touch ID (`get-batch`; readItem also sweeps legacy/orphaned copies).
 *   2. Write each hashed copy (`set`/`set-no-acl` never prompt), preserving
 *      the no-ACL tier for `never`-policy bundles.
 *   3. Batch-verify every copy round-trips (second Touch ID).
 *   4. Only then activate hashing (sentinel + pendingDeletes) and delete the
 *      old items (silent).
 *
 * Add-before-delete throughout: a cancel/crash/failure anywhere before step 4
 * leaves every old item intact and hashing OFF — same rationale as the
 * helper's migrate-orphans, which is also why no pre-write backup is taken.
 * On ANY per-item failure nothing is deleted and the sentinel stays off
 * (all-or-nothing activation); the report names every failed item. A crash
 * between the sentinel write and the deletes is resumed silently by the next
 * process (pendingDeletes). Idempotent: re-running converges.
 */
export function rekeyServiceNames(
  opts: { prefixes?: string[]; announce?: boolean; log?: (line: string) => void } = {},
): RekeyReport {
  const log = opts.log ?? (() => {});
  if (!backend && process.platform !== 'darwin') {
    throw new Error('secrets rekey is macOS-only — service names are enumerable only via the macOS keychain helper.');
  }
  if (rekeyRunning) throw new Error('re-key already running in this process.');
  rekeyRunning = true;
  try {
    const partial = !!opts.prefixes?.length;
    let record = ensureHmacKeyRecord(false);
    const key = Buffer.from(record.k, 'hex');

    // The record we just ensured is a DP item — if enumeration can't see it,
    // every listing below is lying (locked keybag) and no decision — least of
    // all "nothing to migrate, activate" — can be made on it.
    assertEnumerationTrustworthy();

    if (record.pendingDeletes?.length) {
      log(`Finishing interrupted re-key: removing ${record.pendingDeletes.length} already-copied cleartext item(s)…`);
      finishPendingDeletes(record);
      record = readHmacKeyRecord() ?? record;
    }

    const cleartext = listCleartextServices(opts.prefixes);
    if (cleartext.length === 0) {
      if (!record.migrated && !partial) {
        writeHmacKeyRecord({ ...record, migrated: true });
        log('No cleartext-named keychain items found — hashed service names are now active.');
        return { migrated: [], failed: [], activated: true, nothingToDo: true };
      }
      return { migrated: [], failed: [], activated: record.migrated, nothingToDo: true };
    }

    if (opts.announce) {
      log(`One-time secrets re-key: replacing ${cleartext.length} enumerable keychain service name(s) with opaque hashed names (GitHub #316).`);
      log('Touch ID will prompt twice (read + verify). Cancelling is safe — the re-key resumes on a later run.');
    }

    const values = withRawKeychainServiceNames(() => getKeychainTokens(cleartext));
    const { items, unreadable } = computeRekeyPlan(cleartext, values, key);
    const failed: Array<{ item: string; detail: string }> = unreadable.map((item) => ({
      item,
      detail: 'read failed or item absent',
    }));

    const added: RekeyPlanItem[] = [];
    for (const plan of items) {
      try {
        setKeychainToken(plan.newService, plan.payload ?? values.get(plan.oldService)!, { noAcl: plan.noAcl });
        added.push(plan);
      } catch (err) {
        failed.push({ item: plan.oldService, detail: `write: ${(err as Error).message}` });
      }
    }

    const verified: RekeyPlanItem[] = [];
    if (added.length > 0) {
      const readBack = getKeychainTokens(added.map((p) => p.newService));
      for (const plan of added) {
        const expected = plan.payload ?? values.get(plan.oldService)!;
        if (readBack.get(plan.newService) === expected) verified.push(plan);
        else failed.push({ item: plan.oldService, detail: 'verify: value mismatch after rewrite' });
      }
    }

    if (failed.length > 0) {
      log(`Re-key INCOMPLETE — ${failed.length} of ${cleartext.length} item(s) could not be moved; nothing was deleted and hashed naming stays OFF:`);
      for (const f of failed) log(`  ${f.item}: ${f.detail}`);
      return { migrated: [], failed, activated: false, nothingToDo: false };
    }

    if (partial) {
      withRawKeychainServiceNames(() => {
        for (const plan of verified) deleteKeychainToken(plan.oldService);
      });
      log(`Re-keyed ${verified.length} item(s) (partial run — hashed naming NOT activated).`);
      return { migrated: verified.map((p) => p.oldService), failed: [], activated: record.migrated, nothingToDo: false };
    }

    writeHmacKeyRecord({ ...record, migrated: true, pendingDeletes: verified.map((p) => p.oldService) });
    withRawKeychainServiceNames(() => {
      for (const plan of verified) deleteKeychainToken(plan.oldService);
    });
    writeHmacKeyRecord({ ...record, migrated: true, pendingDeletes: undefined });
    log(`Re-keyed ${verified.length} keychain item(s); service names are now opaque (agents-cli.h.*).`);
    return { migrated: verified.map((p) => p.oldService), failed: [], activated: true, nothingToDo: false };
  } finally {
    rekeyRunning = false;
  }
}

/** Re-key state snapshot for `agents secrets rekey --status`. */
export function rekeyStatus(): {
  migrated: boolean;
  hasKey: boolean;
  pendingDeletes: number;
  cleartext: string[];
  /** False when the enumeration probe fails (locked keybag) — the cleartext
   * count is then meaningless. Only probeable once the key record exists. */
  enumerationOk: boolean;
} {
  const rec = readHmacKeyRecord();
  let enumerationOk = true;
  if (rec) {
    try {
      assertEnumerationTrustworthy();
    } catch {
      enumerationOk = false;
    }
  }
  return {
    migrated: !!rec?.migrated,
    hasKey: !!rec,
    pendingDeletes: rec?.pendingDeletes?.length ?? 0,
    cleartext: listCleartextServices(),
    enumerationOk,
  };
}

/** Check if a keychain/keyring item exists. Never prompts for biometry. */
export function hasKeychainToken(item: string): boolean {
  item = prepareServiceName(item);
  if (backend) return backend.has(item);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.has(item);
  if (isWindows()) return windowsBackend.has(item);
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
  // Errors keep the requested (human-readable) name; the storage name may be
  // an opaque hash.
  const requested = item;
  item = prepareServiceName(item, { autoRekey: true });
  if (backend) return backend.get(item);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.get(item);
  if (isWindows()) return windowsBackend.get(item);
  if (!isOurItem(item)) {
    const sec = spawnSync('/usr/bin/security', ['find-generic-password', '-a', os.userInfo().username, '-s', item, '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (sec.status === 0) {
      const token = sec.stdout?.toString().trim();
      if (token) return token;
    }
    throw new Error(`Keychain item '${requested}' not found.`);
  }
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['get', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 1) throw new Error(`Keychain item '${requested}' not found.`);
  if (result.status === 4) throw new Error(`Touch ID cancelled while reading '${requested}'.`);
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to read keychain item '${requested}'.`);
  }
  const token = result.stdout?.toString();
  if (!token) throw new Error(`Keychain item '${requested}' exists but is empty.`);
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
  // Resolve storage names up front, remembering which requested name each one
  // answers for — the returned map is keyed by the names the CALLER passed,
  // whether those were cleartext (hashed here) or already-hashed (enumerated).
  const requestedByStorage = new Map<string, string>();
  const storageItems = items.map((item) => {
    const storage = prepareServiceName(item, { autoRekey: true });
    if (!requestedByStorage.has(storage)) requestedByStorage.set(storage, item);
    return storage;
  });
  const record = (storage: string, value: string) => {
    result.set(requestedByStorage.get(storage) ?? storage, value);
  };
  if (backend) {
    for (const storage of storageItems) {
      try { record(storage, backend.get(storage)); } catch { /* missing — skip */ }
    }
    return result;
  }
  assertSupportedPlatform();
  if (isLinux()) {
    for (const storage of storageItems) {
      try { record(storage, linuxBackend.get(storage)); } catch { /* missing — skip */ }
    }
    return result;
  }
  if (isWindows()) {
    for (const storage of storageItems) {
      try { record(storage, windowsBackend.get(storage)); } catch { /* missing — skip */ }
    }
    return result;
  }
  const bin = getKeychainHelperPath();
  const child = spawnSync(bin, ['get-batch', os.userInfo().username, ...storageItems], {
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
  parseBatchRecords(out, record);
  return result;
}

/**
 * Parse the helper's batch-read output, routing each present record through
 * `record(service, value)` — getKeychainTokens uses that to reverse-map hashed
 * storage names back to the names the caller asked with. The format is shared
 * by `get-batch` and `get-batch-synced` — a sequence of records, one per
 * service in input order:
 *   "V <service>\n<value>\n"   (present)
 *   "M <service>\n"            (missing)
 * Service names are validated newline/'='-free by setKeychainToken below
 * and values are rejected if they contain newlines — so splitting on '\n'
 * and walking line-by-line is unambiguous.
 */
function parseBatchRecords(out: string, record: (service: string, value: string) => void): void {
  const lines = out.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '' && i === lines.length - 1) break;
    if (line.startsWith('V ')) {
      const service = line.slice(2);
      const value = lines[i + 1] ?? '';
      record(service, value);
      i += 2;
    } else if (line.startsWith('M ')) {
      i += 1;
    } else if (line === '') {
      i += 1;
    } else {
      throw new Error(`Malformed get-batch output line: ${JSON.stringify(line)}`);
    }
  }
}

/** Store or update a secret value in the keychain/keyring. Device-local;
 * biometry-gated on macOS. `opts.noAcl` (the `never` prompt-policy) writes our
 * item WITHOUT the biometry access control so later reads are fully silent — it
 * routes through the signed helper's `set-no-acl` path. A pinned helper that
 * predates that path rejects the unknown command (exit 2) and this throws,
 * rather than silently falling back to an ACL'd `set` (which would behave like
 * `always`). Ignored by the Linux/Windows/test backends, which have no ACL. */
export function setKeychainToken(item: string, value: string, opts?: { noAcl?: boolean }): void {
  // Validate the CLEARTEXT name (a hashed storage name is always clean), then
  // resolve the storage name.
  if (/[\x00=\r\n]/.test(item)) throw new Error('Secret item name contains invalid characters.');
  item = prepareServiceName(item, { autoRekey: true });
  if (backend) { backend.set(item, value); return; }
  assertSupportedPlatform();
  assertValueStorable(value);

  if (isLinux()) { linuxBackend.set(item, value); return; }
  if (isWindows()) { windowsBackend.set(item, value); return; }

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
  // `never` policy → no-ACL write. The `set-no-acl` subcommand exists only in a
  // re-notarized helper; an older pinned helper dies with "Unknown command:
  // set-no-acl" (exit 2), surfaced below — never a silent ACL'd downgrade.
  const helperCmd = opts?.noAcl ? 'set-no-acl' : 'set';
  const result = spawnSync(bin, [helperCmd, item, os.userInfo().username], {
    input: value,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    if (opts?.noAcl && /unknown command/i.test(msg ?? '')) {
      throw new Error(
        `The 'never' prompt-policy needs a Keychain helper with the no-ACL write path, ` +
        `but the installed helper does not support it. Rebuild + re-notarize the signed ` +
        `helper (scripts/build-keychain-helper.sh) and re-pin its sha, then retry. ` +
        `(helper said: ${msg})`,
      );
    }
    throw new Error(msg || `Failed to write keychain item '${item}'.`);
  }
}

/** Delete a keychain/keyring item. Returns true if it existed. Never prompts for biometry. */
export function deleteKeychainToken(item: string): boolean {
  item = prepareServiceName(item);
  if (backend) return backend.delete(item);
  assertSupportedPlatform();
  if (isLinux()) return linuxBackend.delete(item);
  if (isWindows()) return windowsBackend.delete(item);
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
  if (isWindows()) return windowsUsesFileFallback();
  return false;
}

/** Enumerate keychain/keyring item names starting with the given prefix.
 * With hashed service names active, the two sub-namespace prefixes callers
 * use (bundle metadata; one bundle's value items) are mapped to their hashed
 * shapes — the returned names are then storage (opaque) names. */
export function listKeychainItems(prefix: string): string[] {
  const mapped = prepareListPrefix(prefix);
  const apply = (names: string[]) => (mapped.filter ? names.filter(mapped.filter) : names);
  if (backend) return apply(backend.list(mapped.prefix));
  assertSupportedPlatform();
  if (isLinux()) return apply(linuxBackend.list(mapped.prefix));
  if (isWindows()) return apply(windowsBackend.list(mapped.prefix));
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['list', mapped.prefix], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to enumerate keychain items with prefix '${prefix}'.`);
  }
  const out = result.stdout?.toString() || '';
  return apply(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

/**
 * Enumerate ONLY legacy file-based-keychain item names with the given prefix —
 * the items that still carry a pre-migration (trusted-app) ACL and pop a
 * separate auth sheet on read. Items already in the data-protection keychain are
 * excluded (they need no migration). Silent (attributes only, never decrypts).
 *
 * macOS only: on Linux / the test backend there is no separate legacy keychain,
 * so this returns []. Used by `agents secrets migrate-acl` to rewrite only the
 * stragglers instead of every item (which would be a Touch ID storm).
 */
export function listLegacyKeychainItems(prefix: string): string[] {
  if (backend) return [];
  assertSupportedPlatform();
  if (isLinux()) return [];
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['list-legacy', prefix], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to enumerate legacy keychain items with prefix '${prefix}'.`);
  }
  const out = result.stdout?.toString() || '';
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Test seam for the LEGACY SYNCHRONIZABLE (iCloud Keychain) recovery path.
 * The main `KeychainBackend` seam models the live device-local store; this one
 * models the orphaned iCloud items that `secrets import --from icloud` reads.
 * Kept separate so a test can populate both sides independently.
 */
export interface SyncedKeychainBackend {
  list(prefix: string): string[];
  getBatch(items: string[]): Map<string, string>;
  delete(item: string): boolean;
}

let syncedBackend: SyncedKeychainBackend | null = null;

export function setSyncedKeychainBackendForTest(
  b: SyncedKeychainBackend | null,
): SyncedKeychainBackend | null {
  const prev = syncedBackend;
  syncedBackend = b;
  return prev;
}

/**
 * Enumerate LEGACY SYNCHRONIZABLE (iCloud Keychain) item names with the given
 * prefix — bundles written by the pre-biometry helper era, which defaulted
 * secrets to iCloud Keychain sync. The device-local cutover orphaned them:
 * every modern query pins synchronizable=false, so only the helper's
 * `list-synced` verb can see them. Silent (attributes only, never decrypts).
 * macOS only — Linux/Windows never had iCloud Keychain sync, so this returns [].
 */
export function listSyncedKeychainItems(prefix: string): string[] {
  if (syncedBackend) return syncedBackend.list(prefix);
  if (backend) return [];
  assertSupportedPlatform();
  if (isLinux() || isWindows()) return [];
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['list-synced', prefix], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to enumerate iCloud keychain items with prefix '${prefix}'.`);
  }
  const out = result.stdout?.toString() || '';
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Batch-read LEGACY SYNCHRONIZABLE (iCloud Keychain) items. Returns a map of
 * item name → value; missing items are simply absent. Pre-biometry items carry
 * no biometry ACL, so this does not normally prompt. macOS only — returns an
 * empty map on Linux/Windows.
 */
export function getSyncedKeychainTokens(items: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (items.length === 0) return result;
  if (syncedBackend) return syncedBackend.getBatch(items);
  if (backend) return result;
  assertSupportedPlatform();
  if (isLinux() || isWindows()) return result;
  const bin = getKeychainHelperPath();
  const child = spawnSync(bin, ['get-batch-synced', os.userInfo().username, ...items], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.status === 4) {
    throw new Error(`Auth cancelled while reading ${items.length} iCloud keychain item(s).`);
  }
  if (child.status !== 0) {
    const msg = child.stderr?.toString().trim();
    throw new Error(msg || `Failed to batch-read ${items.length} iCloud keychain items.`);
  }
  parseBatchRecords(child.stdout?.toString() ?? '', (service, value) => { result.set(service, value); });
  return result;
}

/**
 * Delete a LEGACY SYNCHRONIZABLE (iCloud Keychain) item after a successful
 * import (`--purge`). Matches synchronizable items only — the device-local
 * copy the import wrote is untouched. iCloud propagates the deletion to the
 * user's other devices. Returns true if a copy was removed.
 */
export function deleteSyncedKeychainItem(item: string): boolean {
  if (syncedBackend) return syncedBackend.delete(item);
  if (backend) return false;
  assertSupportedPlatform();
  if (isLinux() || isWindows()) return false;
  const bin = getKeychainHelperPath();
  return spawnSync(bin, ['delete-synced', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  }).status === 0;
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
  if (isWindows()) return windowsBackend.has(item);
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['migrate-acl', item, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const msg = result.stderr?.toString().trim();
  throw new Error(msg || `Failed to migrate keychain item '${item}'.`);
}

/**
 * Enumerate data-protection items whose service starts with `prefix` that live
 * under a NON-concrete access group — pre-#279 "orphans" filed under the implicit
 * default group (the literal `2HTP252L87.*`) that the pinned-group queries can't
 * see. Attributes only: never decrypts, never prompts. macOS only — Linux/Windows
 * and the test backend have no access-group concept, so this returns [].
 */
export function listOrphanedKeychainItems(prefix: string): string[] {
  if (backend) return [];
  assertSupportedPlatform();
  if (isLinux() || isWindows()) return [];
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['list-orphans', prefix, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to enumerate orphaned keychain items with prefix '${prefix}'.`);
  }
  const out = result.stdout?.toString() || '';
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Outcome of re-homing one orphaned keychain item. */
export interface OrphanMigrationResult {
  item: string;
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
}

/**
 * Parse the `migrate-orphans` helper summary (one record per line):
 *   OK <service>               re-homed
 *   WARN <service> <detail>    pinned copy written but orphan not removed
 *   FAIL <service> <detail>    could not re-home (orphan left intact)
 * Unknown lines are ignored. Exported for unit testing without a keychain.
 */
export function parseOrphanMigrationOutput(stdout: string): OrphanMigrationResult[] {
  const results: OrphanMigrationResult[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(' ');
    const tag = sep === -1 ? trimmed : trimmed.slice(0, sep);
    const rest = sep === -1 ? '' : trimmed.slice(sep + 1);
    if (tag === 'OK') {
      // OK carries only the service name (no trailing detail).
      results.push({ item: rest, status: 'ok' });
    } else if (tag === 'WARN' || tag === 'FAIL') {
      // WARN/FAIL are 'TAG <service> <detail>'. Service names are space-free
      // (validateBundleName / validateEnvKey), so the first token IS the exact
      // service — this stays consistent with listOrphanedKeychainItems for the
      // healed-set reconciliation in migrate-acl.
      const item = rest.split(' ')[0] ?? rest;
      results.push({ item, status: tag === 'WARN' ? 'warn' : 'fail', detail: rest });
    }
  }
  return results;
}

/**
 * Re-home every pre-#279 orphaned data-protection item under `prefix` into the
 * concrete access group, behind a SINGLE Touch ID prompt for the whole batch.
 * The helper reads each orphan by its exact persistent ref, adds the pinned copy
 * (add-before-delete: a failed add leaves the orphan intact), then deletes the
 * orphan by ref. Returns one result per item. macOS only — no-op elsewhere.
 *
 * Throws on Touch ID cancellation (exit 4) so callers can distinguish "user
 * aborted" from "nothing to do" (empty array).
 */
export function migrateOrphanedKeychainItems(prefix: string): OrphanMigrationResult[] {
  if (backend) return [];
  assertSupportedPlatform();
  if (isLinux() || isWindows()) return [];
  const bin = getKeychainHelperPath();
  const result = spawnSync(bin, ['migrate-orphans', prefix, os.userInfo().username], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 4) throw new Error('Touch ID cancelled during orphan migration.');
  if (result.status !== 0) {
    const msg = result.stderr?.toString().trim();
    throw new Error(msg || `Failed to migrate orphaned keychain items with prefix '${prefix}'.`);
  }
  return parseOrphanMigrationOutput(result.stdout?.toString() || '');
}

/**
 * Import agents-cli secrets from the native store (GNOME Keyring / Windows
 * Credential Manager) into the encrypted file store — the Linux/Windows
 * analogue of the macOS orphan/legacy migration, exposed as
 * `agents secrets import-keyring`. Requires the native store to be
 * reachable/unlocked; `commit=false` is a dry-run. macOS returns an empty
 * report (it has no file fallback and uses `migrate-acl` instead).
 */
export function importNativeItems(prefix: string, commit: boolean): NativeImportReport {
  if (backend) return { available: false, locked: false, results: [] };
  assertSupportedPlatform();
  if (isLinux()) return importNativeSecretToolItems(prefix, commit);
  if (isWindows()) return importNativeCredManItems(prefix, commit);
  return { available: false, locked: false, results: [] };
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
