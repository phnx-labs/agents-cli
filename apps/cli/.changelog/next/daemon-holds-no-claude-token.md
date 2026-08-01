- **The routines daemon holds no Claude credential and injects no token.** A
  scheduled or daemon-fired Claude run now authenticates exactly like an
  interactive `agents run claude` on the same machine: through the rotation-pinned
  account's own `CLAUDE_CONFIG_DIR` login (`.credentials.json`), which Claude Code
  refreshes per-device. The daemon previously read a token from the `claude`
  secrets bundle and injected it into every routine spawn — first as one ambient
  `CLAUDE_CODE_OAUTH_TOKEN` (RUSH-1759), then also as per-account
  `CLAUDE_CODE_OAUTH_TOKEN_<account>` setup-tokens — which shadowed each account's
  own on-disk login and made the daemon a second, competing credential store. Both
  paths are removed, along with the sandbox `ENV_ALLOWLIST` entry that forwarded
  them; a sandboxed routine now strips `CLAUDE_CODE_OAUTH_TOKEN` from its
  environment and falls through to the per-account login. A box whose interactive
  login has expired is skipped up front by the auth-health preflight with a
  `re-login required` hint instead of running on an injected fallback — log in once
  on that box (`agents run claude`) to restore it; no daemon restart is needed. This
  keeps the daemon out of the credential entirely, which is what avoids the
  fleet-wide rotation logout (a shared/injected token was the cause, not the fix).
  Removed: `readDaemonClaudeOAuthToken` / `readDaemonClaudeBundleEnv` /
  `buildDetachedDaemonEnv` (`daemon.ts`), `resolveAccountSetupToken` and
  `apps/cli/src/lib/secrets/account-token.ts`, `claudeHomeHasOwnCredential`
  (`agents.ts`). Source: `apps/cli/src/lib/daemon.ts`, `runner.ts`, `sandbox.ts`,
  `agents.ts`.
