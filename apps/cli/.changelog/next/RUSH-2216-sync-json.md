- **`agents sync --host all` no longer fails every peer with `unknown option
  '--json'`.** Fleet fan-out injects `--json` on each remote so the roster can
  parse per-device results, but `sync` never registered the flag. Register
  `--json` on `agents sync` and emit a machine-readable umbrella/agent/repo
  payload so peers accept the flag and return parseable stdout (RUSH-2216).
  Source: `apps/cli/src/commands/sync.ts`.
