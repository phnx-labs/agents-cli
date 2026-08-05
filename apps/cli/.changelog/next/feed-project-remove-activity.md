- **`agents feed --project <name>` scopes the whole feed to one project.** Open
  blocks, the updates view (`--filter updates`), and the trailing activity lane
  are all filtered to the requested repo/project using the same worktree-aware
  project key as `agents perf` (`lib/project-key.ts`). The masthead becomes
  `<project> needs you` / `<project> updates`. Filtering is applied locally after
  the fleet fan-out, so older peers that do not recognize `--project` still
  contribute correctly. Source: `apps/cli/src/commands/feed.ts`.

- **Feed blocks are now stamped with their project.** The `feed-publish` hook
  derives project from the session cwd, and `agents feed post --blocked` stamps
  it via the same `resolveProjectNameForCwd` path as `feed post` (defined project
  name wins, else repo key). Live-session enrichment backfills `project` onto
  older blocks that lack it. Source: `apps/cli/src/lib/feed.ts`,
  `apps/cli/src/lib/feed-outcome.ts`.

- **`agents activity` is removed (tombstone).** The standalone milestone timeline
  is gone; its stream is now read through `agents feed --filter all` (blocks +
  updates) or `agents feed --filter updates` (progress posts only).
  `activity --project <name>` is replaced by `feed --project <name>`. The command
  remains as a tombstone redirect (exit 2). The activity log library
  (`lib/activity.ts`) stays — feed posts and the feed activity lane still use it.
  Source: `apps/cli/src/commands/activity.ts`, `apps/cli/docs/06-observability.md`.
