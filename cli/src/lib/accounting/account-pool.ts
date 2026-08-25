import type { AgentId } from '../types.js';
import type { AccountAuthKind } from '../account-provider-registry.js';
import { getAccountProvider } from '../account-provider-registry.js';

/**
 * The provider-account side of the run-candidate pool (RUSH-3182).
 *
 * `--strategy balanced` used to enumerate only version-home native logins, so a
 * setup-token / API-key account added via `agents accounts add` never balanced.
 * This module turns the account registry into the extra candidates the run path
 * folds in — see `collectRunCandidatesForRun` in `account-pool-collect.ts`.
 *
 * Pure + dependency-light so the harness-capability filter is unit-tested in
 * isolation with fixtures.
 */

/** A provider account record as stored in the registry (identity captured separately). */
export interface RegistryAccountRecord {
  name: string;
  provider: string;
  auth: AccountAuthKind;
}

/** A registry account eligible to run one harness, ready to map to a candidate. */
export interface RegistryAccountInput {
  /** Agent-scoped key so `(claude, X)` and `(codex, X)` stay distinct. */
  accountKey: string;
  email: string | null;
  name: string;
  provider: string;
  auth: AccountAuthKind;
}

/**
 * Which provider accounts can authenticate `agent`. An account is a candidate for
 * harness H only when its provider adapter has an `envFor(H, kind)` mapping — the
 * same capability check `attach` uses (`accounts.ts`) — so a Cursor key never
 * enters Claude's pool and a Claude setup-token never enters Codex's. This is what
 * makes the pool harness-parity-correct across claude/codex/grok/cursor/kimi/
 * opencode without a per-harness `else if`.
 *
 * `accountKey` is synthetic here (`${agent}:name=${name}`) — a stable per-account
 * key so balancing can include it immediately; the real agent-scoped identity
 * (email / org uuid) is backfilled by identity capture and replaces it. `email`
 * is null until then, which routes the account as usage-unverified but still a
 * candidate, never excluded.
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
