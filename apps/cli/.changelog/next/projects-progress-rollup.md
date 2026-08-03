- **`agents projects` — named multi-repo projects with a project progress rollup (beta).**
  Define a project once in `~/.agents/projects/<name>.yaml` (name, home-relative
  root/defaultPath, multiple repos with monorepo subpaths, described `contexts[]`
  starting points, external `integrations[]`, Linear link) and `agents run --project
  <name>` resolves the definition before the old `<root>/<slug>` convention — undefined
  slugs behave exactly as before. The headline is `agents projects status`: instead of a
  per-agent activity line, it renders one card per project — live agents by state, plan
  completion, open **and** recently-merged PRs, tickets in flight, and the artifacts
  agents produced — by rolling up signals already on disk (live agents matched to a project
  by this machine's session cwd; the merged-PR count is repo-global via `gh`). `--window
  <days>` and `--no-remote`
  tune the PR/artifact lookup. Also `list` / `add` (infers root + origin slug) / `show` /
  `edit` / `import --from-factory` (absorbs the Factory `projects.json` registry) / `rm`.
  Enable with `agents beta enable projects`. Source: `apps/cli/src/lib/projects.ts`,
  `apps/cli/src/lib/project-status.ts`, `apps/cli/src/commands/projects.ts`,
  `apps/cli/src/lib/project-root.ts`.
