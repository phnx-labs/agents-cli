- **`agents view` now shows live usage bars for Antigravity.** The `agy` account
  row renders one bar per model quota bucket (`3.1P: ███░░ 42% (1d)` style),
  sourced from the same Google Code Assist `:retrieveUserQuota` endpoint `agy`
  itself talks to. Auth reuses the stored `agy` OAuth credential (macOS Keychain
  item `gemini`/`antigravity`, Linux Secret Service, or the
  `~/.gemini/antigravity-cli/antigravity-oauth-token` file fallback), refreshing
  the access token in memory when expired — safe from a read path because
  Google's refresh tokens are non-rotating, and never written back to the
  keychain. Each per-model bucket also flows into the throttle badge, run
  rotation eligibility, and `agents view --json` (whose usage windows now carry
  a `label` so same-keyed per-model bars are distinguishable). Source:
  `apps/cli/src/lib/usage.ts`, `apps/cli/src/lib/agents.ts`,
  `apps/cli/src/commands/view.ts`.
