- **`agents events --limit 0` now reads the whole stream, and a capped read says
  so.** `--limit` parsed as `Math.max(1, parseInt(raw) || 50)`, so `--limit 0`
  collapsed back to `50` (`0 || 50`) and there was no way to read past the default
  cap at all. The cap is applied after filtering and before the caller sees
  anything, so every aggregation over `--json` silently ranked the newest 50
  records instead of the matching set — measured against a real 7-day corpus of
  2,135 CLI failures in 9 classes, 8 of 9 ranks came out wrong with counts off by
  roughly 100x, and nothing warned. `--limit 0` now means no cap (29,649 records
  on a 30-day stream here, against 50 before), a truncated read prints
  `Showing the newest 50 — more events matched. Pass --limit 0 for all.` (on
  stderr under `--json`, so a `| jq` pipeline still receives clean JSON), and a
  non-numeric, negative, or empty `--limit` exits 2 rather than quietly becoming
  50 — an empty one (`--limit "$LIMIT"` with the variable unset) would otherwise
  have read as "no cap" and returned the whole stream unannounced.
  Source: `apps/cli/src/commands/events.ts`, `apps/cli/tests/events-limit.test.ts`,
  `apps/cli/docs/06-observability.md`.
