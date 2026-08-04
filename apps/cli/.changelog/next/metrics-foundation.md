- **Metrics foundation: hook/command instrumentation + routine metrics.** Every
  hook now instruments through a generated shim — `matcher:`-only hooks like
  git-guard/rm-guard/git-require-clean-tree previously fired with zero perf
  samples; `agents perf hooks` now reports them. `agents perf` gains
  `--project <key>` (scope to one repo), a `P95` column alongside P50/P99, and
  an `ERR/TIMEOUT` rate column. New `agents perf friction` surfaces sessions
  stuck repeatedly hitting the same guard block instead of adapting. New
  `agents routines stats [name]` reports run count/failed/missed/avg/p50/p95
  duration per routine; `agents routines runs --json` now includes `duration`.
  Routine session transcripts are now archived for gemini/antigravity/droid/
  kimi/grok routines, not just claude/codex/cursor. Source:
  `apps/cli/src/lib/hooks.ts`, `apps/cli/src/lib/perf/db.ts`,
  `apps/cli/src/commands/perf.ts`, `apps/cli/src/lib/routines.ts`,
  `apps/cli/src/lib/runner.ts`.
