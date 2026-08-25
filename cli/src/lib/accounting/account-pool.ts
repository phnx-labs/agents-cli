import type { AgentId, RunStrategy } from '../types.js';
import type { AccountAuthKind } from '../account-provider-registry.js';
import { getAccountProvider } from '../account-provider-registry.js';
import { capacityWeight } from './capacity.js';

/**
 * The pool of accounts that can run one harness, and the pick over it.
 *
 * This is the picking logic behind `agents run --strategy balanced`: given the
 * accounts connected to a harness, choose one weighted by how much usage each has
 * left. Today the router enumerates *version homes* instead of accounts
 * (`collectRunCandidates`), which is why a token/API-key account never gets
 * picked. This module is the account-centric replacement.
 *
 * The core is PURE — every input is passed in, nothing here reads a home, a
 * secret, or the network — so it is unit-tested with fixtures. The one I/O step
 * (reading native logins + the account registry into `PoolInputs`) lives in the
 * caller/collector, not here.
 *
 * The unit is `(agent, account)`, keyed on the agent-scoped `accountKey`
 * (`buildIdentityKey` → `${agent}:…`), so the same email signed into Claude and
 * Codex is two distinct pool members and one harness's pool never selects the
 * other's login.
 */

/** How an account authenticates — decides how its credential is injected at exec. */
export type PoolAccountKind = 'oauth' | 'setup-token' | 'api-key' | 'bearer-token';

/** Where a pool member came from. A native login wins a dedup tie over a bundle. */
export type PoolAccountSource = 'native-login' | 'registry';

export interface PoolAccount {
  agent: AgentId;
  /** Agent-scoped identity key — the dedup + selection key. `${agent}:…`. */
  accountKey: string;
  email: string | null;
  kind: PoolAccountKind;
  source: PoolAccountSource;
  /** For a native login: the version home that holds it (where a run executes). */
  version: string | null;
  /** For a registry account: its bundle name, so exec can resolve the secret. */
  secretRef: string | null;
  /** Provider adapter id (registry accounts only) — drives `envFor`. */
  provider: string | null;
  /** 0–100 non-session usage, or null when unknown (cold cache). */
  usedPercent: number | null;
  /** Projected minutes to the limit, or null. */
  minutesToLimit: number | null;
  /** True when the account is currently rate-limited and cannot serve a request. */
  rateLimited: boolean;
}

/** A native login discovered in a version home (already balance-visible today). */
export interface NativeLoginInput {
  accountKey: string;
  email: string | null;
  version: string;
  usedPercent?: number | null;
  minutesToLimit?: number | null;
  rateLimited?: boolean;
}

/** A provider account from the registry that CAN authenticate this harness. */
export interface RegistryAccountInput {
  accountKey: string;
  email: string | null;
  name: string;
  provider: string;
  auth: AccountAuthKind;
  usedPercent?: number | null;
  minutesToLimit?: number | null;
  rateLimited?: boolean;
}

export interface PoolInputs {
  native: NativeLoginInput[];
  registry: RegistryAccountInput[];
}

const authKindToPoolKind: Record<AccountAuthKind, PoolAccountKind> = {
  'api-key': 'api-key',
  'setup-token': 'setup-token',
  'bearer-token': 'bearer-token',
};

/** A provider account record as stored in the registry (identity captured separately). */
export interface RegistryAccountRecord {
  name: string;
  provider: string;
  auth: AccountAuthKind;
}

/**
 * The registry side of the collector, pure: which provider accounts can
 * authenticate `agent` at all. An account is a candidate for harness H only when
 * its provider adapter has an `envFor(H, kind)` mapping — the same capability
 * check `attach` uses (`accounts.ts:533`) — so a Cursor key never enters Claude's
 * pool and a Claude setup-token never enters Codex's. This is what makes the pool
 * harness-parity-correct without a per-harness `else if`.
 *
 * `accountKey` is synthetic here (`${agent}:name=${name}`) — a stable per-account
 * key so balancing can include it immediately; the real agent-scoped identity
 * (email/org uuid) is backfilled by identity capture and replaces it. `email` is
 * null until then, which routes the account as usage-unverified but still
 * eligible, never excluded.
 */
export function registryPoolCandidates(
  records: RegistryAccountRecord[],
  agent: AgentId,
): RegistryAccountInput[] {
  const out: RegistryAccountInput[] = [];
  for (const r of records) {
    try {
      getAccountProvider(r.provider).envFor(agent, r.auth); // throws when it can't auth this harness
    } catch {
      continue; // provider can't authenticate `agent` — not in this harness's pool
    }
    out.push({
      accountKey: `${agent}:name=${r.name}`,
      email: null,
      name: r.name,
      provider: r.provider,
      auth: r.auth,
    });
  }
  return out;
}

/**
 * Build the harness's account pool from already-collected inputs.
 *
 * Native logins and registry accounts are unioned and **deduped by
 * `accountKey`** — a native login WINS the tie, because a home signed into an
 * account already has a working credential on disk, while the bundle is the
 * shareable fallback. Order is stable: native first (in input order), then any
 * registry accounts not already present.
 */
export function buildAccountPool(agent: AgentId, inputs: PoolInputs): PoolAccount[] {
  const byKey = new Map<string, PoolAccount>();

  for (const n of inputs.native) {
    if (byKey.has(n.accountKey)) continue;
    byKey.set(n.accountKey, {
      agent,
      accountKey: n.accountKey,
      email: n.email,
      kind: 'oauth',
      source: 'native-login',
      version: n.version,
      secretRef: null,
      provider: null,
      usedPercent: n.usedPercent ?? null,
      minutesToLimit: n.minutesToLimit ?? null,
      rateLimited: n.rateLimited ?? false,
    });
  }

  for (const r of inputs.registry) {
    if (byKey.has(r.accountKey)) continue; // a native login already covers this account
    byKey.set(r.accountKey, {
      agent,
      accountKey: r.accountKey,
      email: r.email,
      kind: authKindToPoolKind[r.auth],
      source: 'registry',
      version: null,
      secretRef: r.name,
      provider: r.provider,
      usedPercent: r.usedPercent ?? null,
      minutesToLimit: r.minutesToLimit ?? null,
      rateLimited: r.rateLimited ?? false,
    });
  }

  return [...byKey.values()];
}

/** Accounts that can serve a request right now: not rate-limited. */
export function eligibleAccounts(pool: PoolAccount[]): PoolAccount[] {
  return pool.filter((a) => !a.rateLimited);
}

export interface PickOptions {
  /** For `pinned`: the accountKey (or email) to select. */
  preferred?: string | null;
  /** Injectable RNG for deterministic tests; defaults to Math.random. */
  rng?: () => number;
}

/**
 * Pick one account from the pool for a run.
 *
 * - `balanced`: weighted-random across eligible accounts by remaining capacity
 *   (`capacityWeight`) — the same weighting the version-home router used, now over
 *   accounts. A near-exhausted account keeps a floor weight so it still runs
 *   occasionally.
 * - `available`: the eligible account with the most remaining capacity.
 * - `pinned`: the account matching `preferred` (accountKey or email), only if
 *   eligible.
 *
 * Returns null when nothing is eligible — the caller fails loud (never silently
 * runs a rate-limited or absent account).
 */
export function pickFromPool(
  pool: PoolAccount[],
  strategy: RunStrategy,
  opts: PickOptions = {},
): PoolAccount | null {
  const eligible = eligibleAccounts(pool);
  if (eligible.length === 0) return null;

  if (strategy === 'pinned') {
    const needle = (opts.preferred ?? '').trim().toLowerCase();
    if (!needle) return null;
    return (
      eligible.find(
        (a) =>
          a.accountKey.toLowerCase() === needle ||
          (a.email?.toLowerCase() ?? '') === needle,
      ) ?? null
    );
  }

  const weightOf = (a: PoolAccount) => capacityWeight(a.usedPercent, a.minutesToLimit);

  if (strategy === 'available') {
    return eligible.reduce((best, a) => (weightOf(a) > weightOf(best) ? a : best), eligible[0]);
  }

  // balanced: weighted-random by capacity.
  const rng = opts.rng ?? Math.random;
  const weights = eligible.map(weightOf);
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return eligible[0];
  let roll = rng() * total;
  for (let i = 0; i < eligible.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return eligible[i];
  }
  return eligible[eligible.length - 1];
}

/**
 * How to authenticate a chosen account at exec — a descriptor, not the secret.
 *
 * - A **native login** runs in its own version home; nothing extra is injected
 *   (`{ nativeHome: version }`).
 * - A **setup-token** account (Claude-only) injects `CLAUDE_CODE_OAUTH_TOKEN`.
 *   This is NOT `getAccountProvider('anthropic').envFor(...)`, which returns
 *   `ANTHROPIC_API_KEY` for both api-key and setup-token — a setup-token
 *   (`sk-ant-oat01-…`) injected as `ANTHROPIC_API_KEY` fails; the OAuth bearer is
 *   a different auth path. The claude harness adapter already keys the setup-token
 *   to `CLAUDE_CODE_OAUTH_TOKEN`, and this mirrors it.
 * - An **api-key / bearer-token** account uses the provider adapter's
 *   `envFor(agent, kind)` to name the variable.
 *
 * `secretRef` names the bundle the caller resolves the value from — the pure layer
 * never touches the secret. Throws for a registry account whose provider cannot
 * authenticate this harness; that account should never have entered the pool
 * (fail loud, not silent).
 */
export function injectionFor(
  account: PoolAccount,
): { nativeHome: string } | { envVar: string; secretRef: string } {
  if (account.source === 'native-login') {
    if (!account.version) throw new Error(`native account ${account.accountKey} has no version home`);
    return { nativeHome: account.version };
  }
  if (!account.provider || !account.secretRef) {
    throw new Error(`registry account ${account.accountKey} is missing provider/secretRef`);
  }
  // Setup-token is a Claude concept authenticated via the OAuth bearer env, not the
  // provider registry's (kind-blind) api-key env.
  if (account.kind === 'setup-token') {
    return { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', secretRef: account.secretRef };
  }
  const authKind = account.kind as AccountAuthKind; // 'api-key' | 'bearer-token'
  const envVar = getAccountProvider(account.provider).envFor(account.agent, authKind);
  return { envVar, secretRef: account.secretRef };
}
