- **Routine auth-failures are now detected, not silent.** When a routine's agent is logged
  out or its token is revoked, the run is classified `failed` with an `auth_failed:` /
  `auth_preflight:` reason instead of a generic non-zero exit. The login-error text is no
  longer written into `report.md`, and `{last_report}` now only injects the last *completed*
  run's report — so a single logged-out run can no longer poison every subsequent run's
  prompt. Classification uses the Claude stream-json markers (`error:"authentication_failed"`
  and a `result` event with `is_error:true`), which is the reliable signal — `terminal_reason`
  is `"completed"` on a logged-out run. Rate-limit still classifies first, so a 429 keeps
  triggering failover rather than being mistaken for an auth failure. Source:
  `apps/cli/src/lib/exec.ts`, `apps/cli/src/lib/runner.ts`, `apps/cli/src/lib/routines.ts`.
- **`agents routines run` now exits non-zero on failure.** A failed run (including an auth
  failure) returns exit code 1 and `--json { "ok": false, … }` with the reason, instead of
  exiting 0 with `ok:true` — so cron wrappers, `&&` chains, and `--json` consumers actually
  see the failure. Source: `apps/cli/src/commands/routines.ts`.
- **Auth preflight before dispatch.** A routine whose (agent, version) has a cached
  `revoked` auth verdict fails fast with `auth_preflight: revoked` without spawning a
  doomed agent. Fails open on any other verdict, so a stale/absent probe or a network blip
  never blocks a run, and agents with no live probe (codex/gemini/grok) are never blocked.
  Source: `apps/cli/src/lib/runner.ts`, reusing `apps/cli/src/lib/auth-health.ts`.
- **The routines daemon no longer starts silently token-less.** When no Claude OAuth token
  is available (e.g. a headless macOS daemon whose keychain was locked at start), the daemon
  now logs a `WARN` and fires a desktop notification instead of quietly spawning Claude
  routines that all fail auth. Source: `apps/cli/src/lib/daemon.ts`.
