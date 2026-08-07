- **`agents secrets import --force` now repairs a bundle whose metadata record is
  undecryptable (#2305).** A file store whose key was lost or rotated out from
  under it leaves bundles present but unreadable — exactly the state provisioning
  exists to fix. `agents secrets export <bundle> --host <box> --remote-backend
  file --force` drives the remote's own `import`, which died on the unreadable
  record (`Bundle 'x': failed to decrypt`) and wrote nothing, so the only route
  left was deleting the record by hand on an already-degraded store. With
  `--force`, an undecryptable record is now treated as absent and recreated.

  Still refused **without** `--force`: recreating unconditionally would destroy a
  healthy bundle for someone who merely forgot to set `AGENTS_SECRETS_PASSPHRASE`.
  Only `BundleUndecryptableError` qualifies — a locked keychain or logged-out
  vault still throws, so a recoverable state is never mistaken for a lost key.
  Source: `apps/cli/src/commands/secrets.ts` (`resolveImportBundle`).
