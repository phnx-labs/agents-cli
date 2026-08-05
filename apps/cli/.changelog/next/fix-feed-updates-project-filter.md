- **`agents feed --filter updates --project <name>` actually scopes posts.** The
  updates short-circuit omitted `project` when calling `gatherStatusPosts`, so the
  masthead said `<project> updates` while the body still listed the full fleet.
  Source: `apps/cli/src/commands/feed.ts`.
