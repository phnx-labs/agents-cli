import * as path from 'path';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir } from '../adapter.js';

export const cursorAdapter: HarnessAdapter = {
  id: 'cursor',

  // Cursor has no config-dir env var (only CURSOR_API_KEY / CURSOR_API_ENDPOINT).
  // Its OAuth token — the login gate — lives at $XDG_CONFIG_HOME/cursor/auth.json
  // (verified empirically: relocating XDG_CONFIG_HOME relocates the login;
  // ~/.cursor/cli-config.json holds only account metadata, not the token). Pin
  // XDG_CONFIG_HOME into the version home so each installed Cursor account
  // authenticates from its own token, isolated per run — no global ~/.cursor
  // symlink swap, so concurrent runs on different accounts never clobber one
  // another. cli-config.json (HOME-relative) has no override and stays on the
  // shared home; only the token is per-account, which is what gates the login.
  applyExecConfigEnv(result, ctx) {
    if (ctx.versionHome) {
      result.XDG_CONFIG_HOME = path.join(ctx.versionHome, '.config');
    }
    stripForeignConfigDir(result);
  },

  execPreModeArgs(ctx) {
    // A configured headless run is the workspace trust decision. Keep this
    // narrower than --yolo/-f, which also bypasses permission checks.
    return ctx.resolvedMode === 'edit' && !ctx.interactive ? ['--trust'] : undefined;
  },

  routineModeArgs(cmd, ctx) {
    if (ctx.mode === 'plan') {
      cmd.push('--plan');
    } else if (ctx.mode === 'skip') {
      cmd.push('-f');
    } else {
      // The configured cwd is the user's workspace trust decision. --trust is
      // narrower than --yolo/-f because it does not bypass tool permissions.
      cmd.push('--trust');
    }
  },
};
