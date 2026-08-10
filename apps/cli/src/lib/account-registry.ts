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
 * surface through unified discovery in [[account-catalog]].
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as yaml from 'yaml';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getUserAgentsDir } from './state.js';
import type { AgentId, Meta } from './types.js';
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

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const AUTH_KINDS: readonly AccountAuthKind[] = ['api-key', 'setup-token', 'bearer-token'];

export function accountRegistryPath(base = getUserAgentsDir()): string { return path.join(base, 'accounts.yaml'); }

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error('Account name must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.');
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

/** Explicit selection wins over a configured per-harness default. */
export function resolveAccountSelection(
  explicit: string | undefined,
  agent: AgentId,
  meta: Pick<Meta, 'accounts'>,
  opts: { useDefault?: boolean } = {},
): string | undefined {
  if (explicit) return explicit;
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
  const adapter = getAccountProvider(provider);
  adapter.validate(auth, secret);
  if (bundleExists(name)) throw new Error(`Secrets bundle '${name}' already exists. Choose a different account name.`);
  if (findAccount(name, readAccountRegistry(base))) throw new Error(`Account '${name}' already exists.`);
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
  const account = findAccount(oldName, doc);
  if (!account) throw new Error(`Unknown account '${oldName}'.`);
  if (findAccount(newName, doc)) throw new Error(`Account '${newName}' already exists.`);
  renameBundle(account.name, newName); // moves metadata + secret, preserves ACCOUNT_ID
  renameProfileConsumers(account.name, newName, base);
}

export function removeAccount(name: string, base = getUserAgentsDir()): void {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
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
