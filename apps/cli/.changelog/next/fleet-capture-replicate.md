- **Capture your whole fleet into `agents.yaml`, then rebuild it anywhere with
  `agents apply` (#1305).** New `agents fleet capture` (alias `agents devices
  capture`) snapshots the live environment into the portable `fleet:` block — the
  device roster (**names only**), the source's agents as `defaults`, secrets-bundle
  **names**, and routine **names**. It commits **zero** Tailscale IPs or usernames:
  `agents apply` reconstructs a fresh machine's roster by resolving each device
  name **live from Tailscale** (`ensureDevicesRegistered`), so `git clone` +
  `agents apply` replicates the fleet with nothing sensitive in the repo. `apply`
  now also passes declared `sync:` scopes through to `agents sync <scope>`
  (previously a bare `sync`) and surfaces declared secrets-bundle names to recreate
  on each device (values stay keychain-local, never pushed). Browser profiles are
  intentionally not duplicated into `fleet:` — they already sync via the central
  `browser:` block. Source: `apps/cli/src/commands/fleet-capture.ts`,
  `apps/cli/src/lib/fleet/capture.ts`, `apps/cli/src/lib/devices/sync.ts`,
  `apps/cli/src/lib/fleet/{types,manifest,apply}.ts`.
