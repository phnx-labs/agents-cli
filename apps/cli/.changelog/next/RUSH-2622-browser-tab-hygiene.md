- **`agents browser` stops leaving duplicate and orphan tabs behind (RUSH-2622).**
  The `about:blank` that a bare `agents browser start` opens is now registered on
  the task, so `done`/`stop` actually closes it — it never was, which made every
  bare start leak one tab permanently. `agents browser start --url` now reclaims
  a tab that an abandoned task is still holding on that exact URL instead of
  opening a duplicate; a tab held by a live task, or one you opened yourself, is
  never taken, and the new `--fresh` skips the reclaim entirely. Tasks also carry
  a `lastActionAt` stamp in `tasks.json` now. Source:
  `apps/cli/src/lib/browser/service.ts`, `apps/cli/src/lib/browser/types.ts`.
