- **`agents run --lease` is reuse-first against the crabbox profile pool, with a
  `--fresh` opt-out.** A bare `--lease` used to always lease a brand-new box, so
  bursts of runs (e.g. resumed sessions) stacked up idle `keep=true` boxes at
  full monthly cost. Now, before warming a new box, the run looks for a warm box
  carrying the same `profile` label the warmup would use (read from the repo's
  `.crabbox.yaml`, matching `scripts/sandbox.sh`'s `pick_ready_box`) and the same
  network mode — a tailnet box is never handed to a public run or vice versa —
  and reuses the first one `crabbox status` reports SSH-ready, keeping it after
  the run. A not-ready pool box is skipped, never stopped. `--fresh` forces the
  old behavior (brand-new box, torn down after the run); `--box <slug>` is
  unchanged. Source: `apps/cli/src/lib/crabbox/lease.ts`,
  `apps/cli/src/lib/crabbox/cli.ts`, `apps/cli/src/lib/crabbox/config.ts`,
  `apps/cli/src/commands/exec.ts`.
