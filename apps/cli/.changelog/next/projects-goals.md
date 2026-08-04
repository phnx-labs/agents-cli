- **`agents projects` definitions can now carry goals — the OKR-shaped "why".**
  A project serves one or more `goals[]`, each an `objective` (the outcome) plus an
  optional `measure` (the key result). Set them at scaffold time with
  `agents projects add <name> --goal "objective:measure"` (repeatable), replace them
  later with `agents projects set <name> --goal …`, or hand-edit the YAML. Goals show
  on the `status` card (compact) and in `projects view` (in full), and survive a
  `--from-linear` re-import like every other hand-set field. Milestones (pulled from
  Linear) remain the dated checkpoints toward these goals. Source:
  `apps/cli/src/lib/projects.ts`, `apps/cli/src/commands/projects.ts`.
