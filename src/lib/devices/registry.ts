/**
 * Device registry.
 *
 * Manages the persistent registry of SSH device profiles stored at
 * ~/.agents/.history/devices/registry.json. Each profile records what we had
 * to re-derive by hand the first time we reached a host: its platform (so we
 * know PowerShell vs POSIX), the login user, how to address it (Tailscale
 * DNS name / IP), and how to authenticate (pubkey, or a password pulled from
 * a secrets bundle).
 *
 * Like the team registry this is per-machine runtime state (it embeds a host
 * list + addresses) and lives under .history/ so it is NOT pulled in by
 * `agents repo push`. The load/save/lock plumbing is a deliberate clone of
 * src/lib/teams/registry.ts so the data-loss guarantees match exactly.
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import lockfile from 'proper-lockfile';
import { getDevicesRegistryPath, getDevicesIgnoredPath } from '../state.js';

/** Operating-system family of a device, used to pick the remote shell. */
export type DevicePlatform = 'windows' | 'linux' | 'macos' | 'unknown';

/** Remote shell dialect derived from the platform. */
export type DeviceShell = 'powershell' | 'posix';

/** How `agents ssh` authenticates to a device. Both are first-class, fully
 * non-interactive: `key` uses the ssh agent / on-disk keys, `password` pulls
 * the secret from a Keychain-backed secrets bundle via an askpass shim. */
export type DeviceAuthMethod = 'key' | 'password';

/** How to reach a device on the network. */
export interface DeviceAddress {
  /** Where the address came from: a Tailscale node, or a manual entry. */
  via: 'tailscale' | 'manual';
  /** Fully-qualified DNS name (Tailscale MagicDNS), without a trailing dot. */
  dnsName?: string;
  /** Raw IP address (IPv4 preferred). */
  ip?: string;
}

/** Authentication settings for a device. */
export interface DeviceAuth {
  method: DeviceAuthMethod;
  /** Secrets bundle holding the password (when method === 'password'). */
  bundle?: string;
  /** Key within the bundle whose value is the password. Defaults to 'password'. */
  bundleKey?: string;
}

/** Last-known Tailscale reachability snapshot for a device. */
export interface DeviceTailscale {
  online: boolean;
  /** True when the last handshake was a direct (non-relayed) connection. */
  direct: boolean;
  /** DERP relay region code (e.g. 'sfo'); empty when direct. */
  relay?: string;
  lastSeen?: string;
}

/** A single registered device. */
export interface DeviceProfile {
  name: string;
  platform: DevicePlatform;
  shell: DeviceShell;
  user?: string;
  address: DeviceAddress;
  auth: DeviceAuth;
  tailscale?: DeviceTailscale;
  createdAt: string;
  updatedAt: string;
}

/** Map of device name to profile. */
export type DeviceRegistry = Record<string, DeviceProfile>;

function registryPath(): string {
  return getDevicesRegistryPath();
}

/** Valid logical device name: the ssh-alias charset, so it renders into an
 * unambiguous `Host` stanza and is safe as an ssh target. */
const DEVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Throw if `name` is not usable as an ssh alias (no spaces, quotes, etc.). */
export function assertValidDeviceName(name: string): void {
  if (!DEVICE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid device name ${JSON.stringify(name)}. Use letters, digits, '.', '_', '-' (no spaces) — e.g. 'win-mini'.`,
    );
  }
}

/** Map a Tailscale `OS` field to our platform enum. */
export function platformFromOs(os: string | undefined): DevicePlatform {
  switch ((os ?? '').toLowerCase()) {
    case 'windows':
      return 'windows';
    case 'linux':
      return 'linux';
    case 'macos':
    case 'darwin':
      return 'macos';
    default:
      return 'unknown';
  }
}

/** The remote shell a platform speaks. */
export function shellForPlatform(platform: DevicePlatform): DeviceShell {
  return platform === 'windows' ? 'powershell' : 'posix';
}

/**
 * Atomic JSON write: write to a unique sibling tmp file then rename over the
 * target. rename(2) is atomic on POSIX, so a crashed write leaves the old file
 * untouched instead of producing a half-written registry that loadDevices()
 * would reject.
 */
async function atomicWriteJson(p: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  try {
    await fs.rename(tmp, p);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Run `fn` while holding an exclusive cross-process lock on the registry file.
 * proper-lockfile requires the target to exist, so we touch it first. Stale
 * locks (from crashed callers) auto-expire after `stale` ms.
 */
async function withRegistryLock<T>(p: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  if (!fsSync.existsSync(p)) {
    try {
      await fs.writeFile(p, '{}', { flag: 'wx' });
    } catch (err: any) {
      if (err && err.code !== 'EEXIST') throw err;
    }
  }
  const release = await lockfile.lock(p, {
    retries: { retries: 60, minTimeout: 25, maxTimeout: 250, factor: 1.5 },
    stale: 10_000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Load all devices from the registry file. Returns an empty object only when
 * the file does not exist. A malformed file is a hard error — silently
 * returning {} would let the next write wipe the user's device list.
 */
export async function loadDevices(): Promise<DeviceRegistry> {
  const p = registryPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw) as DeviceRegistry;
  } catch (err: any) {
    throw new Error(
      `Device registry corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`,
    );
  }
}

async function saveDevices(reg: DeviceRegistry): Promise<void> {
  await atomicWriteJson(registryPath(), reg);
}

/** Get a single device profile, or null if it is not registered. */
export async function getDevice(name: string): Promise<DeviceProfile | null> {
  const reg = await loadDevices();
  return reg[name] ?? null;
}

/** Fields a caller may supply when creating or updating a device. */
export interface DeviceInput {
  platform?: DevicePlatform;
  user?: string;
  address?: DeviceAddress;
  auth?: DeviceAuth;
  tailscale?: DeviceTailscale;
}

/**
 * Create the device if absent, otherwise merge the supplied fields into the
 * existing profile. `shell` is always re-derived from the (possibly new)
 * platform so the two can never drift. Returns the resulting profile.
 */
export async function upsertDevice(name: string, input: DeviceInput): Promise<DeviceProfile> {
  assertValidDeviceName(name);
  const p = registryPath();
  return withRegistryLock(p, async () => {
    const reg = await loadDevices();
    const now = new Date().toISOString();
    const prev = reg[name];
    const platform = input.platform ?? prev?.platform ?? 'unknown';
    const merged: DeviceProfile = {
      name,
      platform,
      shell: shellForPlatform(platform),
      user: input.user ?? prev?.user,
      address: input.address ?? prev?.address ?? { via: 'manual' },
      auth: input.auth ?? prev?.auth ?? { method: 'key' },
      tailscale: input.tailscale ?? prev?.tailscale,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    reg[name] = merged;
    await saveDevices(reg);
    return merged;
  });
}

/** Remove a device. Returns false if it was not registered. */
export async function removeDevice(name: string): Promise<boolean> {
  const p = registryPath();
  return withRegistryLock(p, async () => {
    const reg = await loadDevices();
    if (!reg[name]) return false;
    delete reg[name];
    await saveDevices(reg);
    return true;
  });
}

/**
 * The ignore-list: tailscale node names the user explicitly dismissed from
 * auto-discovery. A dismissed node is NOT a device (it never enters the
 * registry), so it lives in a sibling file. Auto-discovery (`runDeviceSync`'s
 * pending diff) subtracts this set, so an ignored node never re-surfaces as a
 * suggestion. Stored under the same devices/ dir, guarded by the same lock and
 * atomic-write plumbing as the registry.
 */
interface IgnoredFile {
  ignored: string[];
  updatedAt: string;
}

function ignoredPath(): string {
  return getDevicesIgnoredPath();
}

/** Load the set of ignored node names. Missing file => empty set. A malformed
 * file is a hard error for the same reason the registry is: silently returning
 * [] would let the next write wipe the user's dismissals. */
export async function loadIgnored(): Promise<Set<string>> {
  const p = ignoredPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf-8');
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return new Set();
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as IgnoredFile;
    return new Set(Array.isArray(parsed.ignored) ? parsed.ignored : []);
  } catch (err: any) {
    throw new Error(
      `Device ignore-list corrupted at ${p}: ${err?.message ?? err}. Inspect and restore from backup.`,
    );
  }
}

/** True if `name` is on the ignore-list. */
export async function isIgnored(name: string): Promise<boolean> {
  return (await loadIgnored()).has(name);
}

/** Add a node name to the ignore-list. Idempotent. Returns the resulting set. */
export async function addIgnored(name: string): Promise<Set<string>> {
  assertValidDeviceName(name);
  const p = ignoredPath();
  return withRegistryLock(p, async () => {
    const set = await loadIgnored();
    set.add(name);
    await atomicWriteJson(p, { ignored: [...set].sort(), updatedAt: new Date().toISOString() });
    return set;
  });
}

/** Remove a node name from the ignore-list (un-ignore). Returns false if it was
 * not ignored. */
export async function removeIgnored(name: string): Promise<boolean> {
  const p = ignoredPath();
  return withRegistryLock(p, async () => {
    const set = await loadIgnored();
    if (!set.delete(name)) return false;
    await atomicWriteJson(p, { ignored: [...set].sort(), updatedAt: new Date().toISOString() });
    return true;
  });
}
