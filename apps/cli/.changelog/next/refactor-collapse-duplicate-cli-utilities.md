- **One canonical `formatBytes`, and byte sizes now read the same everywhere.** Five
  copies had drifted into three different renderings of the same number. Four of the five
  call sites change output at some boundary: `agents prune` showed `1.50 GB` where every
  other surface showed `1.5 GB`; session artifact sizes capped at `MB`, so a 1.4 GiB
  transcript rendered as `1433.6 MB`; and `agents share` plus the browser artifact list
  capped at `GB`, so a 2.3 TiB entry rendered as `2355 GB` and now reads `2.3 TB`. Only
  `agents inspect` is byte-identical to before — its implementation is the one all five
  now share. Source: `apps/cli/src/lib/format.ts`,
  `apps/cli/src/commands/{prune,share,inspect,sessions}.ts`,
  `apps/cli/src/lib/browser/sessions-list.ts`.

- **Capability version gates now honor OpenClaw's `-N` rebuild suffix.** `supports()` and
  the command version gate each carried a private `compareVersions` that split on `.` and
  dropped the trailing `-N`, so `2026.2.19-2` compared equal to `2026.2.19`. Both now use
  the canonical comparator in `lib/agent-spec/primitives.ts`, which treats a higher `-N`
  as newer. No capability currently declares a `-N` floor, so nothing changes today — the
  gate is simply no longer wrong for the version scheme OpenClaw actually ships. Source:
  `apps/cli/src/lib/capabilities.ts`, `apps/cli/src/lib/commands.ts`.

- **`SESSION_AGENTS` and the sessions command surface documented accurately.** The spec
  said "exactly these 12" while the code has 13 (`muse` was missing), and both it and
  `SES-IF-2` required a `sessions sync` subcommand that has never existed. The command
  list also omitted seven real subcommands (`render`, `bookmark`, `stats`, `insights`,
  `optimize`, `watch`, `backfill resources`) while still listing verbs that
  `655b22512` retired behind `resume`. Source: `apps/cli/docs/specifications.md`,
  `apps/cli/docs/architecture.md`.
