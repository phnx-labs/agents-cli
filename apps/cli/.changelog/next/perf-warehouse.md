- **`agents perf` — disposable SQLite latency warehouse.** Indexed p50/p99
  rollups for hooks, CLI commands, and `agent.run` timings without scanning the
  audit JSONL. Warehouse lives at `~/.agents/.cache/perf/perf.db` (safe to wipe);
  identity columns reuse sessions/events string shapes (`session_id`, `agent`,
  `machine`, …) for soft cross-reference — no foreign keys. Hook shims spool
  into the same DB; `agents hooks profile` reads it first. Source:
  `apps/cli/src/lib/perf/db.ts`, `apps/cli/src/commands/perf.ts`.
