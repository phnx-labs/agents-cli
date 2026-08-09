- **CLI bootstrap no longer loads `versions.ts` via the brand edge (RUSH-2331).**
  Every `agents` invocation statically imports `brand.js` for `resolveBrandName` /
  `disabledCommandsForActiveBrand`. That module used to import `agents.js` solely
  for `reservedBrandNames()` / `validateBrandName()` (mine/setup only), and
  `agents.js` pulls the full `versions.ts` graph — ~90ms of module evaluation on
  the `--version` / secrets-broker / bare-help path. `brand.ts` now reads the
  zero-dep `agent-cli-commands` leaf (pinned equal to `AGENTS[*].cliCommand` by
  test); the self-update → primitives redirect from the same ticket remains.
  Source: `apps/cli/src/lib/brand.ts`, `apps/cli/src/lib/agent-cli-commands.ts`.
