- **`agents doctor` now checks hook WIRING, not just hook files — and treats a
  stale source layer as unhealthy.** Two blind spots let a version home read
  "healthy" while its hooks were dead. (1) Doctor only compared hook FILES against
  source, never that `settings.json` actually references each hook in the right
  event array — so a hook whose script was byte-identical to source but never
  wired into `PreToolUse`/`Stop`/… reported `ok` and silently never fired
  (reproduced on `yosemite-s1`: `Claude@2.1.207` printed `hooks 32 items 32 ok`
  while its `settings.json` PreToolUse array omitted `ask-user-question-guard.sh`).
  Doctor now inspects the version's native `settings.json` (Claude-family: claude,
  droid), verifying each hook per `(event, matcher)` group, and reports a
  present-but-not-wired hook as `UNWIRED <hook> event=<event> matcher=<matcher>`,
  counted against the verdict; a missing/unparseable `settings.json` is surfaced
  too. `--fix` re-wires via the same `registerHooksToSettings` path `agents sync`
  uses. (2) A source layer behind `origin/main` means the home is reconciled
  against stale truth, yet the "N commits behind" fact was a buried preamble while
  the verdict still said healthy — it now flips the per-version verdict to unhealthy
  with the `agents repo pull` remediation. Both checks run in every mode, not just
  `agents doctor <agent>@<version>`: bare `agents doctor` (overview) and the CI gate
  `agents check` now flag a present-but-unwired hook and a behind-origin source
  layer, and `agents check` exits non-zero on them. Source:
  `apps/cli/src/lib/hooks.ts` (`checkVersionHookWiring`), `apps/cli/src/lib/drift.ts`
  (`checkSyncStatus`/`computeSourceBehind`/`computeDrift`),
  `apps/cli/src/lib/doctor-diff.ts`, `apps/cli/src/commands/doctor.ts`
  (`computeVerdict`), `apps/cli/src/commands/check.ts`, `apps/cli/src/lib/git.ts`
  (`commitsBehindUpstream`).
