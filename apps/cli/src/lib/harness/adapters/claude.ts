import * as path from 'path';
import type { HarnessAdapter } from '../adapter.js';
import { stripForeignConfigDir } from '../adapter.js';

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',

  applyExecConfigEnv(result, ctx) {
    const { versionHome } = ctx;
    // The per-account `claude setup-token` only resolves when there is a version
    // home to key it to; version===null (claude unresolved / not installed) yields
    // null, exactly as the routines path treats it (`runner.ts:1017-1021`). The
    // token decision below runs even then, so an ambient inherited value is stripped
    // on the routines/provisioned path regardless of whether a version resolved.
    // resolveClaudeSetupToken is injected (see ExecConfigEnvCtx) to keep this
    // adapter import-leaf — importing claude-account-token here would drag the
    // secrets/sqlite graph into shims.ts.
    const setupToken = versionHome ? ctx.resolveClaudeSetupToken(versionHome) : null;
    if (versionHome) {
      result.CLAUDE_CONFIG_DIR = path.join(versionHome, '.claude');
      // A managed pin lives in a per-version dir; Claude Code's own background
      // auto-updater would rewrite that pinned binary in place (and has left it
      // half-swapped and broken). Disable it so a pin stays a pin. Honor an
      // explicit user value — from process.env (already in result) or from
      // options.env (spread over result below).
      if (result.DISABLE_AUTOUPDATER === undefined) {
        result.DISABLE_AUTOUPDATER = '1';
      }
    }
    // The `auth` bundle's setup-token exists so a run with NO human present
    // authenticates without the Touch-ID-gated login item — usage probes,
    // routines, dispatched runs (claude-account-token.ts). It is a WORKER
    // credential. Two kinds of run defer to the per-version login instead:
    //
    //   1. An interactive run: a human is at the TTY, and their per-version login
    //      is the credential they established and expect. Overriding it made
    //      `/status` report `Auth token: CLAUDE_CODE_OAUTH_TOKEN` on a personal
    //      machine and took every hand-driven session off that login.
    //   2. ANY run on a `personal` device — the user's own interactive box (zion),
    //      marked `config.role: personal`. That box holds a real per-version login
    //      and is the single origin of it, so every run there — interactive TUI OR
    //      a headless one-shot like `agents run claude "fix the bug"` — MUST use
    //      that login, not the setup-token. Gating on run mode ALONE
    //      (resolveInteractive = "this opens a TUI", NOT "a human is present")
    //      sent a headless run on the laptop onto the setup-token and hijacked the
    //      login. Keying the credential on DEVICE ROLE is the fix — RUSH-2395.
    //
    // macOS cannot cheaply confirm a home's login first (probing the Keychain
    // raises an authorization sheet per installed version on the `agents run` hot
    // path — agents.ts `isClaudeCredentialFileBlank`), so this path defers to
    // Claude Code, which reads its own ACL-trusted login item without a prompt and
    // asks a present human to log in only if the login is missing.
    const personalDevice = ctx.deviceRole === 'personal';
    if (ctx.interactive || personalDevice) {
      // Drop an INHERITED copy of OUR OWN setup-token: a launch from inside a
      // headless agent's shell inherits that agent's injected value via
      // sanitizeProcessEnv(process.env) and would keep authenticating as it,
      // overriding the login this branch is protecting. Matched by VALUE, so a
      // token the user exported deliberately is a different string and is left
      // alone (#2383). This is NARROWER than the worker path below, which
      // overwrites-or-deletes unconditionally and never inspects the inherited
      // value — a DIFFERENT account's inherited setup-token passing through this
      // equality check is the adjacent hole RUSH-2360 leaves as follow-up (it does
      // not silently run on a *shared, rotating* token, which is what caused the
      // RUSH-1822 logout storm).
      if (setupToken && result.CLAUDE_CODE_OAUTH_TOKEN === setupToken) {
        delete result.CLAUDE_CODE_OAUTH_TOKEN;
      }
    } else {
      // Headless run on a NON-personal device (worker, dispatched, provisioned
      // box): mirror the routines path (`runner.ts`) UNCONDITIONALLY. Inject the
      // per-account setup-token when one resolves — it replaces any ambient shared
      // value inherited from the launcher. When NONE resolves, STRIP the ambient
      // CLAUDE_CODE_OAUTH_TOKEN so a run on a provisioned box can never silently
      // authenticate as the shared, rotating token an earlier version of this path
      // let through — the RUSH-1822 fleet-wide-logout hazard, tracked by RUSH-2360.
      // A missing login then fails loud (401) against this home's own credential
      // instead of quietly borrowing another's. options.env still wins below for an
      // explicit caller override.
      if (setupToken) {
        result.CLAUDE_CODE_OAUTH_TOKEN = setupToken;
      } else {
        delete result.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }
    stripForeignConfigDir(result, ['CLAUDE_CONFIG_DIR']);
  },

  shimConfigEnvBash(ctx) {
    return `
# Claude stores OAuth credentials in the macOS keychain. Scope them to the
# selected version's config directory so switching versions also switches the
# live Claude account.
export CLAUDE_CONFIG_DIR="$VERSION_DIR/home/${ctx.configDirName}"
# Managed installs are pinned in a per-version dir; Claude Code's background
# auto-updater would rewrite the pinned binary in place. Disable it so a pin
# stays a pin. An explicit user value always wins.
export DISABLE_AUTOUPDATER="\${DISABLE_AUTOUPDATER:-1}"
# On Linux sandboxes (no keychain), fall back to a per-version token file.
# The env var always wins if already set; no-op on macOS.
if [ "\$(uname -s)" = "Linux" ] && [ -z "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -f "\$CLAUDE_CONFIG_DIR/.oauth_token" ]; then
  CLAUDE_CODE_OAUTH_TOKEN=\$(cat "\$CLAUDE_CONFIG_DIR/.oauth_token")
  export CLAUDE_CODE_OAUTH_TOKEN
fi
`;
  },

  routineModeArgs(cmd, ctx) {
    const mode = ctx.mode;
    if (mode === 'edit') {
      const planIndex = cmd.indexOf('plan');
      if (planIndex !== -1) cmd[planIndex] = 'acceptEdits';
    } else if (mode === 'auto') {
      const planIndex = cmd.indexOf('plan');
      if (planIndex !== -1) cmd[planIndex] = 'auto';
    } else if (mode === 'skip') {
      // Replace --permission-mode plan with --dangerously-skip-permissions
      const pmIndex = cmd.indexOf('--permission-mode');
      if (pmIndex !== -1) cmd.splice(pmIndex, 2, '--dangerously-skip-permissions');
    }
  },
};
