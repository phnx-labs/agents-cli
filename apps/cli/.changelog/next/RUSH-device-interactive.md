- **`--device interactive` resolves to the machine the human is at.** `--device
  auto` picks a box by load; this picks the one box someone is actually looking
  at, pinned as `interactive.host`. It resolves in the shared host
  matcher rather than per command, so `browser`, `run`, `sessions` and `secrets`
  inherit it; `teams` and `ssh` resolve it explicitly because they leave the
  fleet passthrough before the matcher runs. A few narrower `--device` surfaces
  do not consult the matcher. None of them mis-routes: most fail loud, and
  `devices harnesses` filters to an empty result. Wiring them up is a follow-up.
  It exists because a skill cannot teach a host name: guidance that says
  "deliver it to <box>" is wrong on every other fleet and stale the moment the
  pin changes, so agents were left inferring the target or skipping the step. A
  fixed token is something documentation can state literally and have be correct
  everywhere.
  When no host is pinned it refuses and names the command that fixes it, rather
  than falling back to the local machine — running on a headless worker with
  nobody watching is the exact failure the sentinel prevents, and it would fail
  invisibly. Source: `src/lib/devices/interactive-host.ts`.
