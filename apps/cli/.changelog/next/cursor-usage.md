- **`agents view` now surfaces the Cursor account and its usage.** Cursor was
  absent from the account view; it now shows the signed-in account (email/authId
  from `~/.cursor/cli-config.json`, token from `~/.config/cursor/auth.json`) and,
  for request-capped (free/legacy) plans, a monthly request bar (`M`) from
  `cursor.com/api/usage`. Usage-based plans have no request cap, so they render the
  account row without a bar. Source: `apps/cli/src/lib/usage.ts`,
  `apps/cli/src/lib/agents.ts`.
