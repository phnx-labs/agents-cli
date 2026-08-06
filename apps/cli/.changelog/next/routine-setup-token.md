- **Scheduled routines now run on a per-account `claude setup-token` when one is
  provisioned, instead of throwing it away.** `buildRoutineSpawnEnv` unconditionally
  deleted `CLAUDE_CODE_OAUTH_TOKEN`, so even after `buildExecEnv` injected a long-lived,
  non-rotating setup-token from the reserved file-backed `auth` bundle
  (`resolveClaudeSetupToken`), a routine still fell back to the version home's rotating
  `.credentials.json` login. With one Claude account signed into several version homes
  (or several fleet boxes), that rotating login is the single-use-refresh-token
  revocation storm — one home's refresh silently revokes every sibling copy, so an
  unattended routine keeps landing on a just-revoked token and dies with `auth_failed:
  OAuth access token has been revoked` / `Please run /login`, even though `agents view`
  shows the account healthy. The delete now distinguishes the two flavours: a
  per-account setup-token (keyed to this home's own account) is re-asserted and KEPT; an
  inherited *ambient* token (a shared value the daemon env happened to carry — the
  RUSH-1822 fleet-logout path) is still stripped so a routine never runs on it.
  Provision the token with `/fleet:mint-auth`. Source:
  `apps/cli/src/lib/runner.ts` (`buildRoutineSpawnEnv`).
