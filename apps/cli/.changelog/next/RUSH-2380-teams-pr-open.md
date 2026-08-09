- **`agents teams status` shows `PR OPEN` instead of bare `COMPLETED` when a
  teammate finished with an unmerged PR (RUSH-2380).** Process-exit success was
  reported as COMPLETED even when the PR was still open, so orchestrators
  composed on top of unlanded work (3/3 edit-mode teammates one day). Delivery
  is now a separate postcondition (`delivery: pr_open | pr_merged | no_pr | …`)
  on status JSON; the human status label is `PR OPEN` (magenta) when process
  status is completed and a PR URL is present without a known merge. Process
  status still drives the DAG (`--after`); only the display/JSON delivery
  signal changed. Source: `apps/cli/src/lib/teams/delivery.ts`,
  `apps/cli/src/lib/teams/api.ts`, `apps/cli/src/commands/teams.ts`.
