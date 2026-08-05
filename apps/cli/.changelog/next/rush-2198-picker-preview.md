- **The interactive session picker's detailed preview no longer collapses to empty.**
  `agents sessions`, `agents sessions <query>`, and `agents sessions --active` open the
  picker with the rich preview pane (prompt, files, hooks, errors, tests, last response)
  on by default, but the preview had no guaranteed height: a 15-row list
  (`PICKER_RECENT_COUNT`) on a short terminal consumed the whole viewport, the computed
  `availablePreviewRows` went to zero, and the pane silently vanished — worse when
  fleet-unreachable warnings and the hidden-session footer had scrolled lines above the
  prompt. The picker now caps the visible list page so the preview keeps a floor of
  `PREVIEW_MIN_ROWS` (6) rows, and accounts for the lines printed above the prompt so
  those notices and the preview stay on screen together. Applied consistently across
  `itemPicker`, `dynamicPicker`, and `multiItemPicker`, so the bare browser, the query
  picker, and the `--active` browser all behave the same; the space/tab preview toggle
  is unchanged. Source: `apps/cli/src/lib/picker.ts`,
  `apps/cli/src/commands/sessions-picker.ts`, `apps/cli/src/commands/sessions.ts`.
