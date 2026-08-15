- **`agents apply` / `agents fleet apply` no longer propagates a harness login
  between devices (RUSH-2527, SING-1b).** `login: sync` used to copy each agent's
  portable login file (Claude `.credentials.json`, codex/grok/opencode/kimi/
  antigravity `auth.json`) from the source box to every target — a rotating token
  that a single refresh then invalidates fleet-wide. `apply` now emits no
  `push-login` action and captures no credential (`snapshotAuth` reads nothing);
  every `login: sync` agent that needs a login is surfaced as **needs-login** with
  the honest reason and the portable alternative — log in on the box itself, or
  `agents accounts sync <name> --device <host>` a policy-`never` provider account.
  The internal `apply --recv-auth` receive path is gone. Sources: `apps/cli/src/lib/fleet/auth-sync.ts`
  (`isCredentialSafeToPropagate`), `apps/cli/src/lib/fleet/apply.ts`,
  `apps/cli/src/commands/apply.ts`.
