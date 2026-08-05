- **`agents trends tools-per-session` now counts every scanned session, not just `agents teams`
  runs.** The recipe read `sessions.tool_call_count`, a column nothing populates except the
  teams summarizer (`apps/cli/src/lib/teams/summarizer.ts`) — the general session indexer never
  computes it. So every session that did not come from a team was scored 0 or excluded outright
  by `WHERE tool_call_count IS NOT NULL`, pinning the fleet-wide p50 at 0 however many tools ran
  and leaving only `claude` in the table. It now reads `tool_scan_ledger.call_count`, the
  per-session count the tool indexer writes for every session it scans — the same index behind
  `agents sessions --include tools`, so the two surfaces stop disagreeing. Sessions with
  genuinely zero tool calls still count as 0 instead of vanishing. On a real 7-day window this
  took the sample from 400 to 570 sessions and surfaced `grok`, `rush`, `codex`, `kimi`,
  `droid` and `antigravity`, none of which had ever appeared. Run `agents sessions backfill
  tools` once if historical sessions were never indexed. Source:
  `apps/cli/src/lib/analytics/recipes.ts`.
