- **The daemon's `MenubarHelper --notify` one-shots can no longer pile up in the
  menu bar.** Each routine notification (start/finish/overdue/heal) spawned a
  fresh, detached, unsupervised `MenubarHelper --notify` process; on a stalled
  delivery — a locked screen or a WindowServer/XPC hiccup — the helper's runloop
  spin never reached its deadline and the process hung indefinitely, so duplicate
  "Agents" instances accumulated. The one-shot is now bounded by two independent
  watchdogs: `runOneShot` arms a background-thread force-exit at 3s (off the main
  queue, so a wedged main thread can't starve it — unlike the 0.6s runloop
  deadline it backs up), and the Node spawner (`spawnDetachedQuiet`) SIGKILLs the
  child at 4s if it never self-exits. A notifier that posts normally (the common
  sub-second path) is untouched; only a genuinely hung one is killed. Source:
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift` (`Notifier.runOneShot`),
  `apps/cli/src/lib/menubar/notify-desktop.ts` (`spawnDetachedQuiet`,
  `NOTIFY_TIMEOUT_MS`).
