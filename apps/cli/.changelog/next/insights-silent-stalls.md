- **`agents insights` detects agent silent stalls (model goes idle until you resume).**
  When the assistant is last to speak and the next user message is ≥5 minutes later,
  facets count duration-bucketed `silent stall: 5-15m` / `15-60m` / `1h+` friction
  signals; resume nudges (`continue`, `keep going`, …) after that silence also count
  as `resume after silent stall`. Report, actions, `--narrative`, and
  `/sessions-insights` instruct models to call these out (not reframe as "user was
  slow"). Extractor version bumped to 5 so cached facets recompute. Source:
  `apps/cli/src/lib/session/insights.ts`, `commands/insights.ts`,
  `docs/06-observability.md`.
