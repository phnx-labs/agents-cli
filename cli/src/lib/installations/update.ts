import * as fs from 'fs';
import { AGENTS, isAgentHardDeprecated, hardDeprecationError } from '../agents.js';
import { emit } from '../feed/events.js';
import {
  getBinaryPath,
  invalidateInstalledVersionsCache,
  invalidateLiveVersionCache,
  verifyBinaryLaunches,
} from './versions.js';
import {
  assertValidRelease,
  selectUpdateStrategy,
  type StagedRelease,
  type UpdateContext,
  type UpdateStrategy,
} from './strategies.js';
import { listInstallations, recordRelease } from './store.js';
import type { Installation, UpdateOutcome } from './types.js';

export interface UpdateInstallationOptions {
  /** `latest` (default), `oldest`, or a concrete release. */
  to?: string;
  onProgress?: (message: string) => void;
  /**
   * Replace the registry-selected strategy. The seam exists so the transaction
   * below can be exercised against a real filesystem without a vendor fetch, and
   * so a track that installs a harness differently (per-installation Cursor
   * isolation) can reuse this orchestration instead of re-implementing it.
   * Omitted in every normal call — `selectUpdateStrategy` is the default.
   */
  strategy?: UpdateStrategy;
}

/**
 * Move one frozen installation to a new vendor release, preserving its identity.
 *
 * The transaction is stage → verify → commit → record, with rollback on any
 * failure after the swap:
 *
 *   1. **stage**   — fetch the target release somewhere that is not yet live.
 *   2. **verify**  — launch the STAGED binary. This is the gate that makes the
 *                    update safe: a release that cannot start is discarded while
 *                    the working one is still in place, so the failure mode is
 *                    "nothing changed", not "the agent no longer runs".
 *   3. **commit**  — swap it in, keeping the displaced release until step 4.
 *   4. **record**  — re-verify in place, then write the new release into the
 *                    installation record and drop the rollback material.
 *
 * The installation's `id` and `label` are never touched, so the global default,
 * an isolated default, a project pin, a routine's `version:`, and a profile's
 * `host.version` all keep resolving to this installation across the update —
 * that reference preservation is the whole point of freezing the label.
 *
 * Strategies whose vendor artifact is global (a self-updating binary) report
 * `transactional: false`; for those, step 3 is a no-op and a failed verify is
 * surfaced as a failed update rather than pretended to be reversible.
 */
export async function updateInstallation(
  installation: Installation,
  options: UpdateInstallationOptions = {}
): Promise<UpdateOutcome> {
  const agent = installation.agent;
  if (isAgentHardDeprecated(agent)) throw new Error(hardDeprecationError(agent));

  const requested = options.to ?? 'latest';
  assertValidRelease(requested);

  const strategy = options.strategy ?? selectUpdateStrategy(agent);
  const ctx: UpdateContext = { agent, installation, requested, onProgress: options.onProgress };
  const target = await strategy.resolveTarget(ctx);

  if (target === installation.releaseVersion) {
    options.onProgress?.(
      `${AGENTS[agent].name}@${installation.label} is already on release ${target}; nothing to update.`
    );
    return {
      installation,
      strategy: strategy.id,
      fromRelease: installation.releaseVersion,
      toRelease: target,
      unchanged: true,
      alsoUpdated: [],
    };
  }

  let staged: StagedRelease | null = null;
  try {
    staged = await strategy.stage(ctx, target);

    const stagedHealth = await verifyBinaryLaunches(staged.binary, staged.home);
    if (!stagedHealth.ok) {
      throw new Error(
        `${AGENTS[agent].name} release ${staged.release} was fetched but its binary failed to launch`
        + `${stagedHealth.detail ? ` (${stagedHealth.detail})` : ''}. `
        + `${installation.label} is unchanged and still on ${installation.releaseVersion}.`
      );
    }

    // The installer may have reported a release the installation already has
    // (a self-updating binary that was already current). Recording it would
    // claim a change that did not happen and append a bogus history entry.
    if (staged.release === installation.releaseVersion) {
      options.onProgress?.(
        `${AGENTS[agent].name}@${installation.label} is already on release ${staged.release}; nothing to update.`
      );
      // Deliberately NOT committed: there is no new release to make live, and
      // for a strategy that swaps the version dir a commit here would displace
      // a working tree, discard its rollback material, and skip the live probe —
      // all while reporting that nothing changed. The `finally` clears staging.
      return {
        installation,
        strategy: strategy.id,
        fromRelease: installation.releaseVersion,
        toRelease: staged.release,
        unchanged: true,
        alsoUpdated: [],
      };
    }

    const handles = await strategy.commit(ctx, staged);
    try {
      // Probe what will actually execute — `getBinaryPath` is the same resolver
      // the shims and `agents run` use — not the staging copy probed above.
      const liveBinary = getBinaryPath(agent, installation.label);
      const liveHealth = await verifyBinaryLaunches(liveBinary, staged.home);
      if (!liveHealth.ok) {
        throw new Error(
          `${AGENTS[agent].name} release ${staged.release} failed to launch after being installed`
          + `${liveHealth.detail ? ` (${liveHealth.detail})` : ''}.`
        );
      }
    } catch (err) {
      // Undo unconditionally. `transactional` describes whether the VENDOR
      // artifact can be put back, not whether this directory can — gating the
      // undo on it left an installer-driven harness with the broken tree live
      // AND the previous one orphaned in rollback material nothing deletes.
      // A strategy with nothing to restore returns a no-op undo.
      handles.undo();
      throw new Error(
        strategy.transactional
          ? `${(err as Error).message} Rolled back to ${installation.releaseVersion}.`
          : `${(err as Error).message} The version directory was restored, but ${AGENTS[agent].name}'s installer `
            + `had already replaced the binary it manages globally — repair it with: agents add ${agent}@latest`
      );
    }
    handles.finalize();

    const updated = recordRelease(installation, staged.release);
    // Several installations of a global-binary harness point at the same file,
    // so the one we just replaced is live for all of them. Recording the release
    // only on the target would leave the others claiming a release that is no
    // longer on disk.
    const alsoUpdated = strategy.sharedBinary
      ? listInstallations(agent)
        .filter((other) => other.label !== installation.label && other.releaseVersion !== staged!.release)
        .map((other) => recordRelease(other, staged!.release))
      : [];

    invalidateInstalledVersionsCache(agent);
    invalidateLiveVersionCache(agent);
    // A release really was installed, so this is the right event; `installation`
    // says WHICH frozen install received it, since the label no longer equals
    // the release.
    emit('version.install', { agent, version: staged.release, installation: installation.label });

    return {
      installation: updated,
      strategy: strategy.id,
      fromRelease: installation.releaseVersion,
      toRelease: staged.release,
      unchanged: false,
      alsoUpdated,
    };
  } finally {
    if (staged?.stagingDir) fs.rmSync(staged.stagingDir, { recursive: true, force: true });
  }
}

