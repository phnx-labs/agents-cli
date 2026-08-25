import { randomBytes } from 'crypto';

import { GLOBAL_HARNESS } from './scope.js';

export const MIN_LEASE_MS = 60 * 1000;
export const MAX_LEASE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SecretLease {
  id: string;
  bundle: string;
  keys: string[];
  createdAt: number;
  expiresAt: number;
  harness: string;
  sleepPersist: boolean;
}

export function clampLeaseTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Lease duration must be a positive finite number.');
  }
  return Math.min(Math.max(Math.floor(ttlMs), MIN_LEASE_MS), MAX_LEASE_MS);
}

export function normalizeLeaseKeys(keys: readonly string[], availableKeys: readonly string[]): string[] {
  const requested = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort();
  if (requested.length === 0) throw new Error('A secret lease requires at least one key.');
  const available = new Set(availableKeys);
  const missing = requested.filter((key) => !available.has(key));
  if (missing.length > 0) throw new Error(`Unknown secret lease key(s): ${missing.join(', ')}`);
  return requested;
}

export function createSecretLease(input: {
  bundle: string;
  keys: readonly string[];
  availableKeys: readonly string[];
  ttlMs: number;
  now?: number;
  id?: string;
  harness?: string;
  sleepPersist?: boolean;
}): SecretLease {
  const createdAt = input.now ?? Date.now();
  const ttlMs = clampLeaseTtlMs(input.ttlMs);
  return {
    id: input.id ?? randomBytes(12).toString('hex'),
    bundle: input.bundle,
    keys: normalizeLeaseKeys(input.keys, input.availableKeys),
    createdAt,
    expiresAt: createdAt + ttlMs,
    harness: input.harness ?? GLOBAL_HARNESS,
    sleepPersist: input.sleepPersist ?? false,
  };
}

export function leaseIsActive(lease: SecretLease, now: number = Date.now()): boolean {
  return now < lease.expiresAt;
}

export function selectLeasedEnv(lease: SecretLease, env: Record<string, string>, now: number = Date.now()): Record<string, string> {
  if (!leaseIsActive(lease, now)) throw new Error(`Secret lease '${lease.id}' has expired.`);
  const missing = lease.keys.filter((key) => typeof env[key] !== 'string');
  if (missing.length > 0) throw new Error(`Secret lease '${lease.id}' is missing value(s): ${missing.join(', ')}`);
  return Object.fromEntries(lease.keys.map((key) => [key, env[key]]));
}
