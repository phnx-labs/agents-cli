- **`agents.yaml` no longer silently loses top-level keys across a version-skewed
  fleet.** `serializeCentral` (`lib/state.ts`) rewrote the synced `agents.yaml`
  with a delete-any-key-not-in-the-in-memory-object pass. An **older CLI version
  whose `Meta` type predated a key** (`beta:`, `notify.owner`, `feed:`, imported
  `projects`) would parse the file, never surface that key, delete it on the next
  write, and sync the deletion to every machine — the recurring "my config
  vanished" data-loss (see the restore in commit `04295e3`). The delete pass now
  consults a `Record<keyof Meta, 'central' | 'device'>` scope map (compile-time
  exhaustive — a new `Meta` field that isn't classified fails the build) and
  deletes **only keys this version knows** (a cleared central key, or a device
  key that is legacy cruft in the synced file); a key it doesn't know is
  preserved verbatim. Once a machine runs a CLI carrying this fix, it can never
  drop a newer version's key again. Source: `apps/cli/src/lib/state.ts`,
  `apps/cli/src/lib/__tests__/state.test.ts`.
