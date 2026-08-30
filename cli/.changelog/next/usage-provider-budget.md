- **Cap and smooth the daemon's usage-refresh traffic with a per-provider budget.** The
  refresher enforced only a per-account hourly cap, so endpoint load scaled linearly
  with account count: 8 Claude accounts × 12/hr = ~96 usage calls/hr from one box,
  against Anthropic's ~100/hr `/api/oauth/usage` ceiling — which 429'd accounts into
  Retry-After parks (measured on `zion`: 7 of 8 accounts parked, never refreshed in
  their window, so `agents view` showed `S: unavailable` and balanced routing read
  stale usage). A per-provider budget (`PROVIDER_HOURLY_BUDGET`, 30/hr across all of a
  network provider's accounts) now bounds aggregate traffic at a fixed rate that no
  longer grows with account count, paced smoothly (one fetch per ~2 min, round-robin,
  stalest account first) so it never bursts-then-stalls. Actively-used accounts stay
  fresh for free via the statusline ingest, which now also re-derives their headroom
  and suppresses a redundant API refresh. Source: `cli/src/lib/usage-refresh.ts`,
  `cli/src/lib/daemon-ticks.ts`.
- **Route-refuse only on genuinely stale usage, not merely budget-paced usage.** Because
  proactive refreshes are now paced, an idle account is deliberately refreshed on a
  stretched cadence. Routing keeps its tight 5-min bar for *weighting* an account, but
  the fail-loud `NO_VERIFIED_USAGE` refusal now fires on a wider 40-min bar
  (`USAGE_STALE_REFUSAL_MAX_AGE_MS`) — so a budget-paced fleet routes normally while a
  genuinely broken refresh (hours-old readings) still refuses. Source:
  `cli/src/lib/accounting/rotate.ts`.
