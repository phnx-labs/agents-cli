- **A routine that misses its fire now runs late instead of being silently lost.** Fires
  are in-process croner timers, and croner only ever schedules forward from "now" — so a
  daemon that was down, asleep, or wedged when a routine came due dropped that fire
  outright, and `loadAll()` rebuilt every timer looking only at the future. Detection
  existed but ran **once, at daemon startup**, and only logged a warning plus a
  notification; catching up was a manual `agents routines catchup`. Observed cost: zion's
  daemon was down from 02:03Z to 08:23Z while the laptop slept, `weekly-fleet-retro` was
  armed for exactly 04:00Z, never ran, and the restart logged `2 routine(s) overdue` and
  did nothing. The daemon now re-scans every 5 minutes as well as at startup and runs each
  missed routine via the same detached path `catchup` already used. Source:
  `apps/cli/src/lib/catchup.ts`, `apps/cli/src/lib/daemon.ts`.
- **New `catchup:` routine field, and `agents routines add --no-catchup`.** Defaults to
  true — a routine you scheduled is one you expect to have run. Set `catchup: false` for a
  routine whose worth expires with its slot (a 9am brief is useless at 3pm); the miss is
  still recorded, it just is not re-run. `agents routines list --json` reports the
  effective value as `catchup`.
- **New `missed` run status.** A missed fire previously left no trace anywhere — no run
  record, no log line in the routine's history — so `agents routines list` kept showing the
  previous run's `completed` as though it were current, sometimes for weeks. A miss is now
  written as a real run stamped at the moment the fire was due, so `agents routines runs
  <name>` shows the gap, and the listing renders it distinctly from `failed` (a miss is an
  infrastructure problem, not a task failure). That record is also what makes catch-up
  idempotent: it advances the overdue comparison, so the same missed fire is never
  reconsidered across ticks or a daemon restart storm, and its directory is created with a
  non-recursive `mkdir` — an atomic claim, so if the daemon's timer and a manual
  `agents routines catchup` overlap, only one of them runs the routine. Source: `apps/cli/src/lib/routines.ts` (`RunMeta`),
  `apps/cli/src/commands/routines.ts`.
