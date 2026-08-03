- **`agents activity` now shows the whole fleet, grouped by project.** The
  question the command answers is "what are my agents doing", and agents run on
  every box — but it read only the local logs unless you remembered
  `--devices-all`, and printed one flat newest-first stream. Both defaults are
  inverted: every run fans `activity --json` out to each reachable device and
  merges the peers' streams host-tagged, then buckets them by project, one level,
  no sub-grouping. `--local` scopes back to this machine, `-H/--host` to named
  boxes, and `--flat` (or `--group-by none`) restores the single stream;
  `--devices-all`/`--hosts-all` remain accepted so existing scripts keep working.
  A peer answering the fan-out still carries the recursion guard, so it never
  re-fans the fleet.

- **Each project header names the machines its work ran on.** A bucket reads
  `▸ agents-cli  12 events · 4 milestones · zion, yosemite-s0` — up to three
  machines by name plus a `+N` tail, so a project touched by a dozen boxes stays
  one scannable line; individual rows keep their own `[host]` tag. Peers that
  never answered are reported once at the end (`· 2 devices unreachable: …`)
  rather than a line each above the timeline, so a missing machine is visible but
  not noisy.

- **A project is now the repository, not whatever directory the agent sat in.**
  A cwd resolves to the git repository containing it, so `<repo>/apps/cli` files
  under `<repo>` instead of `cli`, and a worktree under
  `<repo>/.agents/worktrees/<slug>` folds back into the repo it branched from.
  A directory in no repo groups as itself, and a dotfiles repo at `$HOME` is not
  treated as a project. The `agents sessions` overview and `agents feed post` now
  share this one resolver (`lib/project-key.ts`), so a project reads identically
  everywhere instead of each view folding cwds its own way.

- **`--limit` is spent on milestones, not on collapsed churn.** The default view
  rolls routine `file.edited` work up to a count, so a plain slice let one busy
  machine's 40 file edits hide every other device's PRs behind a single
  `file edited ×40` line. The cap now bounds the milestones shown, with the
  routine events inside that window riding along for the counts. `--all` still
  shows routine work inline and caps every event.

- **The activity header no longer carries other subsystems' hook warnings.**
  Registering the activity-log hooks surfaced every unresolved entry in the hook
  manifest — a missing `inject-session-id` script, someone else's half-installed
  plugin — printing five wrapped yellow lines above the timeline on every run.
  Those are `agents doctor`'s job; only a failure that would leave the activity
  log unwritten is reported here.
