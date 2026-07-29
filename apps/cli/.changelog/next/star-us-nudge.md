- **One-time "star us on GitHub" nudge after your first successful run.** After a
  user's first successful `agents run` or `agents teams`, agents-cli prints a
  single plain inline line pointing at the repo. Shown at most once ever (claimed
  with an atomic O_EXCL sentinel so concurrent `agents teams` processes can't
  double-print), and skipped for non-TTY, CI, `--json`/`--quiet`, or
  `AGENTS_NO_NUDGE=1`. The `agents teams` call site only nudges on a clean drain
  (no failed teammates). Source: `apps/cli/src/lib/star-nudge.ts`,
  `apps/cli/src/commands/exec.ts`, `apps/cli/src/commands/teams.ts`,
  `apps/cli/src/lib/teams/supervisor.ts`.
