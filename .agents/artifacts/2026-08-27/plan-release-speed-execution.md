---
kind: plan
surface: internal
title: "Release speed: cut the 6-platform matrix and the duplicate full-suite run"
summary: >
  The CLI release is slow and noisy because two heavy things run at release
  time that gate nothing: a 6-job cross-platform matrix (16-53 min, failing
  every release, non-required) and a full test suite that the producer runs
  twice per release. Move cross-platform coverage off the release path and
  release from evidence the merged tree already earned. Executes steps 3-4 of
  the Aug-15 master plan, which were never built.
status: draft
tracking: PHNX-3237
links:
  - https://linear.app/getrush/issue/PHNX-3237
  - https://linear.app/getrush/issue/PHNX-2943
---

## Focus for review

1. **Take the `ci.yml` 6-job matrix off the release path.** It is not a required
   check (`main` requires only `test` + `gitleaks`), it runs 16-53 min, and it
   has failed on every release v1.22.50-v1.22.53. Move it to nightly + manual
   dispatch so cross-platform regressions are still caught, just not at release.
2. **Release from evidence the merged tree already earned.** The producer runs
   the full suite twice per release (origin-main tree, then the release-commit
   tree that differs only by version + CHANGELOG). Run it once and *derive* the
   release-tree attestation after proving the diff is metadata-only.
3. **Fix the macOS `daemon.socketsvcs.test.ts` failure** so the relocated
   cross-platform lane is trustworthy instead of red every run.

## Purpose

Lower CLI release wall-clock and stop paying for slow, failing, non-gating work
on every release. The operator's words: *"it builds 6 different images on
different platforms, some take 6-7 min... and it executes a full test suite
which we already do in CI — it doesn't make sense to rerun them."* Both
observations are correct. This plan executes the two master-plan steps that
address them.

<div class="artifact-callout">
The 6-job matrix is <strong>not a required check</strong> and <code>release.sh</code>
never waits on it — yet it runs 16-53 min, is billed 10× on macOS, and has
<strong>failed on every recent release</strong>. It is pure cost and noise. The
merge gates on <code>test + gitleaks</code>; the publish gates on a hand-produced
attestation. Nothing about the matrix protects a release.
</div>

## What is already landed (do not redo)

The Aug-15 master plan (`plan-ci-release-near-instant.md`, RUSH-2666) laid out
the architecture. Its building blocks shipped; its two critical-path steps did
not.

| Master-plan piece | Status |
| --- | --- |
| Impact-scoped required `test` gate (`scripts/ci-scope.ts`) | Landed |
| Immutable exact-tree attestation format + store (`release-attestation.sh`) | Landed |
| Producer shards the suite across the fleet (#3123) | Landed |
| Helper apps decoupled from the tarball, own tags (RUSH-3100) | Landed |
| Promote-only, any-OS home base (RUSH-3026) | Landed |
| Windows off the required gate | Landed |
| **§3 Move full sweeps off the merge/release critical path** | **Not built** |
| **§4 Release from earned evidence; delete the duplicate full-suite run** | **Not built** |

## Evidence

Measured on this repo, 2026-08-27:

- Required checks on `main`: `["test","gitleaks"]` — the 6-job matrix is **not**
  among them (`gh api .../branches/main/protection`).
- `ci.yml` recent runs on `release/**`: **16.6, 18.4, 18.6, 20.0, 53.6, 17.2 min
  — every one `failure`** (v1.22.50 through v1.22.53).
- The failing legs are **macOS 22 and macOS 24**; ubuntu and windows pass. The
  failure is `src/lib/daemon/daemon.socketsvcs.test.ts:335`.
- `release-attestation-produce.sh` is invoked by **nothing** — not `release.sh`,
  not any workflow. It is a manual interim script (RUSH-2749). `release.sh` only
  *requires* an attestation to already exist, for **two** trees:
  `origin/main` (release.sh:1162) and the release-commit tree (release.sh:921).
- Master-plan "before" numbers: release PR **p50 12.8m / p90 73.5m**; target
  **start→npm P99 ≤ 180s**.

## Current architecture

Today the full suite and the cross-platform matrix both run at release time, and
neither is what actually gates the merge. The merge gates on the cheap impact
`test` check; the publish gates on a manually-produced attestation.

<figure class="artifact-figure">
<svg viewBox="0 0 940 430" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Current release pipeline: the matrix and the double full-suite run are off the gate but on the clock">
  <defs><marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4a5f80"/></marker></defs>

  <rect x="20" y="30" width="150" height="56" rx="8" fill="#0f1420" stroke="#2b3a55" stroke-width="1.5"/>
  <text x="34" y="52" fill="#d7e2f2" font-family="system-ui" font-size="13">trigger box</text>
  <text x="34" y="70" fill="#8aa0bd" font-family="monospace" font-size="11">release.sh (any fleet box)</text>

  <rect x="20" y="150" width="210" height="90" rx="8" fill="#241a06" stroke="#8a6b1f" stroke-width="1.5"/>
  <text x="34" y="172" fill="#d7e2f2" font-family="system-ui" font-size="13">attestation producer</text>
  <text x="34" y="190" fill="#8aa0bd" font-family="monospace" font-size="11">full suite × origin-main tree</text>
  <text x="34" y="206" fill="#8aa0bd" font-family="monospace" font-size="11">full suite × release-commit tree</text>
  <text x="34" y="224" fill="#c98a2f" font-family="monospace" font-size="11">MANUAL · runs the suite twice</text>

  <rect x="300" y="30" width="170" height="56" rx="8" fill="#0f1420" stroke="#2b3a55" stroke-width="1.5"/>
  <text x="314" y="52" fill="#d7e2f2" font-family="system-ui" font-size="13">release PR</text>
  <text x="314" y="70" fill="#8aa0bd" font-family="monospace" font-size="11">release/v&lt;x&gt; → main</text>

  <rect x="300" y="150" width="170" height="56" rx="8" fill="#132312" stroke="#3f7a34" stroke-width="1.5"/>
  <text x="314" y="172" fill="#d7e2f2" font-family="system-ui" font-size="13">required gate</text>
  <text x="314" y="190" fill="#8aa0bd" font-family="monospace" font-size="11">test (impact) + gitleaks</text>

  <rect x="300" y="270" width="330" height="90" rx="8" fill="#2a1414" stroke="#7a3434" stroke-width="1.5"/>
  <text x="314" y="292" fill="#d7e2f2" font-family="system-ui" font-size="13">ci.yml 6-job matrix (3 OS × 2 Node)</text>
  <text x="314" y="312" fill="#8aa0bd" font-family="monospace" font-size="11">16-53 min · macOS 10× / Windows 2× billed</text>
  <text x="314" y="330" fill="#c25b5b" font-family="monospace" font-size="11">NOT required · FAILING every release · gates nothing</text>
  <text x="314" y="348" fill="#8aa0bd" font-family="monospace" font-size="11">macOS red: daemon.socketsvcs.test.ts:335</text>

  <rect x="560" y="30" width="150" height="56" rx="8" fill="#0f1420" stroke="#2b3a55" stroke-width="1.5"/>
  <text x="574" y="52" fill="#d7e2f2" font-family="system-ui" font-size="13">merge + tag</text>
  <text x="574" y="70" fill="#8aa0bd" font-family="monospace" font-size="11">on required gate</text>

  <rect x="770" y="30" width="150" height="56" rx="8" fill="#132312" stroke="#3f7a34" stroke-width="1.5"/>
  <text x="784" y="52" fill="#d7e2f2" font-family="system-ui" font-size="13">home base</text>
  <text x="784" y="70" fill="#8aa0bd" font-family="monospace" font-size="11">promote tgz · npm publish</text>

  <path d="M170,58 L300,58" stroke="#4a5f80" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <path d="M470,58 L560,58" stroke="#4a5f80" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <path d="M710,58 L770,58" stroke="#4a5f80" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <path d="M120,86 L120,150" stroke="#4a5f80" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <path d="M230,193 L300,178" stroke="#4a5f80" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <path d="M385,86 L385,150" stroke="#4a5f80" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <path d="M470,300 L560,80" stroke="#4a5f80" stroke-width="1.5" fill="none" stroke-dasharray="4 4" marker-end="url(#a)"/>
  <text x="486" y="250" fill="#c9d6ea" font-family="system-ui" font-size="11">matrix result</text>
  <text x="486" y="266" fill="#c9d6ea" font-family="system-ui" font-size="11">is ignored →</text>
</svg>
<figcaption>Current: the matrix (red) and the second full-suite run (amber) are
on the clock and the bill, but the merge gates only on <code>test + gitleaks</code>
(green) and publish gates on the manual attestation. Dashed = result discarded.</figcaption>
</figure>

## Proposed architecture

Cross-platform coverage moves to a nightly + on-demand lane that never blocks a
release. The full suite runs once (on the merged/main tree, post-merge); the
release-commit attestation is *derived* after a constrained check that the diff
is only version + CHANGELOG + generated command-index.

<figure class="artifact-figure">
<svg viewBox="0 0 940 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Proposed release pipeline: one suite run, derived release-tree proof, matrix moved to nightly">
  <defs><marker id="b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4a5f80"/></marker></defs>

  <rect x="20" y="30" width="210" height="72" rx="8" fill="#132312" stroke="#3f7a34" stroke-width="1.5"/>
  <text x="34" y="54" fill="#d7e2f2" font-family="system-ui" font-size="13">post-merge on main</text>
  <text x="34" y="74" fill="#8aa0bd" font-family="monospace" font-size="11">full suite once → attest tree</text>
  <text x="34" y="90" fill="#8aa0bd" font-family="monospace" font-size="11">cached, keyed by tree sha</text>

  <rect x="300" y="30" width="200" height="72" rx="8" fill="#0f1420" stroke="#2b3a55" stroke-width="1.5"/>
  <text x="314" y="54" fill="#d7e2f2" font-family="system-ui" font-size="13">release.sh</text>
  <text x="314" y="74" fill="#8aa0bd" font-family="monospace" font-size="11">derive release-tree proof:</text>
  <text x="314" y="90" fill="#8aa0bd" font-family="monospace" font-size="11">verify diff = version+changelog</text>

  <rect x="560" y="30" width="150" height="72" rx="8" fill="#132312" stroke="#3f7a34" stroke-width="1.5"/>
  <text x="574" y="54" fill="#d7e2f2" font-family="system-ui" font-size="13">merge + tag</text>
  <text x="574" y="74" fill="#8aa0bd" font-family="monospace" font-size="11">test + gitleaks</text>

  <rect x="770" y="30" width="150" height="72" rx="8" fill="#132312" stroke="#3f7a34" stroke-width="1.5"/>
  <text x="784" y="54" fill="#d7e2f2" font-family="system-ui" font-size="13">home base</text>
  <text x="784" y="74" fill="#8aa0bd" font-family="monospace" font-size="11">promote · publish</text>

  <rect x="300" y="200" width="340" height="68" rx="8" fill="#0f1420" stroke="#2b3a55" stroke-width="1.5"/>
  <text x="314" y="224" fill="#d7e2f2" font-family="system-ui" font-size="13">ci.yml matrix → nightly + dispatch</text>
  <text x="314" y="244" fill="#8aa0bd" font-family="monospace" font-size="11">off the release path · still catches macOS/Windows</text>
  <text x="314" y="260" fill="#8aa0bd" font-family="monospace" font-size="11">no longer 10×-billed on every release</text>

  <path d="M230,66 L300,66" stroke="#4a5f80" stroke-width="1.5" fill="none" marker-end="url(#b)"/>
  <path d="M500,66 L560,66" stroke="#4a5f80" stroke-width="1.5" fill="none" marker-end="url(#b)"/>
  <path d="M710,66 L770,66" stroke="#4a5f80" stroke-width="1.5" fill="none" marker-end="url(#b)"/>
</svg>
<figcaption>Proposed: the suite runs once post-merge; release derives its proof;
the matrix runs nightly, off the release clock and bill.</figcaption>
</figure>

## Proposed Changes

### Change 1 — matrix off the release path (`.github/workflows/ci.yml`)

```diff
 on:
-  push:
-    branches: ['release/**']
-  pull_request:
-    branches: ['release/**']
+  schedule:
+    - cron: '0 8 * * *'   # 08:00 UTC nightly cross-platform sweep
   workflow_dispatch:
```

Rationale: the matrix is not a required check and `release.sh` never waits on it
(it gates on the attestation + the `test` check). Nightly + dispatch keeps the
macOS/Windows signal without putting 16-53 min of 10×-billed, non-gating work on
every release. Update `ci.test.ts` (which currently pins the `release/**`
trigger) to pin the nightly-schedule + dispatch policy instead.

### Change 2 — derive the release-tree attestation (`release-attestation.sh`, `release.sh`)

Add a constrained `derive-release-tree` op: given a verified attestation for the
merged/main tree and the release-commit tree, it re-verifies that the only diff
between them is `package.json` version, `.changelog/*`, `CHANGELOG.md`, and
`docs/command-index.*`, then mints a release-tree attestation that inherits the
suite result. `release.sh` calls it instead of requiring a second independently
produced full-suite attestation. Any code diff fails the derivation closed, so a
non-metadata change still demands a real full-suite proof.

### Change 3 — fix macOS `daemon.socketsvcs.test.ts:335`

Root-cause the macOS-only failure (real bug vs. flake) so the relocated
cross-platform lane is green and trustworthy. Ships with the test change that
reproduces/guards it.

## Public Interface

- `.github/workflows/ci.yml` no longer fires on `release/**`; fires nightly +
  `workflow_dispatch`. No required-check identity changes (it was never required).
- `scripts/release-attestation.sh derive-release-tree --base-attestation <f>
  --tree <sha>` — new constrained op; documented in `cli/CLAUDE.md` §Releasing.
- `release.sh` output gains one derivation phase line; no new flags.

## Plan

- [ ] Change 1: relocate `ci.yml` to nightly + dispatch; update `ci.test.ts`.
- [ ] Change 3: root-cause + fix the macOS `daemon.socketsvcs` failure.
- [ ] Change 2: `derive-release-tree` op + `release.sh` wiring + tests.
- [ ] Update `cli/CLAUDE.md` §Releasing + CHANGELOG.
- [ ] Then the smaller release bugs (PHNX-3176 / 3200 / 3084 / 2943).

## Validation

- `ci.yml`: `bun test .github/workflows/ci.test.ts` pins the new trigger policy;
  a manual `workflow_dispatch` run goes green across all six legs after Change 3.
- Derivation: a version-only release derives and publishes; a release branch
  carrying any code change is refused at derivation and must produce a real
  full-suite attestation. Covered by a new `release-attestation.test.ts` case.
- End-to-end: a dry-run `release.sh <next> ` shows the derive phase; a real
  `--apply` on the next patch publishes with one full-suite run, not two.

## Risks

- **Dropping the only macOS/Windows pre-release signal.** Nightly catches
  regressions within 24h, not at the release boundary. Mitigation: keep
  `workflow_dispatch` so a risky release can run the matrix on demand; Change 3
  makes the signal real again.
- **Derivation allow-list too tight or too loose.** Too tight refuses a
  legitimate release (e.g. a new `.changelog/next/*` path); too loose would let a
  code change ride a stale suite result. The op fails **closed** and enumerates
  the exact allowed paths (`release-attestation.sh`); any surprise path aborts.
- **`release.sh` still requires an attestation for `origin/main`.** If nothing
  produces the post-merge main attestation yet, Change 2 must ship with the
  post-merge producer trigger or release derivation has no base to inherit.

## Tracking

- PHNX-3237 — attestation producer clean-env path (this plan supersedes the
  hermeticity workaround with the derive-once approach).
- PHNX-2943 — computer-mac manifest dead loop (folded into the helper-manifest cleanup).
- Master plan: `.agents/artifacts/2026-08-15/plan-ci-release-near-instant.md` (§3, §4).
