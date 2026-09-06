---
kind: report
title: "Arc native profiles: implementation checklist"
summary: "PHNX-2399 delivery tasks; the plan is complete only as a proposal."
project: agents-cli
repository: phnx-labs/agents-cli
branch: plan/arc-native-profiles
harness: Codex
agent: Codex
human: ""
host: ""
session: ""
date: "2026-09-05"
---

# Arc native profiles: task checklist

Tracking: [PHNX-2399](https://linear.app/getrush/issue/PHNX-2399). [Review plan](arc-native-profiles-proposal.html).

## Planning delivery

- [x] Fetch current main and trace the listing → resolver → browser service → tab action → cleanup path.
- [x] Recover earlier evidence and qualify the fresh native trial, including its selection failure.
- [x] Draft the proposed commands, architecture, failure states, credential-preservation rules and delta contract.
- [x] Reconcile independent planning review.
- [x] Render and visually inspect the plan and overview in light/dark and desktop/mobile.
- [x] Open one plan tab on the user's machine; verify the exact URL, title and native window capture.

Planning artifact review/merge is tracked by [PR #3478](https://github.com/phnx-labs/agents-cli/pull/3478); its live state is authoritative. Runtime delivery is separate and remains unchecked below.

## Implementation: not yet delivered

- [ ] **P1 — de-risk native selection.** Add bounded probe/test coverage beside `cli/src/lib/browser/drivers/arc.ts`; verify exact tab return/marker handling, concurrent human navigation and cleanup. Prove no automation-induced app/window/Space/tab/focus change throughout the action, including while the human uses another app. Temporary switches followed by restoration fail acceptance. Leave browsing readiness unavailable if this cannot be proven. No debug-port relaunch or native data copy.
- [ ] **P2 — discover real profiles and Spaces.** Extend `cli/src/lib/browser/{profiles,registry,resolve-target,types}.ts`, `cli/src/lib/types.ts`; add `arc-discovery.ts` and adjacent `testdata/`. Read-only listing, schema validation, internal-profile exclusion, duplicate-name handling, stable IDs, no implicit YAML writes.
- [ ] **P3 — implement the native adapter.** Add `cli/src/lib/browser/drivers/arc.ts`; extend the existing connection/operation boundary in `service.ts` and `types.ts`. Bounded Apple Events over stdin, exact target identity, explicit core capability results. Reuse common DOM/ref behavior where possible; no full CDP emulation.
- [ ] **P4 — integrate ownership and recovery.** Update `service.ts`, `task-index.ts`, `hygiene.ts` and adjacent tests. Host/app serialization, per-task native references, durable creation intent, idempotent cleanup, moved-tab release, no kill of an externally owned Arc process.
- [ ] **P5 — expose discovery and selection.** Update `cli/src/commands/browser.ts`, `profiles.ts` and help/docs. `profiles list/show/use/doctor`, `start --space`, readiness/ambiguity/permission errors, machine-readable results, alias removal that cannot delete native data.
- [ ] **P6 — preserve remote routing.** Update `cli/src/lib/browser/{resolve-target,ipc,task-index}.ts` and existing CLI dispatch seams. Discovery/control on owner host, no invented CDP tunnel, consent and caller identity preserved, owner-unavailable behavior.
- [ ] **P7 — verify real flows.** Adjacent tests plus real-Arc integration on a test Mac: two different native profiles on the same origin; shared-profile Spaces; logged-in page continuity; input/change behavior; permission denial; reassign/rename/delete; crash/timeout; user selection during actions; worker-to-owner lifecycle.
- [ ] **P8 — land and ship.** `cli/docs/browser.md`, help, changelog, affected checks through `cli/scripts/test.sh`; side-by-side `cli/scripts/install.sh`; non-author review; green PR; canonical `cli/scripts/release.sh`; registry-installed `agents` native-flow demonstration. Only then close PHNX-2399.

## Dependency order

P1 → P2/P3 → P4 → P5/P6 → P7 → P8. P2 discovery may be independently useful, but its release does not complete native browsing. Each implementation task inherits the plan's no-profile-copy and no-selection-disruption requirements.

## Addendum — same-task page reopen (PHNX-2399), implemented + verified ahead of the native driver

Implemented and test-verified as a self-contained CDP-side change, independent of
P1–P8 (native Arc) above, in its own PR. **Implementation-review snapshot,
September 6:** release and installed verification remain outstanding; PR #3483
tracks later delivery. The `[x]` marks below mean implemented and verified by the
tests named, not shipped:

- [x] **Same-task reopen.** `agents browser navigate` / `tab add` reopening a URL
  already live in one of the task's OWN tabs now issues a real `Page.reload` on
  that same tab, retains its tab id + CDP target, marks it current **without
  foreground activation** (background-only — see below), persists, and returns
  `refreshed: true` with the note `Tab already open—refreshed`. Borrowed
  Arc/user tabs are excluded; a stale target or a failed reload never reports a
  phantom refresh.
- [x] **Serialized ownership + persistence.** Per-task reopen/create and per-caller
  first-use creation are serialized; canonical `tasks.json` writes are serialized
  per runtime key (atomic temp-then-rename) so concurrent tasks never corrupt it.
- [x] **Explicit named-start retry.** `start --task <name>` on an existing name
  reuses that task (same id, reload, note) when profile, endpoint, and caller
  match, and refuses a conflicting profile/endpoint/caller instead of acquiring
  another caller's task. Concurrent same-name starts create one task.
- [x] **IPC/CLI result plumbing.** `created`/`refreshed`/`message` over IPC;
  `--json` on `navigate`/`tab add`/`start`; `tabs` marks the current tab; the
  first implicit open reports its actual created/reclaimed result without a second
  execution. A named retry without a URL reuses the task without a page refresh;
  a different-URL retry reports navigation, not refresh.
- [x] **Real-Chromium proof.** Direct-service and real-socket-IPC tests against a
  real headless Chromium (`service.reopen.live.test.ts`,
  `service.reopen.ipc.live.test.ts`) with `testdata/reopen-counter.html`.
  The targeted run passed 142 tests across five files, including existing
  service/IPC/type regressions; TypeScript and test commands both exited zero.

**Background-only (owner requirement).** The reopen marks the tab current purely
as internal task state and issues no `Target.activateTarget` / window-raise /
Space-switch. Transient selection or focus switches are forbidden for automatic
task work, and restoring afterward does **not** qualify — a background reload that
never touches the foreground is the only accepted behavior. Explicit owner
requests to show/focus a page remain separate opt-in actions.
