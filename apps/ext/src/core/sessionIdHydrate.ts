/**
 * Batched session-id discovery for AGI EXT tabs.
 *
 * One `agents sessions --active --json` (optionally `--host <device>`) per host,
 * shared across every tab on that host via {@link cachedInFlight}. Hard timeouts
 * so a hung SSH never blocks the status bar. No per-tab subprocess thrash when
 * the user has ~15 remote sessions.
 *
 * Placement flags: uses `--host` / local only — never `--where`.
 */

import * as os from 'os';
import { cachedInFlight, createTimedCache, type TimedCache } from './cachedInFlight';
import { runAgents } from './agentsBin';
import { normalizeHost } from './remoteSessions';
import {
  parseActiveSessionJoinRows,
  terminalIdToSessionIdMap,
} from './sessionIdJoin';
import { canonicalSessionId, isRolloutSessionStem } from './canonicalSessionId';

/** Local active feed TTL — short enough to pick up a new Grok SessionStart. */
export const ACTIVE_MAP_TTL_LOCAL_MS = 3_000;
/** Remote active feed TTL — one poll services all tabs on that host. */
export const ACTIVE_MAP_TTL_REMOTE_MS = 8_000;
/** Hard ceiling on the local CLI subprocess. */
export const ACTIVE_MAP_TIMEOUT_LOCAL_MS = 5_000;
/** Hard ceiling on a remote `--host` active fetch (SSH + CLI). */
export const ACTIVE_MAP_TIMEOUT_REMOTE_MS = 10_000;

const LOCAL_CACHE_KEY = '__local__';

export type TerminalIdSessionMap = Map<string, string>;

let mapCache: TimedCache<TerminalIdSessionMap> = createTimedCache();

/** Test-only: reset the shared cache between unit tests. */
export function resetSessionIdHydrateCacheForTests(): void {
  mapCache = createTimedCache();
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

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Fetch terminalId → sessionId for one host (or local). Coalesced + TTL'd.
 * On timeout / CLI failure returns an empty map (leave unmapped, never wrong).
 */
export async function fetchTerminalIdSessionMap(
  host: string | undefined,
  deps: {
    runAgents?: typeof runAgents;
    now?: number;
    localHostname?: string;
  } = {},
): Promise<TerminalIdSessionMap> {
  const run = deps.runAgents ?? runAgents;
  const now = deps.now ?? Date.now();
  const key = activeMapCacheKey(host, deps.localHostname);
  const isLocal = isLocalActiveMapKey(key);
  const ttl = isLocal ? ACTIVE_MAP_TTL_LOCAL_MS : ACTIVE_MAP_TTL_REMOTE_MS;
  const timeout = isLocal ? ACTIVE_MAP_TIMEOUT_LOCAL_MS : ACTIVE_MAP_TIMEOUT_REMOTE_MS;

  return cachedInFlight(mapCache, key, ttl, async () => {
    // `--local` for this machine; `--host <device>` for a real offload.
    // Never `--where`.
    const args = isLocal
      ? 'sessions --active --local --json'
      : `sessions --active --json --host ${shellQuote(host!.trim())}`;
    try {
      const { stdout } = await run(args, { timeout });
      return terminalIdToSessionIdMap(parseActiveSessionJoinRows(stdout));
    } catch {
      return new Map();
    }
  }, now);
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
