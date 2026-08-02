- **File-backed secrets bundles no longer require `AGENTS_SECRETS_PASSPHRASE` on
  macOS.** The encrypted file store now silently auto-provisions a stable
  machine-local key (a 0600 file under `~/.agents/.secrets-key/`, kept outside the
  encrypted store) on first use on **every** platform, macOS included — no prompt,
  no Touch ID, nothing to set or remember. Previously a file-backed bundle on a Mac
  hard-failed unless `AGENTS_SECRETS_PASSPHRASE` was exported, which blocked
  headless reads (e.g. the `auth` bundle the usage/auth reader consults) and
  frequently hung. Setting `AGENTS_SECRETS_PASSPHRASE` still works and takes
  precedence — use it to hold the key off disk or to share one bundle's ciphertext
  across boxes under a common key. Source: `apps/cli/src/lib/secrets/filestore.ts`,
  `apps/cli/src/lib/secrets/bundles.ts`.
