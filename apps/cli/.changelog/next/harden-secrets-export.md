- **`agents secrets export`/`list`/`view` now accept `--device`/`--devices` as
  aliases for `--host`/`--hosts`, and a keychain-backed `export --host` push is
  verified.** `--device mac-mini` used to fail with "unknown option" on the secrets
  commands even though the rest of the fleet vocabulary (`agents activity`,
  `agents run --device`) accepts it; it now resolves identically to `--host`. And a
  default keychain-backend push to a macOS host over headless SSH — the sign host a
  Linux-driven release offloads `apple.com` provisioning to — used to land the bundle
  metadata but no readable secret items (the remote login keychain is locked over
  SSH), then fail every later read with the confusing `Bundle 'X' key 'Y': stored
  item '...' not found`. The push now reads the bundle back the way a headless release
  will and **fails loudly** when the keys didn't persist, naming the locked-login-keychain
  cause and steering to `--remote-backend file` (headless-readable) or unlocking the
  remote keychain. This unblocks headless Linux-driven releases. Source:
  `apps/cli/src/commands/secrets.ts`, `apps/cli/src/lib/secrets/remote.ts`.
