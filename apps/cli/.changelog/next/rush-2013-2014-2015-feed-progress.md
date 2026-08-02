- **`agents feed post` carries artifacts and a project chip, and progress posts
  render rich (RUSH-2013 / RUSH-2014).** `feed post` gains `--attach <path-or-url…>`
  (repeatable): a local file is copied under
  `~/.agents/.history/attachments/<session>/<update>/` so the link survives a
  worktree delete, and a URL is kept as a link — each classified to an
  image/audio/video/file/link kind by extension. Every post is now stamped with its
  project (basename of cwd, worktree-aware) on the activity event itself, so the
  chip shows without a live-session join. A `status.posted` event renders as a
  multi-line update — `agent · session · host · project` chips, the message, an
  attachment row with per-kind glyphs, and a `↳ ag focus/sessions` hint — wherever
  it appears (`feed post` echo, the feed activity lane, `agents feed --filter
  updates`, and `agents activity`).
- **`agents feed --filter needs|updates|all` (RUSH-2015).** `needs` (default) is the
  open-blocks inbox as before; `updates` shows only deliberate progress posts over
  the local activity timeline (no block pipeline, no remote fan-out); `all` renders
  the blocks then appends the updates view. `--json` under `--filter updates` emits
  the raw `status.posted` events. Source:
  `apps/cli/src/lib/activity.ts`, `apps/cli/src/lib/feed-post.ts`,
  `apps/cli/src/commands/feed.ts`, `apps/cli/src/commands/activity.ts`.
