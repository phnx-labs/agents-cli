- **`agents secrets unlock` now stays unlocked across an agents-cli upgrade (and,
  with `--durable`, across sleep + reboot).** The macOS secrets broker held an
  unlock only in RAM, so it evaporated every time the daemon restarted (upgrade)
  or the machine slept — forcing a Touch ID re-tap and breaking headless reads
  with "not unlocked in the secrets agent". An unlock now also persists a
  device-local, non-biometry keychain session item that the broker **rehydrates on
  start** and that reads **fall back to** silently. Split default: it survives
  upgrade/restart automatically; pass `--durable` (or set `secrets.agent.durable:
  true`) to also survive sleep/reboot — otherwise a bundle re-locks on sleep as
  before. `lock` / rotate / delete clear it. On Linux and Windows `unlock` is now a
  friendly no-op (secrets already resolve durably from the OS store with no
  prompt), so the command behaves the same on all three platforms. Source:
  `apps/cli/src/lib/secrets/session-store.ts` (new),
  `apps/cli/src/lib/secrets/agent.ts`, `apps/cli/src/lib/secrets/bundles.ts`,
  `apps/cli/src/lib/secrets/index.ts`, `apps/cli/src/commands/secrets.ts`,
  `apps/cli/src/lib/types.ts`.
