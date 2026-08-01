- **No more Touch ID storm from the usage view.** On macOS, rendering usage bars
  (`agents view`, and the Factory watchdog that polls `agents view --json` every
  60s per agent) read Claude's own ACL-bound `Claude Code-credentials-<hash>`
  keychain item on every refresh past the 2-minute usage cache — each read popping
  a Touch ID prompt, so several running Claude agents meant a biometric prompt
  every couple of minutes. `loadClaudeOauth` now caches the access token in a
  device-local no-ACL keychain item (the prompt-free mechanism
  `secrets/session-store.ts` uses for unlocked bundles), bounded by the token's own
  expiry, so the ACL-gated read happens at most once per token lifetime and every
  agent process reads the cache silently. Only the short-lived access token is
  cached, never the refresh token. Source: `apps/cli/src/lib/usage.ts`.
