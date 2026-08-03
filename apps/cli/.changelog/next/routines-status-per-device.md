- **`agents routines list` no longer reports another device's routine as failed.** Run
  records are written into the runs dir of whichever machine fired the routine and carry
  no device attribution, but the listing resolved Last Status from any local record and
  rendered it even on rows for routines pinned elsewhere. A routine re-pinned to another
  device therefore kept reporting the old machine's leftover records forever — on zion,
  `security-sweep`, `review-open-prs` and `hetzner-lease-gc` all read `failed` from late
  July while `yosemite-s0`/`s1`, the devices that actually fire them, had completed them
  that morning. The macOS menu bar reads this JSON, so it painted a column of red `exit 1`
  rows for routines that were green. Last Status is now scoped to the device that owns the
  run: a routine this device does not fire shows `-`, and `--json` returns `null` for
  `lastStatus`, `exitCode`, `failureReason`, `lastRunStartedAt` and `lastRunCompletedAt`
  (`runsHere: false` already says why). A routine pinned to several devices renders one row
  per device but carries a status only on its **This machine** row. Read a peer's status
  with `agents routines list --device <name>`; the local history is untouched and still
  readable via `agents routines runs <name>`. Source: `apps/cli/src/commands/routines.ts`
  (`localLatestRun`, `groupRoutineJobsByDevice`), `apps/cli/docs/03-routines.md`.
