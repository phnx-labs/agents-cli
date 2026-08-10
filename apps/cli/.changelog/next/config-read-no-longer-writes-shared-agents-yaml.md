- **A config read no longer rewrites the fleet-shared `agents.yaml`.** The legacy
  device-config fold hung off `getConfigValue` / `setConfigValue` /
  `unsetConfigValue`, so an ordinary `agents config get` could rewrite
  `~/.agents/agents.yaml` — a file every machine in the fleet tracks and syncs.
  With 13 machines each dirtying one shared path on nearly every command, boxes
  stopped being able to pull at all (`yosemite-s0` sat 4 commits behind, unable to
  fast-forward past its own local rewrite). The fold now runs only from a
  lifecycle entry point (daemon boot, `runMigration`), never from a read or write.
  Source: `apps/cli/src/lib/device-config.ts`.
- **The device-config migration is additive instead of destructive.** It used to
  `fs.rmSync` the per-device `devices/<host>/agents.yaml` and `fs.rmdirSync` its
  directory after folding. Deleting the source mid-rollout meant a box still on the
  previous CLI lost the config it was still reading, and a box that re-created the
  doc got stripped again on its next command. The fold now leaves every legacy
  store in place; the redundant copy is pruned later by one explicit operator
  command rather than by each machine independently.
  Source: `apps/cli/src/lib/devices/config-migration.ts`.
- **`agents devices capture` no longer erases a peer's config.** `captureFleet`
  rebuilt `fleet.devices` from the captured roster alone, so a device the capturing
  box had not seen was dropped along with its `config:` block — observed for real,
  a capture on `yosemite-s0` deleted `zion`'s entire config from the shared file. A
  dropped device now carries its `config:` forward; the roster fields still reflect
  live state.
  Source: `apps/cli/src/lib/fleet/capture.ts`.
- **Clearing the last model-tier override no longer leaves `model: {tiers: {}}`.**
  The emptied container was written back to the shared `agents.yaml`, showing up as
  a spurious local change on whichever box ran the command. It now drops the key,
  matching how an emptied `hosts:` is already handled.
  Source: `apps/cli/src/lib/model-tier-overrides.ts`.
