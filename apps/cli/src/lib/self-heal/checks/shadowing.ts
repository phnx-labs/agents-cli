// shadowing check — when a harness's own launcher shadows our shim on PATH, adopt
// it (symlink-only, reversible) so version management wins regardless of PATH order.
// A REAL native binary is never moved — it's surfaced as needsAttention so the
// interactive layer can inform the user once. POSIX-only (the launcher convention
// and PATH-order problem are POSIX; Windows resolves via the registry PATH).

import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { AGENTS } from '../../agents.js';
import {
  getPathShadowingExecutable,
  adoptShadowingLauncher,
  listAgentsWithInstalledVersions,
} from '../../shims.js';
import { getGlobalDefault } from '../../versions.js';

export const shadowingCheck: HealCheck = {
  id: 'shadowing',
  title: 'Launcher shadowing the version-managed shim',
  platforms: ['darwin', 'linux'],
  cadence: 'frequent',
  async run(ctx: HealCtx): Promise<CheckResult> {
    const fixed: string[] = [];
    const needsAttention: string[] = [];

    for (const agent of listAgentsWithInstalledVersions()) {
      if (!getGlobalDefault(agent)) continue; // only default agents, like the interactive flow
      const cmd = AGENTS[agent].cliCommand;
      const shadowedBy = getPathShadowingExecutable(agent);
      if (!shadowedBy) continue;

      if (ctx.dryRun) {
        // Classify without mutating: adoption only ever touches a symlink.
        let isSymlink = false;
        try {
          const fs = await import('node:fs');
          isSymlink = fs.lstatSync(shadowedBy).isSymbolicLink();
        } catch { /* treat as real binary */ }
        if (isSymlink) fixed.push(`${cmd} launcher (${shadowedBy})`);
        else needsAttention.push(`${cmd}: real binary shadows the shim (${shadowedBy})`);
        continue;
      }

      const res = adoptShadowingLauncher(agent);
      if (res.adopted) fixed.push(`adopted ${cmd} launcher (${res.launcher})`);
      else if (res.reason === 'not-a-symlink') {
        needsAttention.push(`${cmd}: real binary shadows the shim (${shadowedBy})`);
      }
    }

    return resultOf(fixed, needsAttention);
  },
};
