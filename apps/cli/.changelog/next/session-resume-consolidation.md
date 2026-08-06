- **Resume session identities through one live-first path across the fleet.**
  `agents sessions resume <selector>` accepts a full UUID, unique UUID prefix,
  durable tmux name (`ag-codex-c1f3d813`), or unique alias suffix (`c1f3d813`). It
  resolves the owning device, rechecks whether the process and pane are alive,
  attaches a live pane, and otherwise resumes the harness-native conversation with
  its recorded version, cwd, and mode. Retained dead tmux panes no longer count as
  attachable, and native resume no longer collides with an existing live wrapper.
  Source: `apps/cli/src/commands/focus.ts`,
  `apps/cli/src/commands/sessions-resume.ts`, `apps/cli/src/lib/exec.ts`.
