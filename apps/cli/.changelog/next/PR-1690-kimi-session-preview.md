- **`agents sessions` now shows a Kimi session's todo list and its file-touching
  tool calls.** Kimi writes its checklist with `TodoList` (items shaped
  `{title, status}`, where finished is `done`) rather than Claude's `TodoWrite`
  (`{content, status: "completed"}`), so the checklist registry matched nothing
  and every Kimi session rendered with no todos — in the picker preview, the
  session detail, and the `--active` fan-out that carries progress off remote
  devices. Kimi also names the file argument `path` where Claude names it
  `file_path`, so `Read`/`Write`/`Edit` calls summarized as a bare `Read ` with
  no file. Both spellings are now handled, and the snapshot-checklist tool names
  live in one exported registry (`SNAPSHOT_TODO_TOOLS`) that the picker and the
  state engine share instead of each hardcoding its own pair. Source:
  `apps/cli/src/lib/session/parse.ts`, `apps/cli/src/lib/session/state.ts`,
  `apps/cli/src/commands/sessions-picker.ts`.
