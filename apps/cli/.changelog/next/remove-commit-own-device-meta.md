- **Removed the dead `commitOwnDeviceMeta` auto-commit from the pull path.** It
  committed this machine's `devices/<host>/agents.yaml` pin snapshot to the user
  repo's `main` on nearly every `pullRepo`, without pushing — so `main` diverged
  N-ahead per machine and wedged `agents sync` across the fleet. Now that
  per-device pins are gitignored (they are local runtime state — written by
  `writeMetaUnlocked`, read on-disk by pinned-strategy resolution and the shim),
  the function only ever no-ops, so it and its sole `pullRepo` call are deleted
  along with their tests. `--strategy balanced` never read pins; the only behavior
  removed is the never-reached auto-commit. Source: `apps/cli/src/lib/git.ts`
  (`pullRepo`), `apps/cli/src/lib/git.test.ts`.
