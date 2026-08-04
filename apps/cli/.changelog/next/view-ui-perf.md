- **`agents view` columns stay aligned across agents, and usage no longer piles up (view-ui-perf).**
  The multi-agent overview padded every row to the widest usage string — an
  Antigravity account with four model quotas forced ~194-column lines that
  wrapped so `rate-limited` and last-active drifted under the version column.
  Overview now caps compact meters to two windows (`+N` for the rest), always
  emits fixed account/usage/status/lastActive columns (empty cells space-padded),
  and measures padding with `stringWidth` so chalk + block bars don't skew
  gutters. Usage fetches go through one unified core: 5-minute fresh cache
  (was 2), concurrency-capped live reads (`USAGE_FETCH_CONCURRENCY=3`),
  single-flight per identity, and a background SWR queue capped at 2 so delayed
  HTTP responses cannot stack. Spinner stays up through account+usage load.
  Source: `apps/cli/src/commands/view.ts`, `apps/cli/src/lib/usage.ts`,
  `apps/cli/src/lib/agents.ts`.
