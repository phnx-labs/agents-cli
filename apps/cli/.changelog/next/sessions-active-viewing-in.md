- **`agents sessions --active --json` now reports who is watching each session.**
  The `viewingIn` field carries the same string the table prints — `codium tab 3`,
  `ghostty tab 2`, or `detached` for a live tmux pane with **no client attached**
  (its terminal was closed or crashed), and `null` for a session that isn't
  tmux-hosted and so isn't on that axis at all. Previously the JSON path returned
  before the locator pass ran, so the field never appeared and a machine consumer
  could not tell a session someone is looking at from an orphaned one — which is
  exactly what the Factory extension's `Agents: Resume` picker ranks by. The JSON
  path resolves tmux clients only — no osascript — so scriptable output keeps the
  cheapness the old ordering was protecting; a Ghostty-attached client resolves as
  `ghostty` without its tab number. Peers running an older CLI that still emits the
  `{app, tab}` object are normalized at the fan-out boundary, so a mixed-version
  fleet sweep stays correct. Source: `apps/cli/src/lib/session/viewing-in.ts`
  (`viewingInLabel`, `parseViewingIn`), `apps/cli/src/commands/sessions.ts`
  (`serializeActiveSessionsForJson`, `enrichTmuxLocators`),
  `apps/cli/src/lib/session/remote-active.ts`.
