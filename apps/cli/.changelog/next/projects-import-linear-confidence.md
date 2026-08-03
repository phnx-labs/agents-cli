- **`agents projects import` gains Linear as a source, and gates the Factory guess.**
  `import --from-linear` turns the workspace's Linear projects into definitions via the
  `linear` CLI, binding a local checkout only on an exact name match so it never
  silently points a project at the wrong repo. `--from-factory` now imports only
  `high`-confidence rows by default (`--min-confidence low|medium|high`, `--all` to
  take everything), and prints why each row was skipped — the auto-detected registry
  used to absorb every stale clone it found. Source: `apps/cli/src/lib/project-import.ts`.
- **`agents projects list` columns line up again.** Widths are computed from the rows
  being printed instead of a fixed 32-character path pad that every home-relative root
  ran straight through. Source: `apps/cli/src/commands/projects.ts`.
