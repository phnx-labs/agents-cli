import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { armor } from 'age-encryption';
import { getUserAgentsDir } from '../state.js';
import { getCliLaunch } from '../cli-entry.js';
import { atomicWriteFileSync, withFileLock } from '../fs-atomic.js';
import {
  deleteKeychainToken,
  getKeychainToken,
  setKeychainToken,
} from './index.js';

export interface VaultKey {
  passphrase: string;
}

export interface VaultBundleRecord {
  metadata?: string;
  keys: Record<string, string>;
}

export interface VaultData {
  v: 1;
  bundles: Record<string, VaultBundleRecord>;
}

interface VaultSession {
  v: 1;
  passphrase: string;
  expiresAt: number;
}

interface VaultFileStat {
  mtimeMs: number;
  size: number;
}

interface VaultDataCache {
  file: string;
  passphrase: string;
  stat: VaultFileStat;
  data: VaultData;
}

const VAULT_FILE_NAME = 'vault.age';
const VAULT_SESSION_ITEM = 'agents-cli.vault.session';
export const VAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const VAULT_SCRYPT_WORK_FACTOR = 18;
const VAULT_LOCK_STALE_MS = 120_000;
const VAULT_LOCK_ACQUIRE_TIMEOUT_MS = 180_000;

let overrideVaultPath: string | null = null;
let vaultDataCache: VaultDataCache | null = null;
let ageOperationCountForTest = 0;
let ageHelperLaunchForTest: { command: string; args: string[] } | null = null;

export function vaultPath(): string {
  return overrideVaultPath ?? process.env.AGENTS_VAULT_PATH ?? path.join(getUserAgentsDir(), VAULT_FILE_NAME);
}

export function vaultExists(): boolean {
  return fs.existsSync(vaultPath());
}

export function _setVaultPathForTest(filePath: string | null): void {
  overrideVaultPath = filePath;
  clearVaultDataCache();
}

export function _clearVaultDataCacheForTest(): void {
  clearVaultDataCache();
}

export function _resetVaultAgeOperationCountForTest(): void {
  ageOperationCountForTest = 0;
}

export function _getVaultAgeOperationCountForTest(): number {
  return ageOperationCountForTest;
}

export function _setVaultAgeHelperLaunchForTest(launch: { command: string; args: string[] } | null): void {
  ageHelperLaunchForTest = launch;
}

function emptyVault(): VaultData {
  return { v: 1, bundles: {} };
}

function parseVault(raw: string): VaultData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Vault content is malformed.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vault content has an invalid shape.');
  }
  const obj = parsed as Partial<VaultData>;
  if (obj.v !== 1 || !obj.bundles || typeof obj.bundles !== 'object' || Array.isArray(obj.bundles)) {
    throw new Error('Vault content has an invalid shape.');
  }
  const bundles: Record<string, VaultBundleRecord> = {};
  for (const [name, record] of Object.entries(obj.bundles)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Vault bundle '${name}' has an invalid shape.`);
    }
    const rec = record as Partial<VaultBundleRecord>;
    if (rec.metadata !== undefined && typeof rec.metadata !== 'string') {
      throw new Error(`Vault bundle '${name}' metadata is invalid.`);
    }
    if (!rec.keys || typeof rec.keys !== 'object' || Array.isArray(rec.keys)) {
      throw new Error(`Vault bundle '${name}' keys are invalid.`);
    }
    const keys: Record<string, string> = {};
    for (const [key, value] of Object.entries(rec.keys)) {
      if (typeof value !== 'string') throw new Error(`Vault key '${name}.${key}' is invalid.`);
      keys[key] = value;
    }
    bundles[name] = { metadata: rec.metadata, keys };
  }
  return { v: 1, bundles };
}

interface AgeInput {
  action: 'encrypt' | 'decrypt';
  passphrase: string;
  plaintext?: string;
  blob?: string;
  scryptWorkFactor?: number;
}

function runAgeSync(input: AgeInput): string {
  ageOperationCountForTest++;
  const launch = ageHelperLaunchForTest ?? getCliLaunch(['__vault-age-helper']);
  const child = spawnSync(launch.command, launch.args, {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.status !== 0) {
    const msg = child.stderr.trim();
    throw new Error(msg || child.error?.message || 'age operation failed');
  }
  return child.stdout;
}

export function encrypt(key: VaultKey, json: VaultData): string {
  return runAgeSync({
    action: 'encrypt',
    passphrase: key.passphrase,
    plaintext: JSON.stringify(json),
    scryptWorkFactor: VAULT_SCRYPT_WORK_FACTOR,
  });
}

export function decrypt(key: VaultKey, blob: string): VaultData {
  try {
    // Validate armor in-process so malformed files fail before spawning.
    armor.decode(blob);
    const plaintext = runAgeSync({
      action: 'decrypt',
      passphrase: key.passphrase,
      blob,
    });
    return parseVault(plaintext);
  } catch (err) {
    throw new Error(`Failed to decrypt vault. Wrong password or tampered vault file. (${(err as Error).message})`);
  }
}

function vaultFileStat(file: string): VaultFileStat {
  const stat = fs.statSync(file);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

function sameVaultFileStat(a: VaultFileStat, b: VaultFileStat): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function clearVaultDataCache(): void {
  vaultDataCache = null;
}

function cacheVaultData(file: string, key: VaultKey, data: VaultData): void {
  vaultDataCache = {
    file,
    passphrase: key.passphrase,
    stat: vaultFileStat(file),
    data,
  };
}

function vaultAlreadyExistsError(file: string): Error {
  return new Error(`Vault file already exists: ${file}. Use --force to replace it.`);
}

export function createVault(password: string, opts: { overwrite?: boolean } = {}): VaultKey {
  if (!password) throw new Error('Password is required.');
  const file = vaultPath();
  if (!opts.overwrite && fs.existsSync(file)) throw vaultAlreadyExistsError(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key: VaultKey = { passphrase: password };
  const data = emptyVault();
  const blob = encrypt(key, data);
  try {
    fs.writeFileSync(file, blob, { mode: 0o600, flag: opts.overwrite ? 'w' : 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw vaultAlreadyExistsError(file);
    throw err;
  }
  cacheVaultData(file, key, data);
  cacheVaultKey(key);
  return key;
}

export function joinVault(password: string, sourcePath: string, opts: { overwrite?: boolean } = {}): VaultKey {
  if (!password) throw new Error('Password is required.');
  const source = path.resolve(sourcePath);
  const dest = vaultPath();
  if (!opts.overwrite && fs.existsSync(dest)) throw vaultAlreadyExistsError(dest);
  const blob = fs.readFileSync(source, 'utf-8');
  const key: VaultKey = { passphrase: password };
  const data = decrypt(key, blob);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.copyFileSync(source, dest, opts.overwrite ? 0 : fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw vaultAlreadyExistsError(dest);
    throw err;
  }
  fs.chmodSync(dest, 0o600);
  cacheVaultData(dest, key, data);
  cacheVaultKey(key);
  return key;
}

export function unlock(password: string): VaultKey {
  if (!password) throw new Error('Password is required.');
  const file = vaultPath();
  if (!fs.existsSync(file)) throw new Error(`Vault file not found: ${file}`);
  const key: VaultKey = { passphrase: password };
  const data = decrypt(key, fs.readFileSync(file, 'utf-8'));
  cacheVaultData(file, key, data);
  cacheVaultKey(key);
  return key;
}

export function cacheVaultKey(key: VaultKey, ttlMs: number = VAULT_SESSION_TTL_MS): void {
  const session: VaultSession = {
    v: 1,
    passphrase: key.passphrase,
    expiresAt: Date.now() + ttlMs,
  };
  setKeychainToken(VAULT_SESSION_ITEM, JSON.stringify(session), { noAcl: true });
}

export function clearVaultKey(): void {
  clearVaultDataCache();
  deleteKeychainToken(VAULT_SESSION_ITEM);
}

export function getVaultSession(): { loggedIn: true; key: VaultKey; expiresAt: number } | { loggedIn: false; expiresAt?: number } {
  let raw: string;
  try {
    raw = getKeychainToken(VAULT_SESSION_ITEM);
  } catch {
    return { loggedIn: false };
  }
  let parsed: Partial<VaultSession>;
  try {
    parsed = JSON.parse(raw) as Partial<VaultSession>;
  } catch {
    clearVaultKey();
    return { loggedIn: false };
  }
  if (parsed.v !== 1 || typeof parsed.passphrase !== 'string' || typeof parsed.expiresAt !== 'number') {
    clearVaultKey();
    return { loggedIn: false };
  }
  if (parsed.expiresAt <= Date.now()) {
    clearVaultKey();
    return { loggedIn: false, expiresAt: parsed.expiresAt };
  }
  return { loggedIn: true, key: { passphrase: parsed.passphrase }, expiresAt: parsed.expiresAt };
}

function requireVaultKey(): VaultKey {
  const session = getVaultSession();
  if (!session.loggedIn) {
    throw new Error('Not logged in. Run: agents login');
  }
  return session.key;
}

function parseVaultItem(item: string): { kind: 'meta'; bundle: string } | { kind: 'key'; bundle: string; key: string } | null {
  const metaPrefix = 'agents-cli.bundles.';
  const keyPrefix = 'agents-cli.secrets.';
  if (item.startsWith(metaPrefix)) {
    return { kind: 'meta', bundle: item.slice(metaPrefix.length) };
  }
  if (item.startsWith(keyPrefix)) {
    const rest = item.slice(keyPrefix.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0 || dot >= rest.length - 1) return null;
    return { kind: 'key', bundle: rest.slice(0, dot), key: rest.slice(dot + 1) };
  }
  return null;
}

function vaultMissingError(file: string): Error {
  return new Error(
    `Vault file is missing: ${file}. A vault was created but the file is gone` +
      ' (a sync conflict, an undownloaded placeholder, or an accidental move/delete).' +
      ' Restore it before writing, or run: agents login --create --force to start over.',
  );
}

function readVaultData(): VaultData {
  const file = vaultPath();
  if (!fs.existsSync(file)) {
    // A live session means a vault was created/joined/unlocked, so the file
    // must exist. If it is gone, refuse rather than silently starting from an
    // empty vault (which a subsequent write would persist, destroying data).
    if (getVaultSession().loggedIn) throw vaultMissingError(file);
    return emptyVault();
  }
  const key = requireVaultKey();
  const stat = vaultFileStat(file);
  if (
    vaultDataCache &&
    vaultDataCache.file === file &&
    vaultDataCache.passphrase === key.passphrase &&
    sameVaultFileStat(vaultDataCache.stat, stat)
  ) {
    return vaultDataCache.data;
  }
  const data = decrypt(key, fs.readFileSync(file, 'utf-8'));
  vaultDataCache = { file, passphrase: key.passphrase, stat, data };
  return data;
}

function writeVaultData(data: VaultData): void {
  const file = vaultPath();
  const key = requireVaultKey();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, encrypt(key, data), { encoding: 'utf-8', mode: 0o600 });
  cacheVaultData(file, key, data);
}

function withVaultMutation<T>(mutate: (data: VaultData) => { changed: boolean; result: T }): T {
  const file = vaultPath();
  requireVaultKey();
  if (!fs.existsSync(file)) throw vaultMissingError(file);
  return withFileLock(file, () => {
    const data = readVaultData();
    const { changed, result } = mutate(data);
    if (changed) writeVaultData(data);
    return result;
  }, { staleMs: VAULT_LOCK_STALE_MS, acquireTimeoutMs: VAULT_LOCK_ACQUIRE_TIMEOUT_MS });
}

export function vaultHasItem(item: string): boolean {
  const parsed = parseVaultItem(item);
  if (!parsed) return false;
  const data = readVaultData();
  const bundle = data.bundles[parsed.bundle];
  if (!bundle) return false;
  return parsed.kind === 'meta' ? bundle.metadata !== undefined : parsed.key in bundle.keys;
}

export function vaultGetItem(item: string): string {
  const parsed = parseVaultItem(item);
  if (!parsed) throw new Error(`Vault item '${item}' is invalid.`);
  const data = readVaultData();
  const bundle = data.bundles[parsed.bundle];
  const value = parsed.kind === 'meta' ? bundle?.metadata : bundle?.keys[parsed.key];
  if (value === undefined) throw new Error(`Vault item '${item}' not found.`);
  return value;
}

export function vaultGetItems(items: string[]): Map<string, string> {
  const data = readVaultData();
  const out = new Map<string, string>();
  for (const item of items) {
    const parsed = parseVaultItem(item);
    if (!parsed) continue;
    const bundle = data.bundles[parsed.bundle];
    const value = parsed.kind === 'meta' ? bundle?.metadata : bundle?.keys[parsed.key];
    if (value !== undefined) out.set(item, value);
  }
  return out;
}

export function vaultSetItem(item: string, value: string): void {
  vaultSetItems(new Map([[item, value]]));
}

export function vaultSetItems(items: Map<string, string>): void {
  if (items.size === 0) return;
  withVaultMutation((data) => {
    for (const [item, value] of items) {
      const parsed = parseVaultItem(item);
      if (!parsed) throw new Error(`Vault item '${item}' is invalid.`);
      const bundle = data.bundles[parsed.bundle] ?? { keys: {} };
      if (parsed.kind === 'meta') bundle.metadata = value;
      else bundle.keys[parsed.key] = value;
      data.bundles[parsed.bundle] = bundle;
    }
    return { changed: true, result: undefined };
  });
}

export function vaultDeleteItem(item: string): boolean {
  const parsed = parseVaultItem(item);
  if (!parsed) return false;
  return withVaultMutation((data) => {
    const bundle = data.bundles[parsed.bundle];
    if (!bundle) return { changed: false, result: false };
    let deleted = false;
    if (parsed.kind === 'meta') {
      deleted = bundle.metadata !== undefined;
      delete bundle.metadata;
    } else {
      deleted = parsed.key in bundle.keys;
      delete bundle.keys[parsed.key];
    }
    if (bundle.metadata === undefined && Object.keys(bundle.keys).length === 0) {
      delete data.bundles[parsed.bundle];
    }
    return { changed: deleted, result: deleted };
  });
}

export function vaultListItems(prefix: string): string[] {
  const data = readVaultData();
  const out: string[] = [];
  for (const [bundleName, bundle] of Object.entries(data.bundles)) {
    const meta = `agents-cli.bundles.${bundleName}`;
    if (bundle.metadata !== undefined && meta.startsWith(prefix)) out.push(meta);
    for (const key of Object.keys(bundle.keys)) {
      const item = `agents-cli.secrets.${bundleName}.${key}`;
      if (item.startsWith(prefix)) out.push(item);
    }
  }
  return out.sort();
}
