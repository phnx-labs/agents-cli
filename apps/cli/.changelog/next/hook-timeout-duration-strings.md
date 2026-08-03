- **Hook `timeout` in agents.yaml now accepts duration strings, not just bare seconds (#1555).**
  A hook can be written `timeout: 5s` / `timeout: 2m` / `timeout: 1h30m` instead of only
  `timeout: 30` — self-documenting at the call site. A bare number still means seconds, so
  every existing manifest keeps working. `parseHookManifest` normalizes the value to a
  seconds number once, so all harness serializers keep consuming a number; an unparseable
  timeout is dropped with a warning rather than silently coerced. Source:
  `apps/cli/src/lib/hooks.ts` (`normalizeHookTimeoutSeconds`, `parseHookManifest`),
  `apps/cli/docs/hooks.md`.
