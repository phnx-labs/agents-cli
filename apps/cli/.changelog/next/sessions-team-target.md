- **`agents sessions` team rows now show the team's target and teammate, not just
  the slug.** Each teammate row reads `<team> · <teammate> · by <orchestrator> ·
  <live turn | mission>`, where the mission is a one-line summary of the teammate's
  spawn prompt (`assignedTask`, shown even before it has a transcript). Several
  teams from one orchestrator stay legible (distinct team names) and each says what
  it is for. `--active --json` carries `assignedTask`. Source:
  `apps/cli/src/lib/session/active.ts`, `apps/cli/src/commands/sessions.ts`.
