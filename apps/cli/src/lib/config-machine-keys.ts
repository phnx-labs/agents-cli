/**
 * The YAML keys of every machine-visibility config key — the ones that live in
 * the owning box's own `devices/<machine>/agents.yaml` and must never reach the
 * fleet-shared `agents.yaml`.
 *
 * This is a ZERO-DEPENDENCY leaf on purpose. The authority is `CONFIG_KEYS` in
 * `lib/device-config.ts`, but that module imports `devices/config-migration.ts`,
 * so the migration cannot import it back without a cycle. Same shape as the
 * `agent-cli-commands` leaf: duplicated here, pinned equal to the registry by a
 * test (`device-config.test.ts`), so the two cannot drift silently.
 */
export const MACHINE_LOCAL_YAML_KEYS: ReadonlySet<string> = new Set([
  'defaultBrowserProfile', // browser.profile
  'browserRemoteControl',  // browser.remote-control — a consent flag; syncing it is a leak
  'schedulerEnabled',      // scheduler.enabled
  'daemonEnabled',         // daemon.enabled
  'tmuxEnabled',           // tmux.enabled — whether an interactive run is tmux-wrapped on THIS box
]);
