- **`agents repos add` adopts an existing checkout instead of dead-ending.** When
  the target `~/.agents-<alias>/` already holds a git repo whose origin matches the
  requested source, `repos add` now registers it in place (no re-clone) rather than
  erroring `Directory already exists`. A repo with a *different* origin is left
  untouched unless you pass `--adopt`. This removes the trap that forced a second,
  inconsistent install method when a repo had been cloned by hand. Remote matching
  is transport-agnostic (SSH and HTTPS forms of the same repo compare equal). Source:
  `apps/cli/src/commands/repo.ts`, `apps/cli/src/lib/git.ts`.
