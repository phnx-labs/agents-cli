- **Unify native logins and provider credentials under one account model (RUSH-2527).**
  `agents accounts name <agent@version> <name>` gives a durable name to a
  harness's own signed-in login — metadata only in `meta.accounts.native` (a
  stable id + identity key + scope), never the harness's OAuth/session credential,
  which stays in the harness home. Native and provider accounts now share one name
  namespace and one `accounts` / `accounts view` renderer (text + `--json`). New
  positional grammar: `accounts name <source> <name>`,
  `accounts attach <account> <target>` / `detach <account> <target>`, and
  `accounts sync <account> <device>`. Only version-scoped nameable harnesses
  (Claude/Codex/Grok, plus Muse when a live email is present) can be named
  or attached, always to an exact `agent@version`. Device-scoped harnesses
  (Cursor/OpenCode/Antigravity/Kimi/Droid) are unsupported for native
  naming — their API-key path is a provider account. `attach`
  validates the live identity before binding and injects no secret or env;
  `resolveAccountSelection` resolves explicit → exact-target binding →
  device-scoped binding → per-harness default. `remove` refuses while a binding, a
  default, or a harness profile still references the account. Bindings are honored
  end-to-end: `agents run` and routines select the bound account at spawn — a
  provider account injects its env, a native account is validated live and pins
  the installed version that holds it (never forwarded/injected, fails closed for
  a remote/cloud target or a cross-harness login) — and `agents view` plus the
  fleet/harness inventories render the durable account name. Source:
  `apps/cli/src/lib/account-registry.ts`, `apps/cli/src/lib/account-capabilities.ts`,
  `apps/cli/src/commands/accounts.ts`, `apps/cli/src/commands/exec.ts`,
  `apps/cli/src/lib/runner.ts`, `apps/cli/src/commands/view.ts`,
  `apps/cli/src/lib/devices/{fleet,harness}-inventory.ts`, `apps/cli/src/lib/types.ts`.
