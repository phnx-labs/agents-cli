- **`agents apply --provision-secrets` pushes the manifest's declared secrets
  bundles to each device, instead of only printing a reminder (RUSH-1968).** This
  gap is a direct cause of the ticket: an operator who needed secrets on a worker
  box had no supported path — `apply` said "recreate manually" and nothing else —
  so they hand-exported the file store's master key across the fleet. The
  provisioning primitive now exists, and `apply` runs it as a fifth reconcile
  phase, last, because it is the most sensitive mutation `apply` performs.

  It is **off by default** and is a **flag, not a manifest field**: `agents.yaml`
  is shared, so a file-level default would mean someone else's `apply -y` silently
  ships credential values. Three gates, and every refusal still prints a
  `needs-secret` reminder so a skipped device is never silent — the flag must be
  set, the device must be reachable, and its host key must be **pinned** (the same
  bar `agents exec --copy-creds` sets, EXEC-34).

  **Backend follows the platform: `file` on Linux, `keychain` on macOS/Windows.**
  That is the load-bearing default — a headless Linux box has no keychain and its
  file store auto-provisions its OWN machine-local key, so each device gets an
  unshared at-rest key and **no passphrase is forwarded**. That is the direct
  alternative to the fleet-wide shared secret this ticket is about.

  With provisioning on, `apply` runs one extra `agents secrets list --json` per
  device (metadata only — names and timestamps, never values) and skips a bundle
  the device already has; without that, every run re-resolves the bundle locally
  and a resolve can prompt for Touch ID, so a converged fleet would nag on every
  apply. It compares presence, not content — `--force` re-pushes regardless. The
  `--plan` matrix gains a `secrets` column, shown only when the manifest declares
  bundles, and names the flag when the capability is available but off. Source:
  `apps/cli/src/lib/secrets/push.ts` (extracted from the `export --host` action so
  a lib no longer needs a command module), `apps/cli/src/lib/fleet/apply.ts`,
  `apps/cli/src/commands/apply.ts`.
