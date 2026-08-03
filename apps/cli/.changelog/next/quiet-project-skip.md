- **Project sync no longer spams a warning per file it left alone.** Syncing a
  project whose `.claude/commands/` you wrote yourself printed one wrapped
  `Skipping project resource target …: already exists and is user-owned` line
  per file — six hand-authored commands meant twelve lines of terminal noise in
  the middle of `agents view claude`. Those files are the normal steady state,
  not a warning, so the sync now reports them once, grouped, in plain words:
  `Kept 6 of your own files in .claude/commands: debug.md, doc-gaps.md,
  image-nbp.md, +3 more`. The list also rides out on `SyncResult.projectSkipped`
  for callers that want it. Source: `apps/cli/src/lib/project-resources.ts`.
