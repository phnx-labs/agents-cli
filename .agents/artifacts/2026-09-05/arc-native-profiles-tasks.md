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
- [ ] Land the reviewed planning artifact and open it on the user's machine.

## Implementation: not yet delivered

- [ ] **P1 — de-risk native selection.** Add bounded probe/test coverage beside `cli/src/lib/browser/drivers/arc.ts`; verify exact tab return/marker handling, temporary selection changes, conditional restore, concurrent human navigation and cleanup. Prove nondisruptive browsing or leave browsing readiness unavailable. No debug-port relaunch or native data copy.
- [ ] **P2 — discover real profiles and Spaces.** Extend `cli/src/lib/browser/{profiles,registry,resolve-target,types}.ts`, `cli/src/lib/types.ts`; add `arc-discovery.ts` and adjacent `testdata/`. Read-only listing, schema validation, internal-profile exclusion, duplicate-name handling, stable IDs, no implicit YAML writes.
- [ ] **P3 — implement the native adapter.** Add `cli/src/lib/browser/drivers/arc.ts`; extend the existing connection/operation boundary in `service.ts` and `types.ts`. Bounded Apple Events over stdin, exact target identity, explicit core capability results. Reuse common DOM/ref behavior where possible; no full CDP emulation.
- [ ] **P4 — integrate ownership and recovery.** Update `service.ts`, `task-index.ts`, `hygiene.ts` and adjacent tests. Host/app serialization, per-task native references, durable creation intent, idempotent cleanup, moved-tab release, no kill of an externally owned Arc process.
- [ ] **P5 — expose discovery and selection.** Update `cli/src/commands/browser.ts`, `profiles.ts` and help/docs. `profiles list/show/use/doctor`, `start --space`, readiness/ambiguity/permission errors, machine-readable results, alias removal that cannot delete native data.
- [ ] **P6 — preserve remote routing.** Update `cli/src/lib/browser/{resolve-target,ipc,task-index}.ts` and existing CLI dispatch seams. Discovery/control on owner host, no invented CDP tunnel, consent and caller identity preserved, owner-unavailable behavior.
- [ ] **P7 — verify real flows.** Adjacent tests plus real-Arc integration on a test Mac: two different native profiles on the same origin; shared-profile Spaces; logged-in page continuity; input/change behavior; permission denial; reassign/rename/delete; crash/timeout; user selection during actions; worker-to-owner lifecycle.
- [ ] **P8 — land and ship.** `cli/docs/browser.md`, help, changelog, affected checks through `cli/scripts/test.sh`; side-by-side `cli/scripts/install.sh`; non-author review; green PR; canonical `cli/scripts/release.sh`; registry-installed `agents` native-flow demonstration. Only then close PHNX-2399.

## Dependency order

P1 → P2/P3 → P4 → P5/P6 → P7 → P8. P2 discovery may be independently useful, but its release does not complete native browsing. Each implementation task inherits the plan's no-profile-copy and no-selection-disruption requirements.
