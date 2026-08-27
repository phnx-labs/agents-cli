/**
 * Credential accounts, stored as canonical `agents secrets` bundles (RUSH-2470).
 *
 * One account IS one bundle: the bundle label is the account name, its vars
 * carry the identity (ACCOUNT_ID / PROVIDER / AUTH_TYPE / optional BASE_URL)
 * and the secret (API_KEY or TOKEN), and it uses the `never` prompt policy so
 * it reads headlessly and syncs across the fleet with no Touch ID. The bundle
 * shape lives in [[account-schema]]; this module owns the CRUD, resolution,
 * and the one-time migration off the legacy `accounts.yaml`.
 *
 * `readAccountRegistry()` still returns the historical
 * `{ version: 2, accounts }` view so existing consumers (harness, profiles,
 * exec) keep working — it is now a projection over the account bundles, not a
 * file read. Native OAuth logins are NOT accounts here; they stay native and
 * surface through unified discovery in [[account-catalog]]. Fleet-wide native
 * labels sync via tracked `accounts/native.yaml` ([[account-labels]]);
 * `meta.accounts.native` is the device-local read cache.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getUserAgentsDir, readMeta, updateMeta } from './state.js';
import type { AgentId, Meta } from './types.js';
import {
  nativeLabelsPath,
  removeNativeLabel,
  seedNativeLabels,
  upsertNativeLabel,
  type NativeLabelRecord,
} from './account-labels.js';
import { deleteKeychainToken, getKeychainToken, hasKeychainToken } from './secrets/index.js';
import { bundleExists, deleteBundle, listBundles, readBundle, renameBundle, writeBundleWithItems } from './secrets/bundles.js';
import { getAccountProvider, type AccountAuthKind } from './account-provider-registry.js';
import { accountSecretItem, buildAccountBundle, parseAccountBundle, type AccountSchemaRecord } from './account-schema.js';

export interface CredentialAccount {
  id: string;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  secretRef: string;
  baseUrl?: string;
}

export interface AccountRegistryDocument { version: 2; accounts: Record<string, CredentialAccount> }
export interface ResolvedCredentialAccount { id: string; name: string; provider: string; auth: AccountAuthKind; env: Record<string, string> }
export interface NativeAccount {
  id: string;
  name: string;
  kind: 'native';
  agent: AgentId;
  identityKey: string;
  identityLabel?: string;
  scope: 'version' | 'device';
}
export type UnifiedAccount = (CredentialAccount & { kind: 'provider' }) | NativeAccount;

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const NATIVE_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9@._+-]*$/;
const AUTH_KINDS: readonly AccountAuthKind[] = ['api-key', 'setup-token', 'bearer-token'];

export function accountRegistryPath(base = getUserAgentsDir()): string { return path.join(base, 'accounts.yaml'); }

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error('Account name must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.');
}

function assertNativeLabel(label: string): void {
  if (!NATIVE_LABEL.test(label)) throw new Error('Account label must start with a letter or number and contain only letters, numbers, @, dot, underscore, plus, or dash.');
}

function isAccountAuthKind(value: unknown): value is AccountAuthKind {
  return typeof value === 'string' && AUTH_KINDS.includes(value as AccountAuthKind);
}

function toCredentialAccount(record: AccountSchemaRecord): CredentialAccount {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    auth: record.auth,
    secretRef: accountSecretItem(record.name, record.auth),
    baseUrl: record.baseUrl,
  };
}

/** Every account bundle currently on this device, keyed by stable id. */
function readAccountBundles(): CredentialAccount[] {
  const out: CredentialAccount[] = [];
  for (const bundle of listBundles()) {
    const record = parseAccountBundle(bundle);
    if (record) out.push(toCredentialAccount(record));
  }
  return out;
}

/**
 * Fold a legacy `accounts.yaml` into account bundles, then archive it.
 * Transactional: every bundle is written first, and the file is archived (and
 * the old per-account keychain items dropped) ONLY after all writes succeed —
 * so an interrupted migration leaves the file in place and the next read
 * retries, skipping accounts that already landed as a bundle.
 */
function migrateLegacyRegistryFile(base: string): void {
  const file = accountRegistryPath(base);
  if (!fs.existsSync(file)) return;
  const raw = yaml.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (!raw || Array.isArray(raw)) throw new Error(`Account registry corrupted at ${file}: expected a YAML map.`);

  // Legacy version-bound labels (pre-credential-accounts) are not credentials —
  // archive them so they are never resurrected as fake accounts.
  if (raw.version === undefined && raw.labels !== undefined) {
    archiveLegacyFile(file, 'accounts.legacy-labels.yaml');
    return;
  }
  if (raw.version !== 2) throw new Error(`Unsupported account registry version '${String(raw.version)}' at ${file}.`);

  const legacyAccounts = (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts))
    ? raw.accounts as Record<string, Record<string, unknown>>
    : {};
  const retiredSecretItems: string[] = [];
  for (const [key, value] of Object.entries(legacyAccounts)) {
    const item = value ?? {};
    const auth = item.auth;
    if (!isAccountAuthKind(auth)) throw new Error(`Account '${key}' has unsupported auth kind '${String(auth)}'.`);
    const id = String(item.id ?? key);
    const name = String(item.name ?? '');
    assertName(name);
    const provider = String(item.provider ?? '');
    const legacySecretRef = String(item.secretRef ?? `agents-cli.accounts.${id}.credential`);
    retiredSecretItems.push(legacySecretRef);
    if (bundleExists(name)) {
      const existing = parseAccountBundle(readBundle(name));
      if (!existing || existing.id !== id) {
        throw new Error(`Cannot migrate account '${name}': a different secrets bundle already uses that name.`);
      }
      continue; // already migrated on an earlier, interrupted run
    }
    const baseUrl = item.baseUrl ? String(item.baseUrl) : undefined;
    const record: AccountSchemaRecord = { id, name, provider, auth, baseUrl };
    const secret = hasKeychainToken(legacySecretRef) ? getKeychainToken(legacySecretRef) : '';
    const { bundle, items } = buildAccountBundle(record, secret || 'x');
    if (!secret) items.clear(); // no device-local secret: write metadata only
    writeBundleWithItems(bundle, items);
  }

  // Success: the file's accounts all exist as bundles now. Archive it and drop
  // the superseded per-account keychain items.
  archiveLegacyFile(file, 'accounts.migrated.yaml');
  for (const legacyItem of retiredSecretItems) deleteKeychainToken(legacyItem);
}

function archiveLegacyFile(file: string, archiveName: string): void {
  const archived = path.join(path.dirname(file), archiveName);
  if (fs.existsSync(archived)) fs.rmSync(archived, { force: true });
  fs.renameSync(file, archived);
}

export function readAccountRegistry(base = getUserAgentsDir()): AccountRegistryDocument {
  migrateLegacyRegistryFile(base);
  const accounts: Record<string, CredentialAccount> = {};
  for (const account of readAccountBundles()) accounts[account.id] = account;
  return { version: 2, accounts };
}

export function findAccount(name: string, doc = readAccountRegistry()): CredentialAccount | null {
  return doc.accounts[name] ?? Object.values(doc.accounts).find(account => account.name === name) ?? null;
}

export function listNativeAccounts(meta: Pick<Meta, 'accounts'>): NativeAccount[] {
  return Object.values(meta.accounts?.native ?? {}).map(account => ({ ...account, kind: 'native' as const }));
}

/**
 * Resolve one account by name or id across both stores, native first.
 *
 * `doc` is optional and read LAZILY: a native match returns without ever reading
 * the provider bundle registry — so a native view/attach/run never triggers a
 * bundle read, legacy-`accounts.yaml` migration, or a keychain decrypt (which
 * would surface a Touch ID prompt or crash on an undecryptable legacy item). A
 * default-evaluated `doc = readAccountRegistry()` argument would defeat this by
 * running before the body, so callers that only need a native lookup must be
 * able to omit it.
 */
export function findUnifiedAccount(nameOrId: string, meta: Pick<Meta, 'accounts'>, doc?: AccountRegistryDocument): UnifiedAccount | null {
  const needle = nameOrId.toLowerCase();
  const native = listNativeAccounts(meta).find(account =>
    account.id === nameOrId || account.name.toLowerCase() === needle || account.identityLabel?.toLowerCase() === needle,
  );
  if (native) return native;
  const provider = findAccount(nameOrId, doc ?? readAccountRegistry());
  return provider ? { ...provider, kind: 'provider' } : null;
}

function assertUniqueUnifiedName(name: string, meta: Pick<Meta, 'accounts'>, doc?: AccountRegistryDocument): void {
  if (findUnifiedAccount(name, meta, doc)) throw new Error(`Account '${name}' already exists.`);
}

function toLabelRecord(account: Pick<NativeAccount, 'agent' | 'identityKey' | 'name' | 'identityLabel' | 'scope'>): NativeLabelRecord {
  return {
    agent: account.agent,
    identityKey: account.identityKey,
    name: account.name,
    identityLabel: account.identityLabel,
    scope: account.scope,
  };
}

function persistNativeLabel(
  account: Pick<NativeAccount, 'agent' | 'identityKey' | 'name' | 'identityLabel' | 'scope'>,
  meta: Pick<Meta, 'accounts'>,
  base = getUserAgentsDir(),
): void {
  upsertNativeLabel(toLabelRecord(account), base, listNativeAccounts(meta).map(toLabelRecord));
}

export function addNativeAccount(
  name: string,
  agent: AgentId,
  identityKey: string,
  identityLabel: string | undefined,
  scope: 'version' | 'device',
): NativeAccount {
  assertNativeLabel(name);
  const meta = readMeta();
  assertUniqueUnifiedName(name, meta);
  const duplicate = listNativeAccounts(meta).find(account => account.agent === agent && account.identityKey === identityKey);
  if (duplicate) throw new Error(`This ${agent} login is already named '${duplicate.name}'.`);
  const account: NativeAccount = { id: crypto.randomUUID(), name, kind: 'native', agent, identityKey, identityLabel, scope };
  // Cache first so overlay-on-read keeps this id instead of synthesizing another.
  updateMeta(current => ({
    ...current,
    accounts: {
      ...current.accounts,
      native: { ...current.accounts?.native, [account.id]: { id: account.id, name, agent, identityKey, identityLabel, scope } },
    },
  }));
  persistNativeLabel(account, readMeta());
  return account;
}

/** Create or replace the version-independent label for one native identity. */
export function labelNativeAccount(
  agent: AgentId,
  identityKey: string,
  identityLabel: string | undefined,
  label: string | undefined,
  scope: 'version' | 'device',
): NativeAccount {
  const resolvedLabel = label ?? identityLabel;
  if (!resolvedLabel) throw new Error(`${agent} does not expose an email; pass a manual label.`);
  assertNativeLabel(resolvedLabel);
  const meta = readMeta();
  const existing = listNativeAccounts(meta).find(account => account.agent === agent && account.identityKey === identityKey);
  const collision = findUnifiedAccount(resolvedLabel, meta);
  if (collision && collision.id !== existing?.id) throw new Error(`Account '${resolvedLabel}' already exists.`);
  if (!existing) return addNativeAccount(resolvedLabel, agent, identityKey, identityLabel, scope);
  updateMeta(current => ({
    ...current,
    accounts: {
      ...current.accounts,
      native: {
        ...current.accounts?.native,
        [existing.id]: { id: existing.id, name: resolvedLabel, agent, identityKey, identityLabel, scope },
      },
    },
  }));
  persistNativeLabel({ ...existing, name: resolvedLabel, identityLabel }, readMeta());
  return { ...existing, name: resolvedLabel, identityLabel };
}

/**
 * After `agents repo pull user`, seed the tracked labels file from this
 * machine's cache when the file is still missing — so labels that only lived
 * in agents.yaml start syncing on the next push. Overlay-on-read already makes
 * a pulled file visible; this does not rewrite agents.yaml (that would dirty
 * the user repo and block the next pull).
 */
export function reconcileNativeAccountLabels(base = getUserAgentsDir()): { seeded: number } {
  if (fs.existsSync(nativeLabelsPath(base))) return { seeded: 0 };
  const cached = listNativeAccounts(readMeta()).map(toLabelRecord);
  if (cached.length === 0) return { seeded: 0 };
  seedNativeLabels(cached, base);
  return { seeded: cached.length };
}

export function bindAccount(nameOrId: string, target: string): UnifiedAccount {
  const meta = readMeta();
  const account = findUnifiedAccount(nameOrId, meta);
  if (!account) throw new Error(`Unknown account '${nameOrId}'.`);
  updateMeta(current => ({
    ...current,
    accounts: { ...current.accounts, bindings: { ...current.accounts?.bindings, [target]: account.id } },
  }));
  return account;
}

export function unbindAccount(nameOrId: string, target: string): void {
  const meta = readMeta();
  const account = findUnifiedAccount(nameOrId, meta);
  if (!account) throw new Error(`Unknown account '${nameOrId}'.`);
  if (meta.accounts?.bindings?.[target] !== account.id) throw new Error(`Account '${account.name}' is not attached to '${target}'.`);
  updateMeta(current => {
    const bindings = { ...current.accounts?.bindings };
    delete bindings[target];
    return { ...current, accounts: { ...current.accounts, bindings } };
  });
}

export function accountBindings(accountId: string, meta: Pick<Meta, 'accounts'>): string[] {
  return Object.entries(meta.accounts?.bindings ?? {}).filter(([, id]) => id === accountId).map(([target]) => target).sort();
}

/** Explicit selection wins over a configured per-harness default. */
export function resolveAccountSelection(
  explicit: string | undefined,
  agent: AgentId,
  meta: Pick<Meta, 'accounts'>,
  opts: { useDefault?: boolean; target?: string } = {},
): string | undefined {
  if (explicit) return explicit;
  const bound = opts.target ? meta.accounts?.bindings?.[opts.target] : undefined;
  if (bound) return bound;
  const deviceScoped = meta.accounts?.bindings?.[agent];
  if (deviceScoped) return deviceScoped;
  return opts.useDefault === false ? undefined : meta.accounts?.defaults?.[agent];
}

function profileConsumers(name: string, base: string): string[] {
  const dir = path.join(base, 'profiles');
  if (!fs.existsSync(dir)) return [];
  const consumers: string[] = [];
  for (const file of fs.readdirSync(dir).filter(value => /\.ya?ml$/.test(value))) {
    const raw = yaml.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown> | null;
    if (raw?.account === name) consumers.push(file.replace(/\.ya?ml$/, ''));
  }
  return consumers.sort();
}

function renameProfileConsumers(oldName: string, newName: string, base: string): void {
  const dir = path.join(base, 'profiles');
  for (const profile of profileConsumers(oldName, base)) {
    const file = path.join(dir, `${profile}.yml`);
    const yamlFile = fs.existsSync(file) ? file : path.join(dir, `${profile}.yaml`);
    const raw = yaml.parse(fs.readFileSync(yamlFile, 'utf8')) as Record<string, unknown>;
    raw.account = newName;
    atomicWriteFileSync(yamlFile, yaml.stringify(raw));
  }
}

export interface AddAccountOptions { baseUrl?: string }

export function addAccount(name: string, provider: string, auth: AccountAuthKind, secret: string, base = getUserAgentsDir(), opts: AddAccountOptions = {}): CredentialAccount {
  assertName(name);
  assertUniqueUnifiedName(name, readMeta(), readAccountRegistry(base));
  const adapter = getAccountProvider(provider);
  adapter.validate(auth, secret);
  if (bundleExists(name)) throw new Error(`Secrets bundle '${name}' already exists. Choose a different account name.`);
  const record: AccountSchemaRecord = { id: crypto.randomUUID(), name, provider: adapter.provider, auth, baseUrl: opts.baseUrl };
  const { bundle, items } = buildAccountBundle(record, secret);
  writeBundleWithItems(bundle, items);
  return toCredentialAccount(record);
}

export function setAccountSecret(name: string, secret: string, base = getUserAgentsDir()): void {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  getAccountProvider(account.provider).validate(account.auth, secret);
  const record: AccountSchemaRecord = { id: account.id, name: account.name, provider: account.provider, auth: account.auth, baseUrl: account.baseUrl };
  const { bundle, items } = buildAccountBundle(record, secret);
  bundle.created_at = readBundle(account.name).created_at; // rotate the secret, keep the bundle's birth time
  writeBundleWithItems(bundle, items);
}

export function renameAccount(oldName: string, newName: string, base = getUserAgentsDir()): void {
  assertName(newName);
  const doc = readAccountRegistry(base);
  const meta = readMeta();
  const native = listNativeAccounts(meta).find(account => account.id === oldName || account.name === oldName);
  if (native) {
    assertUniqueUnifiedName(newName, meta, doc);
    updateMeta(current => ({
      ...current,
      accounts: {
        ...current.accounts,
        native: { ...current.accounts?.native, [native.id]: { ...current.accounts?.native?.[native.id]!, name: newName } },
      },
    }));
    persistNativeLabel({ ...native, name: newName }, readMeta());
    return;
  }
  const account = findAccount(oldName, doc);
  if (!account) throw new Error(`Unknown account '${oldName}'.`);
  assertUniqueUnifiedName(newName, meta, doc);
  renameBundle(account.name, newName); // moves metadata + secret, preserves ACCOUNT_ID
  renameProfileConsumers(account.name, newName, base);
}

export function removeAccount(name: string, base = getUserAgentsDir()): void {
  const meta = readMeta();
  const native = listNativeAccounts(meta).find(account => account.id === name || account.name === name);
  if (native) {
    const bindings = accountBindings(native.id, meta);
    if (bindings.length) throw new Error(`Account '${native.name}' is attached to: ${bindings.join(', ')}. Detach it before removing it.`);
    updateMeta(current => {
      const accounts = { ...current.accounts?.native };
      delete accounts[native.id];
      return { ...current, accounts: { ...current.accounts, native: accounts } };
    });
    removeNativeLabel(native.agent, native.identityKey, getUserAgentsDir());
    return;
  }
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  const bindings = accountBindings(account.id, meta);
  const defaults = Object.entries(meta.accounts?.defaults ?? {}).filter(([, id]) => id === account.id).map(([agent]) => agent);
  if (bindings.length || defaults.length) {
    const refs = [...bindings.map(target => `binding ${target}`), ...defaults.map(agent => `default ${agent}`)];
    throw new Error(`Account '${account.name}' is still referenced by: ${refs.join(', ')}. Detach or clear those references before removing it.`);
  }
  const consumers = [...new Set([...profileConsumers(account.name, base), ...profileConsumers(account.id, base)])].sort();
  if (consumers.length) throw new Error(`Account '${account.name}' is used by harness${consumers.length === 1 ? '' : 'es'}: ${consumers.join(', ')}. Reassign them before removing it.`);
  deleteKeychainToken(account.secretRef);
  deleteBundle(account.name);
}

export function inspectAccount(name: string, base = getUserAgentsDir()): CredentialAccount & { secretPresent: boolean; policy: 'never' } {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  const bundle = readBundle(account.name);
  if (bundle.policy !== 'never') throw new Error(`Account bundle '${account.name}' must use secrets policy 'never'.`);
  return { ...account, secretPresent: hasKeychainToken(account.secretRef), policy: bundle.policy };
}

export function resolveCredentialAccount(name: string, host: AgentId, expectedProvider?: string, base = getUserAgentsDir()): ResolvedCredentialAccount {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  if (expectedProvider && account.provider !== expectedProvider) throw new Error(`Account '${account.name}' uses provider '${account.provider}', but this harness requires '${expectedProvider}'.`);
  const adapter = getAccountProvider(account.provider);
  if (account.auth === 'setup-token' && (account.provider !== 'anthropic' || host !== 'claude')) {
    throw new Error(`Provider '${account.provider}' cannot use a setup-token with the ${host} harness.`);
  }
  const envVar = account.auth === 'setup-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : adapter.envFor(host, account.auth);
  if (!hasKeychainToken(account.secretRef)) throw new Error(`Credential for account '${account.name}' is missing on this device. Add it with 'agents accounts set-key ${account.name}'.`);
  const connectionEnv = { ...adapter.connectionEnvFor(host) };
  if (account.baseUrl) {
    const baseUrlEnv = adapter.baseUrlEnvFor(host);
    if (!baseUrlEnv) throw new Error(`Account '${account.name}' has a base URL override, but provider '${account.provider}' cannot apply it to the ${host} harness.`);
    connectionEnv[baseUrlEnv] = account.baseUrl;
  }
  return {
    id: account.id,
    name: account.name,
    provider: account.provider,
    auth: account.auth,
    env: { ...connectionEnv, [envVar]: getKeychainToken(account.secretRef) },
  };
}

/** The account a spawn should launch under, classified for the exec path. */
export type SpawnAccount =
  | { kind: 'provider'; id: string; name: string; agent: AgentId; env: Record<string, string> }
  | { kind: 'native'; id: string; name: string; agent: AgentId; identityKey: string; scope: 'version' | 'device' };

/**
 * Resolve the account a run should launch under, following the binding order
 * (explicit → exact `agent@version` → device-scoped `agent` → per-harness
 * default) and classifying the result:
 *
 * - **provider** → the injected env is resolved here (fails closed when the
 *   credential is absent or the provider cannot authenticate the host).
 * - **native** → returns the identity the caller must confirm is live on the
 *   execution device; **no secret or env is produced**, because a native login
 *   is owned by the harness and read from its own home. The caller validates the
 *   live fingerprint against the installed version before spawn.
 *
 * A native account bound to a different harness than the one being launched
 * fails loudly (EXEC-ACCOUNT-4). Returns null when nothing is selected.
 */
export function resolveSpawnAccount(
  explicit: string | undefined,
  agent: AgentId,
  version: string | undefined,
  meta: Pick<Meta, 'accounts'>,
  opts: { useDefault?: boolean; provider?: string; base?: string; target?: string } = {},
): SpawnAccount | null {
  // The binding lookup key. A custom harness passes its own profile/harness name
  // (a run of `deepseek` must find a binding on `deepseek`, not `claude@x`); a
  // native/global run keys on the exact `agent@version` installation.
  const target = opts.target ?? (version ? `${agent}@${version}` : agent);
  const selection = resolveAccountSelection(explicit, agent, meta, { useDefault: opts.useDefault, target });
  if (!selection) return null;
  const unified = findUnifiedAccount(selection, meta);
  if (!unified) throw new Error(`Unknown account '${selection}'.`);
  if (unified.kind === 'native') {
    if (unified.agent !== agent) {
      throw new Error(`Account '${unified.name}' is a ${unified.agent} login and cannot authenticate the ${agent} harness.`);
    }
    // A provider-backed custom harness still injects its provider auth env, so a
    // native identity claim over it is incoherent — reject before spawn even when
    // the account is chosen explicitly with --account (which bypasses `attach`).
    if (opts.provider) {
      throw new Error(`Account '${unified.name}' is a native ${unified.agent} login and cannot run under a provider-backed harness (${opts.provider}); the harness's ${opts.provider} credentials would still be injected. Use a matching provider account.`);
    }
    return { kind: 'native', id: unified.id, name: unified.name, agent, identityKey: unified.identityKey, scope: unified.scope };
  }
  const resolved = resolveCredentialAccount(unified.name, agent, opts.provider, opts.base ?? getUserAgentsDir());
  return { kind: 'provider', id: resolved.id, name: resolved.name, agent, env: resolved.env };
}
