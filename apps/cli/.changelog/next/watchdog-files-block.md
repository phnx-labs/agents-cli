- **Watchdog files a feed block only when a session genuinely needs the human.**
  When the smart brain concludes a stalled session must be left for the human
  (`needsHuman`), the watchdog now surfaces that on the owner's feed instead of
  dropping it in a menubar-only flag. Two cases: if the session is addressable it
  injects a self-file reminder into the agent ("You appear stuck. File it: `agents
  feed post … --blocked`") so the agent declares its own block; if it is
  un-addressable — the case where the watchdog can't even reach the terminal to
  remind it — the watchdog files a declared block on the agent's behalf so the owner
  is still paged. Paging fires **only** on this confirmed-needs-human path: a plain
  nudge-worthy drive-forward poke (un-addressable or under a hands-off policy) is
  flagged for the tray but never texts the owner. Both paths are gated by the
  existing cooldown ledger (at most once per `WATCHDOG_COOLDOWN_MS` window) and are
  no-ops when a block for the session already exists, so no double-paging. Source:
  `apps/cli/src/lib/watchdog/runner.ts` (`NudgeDecision.needsHuman`,
  `WatchdogTickOptions.publishBlockFn`, the needs-human skip branch),
  `apps/cli/src/lib/watchdog/runner.test.ts`.
