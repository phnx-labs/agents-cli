- **`agents projects` outcomes on the card — agent×project members, releases,
  Linear counts, and `projects link --linear` (beta).** The status card gains an
  `agents` line under `live` naming WHICH harness is on each project
  (`claude · running · RUSH-2107 @zion`, sorted running-first, capped at 6 with a
  `+N more` tail; under `--fleet` remote agents carry their peer's hostname), a
  latest-release tag on the `ships` line (primary repo only, best-effort
  `gh release list`), and a `linear` line counting the bound Linear project's
  issues by state type (`12/30 done · 5 in progress`) — best-effort with an 8s
  budget, skipped by `--no-remote`, and omitted when the def has no
  `linear.projectId`. The new `agents projects link <name> --linear [query]`
  writes that binding: no query auto-suggests from the def name + repo slug via
  the normalized-key matcher (ported from Factory's `linearProjects.ts`),
  ambiguous/none prints the candidate list and exits 1. `--json` gains
  `members[]`, `latestRelease`, and `linear`. Source:
  `apps/cli/src/lib/project-status.ts`, `apps/cli/src/lib/linear-projects.ts`,
  `apps/cli/src/lib/linear-project-counts.ts`, `apps/cli/src/commands/projects.ts`.
