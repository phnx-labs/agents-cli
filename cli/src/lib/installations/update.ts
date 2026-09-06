import * as fs from 'fs';
import { AGENTS, isAgentHardDeprecated, hardDeprecationError } from '../agents.js';
import { emit } from '../feed/events.js';
import { withFileLockAsync } from '../fs-atomic.js';
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
import { installationRecordPath, listInstallations, readInstallation, recordRelease } from './store.js';
import { effectiveUpdatePolicy } from './update-policy.js';
import { isInstallationLikelyActive } from './active-check.js';
import type { Installation, UpdateOutcome } from './types.js';

/**
 * How long a held update lock (see {@link updateInstallation}) may go without a
 * refresh before a peer treats it as abandoned and breaks it. Generous relative
 * to `proper-lockfile`'s default (5s): the critical section below spans a real
 * npm install (`INSTALL_TIMEOUT_MS` = 120s in strategies.ts) plus two launch
 * probes, and `withFileLockAsync` only refreshes the lock's mtime on its own
 * timer while the event loop is turning — which it is throughout, since every
 * step here is `await`ed I/O, not one long synchronous span.
 */
const UPDATE_LOCK_STALE_MS = 10 * 60_000;
/**
 * How long a caller will wait to acquire the per-installation lock before
 * giving up. Long enough to sit behind one full concurrent update of the SAME
 * installation (stage + verify + commit + re-verify) rather than failing loud
 * the instant two updates of one installation overlap.
 */
const UPDATE_LOCK_ACQUIRE_TIMEOUT_MS = 5 * 60_000;

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
  /**
   * Abort just before `commit()` if the installation's update policy has
   * flipped to `'pinned'` since staging began, instead of making the staged
   * release live. Set only by the automatic-update pass
   * (`update-runtime.ts`): a manual `agents update` is itself the user's
   * request and must never be undercut by a policy read mid-flight, but an
   * automatic run must not commit an update the operator pinned away from
   * while the (potentially minutes-long) stage was in flight.
   */
  abortIfPinnedBeforeCommit?: boolean;
  /**
   * Abort just before `commit()` if the installation now looks active (a live
   * process naming its directory, or a live launch lease — see
   * `active-check.ts`), instead of committing the swap underneath a launch
   * that started mid-staging. Set only by the automatic-update pass, for the
   * same reason as {@link abortIfPinnedBeforeCommit}: this narrows the
   * launch/update race to the instant between this re-check and the
   * synchronous swap, it does not eliminate it (full closure needs a shared
   * lock between the launch and update code paths). A manual `agents update`
   * never sets this — a human running it against a version they are about to
   * use is a call only they can make.
   */
  abortIfActiveBeforeCommit?: boolean;
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

  // Serialize every update of this SAME installation — manual and automatic
  // alike — behind a cross-process lock keyed on its own record file. Without
  // it, an operator's `agents update claude@2.0.65` racing the automatic pass
  // (or two automatic passes on two boxes sharing this ~/.agents, which
  // shouldn't happen but isn't prevented at this layer) could stage two
  // releases into the same version dir and interleave their swaps. The record
  // is re-read fresh under the lock (never trusting the possibly-stale
  // `installation` the caller passed in) so a concurrent update that already
  // landed is observed before this one decides what to do; a corrupted record
  // makes `readInstallation` throw, which propagates out of the locked section
  // and fails the update closed rather than proceeding on unreadable state.
  return withFileLockAsync(
    installationRecordPath(agent, installation.label),
    () => runUpdateInstallation(agent, installation, options),
    { staleMs: UPDATE_LOCK_STALE_MS, acquireTimeoutMs: UPDATE_LOCK_ACQUIRE_TIMEOUT_MS },
  );
}

async function runUpdateInstallation(
  agent: Installation['agent'],
  requestedInstallation: Installation,
  options: UpdateInstallationOptions,
): Promise<UpdateOutcome> {
  const installation = readInstallation(agent, requestedInstallation.label) ?? requestedInstallation;

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

    // The automatic pass may have started staging while the installation was
    // still eligible, then had it pinned out from under it — staging an npm
    // package can legitimately take the better part of INSTALL_TIMEOUT_MS. Check
    // ONE more time, right before the point of no return, so a policy change
    // that lands mid-staging is honored instead of committed anyway. A manual
    // `agents update` never sets this option: the user's own invocation IS their
    // current intent, so there is nothing to defer to.
    if (options.abortIfPinnedBeforeCommit) {
      const fresh = readInstallation(agent, installation.label);
      if (fresh && effectiveUpdatePolicy(fresh) === 'pinned') {
        options.onProgress?.(
          `${AGENTS[agent].name}@${installation.label} was pinned while ${staged.release} was staging; not committing it.`
        );
        return {
          installation: fresh,
          strategy: strategy.id,
          fromRelease: fresh.releaseVersion,
          toRelease: staged.release,
          unchanged: true,
          alsoUpdated: [],
        };
      }
    }

    if (options.abortIfActiveBeforeCommit && await isInstallationLikelyActive(installation)) {
      options.onProgress?.(
        `${AGENTS[agent].name}@${installation.label} looks active now (a process or launch lease appeared while `
        + `${staged.release} was staging); not committing it.`
      );
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
    // Record BEFORE finalizing the commit's rollback material — not after.
    // `finalize()` discards the only thing that can put the previous release
    // back (deletes the rollback dir / no-ops for a non-transactional
    // strategy). If `recordRelease` throws (e.g. disk full, an unwritable
    // installation.json) AFTER finalize, the new release is live on disk with
    // no rollback path AND no record of it — an installation whose directory
    // and its own metadata now disagree, with no way back. Recording first
    // means a record-write failure still has the rollback material available
    // to undo the live swap, so the failure mode stays "nothing changed"
    // instead of "half updated, unrecoverable."
    let updated: Installation;
    try {
      updated = recordRelease(installation, staged.release);
    } catch (err) {
      handles.undo();
      throw new Error(
        strategy.transactional
          ? `${(err as Error).message} ${AGENTS[agent].name} release ${staged.release} could not be recorded. `
            + `Rolled back to ${installation.releaseVersion}.`
          : `${(err as Error).message} ${AGENTS[agent].name} release ${staged.release} could not be recorded. `
            + `The version directory was restored, but ${AGENTS[agent].name}'s installer had already replaced the `
            + `binary it manages globally — repair it with: agents add ${agent}@latest`
      );
    }
    handles.finalize();

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

