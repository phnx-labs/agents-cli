- **Claude usage/probe reads can authenticate with a file-based setup-token
  instead of the login keychain — no Touch ID.** On macOS, reading a Claude
  account's usage went through Claude Code's ACL-bound
  `Claude Code-credentials-<hash>` keychain item (`loadClaudeOauth` →
  `/usr/bin/security`), popping a Touch ID sheet on every cold read — per account,
  roughly every 8h, and again on the routines daemon's 3-minute auth-health probe
  (`probeLocalFleetAuth`), so `ag view` and the background warm both prompted.
  `loadClaudeOauth` now first resolves a per-account `claude setup-token` from the
  reserved **file-based** `auth` secrets bundle (keyed by account email as
  `CLAUDE_CODE_OAUTH_TOKEN_<slug>`); when present, the usage endpoint is
  authenticated with that long-lived, non-rotating token and the keychain is never
  touched — killing the prompt. This applies only to the read-only usage/probe
  callers (`accessTokenCache`); the full-credential run/export path (which needs the
  refresh token) is unchanged, and an account with no provisioned setup-token still
  falls through to the keychain for now. Keyed strictly per-account (never a bare
  shared key) so one account's token can't be misapplied to another. Source:
  `apps/cli/src/lib/usage.ts`; design: `docs/design/credential-management.md`.
