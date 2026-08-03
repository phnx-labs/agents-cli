- **Removed `agents drive` and the R2/CRDT background session-sync beta.** Both
  predate `agents sessions export`/`import`, which now cover the same ground
  without a daemon: `agents drive` (rsync-based session/config mirroring) and
  the opt-in `session-sync` beta (`agents sessions sync`, the daemon's ~90s R2
  push/pull loop, `agents sync --sessions`) are gone. If you had `session-sync`
  or `drive` enabled, re-enable is no longer possible — use `--host` for live
  cross-machine reads or `agents sessions export --encrypt` /
  `agents sessions import` for portable, encrypted transcript bundles instead.
  The R2 network client and CRDT merge machinery are removed entirely with the
  rest of the background sync. Export/import's own encrypted-bundle path
  survives unchanged: it never talked to R2 over the network — it only reuses
  the `r2.backups` bundle's shared `R2_SYNC_ENC_KEY` for local AES-256-GCM
  encryption, falling back to a printed ephemeral key when that bundle isn't
  configured. Source: `apps/cli/src/commands/drive.ts`,
  `apps/cli/src/commands/sessions-sync.ts`, `apps/cli/src/lib/session/sync/crdt.ts`,
  `apps/cli/src/lib/session/sync/sync.ts`, `apps/cli/src/lib/session/sync/r2.ts`,
  `apps/cli/src/lib/daemon.ts`.
