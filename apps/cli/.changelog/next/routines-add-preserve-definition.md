- **`agents routines add <file>` no longer rewrites a tracked routine definition.**
  Adding a definition that already lives in the routines dir used to run it back
  through the writer, which reformatted the file and stripped its `devices:` and
  `enabled:` keys — corrupting committed config in `~/.agents` (blocking fleet-wide
  `agents repo pull`) and silently promoting a device-pinned routine to fleet-wide,
  so a Linux box could reach a macOS-only sign/notarize phase (RUSH-2517). `add`
  now leaves an in-repo definition byte-for-byte untouched and only materializes
  its activation; an external source file is still copied in as a new definition,
  leaving the user's file alone.
- **`agents routines edit <name> --project-anchor <name>` / `--cwd <path>`** set a
  routine's execution anchor headlessly (no `$EDITOR`), the repair a `routine has
  no project or cwd` readiness block points at. The patch preserves every other
  node in the definition — it never strips `devices:`/`enabled:` or restyles
  untouched YAML. Pass an empty value to clear a field.
