- **`agents view` no longer reports a working Claude install as "logged out".**
  Claude's `signedIn` is `!!email` read from a version home's `.claude.json`
  (`lib/agents.ts`), so a version that authenticates from an ambient
  `CLAUDE_CODE_OAUTH_TOKEN` — no account ever written to that home — rendered
  "(logged out — log in with: claude, then /login)" while every run against it
  succeeded. On one fleet box five of seven versions read as locked out and all
  of them answered a live prompt. Those now render "(no per-version login —
  using ambient CLAUDE_CODE_OAUTH_TOKEN)", which is both accurate and the more
  useful warning: an ambient token is ONE account, so balanced rotation across
  those versions rotates nothing. Source: `apps/cli/src/lib/signin-badge.ts`,
  `apps/cli/src/commands/view.ts`.
