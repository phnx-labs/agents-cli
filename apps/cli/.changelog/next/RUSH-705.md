- **Keep project resources in workspace config (RUSH-705).** Project-scoped commands,
  skills, subagents, and workflows now sync into the current workspace's `.<agent>/`
  directory instead of lingering in global agent version homes. Source:
  `apps/cli/src/lib/project-resources.ts`.
- **Track Goose workflow subrecipes from first sync (RUSH-705).** Goose workflow
  `.subrecipes/` directories are tracked in the ownership manifest from the first
  sync, preventing workflows from being incorrectly skipped on later syncs. Source:
  `apps/cli/src/lib/project-resources.ts`.

