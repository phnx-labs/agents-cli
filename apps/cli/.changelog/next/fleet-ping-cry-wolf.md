- **`agents fleet ping` stops crying wolf on healthy accounts.** The auth matrix
  painted a fully-logged-in fleet as half-broken: `codex`/`grok` (which have no
  in-repo live-probe endpoint) rolled up as an alarming yellow `0/N`, and the
  `--verbose` per-account list painted `expired` **red** — lumped with a real
  `revoked` — even though `expired` is soft and self-refreshes on the CLI's next
  launch (kimi/droid). Both renderers now share one truthful color model
  (`verdictColor` / `authCellColor`): red is reserved for `revoked` (the only
  "re-login now"); `unverified` reads as neutral **gray** "signed in
  (unverifiable)"; `expired`/`rate_limited`/`error` are soft **yellow**; and the
  cell numerator counts signed-in accounts (`live + present`) so a logged-in codex
  fleet reads `1/1`, not `0/1`. Separately, `fleet ping --verbose` now actually
  emits the per-account breakdown: the root program's global `--verbose` was
  shadowing the subcommand flag, so the breakdown was silently unreachable — the
  action now reads the effective value from the merged globals. Source:
  `apps/cli/src/lib/auth-health.ts`, `apps/cli/src/commands/ssh.ts`,
  `apps/cli/src/lib/auth-health.test.ts`.
