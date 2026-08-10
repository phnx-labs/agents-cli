- **`agents teams add` warns and blocks when the base checkout is behind
  `origin/main`, requiring `--confirm` to proceed.** Pointing a team at a stale
  repo (local cwd, or the repo provisioned on a `--device` host) meant teammates
  reasoned and built against code that had already moved on — the real incident
  was a 71-commit-stale checkout on another box that nobody had fetched. `teams
  add` now fetches origin, counts how far behind `origin/<default>` the base is,
  and refuses with a sync command (`git … merge --ff-only origin/main`) unless you
  pass `--confirm`; with `--confirm` it prints a one-line advisory and continues.
  An offline/unreachable/non-git base can't be assessed and never blocks. Cloud
  teammates clone fresh in the provider and are skipped. Source:
  `apps/cli/src/commands/teams.ts`, `apps/cli/src/lib/teams/worktree.ts`,
  `apps/cli/src/lib/teams/remoteWorktree.ts`.
