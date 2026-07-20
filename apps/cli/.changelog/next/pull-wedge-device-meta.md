- **`agents repo pull` no longer wedges on per-machine pin drift.** The committed
  `devices/<machineId>/agents.yaml` (each box's agent version pins) is rewritten
  whenever a pin changes, leaving the working tree perpetually dirty — so
  `agents repo pull`, which refuses a dirty tree, kept failing until the file was
  hand-committed. `pullRepo` now durably commits **just that one path** (explicit
  pathspec) before pulling, via `commitOwnDeviceMeta`. Genuine uncommitted edits to
  any other file still (correctly) block the pull. No-op for the system/extra repos
  that don't own the path. Source: `apps/cli/src/lib/git.ts`.
