- **`agents secrets push`/`pull` and `agents sync --secrets` read `AGENTS_SYNC_PASSPHRASE`
  now; `AGENTS_SECRETS_PASSPHRASE` is the file store's master key and nothing else
  (RUSH-1968).** One variable meant two different secrets: the local file store's master
  key, and the passphrase that seals a bundle for transport. The store stopped needing a
  passphrase once it auto-provisioned a machine-local key, but headless `push`/`pull`
  still hard-failed without one — so the only way to get unattended sync on a worker box
  was to export the **master key** fleet-wide, handing every same-user process the key to
  the whole store. Splitting them means a box that only needs headless sync sets
  `AGENTS_SYNC_PASSPHRASE` and never has the master key in its environment. The old name
  still works for sync as a deprecated fallback — warned exactly once per process, so a
  `push --all` over many bundles does not flood stderr — so scripted CI and release
  automation keep working across the upgrade. The headless error now names the new
  variable (`A sync passphrase is required. Run from a TTY, or set
  AGENTS_SYNC_PASSPHRASE.`), and `agents sync`'s skip reason with it. Resolution moved to
  one chokepoint so the once-per-process promise holds rather than being per-call-site. Also
  corrects `SEC-29a`, which claimed the variable applied "exclusively" to the file and
  age-vault backends: the age-vault backend never reads it (it is gated by `agents
  login`), and sync plus the portable `--to-file` envelope were two more consumers — the
  new `SEC-29b` states the split as a normative invariant. Source:
  `apps/cli/src/lib/secrets/sync-passphrase.ts`, `apps/cli/src/commands/secrets-sync.ts`,
  `apps/cli/src/commands/sync.ts`, `apps/cli/src/lib/sync-umbrella.ts`.
