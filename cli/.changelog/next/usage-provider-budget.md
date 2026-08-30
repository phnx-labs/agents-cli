- **Cap the daemon's usage-refresh traffic with a global per-provider budget.** The
  refresher enforced only a per-account hourly cap, so endpoint load scaled linearly
  with account count: 8 Claude accounts × 12/hr = ~96 usage calls/hr from one box,
  against Anthropic's ~100/hr `/api/oauth/usage` ceiling — which 429'd accounts into
  Retry-After parks (measured on `zion`: 7 of 8 accounts parked, never refreshed in
  their window, so `agents view` showed `S: unavailable` and balanced routing read
  stale usage). A new `PROVIDER_HOURLY_BUDGET` (40/hr per network provider, across all
  its accounts) bounds aggregate endpoint traffic at a fixed rate that no longer grows
  with account count. The budget is spent stalest-account-first, so no account is
  starved and each account's effective proactive cadence simply stretches as N grows.
  The free statusline ingest of a live `agents run` now also suppresses a redundant
  API refresh of an already-current account. Source: `cli/src/lib/usage-refresh.ts`,
  `cli/src/lib/daemon-ticks.ts`.
