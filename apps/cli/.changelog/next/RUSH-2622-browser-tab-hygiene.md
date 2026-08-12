- **`agents browser` stops leaving tabs behind (RUSH-2622).** Leftover tabs piled
  up in Comet/Chrome because agents open browser tasks and never call
  `done`/`stop`. Three fixes, all in the browser daemon. The `about:blank` that a
  bare `agents browser start` opens is now registered on the task, so `done`
  actually closes it — it never was, which made every bare start leak one tab
  permanently. `agents browser start --url` now takes over a live tab already
  showing that URL instead of opening a second copy; pass the new `--fresh` to
  always get your own tab. And a new reaper closes tasks whose agent session has
  exited, or that nothing has touched for 30 minutes, reusing the same `stop`
  path so history and teardown are unchanged. It only ever closes tabs the task
  itself owns, never a tab you opened and never the browser window. Tasks now
  carry a `lastActionAt` stamp in `tasks.json` for the idle window. Source:
  `apps/cli/src/lib/browser/hygiene.ts`, `apps/cli/src/lib/browser/service.ts`,
  `apps/cli/src/lib/browser/types.ts`.
