- **Let a bundle whose passphrase is lost be deleted, so the name can be recovered.**
  A file-backed bundle that no longer decrypts bricked its own name: `view`, `add`,
  `delete`, and both `import --from icloud` and `import --from 1password` all called
  `readBundle()` first, so none of them could touch it — including the two commands that
  exist to restore it from a valid iCloud Keychain or 1Password copy. `delete` now uses
  the new `readBundleIfDecryptable()` and proceeds without the plaintext, reporting that
  the bundle's keychain items cannot be enumerated for purging instead of claiming a
  clean purge. The `view` hint no longer points at `import --from icloud` for a bundle
  that is still on disk — that command fails identically — and names the delete-then-import
  sequence that actually works. Source: `apps/cli/src/lib/secrets/bundles.ts`,
  `apps/cli/src/commands/secrets.ts`.
