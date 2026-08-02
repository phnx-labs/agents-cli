- **`agents view` now shows Grok usage limits.** Grok's network usage endpoints
  404, so usage is parsed from the local `~/.grok/logs/unified.jsonl` log instead —
  the latest billing-period config and subscription tier render as a `W` window,
  matching the other agents' live-usage display. Source: `apps/cli/src/lib/usage.ts`.
