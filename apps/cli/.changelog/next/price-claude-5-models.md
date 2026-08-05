- **`claude-opus-5` and `claude-sonnet-5` were unpriced, so every session using them
  cost $0.** The pricing table carried `claude-opus-4`, `claude-sonnet-4`,
  `claude-fable-5` and `claude-mythos-5` but not the Opus/Sonnet 5 line. Matching is
  dash-bounded (`getModelPricing`), so `claude-opus-5` cannot fall back to the
  `claude-opus-4` entry — it resolved to null, and an unpriced model contributes
  nothing rather than erroring. On one real index that silently zeroed **526 sessions**,
  478 of them the current default model, understating `agents cost`, `agents output`
  and `agents insights` alike. Rates from the published table: Opus 5 $5/$25 per MTok
  (cache write $6.25, cache read $0.50); Sonnet 5 $2/$10 (cache write $2.50, cache read
  $0.20). Source: `apps/cli/src/lib/pricing/prices.json`.

- **Schema v34 reprices the sessions that were zeroed.** Adding prices alone fixes
  nothing already indexed: `cost_usd` is computed at scan time and the scanner skips any
  transcript whose `(file_mtime_ms, file_size)` is unchanged, so those rows would keep
  their NULL forever. They cannot be repaired in place either — the row stores
  `token_count` and `output_tokens` but not the uncached-input / cache-read / cache-write
  split the price table needs. So v34 flushes `scan_ledger`, the same remedy v5 → v6 used
  for this exact column when cost was introduced. One slower scan, then correct numbers.
  Source: `apps/cli/src/lib/session/db.ts`.

  **Sonnet 5's $2/$10 is introductory pricing that ends 2026-08-31.** From 2026-09-01 the
  standard rate is $3/$15. The table holds one current rate per model with no notion of an
  effective date, so that entry must be updated then or Sonnet 5 spend reads ~33% low.
  Called out at the top of `table.ts`.
