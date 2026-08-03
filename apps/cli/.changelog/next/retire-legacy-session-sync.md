- **Removed `agents drive` and the R2/CRDT background session-sync beta.** Both
  predate `agents sessions export`/`import`, which now cover the same ground
  without a daemon: `agents drive` (rsync-based session/config mirroring) and
  the opt-in `session-sync` beta (`agents sessions sync`, the daemon's ~90s R2
  push/pull loop, `agents sync --sessions`) are gone. If you had `session-sync`
  or `drive` enabled, re-enable is no longer possible — use `--host` for live
  cross-machine reads or `agents sessions export --encrypt` /
  `agents sessions import` for portable, encrypted transcript bundles instead.
  The R2 client and credential resolution (`r2.backups` bundle,
  `R2_SYNC_ENC_KEY`) are kept and still power export/import encryption — only
  the background sync and its CRDT merge machinery are removed. Source:
  `apps/cli/src/commands/drive.ts`, `apps/cli/src/commands/sessions-sync.ts`,
  `apps/cli/src/lib/session/sync/crdt.ts`, `apps/cli/src/lib/session/sync/sync.ts`,
  `apps/cli/src/lib/daemon.ts`.
