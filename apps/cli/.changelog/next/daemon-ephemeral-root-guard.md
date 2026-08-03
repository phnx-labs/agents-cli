- **The daemon warns when it was launched from an ephemeral root.** A daemon
  started from a temp dir (`/tmp`, `/var/folders`, `/dev/shm`) or a git worktree
  resolves its own job modules by dynamic `import()` rooted at the launch entry
  (`getAgentsBinPath` → `process.argv[1]`). When that directory is later removed
  — a `/tmp` cleanup, a review/verify checkout teardown, `git worktree remove` —
  the long-lived daemon keeps ENOENT-ing on every routine's imports
  (`auto-dispatch.ts`, `routines-placement.ts`, `devices/fleet.ts`), silently
  wedging until restart. `anchorDaemonCwd` already rescues the cwd, but nothing
  can re-root a deleted module tree. `runDaemon` now calls
  `warnEphemeralDaemonRoot` at startup, so the risk is logged the moment the
  daemon comes up — including a direct `agents __daemon-run` that never passes
  through the launch-time `validateDaemonBinary` check. That launch-time check is
  also broadened from git-worktree-only to any ephemeral root via the shared
  `describeEphemeralDaemonRoot` predicate. The fix for a wedged daemon is
  unchanged: run it from the globally installed binary
  (`npm i -g @phnx-labs/agents-cli`) so its entry roots at a stable version home.
  Source: `apps/cli/src/lib/daemon.ts`
  (`describeEphemeralDaemonRoot`, `warnEphemeralDaemonRoot`, `validateDaemonBinary`).
