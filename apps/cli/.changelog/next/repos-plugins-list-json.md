- **`--json` for `repos list` and `plugins list`.** Both list commands now emit
  machine-readable JSON with `--json`, matching the `repos view --json` /
  `plugins marketplaces --json` that already existed — so an agent can enumerate
  registered repos (with per-repo sync/drift state) and installed plugins (with
  per-agent-version sync targets) without scraping the human table. Source:
  `apps/cli/src/commands/repo.ts`, `apps/cli/src/commands/plugins.ts`.
