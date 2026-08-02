- **`agents teams list` renders from cached team metadata instead of full status
  probes (RUSH-1996).** The list and picker rows now read the team registry plus
  teammate `meta.json` snapshots, so listing teams no longer blocks on remote log
  pulls or unreachable hosts. Full teammate status is still loaded when a user picks
  a team or runs `agents teams status <team>`. Source:
  `apps/cli/src/commands/teams.ts`, `apps/cli/src/commands/teams.test.ts`,
  `apps/cli/docs/teams.md`.
