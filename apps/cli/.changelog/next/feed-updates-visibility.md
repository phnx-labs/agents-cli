- **`agents feed --filter updates` now shows the progress posts agents actually
  wrote, across the fleet.** The view read the most recent N activity events and
  *then* kept `status.posted`, so routine `file.edited` churn filled the whole
  slice — a box with six real posts rendered "0 posts" (and `--json` returned one
  of six). `readRecentActivity` gained `events` / `tier` filters that apply before
  the limit, so the limit counts posts; the same fix restores the milestone lane
  under `agents feed`. The updates view also fans out over SSH like the block view
  (`-H/--host`, `--device`, `--local` to opt out), because an agent posts on
  whichever box ran it. Source: `apps/cli/src/lib/activity.ts`,
  `apps/cli/src/commands/feed.ts`.
