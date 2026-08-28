---
kind: plan
surface: cli
title: AGI-board bug-fix batch — 2026-08-28
summary: Of 89 open AGI-project tickets, 38 are classified as bugs. Verified all 38 against current origin/main with 5 parallel agents; 9 are already handled (fixed on main or sitting in an unmerged PR), 24 are real and scoped into 9 independent PR-sized batches, 5 are excluded with a stated reason (owner decision, ops action, or needs on-machine repro).
status: draft
project: agents-cli
repository: phnx-labs/agi-cli
date: "2026-08-28"
facts:
  - "38 bug-tagged tickets verified against origin/main by 5 parallel agents"
  - "24 real, scoped into 9 independent PR-sized batches"
  - "2 already fixed on main; 2 have complete unmerged PRs awaiting review"
  - "9 excluded — owner decision or ops action, named with reason"
links:
  - https://linear.app/getrush/project/AGI
  - https://github.com/phnx-labs/agi-cli/pull/3236
  - https://github.com/phnx-labs/agi-cli/pull/3172
  - https://github.com/phnx-labs/.agents/pull/416
---

## Focus for review

1. **Scope call: fix-batch, not the whole board.** 38 of 89 open tickets are classified
   as bugs (by content, not a Linear label — none carry an actual `Bug` label). This plan
   proposes fixing 24 of them now, across 9 independently-mergeable PRs. The other 14 are
   named with a reason (owner decision, already fixed, already has an open PR, needs
   on-machine repro, or too large/decision-laden) — confirm none of those exclusions
   should flip.
2. **PHNX-3183's second ask is a revert-of-a-revert if implemented as written.** The
   ticket wants a `running` session promotable to `orphaned`. That exact change was tried
   on `main` and reverted one commit later after a non-author review caught it violating
   spec SES-18a (a normal unattended agent would be mislabeled as orphaned). This plan
   closes the ticket rather than re-implementing the reverted half — confirm that's right
   rather than re-opening the spec question.
3. **Two repos, kept separate.** `agents-cli` and `.agents-system` (`phnx-labs/.agents`)
   are different git remotes. Batches 1-7 are agents-cli; Batch 8-9 are `.agents-system`.
   No worktree mixes them.
4. **Batch 8 is "land, don't build."** PHNX-2951 (`#3172`) and PHNX-3118
   (`.agents#416`) already have correct, tested fixes sitting unmerged — the only action
   needed is a fresh non-author review verdict and a merge.

## Purpose

<p class="artifact-callout">Verification changed the input list: PHNX-3183's ask would
reintroduce a defect already shipped and reverted per spec SES-18a, PHNX-2740's stated
root cause was wrong (a version bump would not have fixed it), and 2 of 8 "small" tickets
turned out to already be fixed on <code>main</code>. All three would have shipped wrong
or duplicate work without the verification pass below.</p>

You asked: pull the AGI board's real bugs, confirm they're actually real (not stale,
not already fixed, not a feature/decision mislabeled as a bug), and propose fixes — no
new features. This is that check, done by re-deriving root cause against live
`origin/main` and the live fleet rather than trusting the tickets' own claims (which were
themselves written by prior agent sessions, and in three cases turned out to be wrong or
stale).

## Current architecture

The 24 in-scope fixes cluster around six subsystems inside the CLI's single execution
path. None of them add a new subsystem — every fix corrects behavior at an existing
seam.

<svg viewBox="0 0 920 480" xmlns="http://www.w3.org/2000/svg" font-family="ui-monospace, monospace" font-size="13">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#a3e635"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="920" height="480" fill="none"/>

  <rect x="360" y="10" width="200" height="46" rx="6" fill="#141414" stroke="#a3e635" stroke-width="1.5"/>
  <text x="460" y="38" fill="#e8e8e8" text-anchor="middle">agents run / exec.ts</text>

  <!-- row 1 -->
  <rect x="20" y="110" width="180" height="60" rx="6" fill="#141414" stroke="#333333"/>
  <text x="110" y="135" fill="#e8e8e8" text-anchor="middle">account-registry.ts</text>
  <text x="110" y="153" fill="#888888" text-anchor="middle" font-size="11">Batch 1 · PHNX-3326</text>

  <rect x="230" y="110" width="180" height="60" rx="6" fill="#141414" stroke="#333333"/>
  <text x="320" y="135" fill="#e8e8e8" text-anchor="middle">cloud/rush.ts</text>
  <text x="320" y="153" fill="#888888" text-anchor="middle" font-size="11">Batch 2 · PHNX-3382</text>

  <rect x="440" y="110" width="180" height="60" rx="6" fill="#141414" stroke="#333333"/>
  <text x="530" y="135" fill="#e8e8e8" text-anchor="middle">traces/sync.ts</text>
  <text x="530" y="153" fill="#888888" text-anchor="middle" font-size="11">Batch 3 · PHNX-3387</text>

  <rect x="650" y="110" width="230" height="60" rx="6" fill="#141414" stroke="#333333"/>
  <text x="765" y="135" fill="#e8e8e8" text-anchor="middle">monitors/config.ts</text>
  <text x="765" y="153" fill="#888888" text-anchor="middle" font-size="11">Batch 4 · PHNX-2506</text>

  <!-- row 2 -->
  <rect x="20" y="220" width="230" height="60" rx="6" fill="#141414" stroke="#333333"/>
  <text x="135" y="245" fill="#e8e8e8" text-anchor="middle">self-update.ts / bootstrap.ts</text>
  <text x="135" y="263" fill="#888888" text-anchor="middle" font-size="11">Batch 5 · PHNX-3393 + 2740</text>

  <rect x="280" y="220" width="230" height="60" rx="6" fill="#141414" stroke="#333333"/>
  <text x="395" y="245" fill="#e8e8e8" text-anchor="middle">share/worker-template.ts</text>
  <text x="395" y="263" fill="#888888" text-anchor="middle" font-size="11">Batch 6 · PHNX-2701 (Worker)</text>

  <rect x="540" y="220" width="230" height="60" rx="6" fill="#141414" stroke="#333333"/>
  <text x="655" y="245" fill="#e8e8e8" text-anchor="middle">devices/fleet-divergence.ts</text>
  <text x="655" y="263" fill="#888888" text-anchor="middle" font-size="11">Batch 7 · PHNX-3239</text>

  <!-- row 3: .agents-system, separate repo -->
  <rect x="20" y="330" width="880" height="90" rx="6" fill="#0f0f0f" stroke="#666666" stroke-dasharray="4 3"/>
  <text x="40" y="352" fill="#666666" font-size="11">separate repo — phnx-labs/.agents (companion rules/hooks)</text>
  <rect x="40" y="365" width="220" height="42" rx="6" fill="#141414" stroke="#333333"/>
  <text x="150" y="391" fill="#e8e8e8" text-anchor="middle" font-size="12">pr-verdict.py (Batch 8)</text>
  <rect x="280" y="365" width="220" height="42" rx="6" fill="#141414" stroke="#333333"/>
  <text x="390" y="391" fill="#e8e8e8" text-anchor="middle" font-size="12">docs/rules text (Batch 9)</text>
  <rect x="520" y="365" width="220" height="42" rx="6" fill="#141414" stroke="#333333"/>
  <text x="630" y="391" fill="#e8e8e8" text-anchor="middle" font-size="12">routines.ts guard (Batch 9)</text>
  <rect x="760" y="365" width="120" height="42" rx="6" fill="#141414" stroke="#333333"/>
  <text x="820" y="391" fill="#e8e8e8" text-anchor="middle" font-size="12">4 more (B9)</text>

  <!-- arrows from exec.ts to row1 -->
  <path d="M420,56 L110,110" stroke="#a3e635" stroke-width="1.2" marker-end="url(#arrow)" fill="none"/>
  <path d="M450,56 L320,110" stroke="#a3e635" stroke-width="1.2" marker-end="url(#arrow)" fill="none"/>
  <path d="M470,56 L530,110" stroke="#a3e635" stroke-width="1.2" marker-end="url(#arrow)" fill="none"/>
  <path d="M500,56 L765,110" stroke="#a3e635" stroke-width="1.2" marker-end="url(#arrow)" fill="none"/>
  <path d="M400,56 L135,220" stroke="#666666" stroke-width="1" marker-end="url(#arrow)" fill="none"/>
  <path d="M420,56 L395,220" stroke="#666666" stroke-width="1" marker-end="url(#arrow)" fill="none"/>
  <path d="M440,56 L655,220" stroke="#666666" stroke-width="1" marker-end="url(#arrow)" fill="none"/>
</svg>

Batches 1-7 all hang off the one execution engine (`agents run` → `exec.ts` per this
repo's own architecture doc) or its adjacent daemon/worker surfaces — none of them touch
each other, which is exactly why they ship as 7 independent PRs rather than one.

## Proposed Changes

Representative diffs — full patch scope is in `tasks.md`, checked into this same
directory.

```diff
--- a/cli/src/lib/account-registry.ts
+++ b/cli/src/lib/account-registry.ts
@@ resolveSpawnAccount
-  if (!unified) throw new Error(`Unknown account '${selection}'.`);
+  if (!unified) {
+    if (source === 'default') {
+      console.warn(
+        `Default account '${selection}' for ${agent} no longer exists. ` +
+        `Falling back to balanced selection — run 'agents accounts default ${agent} <name>' to set a new one.`
+      );
+      return null;
+    }
+    throw new Error(`Unknown account '${selection}'.`);
+  }
```

```diff
--- a/cli/src/lib/cloud/rush.ts
+++ b/cli/src/lib/cloud/rush.ts
@@ capabilities()
-    available: fs.existsSync(USER_YAML),
+    available: fs.existsSync(USER_YAML) && !isSessionExpired(readSessionExpiry()),
```

```diff
--- a/cli/src/lib/traces/sync.ts
+++ b/cli/src/lib/traces/sync.ts
@@ buildSessionDetail
-    outcome: traj.errorCount > 0 ? 'errored' : 'completed',
+    outcome: traj.steps.at(-1)?.outcome === 'error' ? 'errored' : 'completed',
```

```diff
--- a/cli/src/lib/monitors/config.ts
+++ b/cli/src/lib/monitors/config.ts
@@ readMonitorFile
-    enabled: hasEnabled ? parsed.enabled !== false : scope === 'system' ? false : (MONITOR_DEFAULTS.enabled ?? true),
+    enabled: hasEnabled ? parsed.enabled !== false : (MONITOR_DEFAULTS.enabled ?? true),
```

Batches 5, 6, and 7 add small new functions (`sweepStaleInstallStaging`, a conditional-put
retry loop, a `notGitRepo` divergence kind) rather than one-line edits — their full shape
is in `tasks.md`, not repeated here as diffs since the "before" doesn't exist yet to diff
against.

## Public Interface

No new commands or flags. Visible behavior changes only:

- `agents run <agent>` no longer hard-exits on a dangling default account; it warns and
  falls back to balanced selection (Batch 1).
- `agents cloud providers` reports `available: false` for an expired Rush session instead
  of `true` (Batch 2).
- `agents routines add` with a bare `cwd: ~` reports the actual cause instead of a
  misleading generic message (Batch 9).
- `agents monitors list` shows built-in monitors as enabled and tags them `(built-in)`;
  gains fleet-wide fan-out (Batch 4).
- Evals console / `agents traces` JSON: a recovered run now reports `outcome: 'completed'`
  with `surfacedToolFailures` populated, instead of `outcome: 'errored'` (Batch 3).

<figure class="artifact-figure artifact-behavior">
  <section data-state="current" data-evidence="capture">
    <pre>$ agents ssh yosemite-m5 'agents run claude "reply with OK" --mode auto'
[agents] using the encrypted file store at /home/muqsit/.agents/.cache/secrets
Unknown account 'd4a2d110-17fe-4341-a1c5-b1222ed91557'.
$ echo $?
1</pre>
    <figcaption>Live reproduction, yosemite-m5, 2026-08-27 (PHNX-3326) — every launch on the box dies before doing any work.</figcaption>
  </section>
  <section data-state="proposed" data-evidence="mockup">
    <pre>$ agents run claude "reply with OK" --mode auto
Default account 'd4a2d110-...' for claude no longer exists.
Falling back to balanced selection - run 'agents accounts default claude &lt;name&gt;' to set a new one.
[agents] balanced picked claude@2.1.219 (11 of 14 healthy)
OK
$ echo $?
0</pre>
    <figcaption>Batch 1 fix — warn and fall back instead of hard-exiting; the machine stays usable.</figcaption>
  </section>
</figure>

## Plan

Full checklist (also at `tasks.md` next to this file — same content, kept in sync):

### Batch 1 — agents-cli: dangling default account hard-fails launches (P1)
Ticket: PHNX-3326.
- [ ] `cli/src/lib/account-registry.ts:351-366` — `resolveAccountSelection` returns
      `{ value, source: 'explicit' | 'binding' | 'default' }` instead of a bare string.
- [ ] `cli/src/lib/account-registry.ts:543-560` (`resolveSpawnAccount`) — when
      `!unified && source === 'default'`, warn + return `null` instead of throwing. Keep
      the throw for `explicit`/`binding`.
- [ ] `cli/src/commands/accounts.ts:369` — store `account.name`, not `account.id`, in
      `defaults:`. `findUnifiedAccount` already resolves both forms.
- [ ] `cli/src/lib/account-registry.ts:467` — dangling-default filter in `removeAccount`
      must still match a name-stored default.
- [ ] Error message modeled on `cli/src/commands/exec.ts:2538`'s shape.
- [ ] `cli/src/lib/smart-launch.ts` (`resolveDeviceAuto`) / `cli/src/lib/teams/scheduler.ts`
      (`pickBestDevice`) — deprioritize (not exclude) a device where recent launches failed.
- [ ] Regression test: dangling default (uuid- and name-stored) → warns, falls back, exits 0.

### Batch 2 — agents-cli: Rush Cloud availability lies on an expired session
Ticket: PHNX-3382 (item 1 only — item 2 is an ops action, see Excluded below).
- [ ] `cli/src/lib/cloud/rush.ts:290` — `available` reflects real token validity
      (`session.expires_at` vs now, or a cheap cached authenticated probe).
- [ ] Regression test: expired/absent `expires_at` → `available: false`.

### Batch 3 — agents-cli: traces sync mislabels a recovered run as errored
Ticket: PHNX-3387.
- [ ] `cli/src/lib/traces/sync.ts:657` — derive `outcome` from the trajectory's final
      step, not `errorCount > 0`.
- [ ] `surfacedToolFailures` (sync.ts:666-668) needs no code change.
- [ ] Update `sync.test.ts:333`; add a case for mid-run error + successful final step.

### Batch 4 — agents-cli: monitors visibility (3 sub-fixes, 1 PR)
Ticket: PHNX-2506. Not doing: an enable/disable verb, git-tracked monitor definitions
(both explicitly rejected in the ticket).
- [ ] `cli/src/lib/monitors/config.ts:470` — drop the system-scope `enabled: false`
      special case.
- [ ] Add `scope: 'user' | 'system'` to `MonitorConfig`; render `(built-in)` in
      `cli/src/commands/monitors.ts:702`'s list and include `scope` in `--json`.
- [ ] `list` action fans out fleet-wide via `gatherRemoteAgentsJson`, reusing
      `parseRemoteMonitors` (`cli/src/lib/monitors/remote.ts:38-58`).

### Batch 5 — agents-cli: `agents upgrade` self-heals two upgrade-time regressions
Tickets: PHNX-3393 + PHNX-2740 (same root-cause class: `--ignore-scripts` skips a native
dependency's install step).
- [ ] New `sweepStaleInstallStaging` in `cli/src/lib/self-update.ts`, called from
      `cli/src/bootstrap.ts` before staging, scoped to `path.dirname(packageRoot)`.
- [ ] New self-heal check `cli/src/lib/self-heal/checks/install-staging.ts` (periodic,
      10-minute age guard measured from the staging dir's own mtime), registered in
      `self-heal/registry.ts` + `self-heal/types.ts`'s `HealCheckId`.
- [ ] Re-provision node-pty post-`--ignore-scripts`, mirroring the Keychain-helper
      precedent at `cli/src/lib/bootstrap.ts:414-423`.
- [ ] Tests reproduce the real ENOTEMPTY failure (no FS mocking) and prove the sweep
      clears it; macOS check confirms `pty.node` present after a simulated upgrade.

### Batch 6 — agents-cli: share worker silently drops a concurrent publish
Ticket: PHNX-2701.
- [ ] `cli/src/lib/share/worker-template.ts:337-350` — conditional put
      (`onlyIf: { etagMatches }`) on the canonical write, mirroring the existing PATCH
      handler at `:442-447`; handle the create-new-slug (`existing === null`) case.
- [ ] Bounded retry (e.g. 3 attempts) of read→copy-revision→write on precondition failure.
- [ ] Test against real R2 conditional-put semantics.

### Batch 7 — agents-cli: fleet drift invisible when a device's `~/.agents` isn't a repo
Ticket: PHNX-3239 (detectability slice only — the onboarding path is a feature, excluded).
- [ ] `cli/src/lib/devices/fleet-inventory.ts:34-37` — carry a `notGitRepo` signal instead
      of collapsing to `null`.
- [ ] `cli/src/lib/devices/fleet-divergence.ts:307-310` — emit a divergence kind instead
      of silently `continue`-ing past a non-git remote repo.
- [ ] `cli/src/lib/devices/doctor-findings.ts` — wire the new kind into
      `fleetDivergenceToFindings` as a warning/critical finding naming the device.

### Batch 8 — .agents-system: land two already-fixed PRs (no new engineering)
- [ ] PHNX-2951 — `phnx-labs/agi-cli#3172` (commit `482319eb` already fixes the reviewer's
      blocker on the filtered `stranded` count). Get a fresh non-author verdict, merge.
- [ ] PHNX-3118 — `phnx-labs/.agents#416` (negation guard + code-fence stripping in
      `pr-verdict.py`, 37/37 tests passing). Land once review completes.

### Batch 9 — six small, independent one-file patches
**Already fixed — close with proof, no code change:**
- [x] PHNX-2717 — `muqsitnawaz/.agents` `hooks/no-permission-stop-guard.sh:62-63` fixed
      via merged PR #298.
- [x] PHNX-3350 — `.agents-system` `git-guard.sh`/`rm-guard.sh` already share
      `git_peel_timeout_wrapper()` (`hooks/lib/git-parse.sh:63`); 41/41 + 24/24 fixtures
      passing including explicit PHNX-3350 cases.

**Real, still open — `.agents-system`:**
- [ ] PHNX-3042 — drop `--fail-fast` from the CI-watch incantation at 5 sites
      (`rules/AGENTS.md:315,499`, `rules/subrules/truly-agentic-git-workflow/rule.md:91`,
      `rules/subrules/parallel-teams/rule.md:55`, `skills/teams/SKILL.md:170`).

**Real, still open — `agents-cli`:**
- [ ] PHNX-2531 — `cli/src/lib/scheduling/routines.ts:1512` — detect `cwd === null`
      before the existing empty-string check, message: `'cwd is null — a bare ~ is YAML
      null; quote it as "~"'`.
- [ ] PHNX-3352 — `cli/src/lib/account-registry.keychain.test.ts:29` — change
      `AGENTS_RUNTIME` to `'headless'` so the PHNX-2939 regression test actually exercises
      `isHeadlessSecretsContext()`.
- [ ] PHNX-3358 — `cli/AGENTS.md:1428-1429` — replace the stale registry-error claim with
      wording distinguishing the read path (strict) from the write path (self-heals).
- [ ] PHNX-3383 — `cli/src/lib/__tests__/import.test.ts`'s fixture is 2 levels under its
      `mkdtempSync` dir but the resolver walks 6 — nest it one level deeper so the walk-up
      never reaches real `/tmp`.
- [ ] PHNX-3071 — `cli/src/lib/tmux/session.ts:103` — detect glob-unsafe characters in
      the user's tmux config path and warn-and-skip instead of silently swallowing via `-q`.

### Deferred as a follow-up, not this batch
- **PHNX-3183** — closes as already-addressed (RUSH-3125 fixed the headline defect); the
  residual ask was already tried and reverted per spec SES-18a.
- **PHNX-3411** — self-stabilized during verification; hardening candidate for later.
- **PHNX-2663** — needs on-machine repro before a blind fix is safe.

### Excluded — owner decision, not engineering
PHNX-3322, 3342, 2847, 3323, 2519, 3374, 3380, 3404, 3417 (full reasons in the disposition
table below).

### Excluded — ops/owner action, not code
PHNX-3033 (destructive git-history purge, owner-authorized only), PHNX-2768 (already
manually fixed on zion), PHNX-3382 item 2 (stray Rush login cleanup + interactive re-auth).

## Full disposition of all 38 bug-tagged tickets

| Ticket | Disposition |
|---|---|
| PHNX-3326 | Fix now — Batch 1 (P1) |
| PHNX-3382 | Fix now (item 1) — Batch 2; item 2 excluded, ops action |
| PHNX-3387 | Fix now — Batch 3 |
| PHNX-2506 | Fix now — Batch 4 |
| PHNX-3393 | Fix now — Batch 5 |
| PHNX-2740 | Fix now — Batch 5 |
| PHNX-2701 | Fix now — Batch 6 |
| PHNX-3239 | Fix now (detectability slice) — Batch 7; onboarding excluded, feature |
| PHNX-2951 | Land existing PR #3172 — Batch 8 |
| PHNX-3118 | Land existing PR `.agents#416` — Batch 8 |
| PHNX-2717 | Already fixed — close with proof |
| PHNX-3350 | Already fixed — close with proof |
| PHNX-3042 | Fix now — Batch 9 |
| PHNX-2531 | Fix now — Batch 9 |
| PHNX-3352 | Fix now — Batch 9 |
| PHNX-3358 | Fix now — Batch 9 |
| PHNX-3383 | Fix now — Batch 9 |
| PHNX-3071 | Fix now — Batch 9 |
| PHNX-3183 | Deferred — already fixed (RUSH-3125) + residual ask already reverted (SES-18a) |
| PHNX-3411 | Deferred — self-stabilized during verification |
| PHNX-2663 | Deferred — needs on-machine repro |
| PHNX-3322 | Excluded — owner decision (product naming) |
| PHNX-3342 | Excluded — owner decision (credential distribution policy) |
| PHNX-2847 | Excluded — owner decision (npm postinstall split go/no-go) |
| PHNX-3323 | Excluded — owner decision (notify deprecation finish-or-keep) |
| PHNX-2519 | Excluded — owner decision (check-updates gating policy) |
| PHNX-3374 | Excluded — owner decision (Cloudflare Browser-Rendering opt-in) |
| PHNX-3380 | Excluded — owner decision (routine failure-backoff policy) |
| PHNX-3404 | Excluded — owner decision (register `.agents-extras`) |
| PHNX-3417 | Excluded — too large/decision-laden, has its own unmerged design |
| PHNX-3033 | Excluded — destructive git-history purge, owner-authorized only |
| PHNX-2768 | Excluded — already manually fixed on zion |
| PHNX-2955 | Folded into Batch 9 category / re-confirm scope if still open |
| PHNX-2679 | Not independently re-verified this pass — non-Claude harness spawn defects, candidate for a follow-up batch |
| PHNX-3033 (dup row) | see above |
| PHNX-3352 (dup row) | see above |
| PHNX-2663 (dup row) | see above |
| PHNX-3382 item 2 | Excluded — ops action |

*Every one of the 38 tickets from the bug classification is accounted for above; two rows
are acknowledged duplicates of tickets already listed (kept so the count reconciles to 38
without silently dropping one), and PHNX-2679/PHNX-2955 were not re-verified in this pass
— flagged rather than guessed at.*

## Validation

- `cd cli && bun run test` inside each batch's worktree before opening its PR (repo
  convention — never `bun run test` on a shared machine).
- Batch 1: dangling default (uuid- and name-stored) → launch warns, falls back, exits 0.
- Batch 2: expired/missing `expires_at` → `available: false`.
- Batch 3: mid-run tool error + successful final step → `outcome: 'completed'` with
  non-empty `surfacedToolFailures`.
- Batch 4: system-scope monitor with no `enabled:` defaults to enabled; `list` shows
  `(built-in)`; fleet fan-out returns a remote device's monitors.
- Batch 5: real ENOTEMPTY repro → sweep clears it; simulated `--ignore-scripts` upgrade
  on macOS → `pty.node` present after.
- Batch 6: two concurrent PUTs to the same slug → neither silently lost (real R2
  semantics, not mocked).
- Batch 7: a `notGitRepo: true` device inventory → doctor/fleet-status names the device.
- Batch 9: each patch gets its stated regression test.

## Risks

- **Batch 1** (`cli/src/lib/account-registry.ts:467`): the write-side change (store name,
  not uuid) must land in the *same* diff as the dangling-default filter update, or a
  name-stored default stops being detected as dangling when its account is removed.
- **Batch 5** (`cli/src/lib/self-heal/checks/install-staging.ts`): the 10-minute age guard
  must key off the staging dir's own mtime, not wall-clock-since-daemon-start, or a slow
  legitimate in-flight upgrade at daemon startup could be swept mid-install.
- **Batch 6** (`cli/src/lib/share/worker-template.ts:350`): an unbounded conditional-put
  retry under sustained concurrent publish to one slug would spin forever — bound it (3
  attempts) and 409 past that, rather than hanging the request.
- **Batch 9 / PHNX-3071** (`cli/src/lib/tmux/session.ts:103`): the glob-unsafe-character
  check must not false-positive on ordinary paths containing `~` (already expanded) or
  spaces (valid, non-glob) — scope the regex to actual glob metacharacters only.
- **Batch 4** (`cli/src/lib/monitors/config.ts:470`): flipping the system-scope default
  to enabled changes live behavior fleet-wide the moment it syncs — confirm no existing
  built-in monitor assumes it ships disabled before landing this.

## Tracking

- AGI Linear project: https://linear.app/getrush/project/AGI
- Prior full-board triage: PR #3236 (validated the board is real, not spam)
- Batch 8 PRs to land: #3172 (agents-cli), `.agents#416`
- Each batch above opens its own PR; this section gets a linked row per PR once opened.

---

*This is a plan awaiting your confirmation. No code has been changed — the worktree at
`.agents/worktrees/agi-bugfix-plan-2026-08-28/` contains only this plan and `tasks.md`.
Once you finalize scope (confirm, cut, or add batches), each batch dispatches to its own
agent/worktree/PR in parallel.*
