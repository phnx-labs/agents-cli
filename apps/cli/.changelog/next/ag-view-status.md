- **Accurate account tier and legible usage limits in `agents view`.** Each row's plan
  tier is now derived from `organizationType` (Max/Pro/Team/Enterprise) instead of a
  billingType guess that mislabelled every Max account as "Pro", and the redundant tier
  badge next to the email is dropped for personal plans (multi-seat orgs keep their org
  name, which is real identity). The compact `S:`/`W:` usage bars now show the exact
  percentage and a compact reset hint (`S: ███░░ 58% (3d)`), a signed-in account whose
  usage can't be fetched reads `usage unavailable` instead of a blank gauge, and a new
  `agents view --refresh` (`-r`) forces a live usage refresh past the cache. Source:
  `apps/cli/src/lib/agents.ts`, `apps/cli/src/lib/usage.ts`, `apps/cli/src/commands/view.ts`.
