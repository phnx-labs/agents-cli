- **The keychain reaper no longer kills the auto-lock-on-sleep watcher (RUSH-2232 follow-up).**
  The reaper (shipped in 1.22.23) classified a process as a reap target purely by the
  helper binary path, which also matches the broker's deliberately long-lived
  `watch-lock` watcher — a healthy child of the live daemon that wipes the in-memory
  secret store on sleep. Its class-(b) rule ("helper child of a live parent, older than
  90s") therefore killed the watcher on its second sweep (~10 min after the daemon
  started hosting the broker), silently disabling auto-lock-on-sleep. Reap-eligibility
  now matches the full command line and excludes the `watch-lock` verb, so only the
  short-lived keychain reads/writes a wedged `coreauthd` can hang are ever reaped.
  Source: `apps/cli/src/lib/secrets/reaper.ts` (`isReapableHelperCommand`).
