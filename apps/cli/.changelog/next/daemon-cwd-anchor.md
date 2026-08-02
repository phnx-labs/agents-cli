- **The routines daemon now anchors its working directory to `$HOME` on startup,
  so a deleted launch directory no longer crashes every scheduled routine.** The
  daemon is long-lived and inherited whatever cwd it was launched from — commonly a
  git worktree under `.agents/worktrees/`. When that directory was later removed
  (`git worktree remove`, `rm -rf`), the daemon kept the deleted inode as its cwd
  (a process cannot chdir out of a deleted directory on its own), and every job it
  spawned inherited the dead cwd — `spawnJobAttempt` and command runs pass no
  explicit `cwd`. Bun then failed `getcwd()` at startup and *every* routine died at
  0 seconds with `ENOENT: Bun could not find a file` (or `The current working
  directory was deleted`) before the agent ran — a fleet-wide routine outage from a
  single removed worktree. `runDaemon` now re-anchors to the home directory once at
  startup (`anchorDaemonCwd`), making the scheduler immune regardless of how it was
  launched. Source: `apps/cli/src/lib/daemon.ts` (`anchorDaemonCwd`, `runDaemon`).
