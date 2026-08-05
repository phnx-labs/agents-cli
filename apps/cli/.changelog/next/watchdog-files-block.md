- **Watchdog files a feed block when a session genuinely needs the human.**
  Three paths now route the "needs human" signal to the owner's feed instead of
  silently dropping it. (1) Brain says stuck + session is addressable: the watchdog
  injects a self-file reminder into the agent ("You appear stuck. File it: `agents
  feed post … --blocked`") so the agent can declare its own block. (2) Session is
  un-addressable (refuse branch): the watchdog publishes a declared block on the
  agent's behalf. (3) Hands-off policy — would nudge but policy prevents it: same
  as (2). All three paths are gated by the existing cooldown ledger (at most once per
  `WATCHDOG_COOLDOWN_MS` window) and are no-ops when a block for the session already
  exists, preventing double-paging. Deterministic skips (session completed, no stall)
  never trigger the block path. Source:
  `apps/cli/src/lib/watchdog/runner.ts` (`NudgeDecision.needsHuman`,
  `WatchdogTickOptions.publishBlockFn`, skip/refuse/handsoff branches),
  `apps/cli/src/lib/watchdog/runner.test.ts`.
