- **Hooks: one-level event dirs (`hooks/<event-name>/<script>`) are first-class.**
  System hooks organize by harness event (`session-start/`, `pre-tool-use/`, …).
  Install names stay the file basename. Dirs with top-level scripts expand into
  individual hooks; fixture-only dirs remain directory bundles. Manifest `script:`
  may be a relative path under `hooks/`. Source: `apps/cli/src/lib/hooks.ts`,
  `apps/cli/src/lib/staleness/writers/sources.ts`, `apps/cli/src/lib/versions.ts`,
  `apps/cli/src/lib/__tests__/hooks-nested-groups.test.ts`.
