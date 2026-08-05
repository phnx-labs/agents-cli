- **The menu bar now notices and reports when the scheduler dies — instead of
  staying silent forever.** The only proactive "routines overdue / scheduler
  down" signal was `notifyOverdue` (`src/lib/overdue.ts`), fired from inside
  `runDaemon()` — so it could never fire while the daemon itself was down, the
  exact outage it exists to report. `MenubarHelper` is a separate launchd
  KeepAlive service that stays alive when the daemon dies, so its 10s tick now
  polls daemon liveness independently of the dropdown ever being opened; once
  it has been continuously unreachable for ~30s (debounced past a routine
  restart blip), it fires one native notification ("Scheduler stopped —
  routines won't run") through its own `NSUserNotificationCenter` delivery —
  no daemon, no CLI spawn required — and lights the always-visible menu-bar
  badge (`⏻`) until the scheduler comes back. Source:
  `apps/cli/menubar/Sources/MenubarHelper/StatusItemController.swift`.
