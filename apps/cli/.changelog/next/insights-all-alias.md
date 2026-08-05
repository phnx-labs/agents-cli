- **`agents insights --all` now works as an alias for `--since all`.** It previously
  exited with `unknown option '--all'` — a hard failure in the middle of a report the
  user asked for, on the spelling most people reach for first. An explicit `--since`
  still wins, so `--all --since 7d` resolves to 7d rather than silently contradicting
  itself. Source: `apps/cli/src/commands/insights.ts`.
