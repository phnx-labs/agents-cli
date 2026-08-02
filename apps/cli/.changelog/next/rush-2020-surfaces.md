- **Actor provenance reaches events, routines, and browser tasks (RUSH-2020).**
  Completes the actor layer's coverage beyond sessions: every emitted **event** now
  records `actor` + `kind` through the audit origin (so `agents events` stats carry
  a `byActor` breakdown); a **routine** stamps its creator's actor at creation and
  injects it into each fired run's env, so an unattended cron traces back to the
  person who scheduled it instead of `UNRESOLVED@<host>` — its run records gain
  `actor` (creator) and `triggeredBy` (who kicked off that run); a **browser task**
  records the `owner` who launched it, on the live task and in history. Source:
  `apps/cli/src/lib/events.ts`, `apps/cli/src/lib/runner.ts`,
  `apps/cli/src/lib/routines.ts`, `apps/cli/src/lib/browser/{types,service}.ts`.
