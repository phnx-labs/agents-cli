- **Stop `agents doctor` from reporting phantom drift and `agents prune` from
  deleting source-managed resources.** Three reconciler false positives are
  fixed: the instruction file (`CLAUDE.md`/`AGENTS.md`) is now compared against
  the composed active-preset output the rules writer actually emits — not the raw
  whole-repo `rules/AGENTS.md` — so a correctly-synced home no longer shows as
  permanent drift; plugin-bundled commands installed as `<plugin>-<command>`
  command-skills (e.g. `swarm-plan`, `code-review`) are no longer flagged as
  orphans/extras that `prune cleanup` would delete; and command-as-skill wrappers
  (the `agents_command` marker) are no longer miscounted as skills and surfaced as
  deletable skill orphans. Source: `apps/cli/src/lib/staleness/`,
  `apps/cli/src/lib/commands.ts`, `apps/cli/src/lib/skills.ts`.
