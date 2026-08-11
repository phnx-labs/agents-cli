- **BREAKING: `agents share` moved under a new `agents artifacts` group (RUSH-2580).**
  `artifacts` is the noun and `share` the action on it, so the surface now reads
  noun-then-action like the rest of the CLI. The whole subtree moved down one
  level — `agents artifacts share <file>` publishes, and
  `agents artifacts share list|delete|analytics|join|status|update` are unchanged
  under it. The two provisioning doors collapsed into one:
  `agents artifacts setup` replaces both `agents share setup` (flag-driven) and
  `agents setup share` (the wizard). It runs the wizard only when no endpoint
  flag is typed on a TTY; type any of `--bundle`/`--worker`/`--bucket`/
  `--account`/`--token`/`--domain`/`--analytics-token`, or run non-interactively,
  and it provisions directly with what you named. The top-level `agents share` group and the
  `agents setup share` subcommand no longer exist; `share` is retired from
  distance-1 auto-correct, so a stale invocation fails loudly instead of running a
  neighbouring command. `agents unshare <targets...>` is unchanged and stays
  top-level. Source: `apps/cli/src/commands/artifacts.ts`,
  `apps/cli/src/commands/artifacts-setup.ts`, `apps/cli/src/commands/share.ts`,
  `apps/cli/src/commands/setup.ts`, `apps/cli/src/lib/startup/command-registry.ts`.
