- **`agents secrets export --host --remote-backend file` no longer requires
  `AGENTS_SECRETS_PASSPHRASE`.** Since the file store became passphrase-free
  (auto-provisioning a 0600 machine-local key under `~/.agents/.secrets-key/`), the
  remote `import --backend file` reads headlessly under that key with no passphrase
  and no Touch ID — but the export path still hard-failed unless a passphrase was
  set, and forcing one made the remote bundle require that shared passphrase to
  read, defeating the headless use it was for. The passphrase is now **optional**:
  with none set, the remote command carries no `AGENTS_SECRETS_PASSPHRASE`
  read/export prologue and the .env is the only stdin, so the remote keys the bundle
  under its own machine-local key (headless reads); set `AGENTS_SECRETS_PASSPHRASE`
  locally only to opt into a shared off-disk key, which is still forwarded over ssh
  stdin (never argv). This unblocks hands-off Linux-driven releases that provision
  `apple.com` on a headless macOS sign host. Windows targets are still refused
  cleanly. Source: `apps/cli/src/lib/secrets/remote.ts`,
  `apps/cli/src/commands/secrets.ts`.
