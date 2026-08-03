import { normalizeHost } from '../shared/project';
import type { HostUsageScore } from './agentUsage';

/**
 * The persisted snapshot behind the host picker's stale-while-revalidate flow.
 * The picker renders from this instantly (even minutes or restarts old), fires
 * one background refresh, and swaps the items in place when fresh data lands —
 * the menu never blocks on the fleet-wide SSH sweep again.
 *
 * `devices` mirrors the vscode-side `Device` (deviceHealth.vscode.ts), which is
 * JSON-serializable; the extra fields ride along for pickers that need them.
 */
export interface HostPickerDevice {
  name: string;
  host: string;
  secretRef?: string;
  user?: string;
  platform?: string;
  online?: boolean;
  registeredAt?: number;
}

export interface HostPickerCache {
  devices: HostPickerDevice[];
  /** Usage scores keyed by normalized host name ('this-mac' for the local box). */
  usage: Record<string, HostUsageScore>;
  fetchedAt: number;
}

export const HOST_PICKER_CACHE_KEY = 'agents.hostPicker.v1';

/** Revalidate at most this often — a fresher snapshot is reused as-is. */
export const HOST_PICKER_STALE_MS = 60_000;

export function serializeUsage(scores: Map<string, HostUsageScore>): Record<string, HostUsageScore> {
  return Object.fromEntries(scores);
}

/** Shape-check a value read back from globalState; returns undefined on drift. */
export function parseHostPickerCache(raw: unknown): HostPickerCache | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<HostPickerCache>;
  if (!Array.isArray(c.devices) || typeof c.fetchedAt !== 'number') return undefined;
  if (!c.usage || typeof c.usage !== 'object' || Array.isArray(c.usage)) return undefined;
  return c as HostPickerCache;
}

export function isHostPickerStale(cache: HostPickerCache | null | undefined, now = Date.now()): boolean {
  return !cache || now - cache.fetchedAt >= HOST_PICKER_STALE_MS;
}

/**
 * Merge a fresh device snapshot into the prior cache while PRESERVING its usage
 * scores. The device rows (names + reachability) come from the cheap registry
 * read; the expensive fleet usage sweep fills `usage` on its own pass. Splitting
 * them this way is what lets the picker render every host from the registry read
 * alone, without waiting on the SSH sweep — the usage annotations arrive after.
 */
export function withRefreshedDevices(
  prev: HostPickerCache | null | undefined,
  devices: HostPickerDevice[],
  now = Date.now(),
): HostPickerCache {
  return { devices, usage: prev?.usage ?? {}, fetchedAt: now };
}

/**
 * The picker's device order: online first, then how much the box is actually
 * used, then name. Pure so the stale render and the revalidated render sort
 * identically — the item swap never reshuffles a row the scores didn't move.
 */
export function sortHostPickerDevices<T extends Pick<HostPickerDevice, 'name' | 'online'>>(
  devices: readonly T[],
  usage: Record<string, HostUsageScore>,
): T[] {
  const scoreOf = (name: string) => usage[normalizeHost(name)]?.score ?? 0;
  return [...devices].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      scoreOf(b.name) - scoreOf(a.name) ||
      a.name.localeCompare(b.name),
  );
}

/** Short age label appended to picker rows so a stale snapshot reads as stale. */
export function freshnessSuffix(fetchedAt: number, now = Date.now()): string {
  const ageMs = Math.max(0, now - fetchedAt);
  if (ageMs < 60_000) return 'updated just now';
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}
