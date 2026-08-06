- **`agents insights` owns counter mix; `agents trends` is a deprecated alias.** The
  former top-level `trends` tree (harness/model mix, tools-per-session, token ratios,
  secrets/browser recipes, raw usage query) now lives under `agents insights mix` and
  `agents insights <recipe>` / `query` / `recipes`. Bare `agents insights` remains the
  behavioural report (transcript content, account split). `agents trends` still works
  but prints one deprecation line and runs the same mix tree — no second implementation.
  **Why:** two peer "analytics" verbs (`insights` + `trends`) taught agents and humans
  to guess; one verb, two engines (content vs counters). Latency stays on `agents perf`;
  quota on `agents usage`; skill/slash popularity on `agents sessions stats`. Source:
  `apps/cli/src/lib/analytics/mix-commands.ts`, `commands/insights.ts`,
  `commands/trends.ts`, `docs/06-observability.md`.
