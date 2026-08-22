/**
 * Batched session-id discovery for AGI EXT tabs.
 *
 * Reads the shared `agents sessions watch --json` projection for every tab.
 * No per-tab subprocesses or extension-owned freshness cache.
 *
 * Placement flags: uses `--device` / local only — never `--where`.
 */

import * as os from 'os';
import { normalizeHost } from './remoteSessions';
import { canonicalSessionId, isRolloutSessionStem } from './canonicalSessionId';
import { sessionPresentationStore } from './sessionPresentationStore';

/** Legacy exported timing constants retained for pure caller compatibility. */
export const ACTIVE_MAP_TTL_LOCAL_MS = 3_000;
/** Remote active feed TTL — one poll services all tabs on that host. */
export const ACTIVE_MAP_TTL_REMOTE_MS = 8_000;
/** Hard ceiling on the local CLI subprocess. */
export const ACTIVE_MAP_TIMEOUT_LOCAL_MS = 5_000;
/** Hard ceiling on a remote `--device` active fetch (SSH + CLI). */
export const ACTIVE_MAP_TIMEOUT_REMOTE_MS = 10_000;

const LOCAL_CACHE_KEY = '__local__';

export type TerminalIdSessionMap = Map<string, string>;

/** Test-only: reset the shared cache between unit tests. */
export function resetSessionIdHydrateCacheForTests(): void {
  // The canonical stream store owns freshness; there is no extension cache.
}

/**
 * Cache key for a tab's placement. Same-machine `--device <this-host>` collapses
 * to local so we do not SSH to ourselves and so local state hydrate can still run.
 */
export function activeMapCacheKey(
  host: string | undefined,
  localHostname: string = os.hostname(),
  localMachineId: string = normalizeHost(localHostname),
): string {
  if (!host?.trim()) return LOCAL_CACHE_KEY;
  const n = normalizeHost(host);
  if (!n) return LOCAL_CACHE_KEY;
  if (n === localMachineId || n === normalizeHost(localHostname)) return LOCAL_CACHE_KEY;
  // Also match bare hostname equality (yosemite-s1 vs yosemite-s1.tailnet)
  if (host === localHostname || host.startsWith(`${localHostname}.`)) return LOCAL_CACHE_KEY;
  return n;
}

export function isLocalActiveMapKey(key: string): boolean {
  return key === LOCAL_CACHE_KEY;
}

/**
 * Read terminalId → sessionId for one host (or local) from the shared stream.
 */
export async function fetchTerminalIdSessionMap(
  host: string | undefined,
  deps: {
    now?: number;
    localHostname?: string;
  } = {},
): Promise<TerminalIdSessionMap> {
  const key = activeMapCacheKey(host, deps.localHostname);
  return sessionPresentationStore.terminalSessionMap(isLocalActiveMapKey(key) ? undefined : host);
}

/**
 * Resolve one tab's session id from the batched active map.
 * `terminalId` is the ext's AGENT_TERMINAL_ID (EditorTerminal.id).
 */
export async function resolveSessionIdForTerminal(
  terminalId: string | undefined,
  host: string | undefined,
  deps?: Parameters<typeof fetchTerminalIdSessionMap>[1],
): Promise<string | undefined> {
  const tid = terminalId?.trim();
  if (!tid) return undefined;
  const map = await fetchTerminalIdSessionMap(host, deps);
  return map.get(tid);
}

/**
 * Whether the tab still needs a CLI join (missing id, or a dirty rollout stem).
 */
export function needsSessionIdHydrate(sessionId: string | undefined | null): boolean {
  if (!sessionId?.trim()) return true;
  return isRolloutSessionStem(sessionId) || canonicalSessionId(sessionId) !== sessionId.trim();
}
