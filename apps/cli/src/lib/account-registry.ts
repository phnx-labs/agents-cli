import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { atomicWriteFileSync } from './fs-atomic.js';
import { getUserAgentsDir } from './state.js';
import type { AgentId } from './types.js';
import { deleteKeychainToken, getKeychainToken, hasKeychainToken, setKeychainToken } from './secrets/index.js';
import { getAccountProvider, type AccountAuthKind } from './account-provider-registry.js';

export interface CredentialAccount {
  id: string;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  secretRef: string;
}

export interface AccountRegistryDocument { version: 2; accounts: Record<string, CredentialAccount> }
export interface ResolvedCredentialAccount { id: string; name: string; provider: string; auth: AccountAuthKind; env: Record<string, string> }

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export function accountRegistryPath(base = getUserAgentsDir()): string { return path.join(base, 'accounts.yaml'); }
export function accountSecretItem(id: string): string { return `agents-cli.accounts.${id}.credential`; }
function empty(): AccountRegistryDocument { return { version: 2, accounts: {} }; }
function assertName(name: string): void { if (!NAME.test(name)) throw new Error('Account name must start with a letter or number and contain only letters, numbers, dot, underscore, or dash.'); }

export function readAccountRegistry(base = getUserAgentsDir()): AccountRegistryDocument {
  const file = accountRegistryPath(base);
  if (!fs.existsSync(file)) return empty();
  const raw = yaml.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> | null;
  if (!raw || Array.isArray(raw)) throw new Error(`Account registry corrupted at ${file}: expected a YAML map.`);
  if (raw.version !== 2) {
    if (raw.version === undefined && raw.labels !== undefined) {
      const archived = path.join(path.dirname(file), 'accounts.legacy-labels.yaml');
      if (fs.existsSync(archived)) throw new Error(`Cannot migrate legacy account labels because ${archived} already exists.`);
      fs.renameSync(file, archived);
      const migrated = empty();
      writeAccountRegistry(migrated, base);
      return migrated;
    }
    throw new Error(`Unsupported account registry version '${String(raw.version)}' at ${file}.`);
  }
  const accounts: Record<string, CredentialAccount> = {};
  for (const [id, value] of Object.entries((raw.accounts ?? {}) as Record<string, unknown>)) {
    const item = value as Record<string, unknown>;
    const auth = item.auth as AccountAuthKind;
    if (!['api-key', 'setup-token', 'bearer-token'].includes(auth)) throw new Error(`Account '${id}' has unsupported auth kind '${String(item.auth)}'.`);
    accounts[id] = { id, name: String(item.name ?? ''), provider: String(item.provider ?? ''), auth, secretRef: String(item.secretRef ?? '') };
  }
  return { version: 2, accounts };
}

export function writeAccountRegistry(doc: AccountRegistryDocument, base = getUserAgentsDir()): void {
  const file = accountRegistryPath(base);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, yaml.stringify(doc));
}

export function findAccount(name: string, doc = readAccountRegistry()): CredentialAccount | null {
  return doc.accounts[name] ?? Object.values(doc.accounts).find(account => account.name === name) ?? null;
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

export function addAccount(name: string, provider: string, auth: AccountAuthKind, secret: string, base = getUserAgentsDir()): CredentialAccount {
  assertName(name);
  const adapter = getAccountProvider(provider);
  adapter.validate(auth, secret);
  const doc = readAccountRegistry(base);
  if (findAccount(name, doc)) throw new Error(`Account '${name}' already exists.`);
  const id = crypto.randomUUID();
  const secretRef = accountSecretItem(id);
  setKeychainToken(secretRef, secret);
  const record = { id, name, provider: adapter.provider, auth, secretRef };
  doc.accounts[id] = record;
  try { writeAccountRegistry(doc, base); } catch (error) { deleteKeychainToken(secretRef); throw error; }
  return record;
}

export function setAccountSecret(name: string, secret: string, base = getUserAgentsDir()): void {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  getAccountProvider(account.provider).validate(account.auth, secret);
  setKeychainToken(account.secretRef, secret);
}

export function renameAccount(oldName: string, newName: string, base = getUserAgentsDir()): void {
  assertName(newName);
  const doc = readAccountRegistry(base);
  const account = findAccount(oldName, doc);
  if (!account) throw new Error(`Unknown account '${oldName}'.`);
  if (findAccount(newName, doc)) throw new Error(`Account '${newName}' already exists.`);
  account.name = newName;
  writeAccountRegistry(doc, base);
  renameProfileConsumers(oldName, newName, base);
}

export function removeAccount(name: string, base = getUserAgentsDir()): void {
  const doc = readAccountRegistry(base);
  const account = findAccount(name, doc);
  if (!account) throw new Error(`Unknown account '${name}'.`);
  const consumers = [...new Set([...profileConsumers(name, base), ...profileConsumers(account.id, base)])].sort();
  if (consumers.length) throw new Error(`Account '${name}' is used by harness${consumers.length === 1 ? '' : 'es'}: ${consumers.join(', ')}. Reassign them before removing it.`);
  delete doc.accounts[account.id];
  writeAccountRegistry(doc, base);
  deleteKeychainToken(account.secretRef);
}

export function inspectAccount(name: string, base = getUserAgentsDir()): CredentialAccount & { secretPresent: boolean } {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  return { ...account, secretPresent: hasKeychainToken(account.secretRef) };
}

export function resolveCredentialAccount(name: string, host: AgentId, expectedProvider?: string, base = getUserAgentsDir()): ResolvedCredentialAccount {
  const account = findAccount(name, readAccountRegistry(base));
  if (!account) throw new Error(`Unknown account '${name}'.`);
  if (expectedProvider && account.provider !== expectedProvider) throw new Error(`Account '${account.name}' uses provider '${account.provider}', but this harness requires '${expectedProvider}'.`);
  const adapter = getAccountProvider(account.provider);
  const envVar = account.auth === 'setup-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : adapter.envFor(host, account.auth);
  if (!hasKeychainToken(account.secretRef)) throw new Error(`Credential for account '${account.name}' is missing on this device. Add it with 'agents accounts set-key ${account.name}'.`);
  return {
    id: account.id,
    name: account.name,
    provider: account.provider,
    auth: account.auth,
    env: { ...adapter.connectionEnvFor(host), [envVar]: getKeychainToken(account.secretRef) },
  };
}
