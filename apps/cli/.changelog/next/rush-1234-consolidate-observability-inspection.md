- **Consolidate the observability + inspection commands into one role each; remove
  `check` and `resources` (RUSH-1234).** Two overlapping command clusters had grown
  ambiguous. `agents check` (the CI drift gate) is folded into `agents doctor --check`
  — same drift engine, now with a scriptable exit code (`--check --quiet`,
  `--check --json`, `--check --devices` all carry over byte-for-byte); the standalone
  `check` command is removed. `agents resources` (the merged first-wins cross-layer
  resource table) is folded into `agents view --merged`; the standalone `resources`
  command is removed. The observability surfaces (`events`, `feed`, `activity`,
  `output`, `sessions`) now have a documented one-role-each taxonomy — `events` is the
  raw unified audit stream, `feed` the cross-agent decisions/status inbox, `activity`
  the human milestone timeline, `output` productivity accounting, `sessions` the live
  roster + transcripts. Running the removed `agents check` / `agents resources` now
  yields an unknown-command "did you mean" suggestion. Source:
  `apps/cli/src/commands/doctor.ts`, `apps/cli/src/commands/view.ts`,
  `apps/cli/src/lib/merged-resources.ts`, `apps/cli/src/lib/startup/command-registry.ts`,
  `apps/cli/docs/06-observability.md`.
