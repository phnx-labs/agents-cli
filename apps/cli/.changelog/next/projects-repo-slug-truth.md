- **`agents projects` stops reading the wrong GitHub repository.** Factory derives a
  project's `owner/repo` from the checkout path's last two segments, so a repo cloned to
  `~/src/github.com/<you>/agents-cli` whose origin is `phnx-labs/agents-cli` imported as
  `<you>/agents-cli`. Both are real repositories, so nothing errored — the card's merged-PR
  and release lines simply reported a stranger's repo (0 merges in 7 days instead of 100).
  `import --from-factory` now reads the checkout's actual `origin` and only falls back to the
  path guess when there is no remote to ask, and `status`/`show` print a warning with the fix
  when a stored slug disagrees with the remote. Source: `apps/cli/src/lib/project-doctor.ts`.
- **`agents projects set <name>` changes one field without destroying the rest.** Previously
  the only ways to correct a field were `$EDITOR` on raw YAML or `add --force`, which rebuilds
  the definition from flags alone and silently drops `linear`, `contexts`, and `description`.
  `set` loads, patches the named field, and writes back. Flags: `--repo`, `--root`, `--path`,
  `--description`. Source: `apps/cli/src/commands/projects.ts`.
- **Merged-PR counts say when they are a lower bound.** The `gh` fetch caps at 100, and a busy
  repo where all 100 land inside the window has more — the count now renders `100+` rather than
  presenting the cap as a total, matching the existing Linear `2500+` contract. Source:
  `apps/cli/src/lib/project-status.ts`.
