- **Monitor `condition: { mode: every }` no longer fires on an empty observation (RUSH-2488).** `every`
  previously returned `fire: true` for every tick regardless of the observation, so a poll whose
  command produced no rows still dispatched the action with an empty `{event}`. It now stays silent on
  an empty or whitespace-only observation and fires on every tick that carries real output. This gives
  a poll-driven monitor the "re-fire while the watched set is non-empty" semantics that a
  silently-failed action dispatch needs to be retried — an action failure leaves the same non-empty
  observation next tick, so `every` re-fires (bounded by `rateLimit`), where `match`/`on-change` would
  dedupe and never retry. No shipped monitor used `every`, so there is no behavior change to an existing
  monitor. Source: `apps/cli/src/lib/monitors/engine.ts`, `apps/cli/src/lib/monitors/engine.test.ts`.
