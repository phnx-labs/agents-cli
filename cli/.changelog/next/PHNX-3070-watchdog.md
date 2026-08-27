- **Watchdog un-addressable stalls now include the same recovery command as `agents focus` (PHNX-3070).**
  Rotate, needs-human declared-block, and nudge-refuse paths append `addressabilityRecoveryHint` so an un-addressable session prints `agents sessions resume <id>` / tmux wrap instead of a reason-only skip. Source: `cli/src/lib/watchdog/runner.ts`.
