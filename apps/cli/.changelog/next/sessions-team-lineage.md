- **`agents sessions` now shows which session spawned which team.** The link
  already existed on disk and was discarded twice. `SessionMeta.spawnedTeam` — the
  team name read off the `agents teams create/add` command at scan time — had no
  column in `sessions.db`, so the writer dropped it and no consumer had ever seen
  a non-`undefined` value; a new `spawned_team` column (schema **v21**, which
  forces one full rescan) persists it, and orchestrator rows now carry a green
  `team:<name>` badge. Separately, `classifyTeamSession` was already opening each
  teammate's `meta.json` and throwing away its `task_name` and
  `parent_session_id`, so a teammate row could not name its team or point back at
  its orchestrator; teammate rows now read `[<team>/<handle>]` and the preview
  pane carries a `Team:` line from either end of the lineage. New `--in-team
  <name>` (and a `t` hotkey in the browser) filters to one team's orchestrator
  plus its teammates, `agents teams status --parent-session <id>` lists the
  teammates a given session spawned, and `agents teams list` gains a `by <id>`
  column. Source: `apps/cli/src/lib/session/db.ts`,
  `apps/cli/src/lib/session/team-filter.ts`, `apps/cli/src/commands/sessions.ts`,
  `apps/cli/src/commands/sessions-browser.ts`, `apps/cli/src/commands/teams.ts`.

- **`agents sessions --device <box>` no longer opens an empty browser.** The
  interactive one-host listing kept the browser's default this-repo scope, but
  every row it fetches is the peer's and no peer cwd is under the local
  `process.cwd()` — so the filter dropped all of them. A host scope now implies
  all-directories (and the `p` hotkey is a no-op under one). Three more
  scope bugs on the same path: `--device <this machine>` fanned out to the whole
  tailnet, because `gatherRemoteList` reads the resulting empty peer list as "no
  hosts given" and sweeps; `--local --device <box>` rendered a silent empty list
  instead of reporting that the two flags ask for opposite things; and
  `--device <box> --cloud` fell through to the cloud listing, which has no host
  scope and silently ignored the device. An unreachable peer now says so in the
  browser header — the fan-out's stderr note is repainted away by the full-screen
  picker, so "that box is asleep" used to read as "no sessions match". Source:
  `apps/cli/src/commands/sessions.ts`, `apps/cli/src/commands/sessions-browser.ts`,
  `apps/cli/src/lib/session/remote-list.ts`.

- **The session preview pane sanitizes peer-supplied `plan` and directory
  text.** A remote row's metadata is JSON the peer sent and `parseRemoteList`
  hands over verbatim; `sanitizeMeta` covered `topic`/`label`/`cwd`/`todos` but
  not these, so a terminal escape in another machine's plan text reached the TTY.
  The remote preview also renders more of what already rides across the hop: the
  checklist items, the directories the scan recorded, and a one-line plan summary
  (never the full markdown blob). `directoriesTouched` now reads the real
  `recentDirectoriesTouched` field instead of a `dirsTouched` that nothing in the
  repo ever wrote. Source: `apps/cli/src/commands/sessions-picker.ts`.
