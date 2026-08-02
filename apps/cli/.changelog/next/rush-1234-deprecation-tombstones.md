- **Removed `agents check` / `agents resources` now forward to their replacements
  instead of erroring (RUSH-1234).** After the command consolidation, running the
  removed names produced a bare `unknown command` (their edit-distance to `doctor`
  was too far to even trigger a "did you mean"). They are now hidden tombstone
  commands that print a one-line deprecation notice to stderr and re-run the
  replacement, preserving flags and exit codes: `agents check …` runs
  `agents doctor --check …` (so `--json` / `--quiet` / `--devices` and the CI
  drift-gate exit code carry through), and `agents resources …` runs
  `agents view --merged …` (with `agents inspect <target>` pointed to for
  per-agent/per-repo detail). The notice goes to stderr so a `--json` consumer's
  stdout stays clean. Source: `apps/cli/src/index.ts`.
