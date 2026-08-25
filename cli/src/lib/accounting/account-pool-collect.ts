import type { AgentId } from '../types.js';
import { readAccountRegistry } from '../account-registry.js';
import { collectRunCandidates, getRoutingUsedPercent } from './rotate.js';
import { deriveUsageStatusFromSnapshot } from './usage.js';
import { registryPoolCandidates, type PoolInputs, type RegistryAccountRecord } from './account-pool.js';

/**
 * The I/O collector for the account pool: read this machine's real native logins
 * and provider-account registry into {@link PoolInputs}, ready for
 * {@link buildAccountPool}.
 *
 * The native side REUSES {@link collectRunCandidates} — the exact version-home
 * enumeration + usage read the router already does — rather than duplicating it,
 * then maps each signed-in candidate to a `NativeLoginInput`. The registry side
 * reads the account registry and keeps only the accounts whose provider can
 * authenticate `agent` ({@link registryPoolCandidates}).
 *
 * This is the one impure step; the decision logic it feeds is pure and
 * fixture-tested in `account-pool.test.ts`.
 */
export async function collectPoolInputs(agent: AgentId): Promise<PoolInputs> {
  const candidates = await collectRunCandidates(agent);
  const native = candidates
    .filter((c) => c.signedIn && c.accountKey)
    .map((c) => ({
      accountKey: c.accountKey as string,
      email: c.email,
      version: c.version,
      usedPercent: getRoutingUsedPercent(c.usageSnapshot),
      minutesToLimit: c.usageMinutesToLimit,
      rateLimited: c.usageSnapshot
        ? deriveUsageStatusFromSnapshot(c.usageSnapshot) === 'rate_limited'
        : false,
    }));

  const registry: RegistryAccountRecord[] = Object.values(readAccountRegistry().accounts).map(
    (a) => ({ name: a.name, provider: a.provider, auth: a.auth }),
  );

  return { native, registry: registryPoolCandidates(registry, agent) };
}
