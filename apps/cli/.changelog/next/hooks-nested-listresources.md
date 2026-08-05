### Fixed

- **`agents sync` re-copies nested system hooks after content changes.**
  `listResources('hooks')` treated event-group directories (`pre-tool-use/`) as
  resource names, so `system:*` pattern expansion never included nested scripts
  like `git-guard.sh`. Force sync then left stale flat copies in version homes
  forever. Hooks discovery now expands one-level group dirs the same way as
  `getAvailableResources` / `listHookEntriesFromDir`. Source:
  `apps/cli/src/lib/resources.ts`.
