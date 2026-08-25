import type { AgentId } from '../types.js';
import { readAccountRegistry } from '../account-registry.js';
import { getGlobalDefault, listInstalledVersions } from '../installations/versions.js';
import { collectRunCandidates, type RotateCandidate } from './rotate.js';
import { registryPoolCandidates, type RegistryAccountRecord } from './account-pool.js';

function registryRecords(): RegistryAccountRecord[] {
  return Object.values(readAccountRegistry().accounts).map((a) => ({
    name: a.name,
    provider: a.provider,
    auth: a.auth,
  }));
}

/**
 * Candidate list for the `agents run` strategy pick, account-centric: the usual
 * native version-home candidates PLUS one candidate per provider account whose
 * provider can authenticate `agent` (RUSH-3182). This is what makes a setup-token
 * / API-key account balance-eligible.
 *
 * Passed as the `collect` argument to {@link resolveRunVersion} on the RUN path
 * ONLY — the other consumers of {@link collectRunCandidates} (watchdog, session
 * recovery, teams placement) keep calling it directly and are unaffected.
 *
 * A registry account runs in the agent's default installed version home; the
 * token/key overrides that home's own login at exec, so any home works. It
 * carries `providerAccount` so the run path routes it through the existing
 * `--account` injection (`resolveSpawnAccount` → `accountEnv`). The existing
 * {@link pickBalancedCandidate} selects over the combined list, so the
 * revoked / rate-limit / exhausted logic is unchanged.
 *
 * A registry account already covered by a native login is skipped by accountKey;
 * the native and synthetic keys differ until identity capture unifies them, so an
 * account that is BOTH natively logged in AND a bundle may list twice (a minor
 * over-weight, never a wrong run) — the identity-capture follow-up.
 */
export async function collectRunCandidatesForRun(agent: AgentId): Promise<RotateCandidate[]> {
  const native = await collectRunCandidates(agent);
  const runVersion = getGlobalDefault(agent) ?? listInstalledVersions(agent)[0];
  if (!runVersion) return native; // nothing installed to execute a registry account in

  const seen = new Set(native.filter((c) => c.accountKey).map((c) => c.accountKey as string));
  const extra: RotateCandidate[] = registryPoolCandidates(registryRecords(), agent)
    .filter((r) => !seen.has(r.accountKey))
    .map((r) => ({
      agent,
      version: runVersion,
      accountKey: r.accountKey,
      accountLabel: r.name,
      email: null,
      usageKey: null,
      usageStatus: null,
      usageSnapshot: null,
      usageError: null,
      usageMinutesToLimit: null,
      plan: null,
      signedIn: true,
      authVerdict: null,
      lastActive: null,
      providerAccount: r.name,
    }));

  return [...native, ...extra];
}
