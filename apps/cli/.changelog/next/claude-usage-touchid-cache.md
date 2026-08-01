- **No more Touch ID storm from the usage view.** On macOS, the usage-bar fetch
  (`agents view`, the Factory watchdog that polls `agents view --json` every 60s
  per agent) and the daemon's every-3-min auth-health probe each read Claude's own
  ACL-bound `Claude Code-credentials-<hash>` keychain item on every refresh — each
  read popping a Touch ID prompt, so several running Claude agents meant a
  biometric prompt every couple of minutes. Those two access-token-only, high-
  frequency callers now opt into a device-local **no-ACL** access-token cache (the
  prompt-free mechanism `secrets/session-store.ts` uses for unlocked bundles),
  bounded by the token's own expiry, so the ACL-gated read happens at most once per
  token lifetime and every agent process reads the cache silently. The cache is
  opt-in and caches only the short-lived access token — callers that need the full
  credential (`isClaudeAuthValid`'s refresh, `readClaudeCredentialsBlob`'s Rush
  Cloud export) still take the ACL read with the refresh token intact. Source:
  `apps/cli/src/lib/usage.ts`.
