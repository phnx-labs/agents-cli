- **`agents run --notify` posts a desktop notification when a headless run
  finishes, and menu-bar quick dispatch now uses it.** The dispatch panel used to
  post its "finished"/"failed" notice from the MenubarHelper's own
  process-termination callback, so a helper that restarted mid-run — an upgrade
  replacing the bundle, a crash — took the callback with it while the run carried
  on reparented to launchd, and the dispatch could never report back. The run
  process owns the notice now: armed on its own `exit`, so it covers local,
  `--host` and `--lease` dispatch alike and survives anything that happens to the
  launcher. The helper's click actions also accept `url:<https…>` so a completion
  notification can open the PR or ticket the run produced. Source:
  `apps/cli/src/lib/run-notify.ts`, `apps/cli/src/commands/exec.ts`,
  `apps/cli/menubar/Sources/MenubarHelper/AgentsCLI.swift`,
  `apps/cli/menubar/Sources/MenubarHelper/PromptPanel.swift`.
