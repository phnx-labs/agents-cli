- **Background processes no longer storm macOS Touch ID sheets (secrets-touchid-storm).**
  Raw keychain item reads — a profile's provider token on `agents run <profile>`,
  the Claude OAuth read behind `agents view`, any `getKeychainToken` caller — now
  fail fast with an actionable error naming the item when the process is
  non-interactive (an agent runtime, or a TTY-less background spawn like the
  Factory extension host's `agents view` poll), instead of raising a sheet nobody
  is watching. A cancelled or failed interactive read opens a 5-minute back-off
  memo (`~/.agents/.cache/keychain-read-backoff/`) so a polling caller can't
  re-prompt every few seconds; any successful read or write clears it. Reads that
  are prompt-free by construction (bundle metadata, `never`-policy bundles, the
  unlock session store, the OAuth token cache) attest their no-ACL write and are
  unaffected. crabbox's tailscale key is now read at most once per process
  instead of on every `crabboxEnv` call (list/wait/spawn/stop). Source:
  `apps/cli/src/lib/secrets/index.ts`, `apps/cli/src/lib/secrets/headless.ts`,
  `apps/cli/src/lib/secrets/read-backoff.ts`,
  `apps/cli/src/lib/secrets/bundles.ts`, `apps/cli/src/lib/crabbox/cli.ts`,
  `apps/cli/docs/specifications.md` (SEC-13, SEC-27).
