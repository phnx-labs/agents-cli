/**
 * Non-secret daemon state exchanged through the already fleet-synced user repo.
 *
 * Each device owns exactly one file under `~/.agents/devices/<device>/`, so
 * normal `agents repo push/pull user` merges the fleet without devices dialing
 * one another on every daemon tick. OAuth/setup-token values never belong here:
 * auth publishes only a readiness verdict; the existing encrypted SSH transport
 * remains the one path that may carry secret material.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertValidDeviceName } from './devices/registry.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';
import { getUserAgentsDir } from './state.js';
import type { CachedUsageSnapshot } from './accounting/usage.js';

export const FLEET_SHARED_STATE_VERSION = 1;
export const FLEET_SHARED_STATE_FILE = 'daemon-state.json';

export type SharedAuthStatus = 'ready' | 'missing' | 'invalid';

export interface FleetSharedDeviceState {
  version: typeof FLEET_SHARED_STATE_VERSION;
  device: string;
  usage?: {
    rows: Record<string, CachedUsageSnapshot>;
  };
  auth?: {
    status: SharedAuthStatus;
  };
}

export interface FleetSharedStatePatch {
  usage?: FleetSharedDeviceState['usage'];
  auth?: FleetSharedDeviceState['auth'];
}

export interface FleetSharedStateReadResult {
  states: FleetSharedDeviceState[];
  errors: Array<{ device: string; message: string }>;
}

/** Path owned by one device in the conflict-free tracked device-doc tree. */
export function fleetSharedStatePath(
  device: string,
  userAgentsDir = getUserAgentsDir(),
): string {
  assertValidDeviceName(device);
  return path.join(userAgentsDir, 'devices', device, FLEET_SHARED_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseFleetSharedDeviceState(raw: string, owner: string): FleetSharedDeviceState {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.version !== FLEET_SHARED_STATE_VERSION || parsed.device !== owner) {
    throw new Error('unrecognized shared-state envelope');
  }
  const usage = parsed.usage;
  if (usage !== undefined && (!isRecord(usage) || !isRecord(usage.rows))) {
    throw new Error('unrecognized usage snapshot');
  }
  const auth = parsed.auth;
  if (
    auth !== undefined &&
    (!isRecord(auth) || !['ready', 'missing', 'invalid'].includes(String(auth.status)))
  ) {
    throw new Error('unrecognized auth verdict');
  }
  return parsed as unknown as FleetSharedDeviceState;
}

/**
 * Merge one daemon-owned field into this device's shared file under a real
 * inter-process lock. Stable serialization avoids dirtying the user repo when
 * neither usage nor auth state changed.
 */
export function updateFleetSharedDeviceState(
  device: string,
  patch: FleetSharedStatePatch,
  userAgentsDir = getUserAgentsDir(),
): { changed: boolean; path: string } {
  const file = fleetSharedStatePath(device, userAgentsDir);
  ensureLockTarget(file, '');
  return withFileLock(file, () => {
    let current: FleetSharedDeviceState = {
      version: FLEET_SHARED_STATE_VERSION,
      device,
    };
    try {
      const raw = fs.readFileSync(file, 'utf-8').trim();
      if (raw) current = parseFleetSharedDeviceState(raw, device);
    } catch {
      // The owning device repairs its own malformed file from authoritative
      // local state. Peer files are never repaired by this writer.
    }
    const next: FleetSharedDeviceState = {
      ...current,
      ...(patch.usage !== undefined ? { usage: patch.usage } : {}),
      ...(patch.auth !== undefined ? { auth: patch.auth } : {}),
      version: FLEET_SHARED_STATE_VERSION,
      device,
    };
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (fs.readFileSync(file, 'utf-8') === serialized) return { changed: false, path: file };
    atomicWriteFileSync(file, serialized, 'utf-8');
    return { changed: true, path: file };
  });
}

/** Read every valid peer-owned state file; malformed peers fail separately. */
export function readFleetSharedDeviceStates(
  userAgentsDir = getUserAgentsDir(),
): FleetSharedStateReadResult {
  const devicesDir = path.join(userAgentsDir, 'devices');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(devicesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { states: [], errors: [] };
    return { states: [], errors: [{ device: '*', message: (err as Error).message }] };
  }
  const states: FleetSharedDeviceState[] = [];
  const errors: Array<{ device: string; message: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(devicesDir, entry.name, FLEET_SHARED_STATE_FILE);
    if (!fs.existsSync(file)) continue;
    try {
      states.push(parseFleetSharedDeviceState(fs.readFileSync(file, 'utf-8'), entry.name));
    } catch (err) {
      errors.push({ device: entry.name, message: (err as Error).message });
    }
  }
  return { states, errors };
}
