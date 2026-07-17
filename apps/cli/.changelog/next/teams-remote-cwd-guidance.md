- **`teams add --remote-cwd` now fails loud instead of silently doing nothing.** The
  flag rides the shared `--host` option family but `teams add` treats
  `--host`/`--device` as placement and never reads it, so passing it used to be a
  silent no-op that misled you into thinking it set the teammate's repo path. It is
  now rejected with guidance (place with `--device`, set the code with the team's
  `--repo`, one team per repo). The shared `--remote-cwd` help also warns that a
  local `~` expands on your machine, not the remote host — pass a single-quoted
  `'$HOME/…'` path or a valid remote absolute path. Teams docs + skill lead with
  this. Source: `apps/cli/src/commands/teams.ts` (`remoteCwdOnAddError`),
  `apps/cli/src/lib/hosts/option.ts`, `apps/cli/docs/teams.md`, `skills/teams/SKILL.md`.
