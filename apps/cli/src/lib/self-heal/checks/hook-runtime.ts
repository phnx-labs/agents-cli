// hook-runtime check — detects and bounded-repairs agents-managed generated
// hook shims (~/.agents/.cache/shims/hooks/<name>.sh). A native hook command can
// look wired while its generated wrapper is missing, non-executable, non-file,
// or broken — silent breakage. Repair runs at most once per unique path per
// pass (no retry, no sync recursion); unresolved findings stay needsAttention.

import type { HealCheck, HealCtx, CheckResult } from '../types.js';
import { resultOf } from '../types.js';
import { repairManagedHookRuntimeArtifacts } from '../../hooks.js';

export const hookRuntimeCheck: HealCheck = {
  id: 'hook-runtime',
  title: 'Generated hook runtime shims',
  cadence: 'frequent',
  async run(ctx: HealCtx): Promise<CheckResult> {
    const report = repairManagedHookRuntimeArtifacts({ dryRun: ctx.dryRun });
    return resultOf(report.fixed, report.needsAttention);
  },
};
