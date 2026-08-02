- **Point-of-use friction events for `agents teams` failures.** The CLI's `die()`
  chokepoints in `teams` now emit a structured `friction` event (`surface`,
  `failureId`, `error`) before exiting, so the nightly factory-metrics routine can
  rank recurring failures without re-parsing transcripts. A hidden
  `agents _internal friction` recorder lets shell guard hooks (git-guard, rm-guard,
  large-file-add-guard) self-report blocks into the same stream. Source:
  `apps/cli/src/lib/events.ts`, `apps/cli/src/lib/format.ts`,
  `apps/cli/src/commands/teams.ts`, `apps/cli/src/index.ts`.
