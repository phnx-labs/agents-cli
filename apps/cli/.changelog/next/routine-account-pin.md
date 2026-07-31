- **Routines can pin a Claude account by identity to stop the OAuth-rotation
  logout storm.** Unpinned `claude` routines pick an account with the default
  `balanced` (stateless weighted-random) strategy, so two concurrent unattended
  runs — on one box or across the fleet — can land on the same account; Claude's
  refresh token is single-use and rotates server-side, so the second refresh
  revokes the first run's token mid-flight (`401 OAuth access token has been
  revoked`). Across ~20 routines waking in one morning window that is a
  self-inflicted logout storm (RUSH-1957). A routine may now set `account:` (a
  login email or account key) to pin the run to the version slot holding that
  account — no rotation, no usage-read refresh, no failover onto other accounts —
  so each routine (or each device's routines) refreshes one credential nobody else
  touches. Prefer it over `version:`, which pins a version *number* that is GC'd on
  the next upgrade, silently dropping the routine back to `balanced`. An account
  that is not signed in on the box warns and falls back to the strategy rather than
  refusing to run. Source: `apps/cli/src/lib/routines.ts`,
  `apps/cli/src/lib/rotate.ts`, `apps/cli/src/lib/runner.ts`.
