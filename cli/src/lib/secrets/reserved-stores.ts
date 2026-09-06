/**
 * Reserved per-harness credential stores (PHNX-3940).
 *
 * One store name per `ALL_AGENT_IDS` entry: `__<harness>__`. A user-named
 * bundle can never collide with these — `bundles.ts` rejects names starting
 * with `__`. The table is the only place a reserved name can be added.
 *
 * The legacy `auth` bundle remains a readable alias for `__claude__`. This
 * module does not migrate data.
 *
 * The store may only hold non-rotating kinds (`setup-token`, `api-key`). A
 * native OAuth/session file with a refresh token is refused at write time —
 * reusing it across devices logs the owner out (RUSH-1958).
 */
import { AGENT_IDS, type AgentId } from '../types.js';

/** Legacy readable alias for `__claude__`. Not migrated in this track. */
export const AUTH_STORE_ALIAS = 'auth';

export const RESERVED_STORES: Record<AgentId, string> = Object.fromEntries(
  AGENT_IDS.map((id) => [id, `__${id}__`]),
) as Record<AgentId, string>;

export function reservedStoreName(harness: AgentId): string {
  const name = RESERVED_STORES[harness];
  if (!name) throw new Error(`No reserved store for '${harness}'.`);
  return name;
}

export function isReservedStoreName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n === AUTH_STORE_ALIAS) return true;
  return AGENT_IDS.some((id) => RESERVED_STORES[id].toLowerCase() === n);
}

export type StorableCredentialKind = 'setup-token' | 'api-key';

/**
 * Fail loud at the write boundary: only a setup-token or an API key may enter
 * a reserved store. Rotating OAuth/session credentials stay in their slot on
 * the device that minted them.
 */
export function assertStorableCredentialKind(
  kind: string,
  harness?: AgentId,
): asserts kind is StorableCredentialKind {
  if (kind === 'setup-token' || kind === 'api-key') return;
  throw new Error(storableCredentialRefusal(kind, harness));
}

function storableCredentialRefusal(kind: string, harness?: AgentId): string {
  if (harness === 'codex') {
    return 'codex: auth.json is a rotating session; add an API key instead';
  }
  if (harness === 'droid') {
    return 'droid: refresh tokens are single-use and collapse the fleet when copied; add a FACTORY_API_KEY instead';
  }
  if (harness === 'claude') {
    return 'claude: native OAuth (.credentials.json) is a rotating session; mint a setup-token instead';
  }
  if (harness === 'grok') {
    return 'grok: auth.json is a rotating session; add an XAI_API_KEY instead';
  }
  if (harness === 'kimi' || harness === 'antigravity') {
    return `${harness}: no portable worker credential; log in per device`;
  }
  const who = harness ?? 'this harness';
  return `${who}: reserved stores accept only a setup-token or an API key, not '${kind}'`;
}
