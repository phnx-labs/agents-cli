- **`agents projects view <name>`** replaces `show` (kept as an alias) and now renders the
  project's full plan: every declared Linear milestone with its date and progress, issue
  counts, and a warning when no issues are assigned to any milestone — a milestone nothing is
  filed against cannot report progress, and a row of silent `0%`s hid that. Sixteen other
  command groups already use `view <name>`; `projects` was the only one that did not. Source:
  `apps/cli/src/commands/projects.ts`.
- **The status headline counts live agents, not corpses.** It read `39 agents` on a project
  where 19 had crashed. It now reads `19 live`, with a separate `dead` row breaking down what
  finished or was lost — 19 crashed sessions is a thing to go fix, not throughput. `orphaned`
  counts as **live**: `session/active.ts` defines it as "alive, but no client is attached", and
  the repo's own dead rule is `closed` + `crashed` only. Source:
  `apps/cli/src/lib/project-status.ts`.
- **`planPct` is gone from the card and from `--json`.** It summed each matched session's most
  recent checklist snapshot, so one agent opening a fresh 40-item plan rendered the whole
  project `0% plan`, and a project where nobody had written a checklist showed no figure at
  all. A cross-session sum of ad-hoc checklists does not measure project progress. `live` and
  `dead` counts replace it in `--json`.
- **The next milestone comes from Linear's own `status: "next"`** when Linear sets it, falling
  back to earliest-dated-unfinished only when nothing is flagged — Linear's answer is the one
  shown in its UI, ours is a guess.
