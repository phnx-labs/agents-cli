// path check — ensures the shims dir is on PATH. On POSIX it appends to the shell
// rc file; on Windows it registers on the user PATH (registry). addShimsToPath is a
// no-op when already present, so this is idempotent. Formerly an interactive prompt
// in index.ts fired on every new shell; here the daemon does it once, silently.
//
// Caveat: an already-open shell won't pick up the new rc/PATH entry until it reloads
// — but new shells will, so the recurring prompt stops.

import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { isShimsInPath, addShimsToPath } from '../../shims.js';

export const pathCheck: HealCheck = {
  id: 'path',
  title: 'Shims directory on PATH',
  cadence: 'startup',
  async run(ctx: HealCtx): Promise<CheckResult> {
    if (isShimsInPath()) return resultOf([], []);
    if (ctx.dryRun) return resultOf(['add shims dir to PATH'], []);

    const r = addShimsToPath();
    if (r.success && !r.alreadyPresent) {
      return resultOf([`added shims to PATH (${r.location ?? r.rcFile ?? 'PATH'})`], []);
    }
    if (r.success && r.alreadyPresent) {
      // Present in the rc file but not in THIS process's PATH — a reload issue,
      // not something to fix again. Report quietly.
      return resultOf([], [`shims dir in ${r.rcFile ?? 'rc file'} but not loaded — open a new terminal`]);
    }
    return resultOf([], [`could not add shims to PATH: ${r.error ?? 'unknown'}`]);
  },
};
