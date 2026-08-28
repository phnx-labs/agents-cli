# Tasks — AGI bug-fix batch (2026-08-28)

Ordered by severity/blast-radius. Each batch is one PR in one worktree. `agents-cli` and
`.agents-system` batches never share a worktree (separate remotes).

Status of the last verification slice (8 small `.agents-system`/`agents-cli` tickets:
PHNX-2717, 3350, 3042, 2531, 3352, 3358, 3383, 3071) is still coming back from the 5th
background agent — filled in once it lands, before this plan is presented as final.

## Batch 1 — agents-cli: dangling default account hard-fails launches (P1)
Ticket: PHNX-3326. Repo: agents-cli.
- [ ] `cli/src/lib/account-registry.ts:351-366` — `resolveAccountSelection` returns
      `{ value, source: 'explicit' | 'binding' | 'default' }` instead of a bare string.
- [ ] `cli/src/lib/account-registry.ts:543-560` (`resolveSpawnAccount`) — when
      `!unified && source === 'default'`, warn + return `null` (falls through to balanced
      selection) instead of throwing. Keep the throw for `explicit`/`binding`.
- [ ] `cli/src/commands/accounts.ts:369` — store `account.name`, not `account.id`, when
      writing `defaults:`. `findUnifiedAccount` already resolves both forms so this is
      read-compatible.
- [ ] `cli/src/lib/account-registry.ts:467` — dangling-default filter in `removeAccount`
      must still match a name-stored default (compare via `findUnifiedAccount(ref, meta)?.id`).
- [ ] Error message: model on `cli/src/commands/exec.ts:2538`'s shape — name the harness,
      the cause, and the remedy (`agents accounts default <agent> <name>`).
- [ ] `cli/src/lib/smart-launch.ts` (`resolveDeviceAuto`) / `cli/src/lib/teams/scheduler.ts`
      (`pickBestDevice`) — add a recent-launch-failure signal to device placement so
      `--device auto` deprioritizes (does not fully exclude, per ticket) a device where
      every recent launch failed.
- [ ] Regression test: dangling default present (id-based AND name-based), launch warns
      and falls back to balanced selection instead of exiting 1.

## Batch 2 — agents-cli: Rush Cloud availability lies on an expired session
Ticket: PHNX-3382 (item 1 only — item 2, the stray `test@example.com` login on
yosemite-s0, and the interactive `rush login` re-auth, are owner/ops actions, not code).
- [ ] `cli/src/lib/cloud/rush.ts:290` (`capabilities()`) — `available` must reflect real
      token validity (compare parsed `session.expires_at` against now, or a cheap
      authenticated probe cached per-process), not bare `fs.existsSync(USER_YAML)`.
- [ ] Regression test: an expired/absent-`expires_at` session reports `available: false`.

## Batch 3 — agents-cli: traces sync mislabels a recovered run as errored
Ticket: PHNX-3387.
- [ ] `cli/src/lib/traces/sync.ts:657` — derive `outcome` from the trajectory's final step
      (`traj.steps.at(-1)?.outcome === 'error' ? 'errored' : 'completed'`), not
      `errorCount > 0`.
- [ ] `surfacedToolFailures` (sync.ts:666-668) needs no code change — already derived from
      per-step outcome independent of run-level `outcome`.
- [ ] Update `cli/src/lib/traces/sync.test.ts:333`'s existing assertion; add a new case
      covering a mid-run tool error followed by a successful final step
      (`outcome: 'completed'` with non-empty `surfacedToolFailures`).

## Batch 4 — agents-cli: monitors visibility (3 sub-fixes, 1 PR)
Ticket: PHNX-2506. Explicitly NOT doing: an enable/disable verb, git-tracking monitor
definitions (both rejected in the ticket itself).
- [ ] `cli/src/lib/monitors/config.ts:470` — drop the `scope === 'system' ? false : ...`
      special case; system-scope built-ins default enabled the same as user monitors.
- [ ] Add `scope: 'user' | 'system'` to `MonitorConfig`/`readMonitorFile`/`listMonitors()`
      (currently computed and discarded); render `(built-in)` next to system-scope monitors
      in `cli/src/commands/monitors.ts:702`'s text list and include `scope` in the
      `--json` payload (`monitors.ts:657-685`).
- [ ] `cli/src/commands/monitors.ts` `list` action — fan out fleet-wide via
      `gatherRemoteAgentsJson` (reuse `parseRemoteMonitors` from
      `cli/src/lib/monitors/remote.ts:38-58`, the same helper the `add` duplicate-guard
      already uses), so `list` shows every monitor fleet-wide tagged with its owning box.

## Batch 5 — agents-cli: `agents upgrade` self-heals two upgrade-time regressions
Tickets: PHNX-3393 (ENOTEMPTY dead-end) + PHNX-2740 (node-pty missing post-upgrade —
same root cause class: `--ignore-scripts` skips a native dependency's install step).
- [ ] New `sweepStaleInstallStaging` in `cli/src/lib/self-update.ts`, called from
      `cli/src/bootstrap.ts` before `installPackageIntoPrefix`/`installPackageWithBun`
      (self-update.ts:369, :390). Scope: `path.dirname(packageRoot)` (from
      `resolveRunningPackageRoot`, self-update.ts:305) — covers npm POSIX/Windows and bun
      layouts in one sweep.
- [ ] New self-heal check `cli/src/lib/self-heal/checks/install-staging.ts` (periodic
      cadence, 10-minute age guard so it never deletes a live in-flight reify), registered
      in `cli/src/lib/self-heal/registry.ts`'s `HEAL_CHECKS` + `HealCheckId` union in
      `cli/src/lib/self-heal/types.ts`.
- [ ] After the `--ignore-scripts` install in `self-update.ts`, add a node-pty
      re-provision step mirroring the existing Keychain-helper precedent at
      `cli/src/lib/bootstrap.ts:414-423` — re-run node-pty's own install/prebuild-install
      step (or equivalent) so the darwin binary is fetched post-upgrade on macOS.
- [ ] Tests reproduce the real ENOTEMPTY rename failure (no FS mocking, per repo
      convention) and prove the sweep clears it; a macOS-only test (or documented manual
      check on mac-mini) confirms `pty.node` exists after a simulated `--ignore-scripts`
      upgrade.

## Batch 6 — agents-cli: share worker silently drops a concurrent publish
Ticket: PHNX-2701.
- [ ] `cli/src/lib/share/worker-template.ts:337-350` (PUT handler) — read `existing`'s
      etag, `put` the canonical key with `onlyIf: { etagMatches: existing.etag }` (mirror
      the PATCH handler's existing pattern at `:442-447`), handle the create-new-slug case
      (`existing` is `null`).
- [ ] On a `null` return (precondition failed), retry the whole read→copy-revision→write
      cycle a bounded number of times rather than failing the request.
- [ ] Test against Cloudflare's real R2 conditional-put semantics (`onlyIf.etagMatches`,
      confirmed current at developers.cloudflare.com/r2/api/workers/workers-api-reference)
      — no mocking the Worker's R2 binding beyond what the existing test harness already
      does for the PATCH path.

## Batch 7 — agents-cli: fleet drift invisible when a device's `~/.agents` isn't a repo
Ticket: PHNX-3239 (detectability slice only — the full onboarding/provisioning path is a
feature, out of scope for this bug-fix batch).
- [ ] `cli/src/lib/devices/fleet-inventory.ts:34-37` (`toRepoState`) — don't collapse a
      non-git `~/.agents` to a bare `null`; carry a `notGitRepo: boolean` (or a new
      `RepoState` variant).
- [ ] `cli/src/lib/devices/fleet-divergence.ts:307-310` — when a remote device's repo
      state signals `notGitRepo`, emit a new divergence kind instead of `continue`-ing
      past it silently.
- [ ] `cli/src/lib/devices/doctor-findings.ts` — wire the new divergence kind into
      `fleetDivergenceToFindings` as a `warning`/`critical` finding ("`<device>` `.agents`
      is not a git repo — resources will not propagate").

## Batch 8 — .agents-system: land two already-fixed PRs (no new engineering)
- [ ] PHNX-2951 — PR `phnx-labs/agi-cli#3172` already contains the correct fix (commit
      `482319eb` addresses the reviewer's blocker on the filtered `stranded` count). Get a
      fresh non-author review verdict confirming the blocker is cleared, then rebase-merge.
- [ ] PHNX-3118 — PR `phnx-labs/.agents#416` already contains the correct fix (negation
      guard + code-fence stripping in `pr-verdict.py`, 37/37 tests passing). Land it once
      its review completes (already requested from bisma-nawazz per the ticket).

## Batch 9 — six small, independent one-file patches (bundle into one low-risk PR each repo)

**Already fixed — close the ticket, no code change needed:**
- [x] PHNX-2717 — `~/.agents` (muqsitnawaz/.agents, a THIRD repo, separate from
      `.agents-system`) `hooks/no-permission-stop-guard.sh:62-63` already resets
      `last=''` on every assistant record via merged PR #298. Linear still says "Todo" —
      close it with that proof.
- [x] PHNX-3350 — `git-guard.sh`/`rm-guard.sh` already source a shared
      `git_peel_timeout_wrapper()` (`hooks/lib/git-parse.sh:63`) in `.agents-system`,
      landed across 4 commit-pairs, full fixture suites passing (41/41, 24/24) including
      explicit PHNX-3350 timeout/gtimeout fixtures. Close it. (Optional separate small
      ticket: an advisory nudge when the `timeout` binary is missing on macOS — an
      enhancement, not this bug.)

**Real, still-open, each a small patch — repo: `.agents-system`:**
- [ ] PHNX-3042 — drop `--fail-fast` from the prescribed CI-watch incantation at
      `rules/AGENTS.md:315`, `rules/AGENTS.md:499`,
      `rules/subrules/truly-agentic-git-workflow/rule.md:91`,
      `rules/subrules/parallel-teams/rule.md:55`, `skills/teams/SKILL.md:170` (5 sites;
      leave the rejected-pattern test fixture at
      `hooks/stop/tests/00-agent-verify-work-complete_test.sh:116` alone — it's testing
      detection of the old pattern, not prescribing it).

**Real, still-open, each a small patch — repo: `agents-cli`:**
- [ ] PHNX-2531 — `cli/src/lib/scheduling/routines.ts:1512` (`cwd` guard) — add a
      `config.cwd === null` branch before the existing check:
      `'cwd is null — a bare ~ is YAML null; quote it as "~"'`. Optionally mirror for
      `project` at line 1509.
- [ ] PHNX-3352 — `cli/src/lib/account-registry.keychain.test.ts:29` — change
      `AGENTS_RUNTIME` from `'test-headless-account-launch'` to `'headless'` so the test
      actually exercises `isHeadlessSecretsContext()` (`cli/src/lib/secrets/headless.ts:35`)
      and would fail if the PHNX-2939 fix were reverted.
- [ ] PHNX-3358 — `cli/AGENTS.md:1428-1429` — replace the stale "fails loud and never
      becomes an empty successful read" line with wording distinguishing the read path
      (`ChildProcess.swift:575`, strict) from the write path (`:580`, self-heals a corrupt
      registry to empty before persisting).
- [ ] PHNX-3383 — `cli/src/lib/__tests__/import.test.ts`'s `resolvePackageDirFromBinary`
      fixture (`bareDir`) is only 2 levels under its `mkdtempSync` dir, but the resolver
      walks up 6 levels — reaching real `/tmp` and returning it on a polluted box instead
      of `null`. Nest the fixture one level deeper so the walk-up never reaches
      `os.tmpdir()` within 6 hops.
- [ ] PHNX-3071 — `cli/src/lib/tmux/session.ts:103` — before emitting
      `` source-file -q ${tmuxConfigArgument(userConfig)} ``, detect glob-unsafe
      characters in `userConfig` (`/[\\*?[\]]/`) and warn-and-skip instead of silently
      swallowing the failure via `-q`. Add a test — none currently exists for this path.

## Deferred as a follow-up, not a fix in this batch
- **PHNX-3183** (orphan detection) — closes as already-addressed (RUSH-3125 fixed the
  headline defect); the "promote a running session to orphaned" ask was already tried and
  reverted per spec SES-18a. Re-scope any residual work as a future ticket, not this batch.
- **PHNX-3411** (zion daemon SIGKILL loop) — self-stabilized during verification; the
  underlying tolerance gap (daemon singleton logic reacting to a pure node-path change for
  the same version+entrypoint) is real but low urgency now. Small hardening candidate for
  a later pass, not blocking.
- **PHNX-2663** (browser daemon socket timeout / CDP on a live instance) — needs on-machine
  repro on zion under controlled conditions; not scoped tightly enough yet for a blind fix.

## Explicitly excluded — owner decision, not engineering
PHNX-3322 (product naming), PHNX-3342 (credential distribution policy), PHNX-2847 (npm
postinstall split go/no-go), PHNX-3323 (notify deprecation finish-or-keep), PHNX-2519
(check-updates gating policy), PHNX-3374 (Cloudflare Browser-Rendering opt-in), PHNX-3380
(routine failure-backoff policy), PHNX-3404 (register `.agents-extras`), PHNX-3417
(routines fleet-wide-claim design — has its own unmerged design doc, too large/decision-
laden for a bugfix batch).

## Explicitly excluded — ops/owner action, not code
PHNX-3033 (destructive git-history purge, owner-authorized only — already remediated on
the live/public surface), PHNX-2768 (already manually fixed on zion), PHNX-3382 item 2
(stray Rush login logout + interactive re-login on yosemite-s0/s1).
