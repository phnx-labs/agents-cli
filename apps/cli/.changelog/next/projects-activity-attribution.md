- **Activity, feed posts, and the sessions overview now speak defined project
  names.** One resolver (`resolveProjectNameForCwd`, `lib/projects.ts`) backs all
  three: a cwd inside a defined project (`~/.agents/projects/<name>.yaml`) reads
  as the project's name — a multi-repo project is a single bucket in `agents
  activity`, not one per repo — and anything else falls back to the
  repository-level key, so nothing changes without definitions. Each peer
  resolves its own cwds against its synced definitions before events cross the
  wire. Source: `apps/cli/src/lib/projects.ts`, `apps/cli/src/commands/activity.ts`.

- **`agents activity --project <name>`** narrows the fleet stream to one project,
  exact-matched on the resolved label — one project's PRs, plans, and worktrees
  across every box without the rest of the fleet's noise. Source:
  `apps/cli/src/lib/activity.ts` (`filterActivityByProject`).
