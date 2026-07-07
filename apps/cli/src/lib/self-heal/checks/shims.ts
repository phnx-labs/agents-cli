// shims check — keeps the dispatch shims and versioned aliases current, and clears
// pre-split legacy shim files. Formerly done in the interactive index.ts startup
// (which PRINTED "Updated <cli> shim" on every run); here it runs silently in the
// background so the shim schema settles without user-facing churn.

import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { AGENTS } from '../../agents.js';
import {
  createShim,
  ensureShimCurrent,
  ensureVersionedAliasCurrent,
  isShimCurrent,
  isVersionedAliasCurrent,
  shimPointsAtLiveInstall,
  removeLegacyUserShim,
  listAgentsWithInstalledVersions,
  listShimFileNames,
  pruneOrphanedCommandShim,
} from '../../shims.js';
import { listInstalledVersions } from '../../versions.js';

export const shimsCheck: HealCheck = {
  id: 'shims',
  title: 'Dispatch shims + versioned aliases',
  cadence: 'frequent',
  async run(ctx: HealCtx): Promise<CheckResult> {
    const fixed: string[] = [];

    for (const agent of listAgentsWithInstalledVersions()) {
      const cmd = AGENTS[agent].cliCommand;

      if (!isShimCurrent(agent)) {
        if (!ctx.dryRun) ensureShimCurrent(agent);
        fixed.push(`${cmd} shim`);
      } else if (!shimPointsAtLiveInstall(agent)) {
        // Schema is current but the baked AGENTS_BIN points at a different, removed
        // install (dev build, old npm-global, rotated version dir). ensureShimCurrent
        // would no-op on a schema-current shim, so force a rewrite to the current install.
        if (!ctx.dryRun) createShim(agent);
        fixed.push(`${cmd} shim (repointed to current install)`);
      }

      for (const version of listInstalledVersions(agent)) {
        if (!isVersionedAliasCurrent(agent, version)) {
          if (!ctx.dryRun) ensureVersionedAliasCurrent(agent, version);
          fixed.push(`${cmd}@${version} alias`);
        }
      }

      // Pre-split ~/.agents/shims/<cli> files cause false-positive shadow hits.
      if (!ctx.dryRun && removeLegacyUserShim(agent)) fixed.push(`removed legacy ${cmd} shim`);
    }

    // Prune orphaned legacy command shims (browser/secrets/sessions/… left by a
    // removed install) whose baked AGENTS_BIN is dead — the current source never
    // regenerates them, and they either die with exit 127 or shadow the real
    // package bin on PATH. Only removes shims whose target install is gone.
    if (!ctx.dryRun) {
      for (const name of listShimFileNames()) {
        if (pruneOrphanedCommandShim(name)) fixed.push(`pruned orphaned ${name} shim`);
      }
    }

    return resultOf(fixed, []);
  },
};
