- **`agents projects status --fleet` — per-device workspace drift (beta).**
  Projects are natively multi-device; `--fleet` adds a `fleet` line to the status
  card showing, for each project, whether its workspace repos are present on every
  fleet device, on which branch, ahead/behind their upstream (`↑`/`↓`), and how
  many uncommitted changes they carry — plus a hidden `agents projects probe
  --json <path...>` subcommand that is the peer half of the fan-out. One parallel
  SSH call per device (12s timeout), **no `git fetch`** — drift is measured
  against each peer's last-fetched upstream, and a repo with no upstream reports
  no drift rather than zero. Peers that are unreachable or run an older CLI are
  named once in a trailing note; `probe` itself is not beta-gated so peers answer
  whenever their binary carries it. The schema gains `repos[].path` (home-relative
  local checkout) to opt additional repos into probing beyond the primary `root`,
  and `--json` gains per-project `workspaces[]` with the host-tagged probe rows.
  The card's `live` line also counts agents on every box under `--fleet` via the
  existing sessions fan-out. Source: `apps/cli/src/lib/project-probe.ts`,
  `apps/cli/src/commands/projects.ts`, `apps/cli/src/lib/projects.ts`.
