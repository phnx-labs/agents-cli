// shims check — keeps the dispatch shims and versioned aliases current, and clears
// pre-split legacy shim files. Formerly done in the interactive index.ts startup
// (which PRINTED "Updated <cli> shim" on every run); here it runs silently in the
// background so the shim schema settles without user-facing churn.

import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { AGENTS } from '../../agents.js';
import {
  ensureShimCurrent,
  ensureVersionedAliasCurrent,
  isShimCurrent,
  isVersionedAliasCurrent,
  removeLegacyUserShim,
  listAgentsWithInstalledVersions,
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

    return resultOf(fixed, []);
  },
};
