- **Choose a safe account with `agents run <agent>@`.** A trailing `@` opens a
  per-run picker showing each installed version's account identity, login state,
  plan, and available session/weekly/monthly capacity. Logged-out, rate-limited,
  and out-of-credit accounts remain visible but disabled; signed-in accounts
  without quota data remain selectable and say `limits unavailable`. Source:
  `apps/cli/src/commands/run-account-picker.ts`,
  `apps/cli/src/commands/exec.ts`, `apps/cli/src/lib/rotate.ts`.
