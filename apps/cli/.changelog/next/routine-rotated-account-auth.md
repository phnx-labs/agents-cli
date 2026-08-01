- **Balanced account rotation now works for scheduled Claude routines.** The
  routines daemon injects one `CLAUDE_CODE_OAUTH_TOKEN` into its environment so a
  token-less default account still authenticates (RUSH-1759). But Claude — and the
  Linux shim's own `-z CLAUDE_CODE_OAUTH_TOKEN` guard — both prefer that env var
  over a pinned account's `CLAUDE_CONFIG_DIR`, so once balanced rotation pinned a
  specific account the injected token shadowed it: the whole pool was inert and
  every fire authenticated as (and eventually 401'd on) the one token. A routine
  spawn now drops the injected token when the rotated account holds its own on-disk
  credential, so it authenticates as that account; when the account has no on-disk
  credential (the RUSH-1759 default) the injected token is kept. Source:
  `apps/cli/src/lib/runner.ts` (`buildRoutineSpawnEnv`),
  `apps/cli/src/lib/agents.ts` (`claudeHomeHasOwnCredential`).
