- **The menu-bar helper can no longer leak CLI processes until the machine is unusable.**
  Its poll shelled `agents doctor --json` through an unbounded `Process` +
  `readDataToEndOfFile()`. Two properties composed badly: the call had no deadline
  (`doctor --json` measures **136s on an idle box**, against a 60s poll interval), and a
  helper that died mid-call left the child reparented to launchd (PPID 1) with nothing
  to reap it — along with the `node -e` version probes that child had forked. Both fire
  together, because the helper crashes under exactly the conditions that make the CLI
  slow: `NSApplication.shared` segfaults inside `SLSNewConnection` when WindowServer is
  too starved to hand out a connection, launchd's `KeepAlive` restarts it, and the
  restart spawns a new doctor while the old one keeps burning a core. Observed on a real
  machine: 38 orphaned doctors + 92 orphaned probes, ~13 of 18 cores consumed, load
  average 490, keystrokes visibly lagging.
  The crash itself cannot be prevented from inside the app — it is AppKit dereferencing
  a null connection before any of our code runs — so a crash no longer costs anything
  permanent: every child carries a deadline (30s; 180s for `doctor --json`, above its
  real measured cost); it is spawned as its own process-group leader so a timeout kills
  the whole subtree rather than just the CLI; and each live child is recorded on disk so
  the *next* launch reaps whatever a crash abandoned (no exit handler runs on SIGSEGV).
  The doctor refresh also drops from every 60s to every 15 minutes, and the launchd job
  gains `ThrottleInterval` 30 so a startup crash-loop cannot respawn every 10s.
  A poll that blows its deadline now shows a stale menu instead of taking the machine
  down with it. Source: `apps/cli/menubar/Sources/MenubarHelper/ChildProcess.swift`,
  `AgentsCLI.swift`, `StatusItemController.swift`, `main.swift`,
  `apps/cli/src/lib/menubar/install-menubar.ts`.
