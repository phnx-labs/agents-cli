- **`agents trends` — resource and session analytics dashboard.** Baked recipes
  (harness/model mix, tools per session, token ratio, secrets/browser hot lists)
  read `sessions.db` plus a new value-free warehouse at
  `~/.agents/.history/analytics/usage.db`. Secrets usage migrates once from
  `secrets.db`; agent run and browser launch/close emit into the warehouse.
  Quota stays on `agents usage`, latency on `agents perf`.
  Source: `apps/cli/src/commands/trends.ts`, `apps/cli/src/lib/analytics/`.
