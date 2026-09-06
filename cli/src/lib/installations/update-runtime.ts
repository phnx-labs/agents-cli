/**
 * The automatic-update pass (PHNX-3940): decide which installations may be
 * moved to their harness's latest release with no operator in the loop, then
 * (optionally) move them.
 *
 * Split into a PLAN (`planAutoUpdates` — the `--check` dry-run and the
 * daemon's own decision step both read it; it touches no release/policy data,
 * though `listInstallations` may lazily backfill a legacy installation's
 * `installation.json` the same one-time way `agents view` already does — a
 * metadata-presence fix, never a release or policy change) and a RUN
 * (`runAutoUpdatePass`, drives eligible plan entries through the existing
 * `updateInstallation` transaction). Both share one eligibility computation so
 * a dry-run can never report "would update" for something the real run would
 * skip, or vice versa.
 *
 * Eligibility is deliberately narrow:
 *   - Only the `npm-package` strategy is transactional AND isolated per
 *     installation (stage into a sibling dir, launch-probe it, swap, keep the
 *     displaced tree until the swap is proven) — the shape every existing
 *     safety property in `update.ts` depends on. A global-binary or
 *     install-script harness has no reversible per-installation swap to offer,
 *     so it is reported honestly as manual/vendor-managed rather than silently
 *     skipped or, worse, "updated" via an irreversible reinstall with no
 *     operator watching.
 *   - The operator switch (`updates.auto` / `updates.<agent>.auto`,
 *     `update-policy.ts`) and the per-installation policy
 *     (`Installation.updatePolicy`) must both allow it.
 *   - The installation must not look ACTIVE right now (see
 *     {@link isInstallationLikelyActive}) — a real OS process-table scan, not
 *     just this box's session registry, so a harness launched by a bare
 *     generated shim with no session bookkeeping still defers correctly.
 *
 * The latest release for a harness is resolved ONCE per pass (not once per
 * installation) — `resolveSharedTargets` below — so a fleet with a dozen
 * pinned-to-latest Claude installations issues one npm registry read, not a
 * dozen.
 */

import { AGENTS, isAgentHardDeprecated } from '../agents.js';
import { MANAGED_AGENT_IDS } from '../agent-spec/agents.js';
import type { AgentId } from '../types.js';
import { listInstallations } from './store.js';
import { hasLiveLaunchLease } from './shims.js';
import { installationLooksActive, realProcessSnapshot } from './active-check.js';
import { selectUpdateStrategy, type UpdateContext, type UpdateStrategy } from './strategies.js';
import { updateInstallation } from './update.js';
import { effectiveUpdatePolicy, isAutoUpdateEnabledForAgent } from './update-policy.js';
import type { Installation, UpdateOutcome, UpdatePolicy } from './types.js';

export interface AutoUpdatePlanEntry {
  agent: AgentId;
  installation: Installation;
  currentRelease: string;
  /** The resolved latest release, or `null` when it could not be resolved (network error, unsupported strategy). */
  targetRelease: string | null;
  policy: UpdatePolicy;
  /** Whether the automatic pass would act on this installation at all (ignoring whether it is currently deferred). */
  eligible: boolean;
  /** Whether a live process for this installation held it back THIS pass. Independent of `eligible`. */
  deferred: boolean;
  /** Human-readable reason `eligible` is false, or `deferred` is true, or `targetRelease` is null. Unset when there is nothing to explain (already current, or a real update would run). */
  reason?: string;
}

export interface AutoUpdatePassOutcome {
  entry: AutoUpdatePlanEntry;
  outcome?: UpdateOutcome;
  error?: string;
}

export interface AutoUpdatePassResult {
  plan: AutoUpdatePlanEntry[];
  outcomes: AutoUpdatePassOutcome[];
}

export interface AutoUpdatePassOptions {
  /** Scope to these agents only. Default: every non-hard-deprecated managed agent. */
  agents?: AgentId[];
  onProgress?: (message: string) => void;
}

/** The only strategy shape the automatic pass will ever touch — see the module docblock. */
function autoUpdateStrategyFor(agent: AgentId): UpdateStrategy | null {
  let strategy: UpdateStrategy;
  try {
    strategy = selectUpdateStrategy(agent);
  } catch {
    return null;
  }
  return strategy.id === 'npm-package' && strategy.transactional ? strategy : null;
}

/**
 * Build the automatic-update plan: one entry per installation of every scoped
 * agent, with eligibility, deferral, and the resolved target release already
 * computed. Never mutates anything — safe to call from `--check` or before
 * every real pass.
 */
export async function planAutoUpdates(opts: AutoUpdatePassOptions = {}): Promise<AutoUpdatePlanEntry[]> {
  const agents = (opts.agents ?? MANAGED_AGENT_IDS).filter((agent) => !isAgentHardDeprecated(agent));
  let commandLines: string[] | null = null;
  let processScanError: string | undefined;
  try {
    commandLines = await realProcessSnapshot.listCommandLines();
  } catch (err) {
    processScanError = err instanceof Error ? err.message : String(err);
  }

  const plan: AutoUpdatePlanEntry[] = [];

  for (const agent of agents) {
    const installations = listInstallations(agent);
    if (installations.length === 0) continue;

    const strategy = autoUpdateStrategyFor(agent);
    const agentAutoEnabled = isAutoUpdateEnabledForAgent(agent);

    // Resolve the latest release ONCE per agent — not once per installation —
    // and only when at least the strategy/switch preconditions hold, so a
    // harness nobody enabled auto-updates for never triggers a registry read.
    let target: string | null = null;
    let resolveError: string | undefined;
    if (strategy && agentAutoEnabled) {
      try {
        const ctx: UpdateContext = {
          agent,
          installation: installations[0],
          requested: 'latest',
          onProgress: opts.onProgress,
        };
        target = await strategy.resolveTarget(ctx);
      } catch (err) {
        resolveError = err instanceof Error ? err.message : String(err);
      }
    }

    for (const installation of installations) {
      const policy = effectiveUpdatePolicy(installation);
      let eligible = true;
      let reason: string | undefined;

      if (!strategy) {
        eligible = false;
        reason = `${AGENTS[agent].name} is manual/vendor-managed for updates (no isolated, reversible per-installation swap) — update it yourself.`;
      } else if (!agentAutoEnabled) {
        eligible = false;
        reason = 'automatic updates are disabled for this harness (updates.auto / updates.<agent>.auto).';
      } else if (policy === 'pinned') {
        eligible = false;
        reason = 'installation is pinned to a concrete release (agents update … --to <release> unpins with --to latest).';
      } else if (resolveError) {
        eligible = false;
        reason = `could not resolve the latest release: ${resolveError}`;
      }

      let deferred = false;
      if (eligible) {
        if (hasLiveLaunchLease(installation.agent, installation.label)) {
          deferred = true;
          reason = 'a launch is in flight for this installation (live launch lease); deferring.';
        } else if (commandLines) {
          deferred = installationLooksActive(installation, commandLines);
          if (deferred) reason = 'the installation appears to have a process running right now; deferring.';
        } else {
          // The process scan itself failed — fail closed for every installation
          // this pass would otherwise touch, not just the ones a scan would have
          // flagged as active.
          deferred = true;
          reason = `could not confirm no process is running (${processScanError}); deferring.`;
        }
      }

      plan.push({
        agent,
        installation,
        currentRelease: installation.releaseVersion,
        targetRelease: target,
        policy,
        eligible,
        deferred,
        reason,
      });
    }
  }

  return plan;
}

/**
 * Run the automatic-update pass: plan, then drive every eligible,
 * non-deferred, actually-behind entry through {@link updateInstallation}.
 * Installations update sequentially — this runs from a bounded daemon-spawned
 * child process (`harness-update-service.ts`) on its own schedule, not a
 * user-facing wait, so there is no reason to parallelize and every reason not
 * to (concurrent npm installs sharing this box's npm cache have a history of
 * corrupting each other).
 *
 * `abortIfPinnedBeforeCommit: true` on every call: this is the ONE caller for
 * whom a policy change mid-staging must cancel the commit (see
 * `update.ts`'s docblock on that option) — a manual `agents update` never
 * routes through here.
 */
export async function runAutoUpdatePass(opts: AutoUpdatePassOptions = {}): Promise<AutoUpdatePassResult> {
  const plan = await planAutoUpdates(opts);
  const outcomes: AutoUpdatePassOutcome[] = [];

  for (const entry of plan) {
    if (!entry.eligible || entry.deferred) continue;
    if (!entry.targetRelease || entry.targetRelease === entry.currentRelease) continue;

    try {
      const outcome = await updateInstallation(entry.installation, {
        to: entry.targetRelease,
        onProgress: opts.onProgress,
        abortIfPinnedBeforeCommit: true,
      });
      outcomes.push({ entry, outcome });
    } catch (err) {
      outcomes.push({ entry, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { plan, outcomes };
}
