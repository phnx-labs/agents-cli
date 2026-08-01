- **`agents repo pull` reconciles a diverged repo instead of wedging on it.** It ran
  `git merge --ff-only`, which refuses *any* divergence — conflict or not — so a
  single local commit permanently blocked every later pull with nothing actually in
  conflict. Since `pullRepo` itself auto-commits the machine's own
  `devices/<host>/agents.yaml` before pulling, every device eventually created that
  commit and stopped receiving updates: on one fleet, nine machines sat 9 commits
  behind, and merged rule changes never reached any of them. It now rebases, which is
  what its own documentation has always described. Per-device paths are disjoint, so
  they replay cleanly; a genuine conflict still fails, now naming the conflict.
- **`agents repo pull` / `push` exit non-zero when a repo fails.** Both printed a
  failure line and returned 0, so `agents fleet run "agents repo pull user"` reported
  `11 ok` across a fleet that pulled nothing. Any automation gating on the exit code
  read a total no-op as success. Matches `agents sync`, which already did this.
- **`agents cloud … --host` no longer reassigns a routine's device pin.** It set
  `devices: [<this machine>]` unconditionally, so re-registering a webhook routine
  from another box silently moved where it fires. The pin names where the routine's
  author wants it to run; it is now filled only when empty, matching the three other
  pin sites.
