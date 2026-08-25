import type { HarnessAdapter } from '../adapter.js';

// Droid has no config-dir env pin (exec strips the foreign keys via the registry
// fallback) and no shim config env. Its only harness quirk is routine autonomy.
export const droidAdapter: HarnessAdapter = {
  id: 'droid',

  // droid exec defaults to read-only (plan). Escalate autonomy per mode.
  routineModeArgs(cmd, ctx) {
    if (ctx.mode === 'edit') {
      cmd.push('--auto', 'low');
    } else if (ctx.mode === 'auto') {
      cmd.push('--auto', 'high');
    } else if (ctx.mode === 'skip') {
      cmd.push('--skip-permissions-unsafe');
    }
  },
};
