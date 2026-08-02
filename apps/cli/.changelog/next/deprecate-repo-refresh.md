- **`agents repo refresh` is deprecated in favor of `agents sync`.** The command is
  now hidden from help and prints a deprecation notice on use, pointing at the
  replacement: `agents sync --local` (reconcile all installed agents, no git) or
  `agents sync <agent>` (one agent). It still runs for now so existing scripts and
  muscle memory don't break — `refresh` was a partial variant of `sync` (it only
  ever materialized the single global-default version, and silently no-op'd for an
  agent with installed versions but no global default), whereas `sync` covers
  every installed version. Internal callers (crabbox bootstrap, the `agents pull`
  redirect, `agents setup` help) now use `agents sync --local`. The underlying
  `refresh()` function stays — it is the reconcile stage behind `agents sync`.
  Source: `apps/cli/src/commands/repo.ts`, `apps/cli/src/lib/crabbox/`.
