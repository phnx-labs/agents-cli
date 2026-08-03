- **New `agents secrets rotate-passphrase` re-keys the encrypted file store under
  a new master passphrase, atomically (RUSH-1975).** Until now there was no
  supported way to rotate the file-store passphrase — `rekey` only renames macOS
  keychain service names and `rotate <bundle> <key>` replaces a single secret
  value, so a leaked passphrase (RUSH-1968) could only be remediated by a
  hand-rolled non-atomic script or an export-to-plaintext round-trip (the exact
  exposure being fixed). The new command decrypts every `<item>.enc` under the
  current key, re-encrypts under a freshly generated one, and swaps both the
  ciphertext and the 0600 key file by directory rename after verifying every item
  round-trips. A crash at any point self-heals on the next *rotate* run to a single
  readable store — content-aware recovery probes which key actually decrypts the
  live store (not merely which files are present) and classifies the WHOLE store:
  it completes the rotation forward or rolls back only when one key opens every
  item, and if a later `secrets set` contaminated a crashed rotation into a MIXED
  store (items under two keys at once, or a store dir recreated by an interstitial
  write after the crash left it absent, so its backup holds items the live dir does
  not) it refuses with an actionable error and preserves every recovery artifact
  rather than sweeping the only copy of a key or the backed-up ciphertext — so a
  crash anywhere in the swap can never orphan the store, even when a write landed in
  between. The rotation and every store write run under
  one cross-process lock, so a `secrets set` or a second rotation can never
  interleave with a swap in the first place. No plaintext secret or passphrase is
  ever written to disk, argv, or a log. Items
  that don't decrypt under the current key (orphan caches, stale test artifacts)
  are carried through verbatim, never re-keyed. Dry-run by default (`--commit` to
  apply). A dry run never re-keys, but it *does* heal an interrupted rotation —
  that is how a crashed store becomes readable again without re-keying it — and it
  says so instead of claiming nothing was written. Refuses while the secrets-agent
  holds live unlocks or while
  `AGENTS_SECRETS_PASSPHRASE` is exported in the environment, unless `--force`.
  Headless-safe and Linux-first. Source: `apps/cli/src/lib/secrets/filestore.ts`,
  `apps/cli/src/commands/secrets-rotate-passphrase.ts`.
