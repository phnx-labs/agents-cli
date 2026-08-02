- **Codex hook sync no longer leaves startup warnings after upgrades.** The Codex
  hook registrar now prunes hook commands from sibling Codex version homes before
  writing `hooks.json`, so removed versions such as `0.142.0` cannot leave dead
  PreToolUse/Stop handlers that exit `127`. It also writes `SessionEnd` hook
  timeouts at Codex's 3-second limit instead of emitting `timeout: 5` and making
  Codex warn that it is clamping the value on every startup. Source:
  `apps/cli/src/lib/hooks.ts`.
