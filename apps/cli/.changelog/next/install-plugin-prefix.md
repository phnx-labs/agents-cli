- **Install: `plugin:` prefix on the unified path (Phase 5 packaging).**
  `agents install plugin:<spec>` uses the same grammar and trust gate as
  `agents plugins install` (`name@url`, local path, `--allow-exec-surfaces`).
  Specialized verbs still work; `agents install` is the one add path for mcp,
  skill, plugin, and GitHub sources. Source: `apps/cli/src/commands/packages.ts`,
  `apps/cli/src/lib/registry.ts`.
