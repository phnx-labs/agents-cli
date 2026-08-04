- **Local team worktrees base on freshly-fetched `origin/<default>`, not `HEAD`.**
  `createWorktree` (and `agents worktree provision` for new branches) now
  `git fetch origin` then `worktree add -b … origin/<default>`, matching
  `createRemoteWorktree`. Previously local teammates forked from the
  orchestrator's current `HEAD`, so a stale checkout made every teammate write
  on old code and only surface the conflict at merge. Source:
  `apps/cli/src/lib/teams/worktree.ts`, `apps/cli/src/commands/worktree.ts`,
  `apps/cli/docs/teams.md`.
