- **`agents setup secrets` now guides first-run secrets onboarding (RUSH-1999).**
  The setup command registers a new `secrets` capability wizard that chooses a
  default storage backend (`keychain`, encrypted `file`, or synced `vault`), sets
  the existing default prompt policy (`daily`/`always`, with `never` gated for
  explicit automation use), optionally delegates imports to `agents secrets
  import`, and writes durable setup preferences under `~/.agents/.history/setup`.
  Source: `apps/cli/src/commands/setup-secrets.ts`,
  `apps/cli/src/commands/setup.ts`.
