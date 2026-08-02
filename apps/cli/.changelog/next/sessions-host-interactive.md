- **`agents sessions --host`/`--device <box>` now opens the interactive fleet
  browser instead of a raw text dump.** A bare remote listing on a TTY folds the
  named box into the same preview-rich, selectable picker as the local view (it
  previously short-circuited to the legacy per-host stream — non-interactive, no
  previews). A `--host` *query*, a render/filter flag, `--json`, or a
  non-interactive caller keep the streamed output. Source:
  `apps/cli/src/commands/sessions.ts`.
