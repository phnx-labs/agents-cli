- **Per-machine config no longer lives in the fleet-shared `agents.yaml`.** Every
  device-scope config key now declares `visibility`, which asks who READS it.
  `shared` keys stay in the synced `fleet.devices.<name>.config` because a peer
  resolves them — the ssh fields and `platform` are needed to dial a box before it
  is reachable, `agents.max-concurrent` drives teams placement, `auto-launch.*`
  and `notes` feed fleet views. `machine` keys — `browser.profile`,
  `browser.remote-control`, `scheduler.enabled`, `daemon.enabled` — move to that
  box's own `~/.agents/devices/<machine>/agents.yaml`, which is gitignored. That
  is what stops 13 machines writing one tracked path.
  Source: `apps/cli/src/lib/device-config.ts`, `apps/cli/src/lib/state.ts`.
- **`browser.remote-control` was a consent leak.** It gates whether OTHER machines
  may drive this box's browser, and its own help text promised "device-local,
  never synced" — but it was stored in the file the fleet syncs, so one box's
  opt-in propagated to the rest on pull. It is now machine-local, and setting or
  reading a machine-local key for a peer is refused outright with the
  `agents ssh <device>` form to use instead.
  Source: `apps/cli/src/lib/device-config.ts`.
- **A new config key cannot silently pick the wrong home.** `ConfigKeySpec` is a
  discriminated union, so omitting `visibility` on a device-scope key is a COMPILE
  error — the same discipline `META_KEY_SCOPE` already applies to `Meta`. The
  migration no longer folds machine-local keys at all: they already sit where the
  new read path looks, and copying a peer's would spread that consent flag
  fleet-wide. Values an older CLI wrote centrally are still honored until
  overwritten, so a mixed-version fleet keeps working.
  Source: `apps/cli/src/lib/config-machine-keys.ts`,
  `apps/cli/src/lib/devices/config-migration.ts`.
