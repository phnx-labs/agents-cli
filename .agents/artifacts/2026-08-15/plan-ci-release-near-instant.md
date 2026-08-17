---
kind: plan
surface: workflow
title: Near-instant CI and release for agents-cli
summary: Replace component-wide test sweeps and lease-bound sandboxes with exact affected-test selection on a dedicated untrusted-code executor, then release from merge-candidate attestations and reusable signed helper artifacts.
status: awaiting-review
links:
  - "https://vitest.dev/guide/cli"
  - "https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access"
  - "https://github.com/phnx-labs/agi-cli/pull/2717"
---

## Focus for review

- **Required-check target:** event-to-terminal-check P99 is **≤90 seconds**; a warm cache-hit should finish in **≤10 seconds**. A result older than or for a different commit SHA never counts.
- **Safety boundary:** static imports select tests automatically; subprocess, filesystem, platform, and global-state dependencies are declared in one reviewed ownership manifest. An unmapped changed file fails immediately with the missing mapping instead of silently skipping tests or running the entire suite.
- **Compute:** keep one always-on Crabbox as a shared multi-repository executor. Repositories and agents run concurrently in namespaced exact-candidate worktrees and one-use Firecracker microVMs restored from warm snapshots. No run acquires the machine; a fair scheduler admits CPU/memory slots. The host is only a controller/cache substrate and exposes no tailnet, durable credentials, host sockets, or writable trusted cache to jobs.
- **Windows:** remove Windows from required pull-request and release gates. Keep at most a best-effort post-merge smoke while real usage is measured; close PR #2717 because optimizing a non-required gate adds complexity without helping the 90-second P99.
- **Release:** ordinary release P99 is **≤180 seconds**. Promote the exact tested npm tarball with OIDC, run a clean install smoke, and rebuild/sign/notarize helpers only when their own inputs change.
- **Backstop:** keep a full cross-platform sweep after merge and nightly. It detects selection mistakes and blocks promotion of the affected attestation policy, but does not hold every pull request open.

## Intent

Make the required CI result feel immediate and make a routine release publish in minutes, without weakening correctness. A change to one module should not execute the CLI's entire 12,000-test corpus. A version-only release should not repeat tests already proven for the exact tree or rebuild unrelated native applications and helpers.

## Purpose

Return merge and release latency to the scale of the changed behavior. The test corpus remains a correctness backstop; it stops being a tax paid by every unrelated change.

<div class="artifact-callout">
The load-bearing change is affected-test selection. Warm checkout and dependency caches save roughly 20 seconds; they cannot remove five minutes of unrelated test execution.
</div>

## Current architecture

### What happens now

<div class="artifact-grid artifact-grid-2 artifact-behavior">
<div class="artifact-panel" data-state="current" data-evidence="capture">

**Before — one CLI file changes**

```console
scope (Ubuntu)                         17s
├─ cli-preflight: install + build      42s
├─ cli-docs: docs + command index      25s
├─ shard 1: 287 files / 4,088 tests   335s
├─ shard 2: 287 files / 4,020 tests   300s
└─ shard 3: 287 files / 4,051 tests   229s

required workflow: median 6.1m · p90 15.8m
```

The scope classifier knows only that `apps/cli/**` changed. It does not know which source module, test owner, platform, command index, binary bootstrap, or helper changed.
</div>

<div class="artifact-panel" data-state="proposed" data-evidence="mockup">

**After — the same file changes**

```console
impact plan                              2s
exact-SHA worktree + warm dependencies   3s
related + declared owner tests          8–35s
policy / docs check only if affected     1–8s
attestation + required check             2s

target: P99 ≤90s · cache hit ≤10s
selected: 3 test files, not 861
```

The required check names every selected test and the rule that selected it. An unmapped boundary produces a fast red policy result with the exact manifest entry to add.
</div>
</div>

### Six-month request, available evidence

The requested window begins 2026-02-15. GitHub exposes merged pull-request history for this repository from 2026-05-06, so the quantitative baseline covers **101 days**, not a fabricated six months. Fleet session search was widened across directories and devices; the available indexed topic corpus starts 2026-07-29 and is supporting context only. GitHub timestamps are the merge-latency source of truth.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 960 440" role="img" aria-label="CI and release latency baseline with hard targets" xmlns="http://www.w3.org/2000/svg">
  <text x="24" y="28" font-family="ui-monospace,monospace" font-size="18" font-weight="700" fill="#f5f5f4">2,158 merged pull requests · 2026-05-06 → 2026-08-15</text>
  <text x="24" y="49" font-family="ui-monospace,monospace" font-size="15" fill="#b9c7d5">Aggregate open→merge capacity wait: 6,383 hours (overlapping PR/agent time, not literal human hours)</text>
  <line x1="170" y1="85" x2="930" y2="85" stroke="#b9c7d5" stroke-opacity=".25"/><line x1="170" y1="165" x2="930" y2="165" stroke="#b9c7d5" stroke-opacity=".25"/><line x1="170" y1="245" x2="930" y2="245" stroke="#b9c7d5" stroke-opacity=".25"/>
  <text x="24" y="107" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">PR open→merge p50</text><rect x="170" y="88" width="442" height="27" rx="4" fill="#e0663a"/><text x="620" y="107" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">17.7m</text>
  <text x="24" y="147" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">PR open→merge p90</text><rect x="170" y="128" width="720" height="27" rx="4" fill="#e0663a"/><text x="898" y="147" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">297.6m</text>
  <text x="24" y="187" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">Tests workflow p50</text><rect x="170" y="168" width="307" height="27" rx="4" fill="#e0663a"/><text x="485" y="187" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">6.1m</text>
  <text x="24" y="227" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">Tests workflow p90</text><rect x="170" y="208" width="630" height="27" rx="4" fill="#e0663a"/><text x="808" y="227" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">15.8m</text>
  <text x="24" y="267" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">Release PR p50 / p90</text><rect x="170" y="248" width="638" height="27" rx="4" fill="#e0663a"/><text x="816" y="267" font-family="ui-monospace,monospace" font-size="16" fill="#f5f5f4">12.8m / 73.5m</text>
  <text x="24" y="315" font-family="ui-monospace,monospace" font-size="22" font-weight="700" fill="#84cc16">HARD P99 TARGETS</text>
  <text x="24" y="358" font-family="ui-monospace,monospace" font-size="20" fill="#f5f5f4">Required CI</text><rect x="190" y="330" width="150" height="38" rx="6" fill="#84cc16"/><text x="360" y="357" font-family="ui-monospace,monospace" font-size="21" font-weight="700" fill="#f5f5f4">≤ 90 seconds</text>
  <text x="500" y="358" font-family="ui-monospace,monospace" font-size="20" fill="#f5f5f4">Ordinary release</text><rect x="700" y="330" width="190" height="38" rx="6" fill="#84cc16"/><text x="900" y="357" font-family="ui-monospace,monospace" font-size="21" font-weight="700" text-anchor="end" fill="#f5f5f4">≤ 180 seconds</text>
  <text x="24" y="408" font-family="ui-monospace,monospace" font-size="18" fill="#b9c7d5">Warm-cache CI stretch target: ≤ 10 seconds</text>
</svg>
<figcaption><b>Figure 1.</b> Large, explicit hard-percentile targets replace the previous soft median goals.</figcaption>
</figure>

### Where the required test time goes

| Work | Current median | What the evidence says |
| --- | ---: | --- |
| Checkout | 3 seconds | Not the bottleneck. |
| `bun install` | 17 seconds | Warm dependencies help, but cannot turn six minutes into seconds. |
| Build | 14 seconds | Split by build inputs; do not optimize first. |
| Shard 1 tests | 318 seconds | Dominant path. |
| Shard 2 tests | 286 seconds | Dominant path. |
| Shard 3 tests | 228 seconds | Dominant path. |
| Docs | 25 seconds | Separate runner/job overhead for a check that can be selected inside the impact plan. |
| Preflight | 42 seconds | Bundles unrelated command-index, build, binary-smoke, and benchmark concerns. |

The slow tail is concentrated. Representative files include `routines.test.ts` at 208 seconds, `sessions.test.ts` at 176 seconds, `daemon.test.ts` at 112 seconds, `non-interactive.test.ts` at 76 seconds, and `versions.test.ts` at 73 seconds. More shards move this work around; affected-test selection stops running it when its owners did not change.

### Why only-the-changed-module does not happen today

```diff
 // scripts/ci-scope.ts — current decision granularity
-if (file.startsWith('apps/cli/')) flags.cli = true
+const plan = selectImpact(baseSha, headSha, changedFiles, ownershipManifest)
+// plan.tests, plan.checks, plan.platforms, plan.reasons
```

The current classifier emits five booleans: CLI, CLI docs, extension, session tracker, and Windows. Any non-document CLI path sets the single `cli` boolean, which starts all three full Vitest shards. Vitest already provides `related`/`--changed`, but its graph covers static imports and explicitly does not cover dynamic paths. This repository has CLI subprocess, filesystem, and global-state tests, so `vitest related` is a useful engine, not a complete policy.

### Why CLI docs and preflight exist

They are legitimate invariants with the wrong scheduling boundary:

| Current check | Invariant | Run when |
| --- | --- | --- |
| CLI docs | Generated command index and documented command surface agree | Command definitions, command metadata, docs index generator, or covered docs change |
| Preflight: command index | Committed command index is current | Same ownership set as CLI docs |
| Preflight: TypeScript build | Shipping entry graph compiles | Imported production source, build config, lockfile, package manifest, or build script changes |
| Preflight: standalone smoke | The standalone bootstrap starts | Bootstrap, binary builder, package version, or entrypoint changes |
| Preflight: session benchmark | Session distribution remains within threshold | Session discovery/index/database/status code or benchmark policy changes |

The plan keeps each invariant and removes the insistence that every CLI edit run all of them on separate machines.

### Existing PR #2717 — closed, not optimized

PR [#2717](https://github.com/phnx-labs/agi-cli/pull/2717) reduced the Windows gate to a 1 minute 47 second smoke. That single platform check already exceeds the complete 90-second event-to-result budget before Linux work or GitHub scheduling is counted. The PR is closed: Windows is removed from required pull-request and ordinary-release gates instead of spending more complexity on a platform that has not demonstrated enough demand to justify blocking every contributor.

During a short evidence window, Windows gets at most one best-effort post-merge smoke on separate capacity. It cannot block a merge or release. If demand remains unproven, remove Windows-only code, documentation, packaging, and the supported-platform claim rather than carrying permanent conditional branches.

## Proposed Changes

### 1. One exact impact planner is the source of truth

Extend `scripts/ci-scope.ts` from component booleans to a deterministic JSON plan keyed by the selection range, tested merge-candidate tree, and policy version. Add one reviewed manifest at `apps/cli/ci/test-ownership.yaml` for dependencies that static imports cannot see.

```diff
-{ "cli": true, "cli_docs": false, "windows": false }
+{
+  "selection_base_sha": "…",
+  "pr_head_sha": "…",
+  "candidate_tree_sha": "…",
+  "policy_version": "impact-v1",
+  "tests": [
+    {"file":"src/lib/example.test.ts","reason":"static-import"},
+    {"file":"tests/non-interactive.test.ts","reason":"owner:cli-bootstrap"}
+  ],
+  "checks": ["typecheck"],
+  "platforms": ["linux"],
+  "unmapped": []
+}
```

Selection rules are fixed and ordered:

1. A changed test file selects itself.
2. A changed TypeScript source file selects companion tests and `vitest related --run` results.
3. The ownership manifest adds subprocess, dynamic-import, filesystem-layout, platform, generated-doc, build, benchmark, and global-state consumers.
4. A changed dependency/configuration file selects the explicit group named in the manifest.
5. Every changed executable source must select at least one test/check. Zero selections fail unless the path has an explicit reviewed `testless` entry; the manifest validator audits every production/build/config path, including paths absent from the 200-PR sample.
6. A changed path with no classification produces `unmapped[]` and fails the policy check in seconds. There is no silent skip and no automatic full-suite fallback.
7. Workflow/policy changes run the impact planner's own tests plus a shadow full sweep before the new policy version can attest later commits.

The planner also emits a human-readable table in the check summary: changed file → selected test/check → reason. This makes a wrong selection reviewable.

### 2. Collapse the pull-request gate into one job

Replace only the CLI `scope` fan-out, three CLI shards, `cli-docs`, and `cli-preflight` with one CLI `Tests / impact` execution. Extension and session-tracker jobs remain separately selected with their current build/test commands and continue feeding the stable final aggregator. During shadow rollout all pull-request jobs remain GitHub-hosted; only after the dedicated untrusted executor passes its isolation gate do same-repository branches move there.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 980 330" role="img" aria-label="Before and after CI architecture" color="#f5f5f4" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="#b9c7d5"/></marker></defs>
  <text x="20" y="25" font-family="ui-monospace,monospace" font-size="17" font-weight="700" fill="#f5f5f4">BEFORE: every CLI edit fans out to whole-component jobs</text>
  <rect x="20" y="45" width="105" height="45" rx="5" fill="none" stroke="#e0663a" stroke-width="2"/><text x="43" y="72" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">scope</text>
  <line x1="125" y1="67" x2="170" y2="67" stroke="#b9c7d5" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="180" y="35" width="120" height="45" rx="5" fill="none" stroke="#e0663a" stroke-width="2"/><text x="199" y="62" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">preflight</text>
  <rect x="180" y="90" width="120" height="45" rx="5" fill="none" stroke="#e0663a" stroke-width="2"/><text x="213" y="117" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">docs</text>
  <rect x="325" y="35" width="120" height="45" rx="5" fill="none" stroke="#e0663a" stroke-width="2"/><text x="350" y="62" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">shard 1</text>
  <rect x="325" y="90" width="120" height="45" rx="5" fill="none" stroke="#e0663a" stroke-width="2"/><text x="350" y="117" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">shard 2</text>
  <rect x="470" y="62" width="120" height="45" rx="5" fill="none" stroke="#e0663a" stroke-width="2"/><text x="495" y="89" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">shard 3</text>
  <line x1="590" y1="84" x2="650" y2="84" stroke="#b9c7d5" stroke-width="1.5" marker-end="url(#a)"/><rect x="660" y="62" width="130" height="45" rx="5" fill="none" stroke="#e0663a" stroke-width="2"/><text x="683" y="89" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">required gate</text>
  <text x="20" y="185" font-family="ui-monospace,monospace" font-size="17" font-weight="700" fill="#f5f5f4">AFTER: exact SHA → isolated worktree → selected proof</text>
  <rect x="20" y="205" width="125" height="50" rx="5" fill="none" stroke="#84cc16" stroke-width="2"/><text x="42" y="226" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">GitHub event</text><text x="50" y="243" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">+ head SHA</text>
  <line x1="145" y1="230" x2="185" y2="230" stroke="#b9c7d5" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="195" y="205" width="145" height="50" rx="5" fill="none" stroke="#84cc16" stroke-width="2"/><text x="208" y="226" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">shared Crabbox</text><text x="210" y="243" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">multi-repo · no lease</text>
  <line x1="340" y1="230" x2="380" y2="230" stroke="#b9c7d5" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="390" y="195" width="155" height="70" rx="5" fill="none" stroke="#84cc16" stroke-width="2"/><text x="410" y="217" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">detached worktree</text><text x="413" y="235" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">Firecracker microVM</text><text x="425" y="252" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">warm cache</text>
  <line x1="545" y1="230" x2="585" y2="230" stroke="#b9c7d5" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="595" y="205" width="145" height="50" rx="5" fill="none" stroke="#84cc16" stroke-width="2"/><text x="615" y="226" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">selected tests</text><text x="612" y="243" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">+ named reasons</text>
  <line x1="740" y1="230" x2="780" y2="230" stroke="#b9c7d5" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="790" y="195" width="165" height="70" rx="5" fill="none" stroke="#84cc16" stroke-width="2"/><text x="814" y="217" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">SHA attestation</text><text x="817" y="235" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">required check</text><text x="823" y="252" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">P99 ≤90s</text>
  <text x="195" y="295" font-family="ui-monospace,monospace" font-size="15" fill="#f5f5f4">Fork PRs: GitHub-hosted isolated lane; never execute fork code on the persistent machine.</text>
</svg>
<figcaption><b>Figure 2.</b> Worktrees solve concurrency; the per-job microVM and fork split solve persistence and trust.</figcaption>
</figure>

The target executor is one always-on Crabbox shared by multiple repositories and agents. It is provider-owned capacity from the fleet's perspective: the broker does not acquire, reclaim, or exclusively assign it per run. It is also separate from the existing trusted org-runner host. Its directory contract is:

```text
/srv/ci/mirrors/<owner>/<repo>.git
/srv/ci/runs/<owner>/<repo>/<candidate-tree>/<run-id>/worktree
/srv/ci/results/<owner>/<repo>/<run-id>/
/srv/ci/cache/bun/<lockfile-digest>/
```

Each job:

- computes selection from merge base to PR head, then executes GitHub's merge-ref tree or an independently constructed equivalent candidate tree;
- records selection base, PR head, base, candidate commit/tree, and policy/toolchain digests separately;
- creates a detached worktree named by check-run id and candidate tree SHA;
- mounts only that worktree and content-addressed Bun/Vitest caches into a one-use Firecracker microVM;
- runs with no signing, npm, GitHub-write, fleet, SSH, or user secrets;
- exposes worker output only as raw logs/reports; the controller derives the conclusion from controller-observed exit status and report hashes, then signs with a key never mounted into the worker;
- removes the container/worktree after completion;
- allows worktrees from different repositories and agents concurrently up to measured CPU/memory limits;
- enters a fair per-repository queue when capacity is full; this is short-lived resource admission, not an exclusive machine lease;
- caps per-repository concurrency so one repo cannot starve all other agents.

GitHub explicitly warns that pull-request code can be dangerous on a persistent self-hosted runner. Fork PRs therefore use GitHub-hosted runners with restore-only, non-secret caches. Same-repository PRs move only to the separate untrusted-code host after isolation proves they cannot reach trusted-runner files/processes, host sockets, Docker, tailnet, SSH agent, signing/publish credentials, GitHub token, or host home. The existing trusted runner label remains forbidden on every `pull_request` trigger.

### 3. Move full sweeps out of the merge critical path

On every merge to the default branch, run the full Linux suite and relevant macOS/Windows sweeps asynchronously. Nightly, run all platforms and Node versions. Compare selected tests with full-suite failures and store:

- selection recall: full-suite failures whose test was not selected on the originating PR;
- impacted test count and duration per changed path;
- queue, setup, execution, and reporting latency percentiles;
- policy version and exact source tree SHA;
- top test files by exclusive wall time.

The rollout stays in shadow mode until **200 representative pull requests and at least 14 days** complete with zero missed failures. During shadow mode, the old full suite remains required and the new impact job reports what it would have selected. Promotion requires the measured targets and zero false negatives; otherwise the manifest or graph is corrected and the sample restarts for that policy version.

### 4. Release from evidence already earned by the merged tree

Today the release script runs a full Crabbox suite before opening a release PR, waits for pull-request checks, waits for a release matrix, then always builds/signs/notarizes the CLI and native helpers. Replace that sequence:

<div class="artifact-grid artifact-grid-2 artifact-behavior">
<div class="artifact-panel" data-state="current" data-evidence="capture">

**Before — routine release**

```console
lease/reuse Crabbox
full Linux build + test
create version/changelog PR
full PR test workflow
release OS × Node matrix
merge
build/sign/notarize all helpers
build package → npm publish

release PR p50 12.8m · p90 73.5m
merge→npm p50 3.6m · p90 26.1m
```
</div>

<div class="artifact-panel" data-state="proposed" data-evidence="mockup">

**After — routine release**

```console
verify candidate-tree attestations      seconds
create version/changelog PR
version/changelog + package/build/smoke seconds
merge
build package + versioned CLI binary  parallel
resolve verified helper digests         seconds
publish npm and release manifest

target start→npm P99 ≤180s
```
</div>
</div>

The release attestation key is immutable: tested candidate tree digest, selection base/base/head identities, platform, runtime/toolchain versions, lockfile digest, test-policy version, and selected/full suite identity. A base advance invalidates the candidate. Release reuse is allowed only when the final default-branch tree digest equals the tested candidate tree digest; evidence from a parent, nearby commit, branch name, or mutable cache key never counts.

### 5. Stop rebuilding unchanged helpers at the source

Decouple helper artifact identity from the CLI package version. On main, a change-driven helper builder produces a signed/notarized artifact keyed by a digest of its complete inputs: source, build script, lockfile/toolchain, entitlements, assets, signing identity, and target architecture. It verifies `codesign`, Gatekeeper/stapling, and SHA-256 before recording the artifact.

The release manifest maps one CLI version to immutable helper digests and independent helper versions. Migration is staged: release N ships the manifest-aware downloader while retaining the current per-CLI-version helper asset; only after that client is live does release N+1 consume an independent helper artifact. Old clients keep resolving the immutable asset already attached to their own `v<cli-version>` tag.

The bundled `dist/lib/computer/helper-manifest.json` contains `schemaVersion`, platform, helper version, immutable asset URL, SHA-256, signer team, and input digest. Package integrity protects the manifest; the downloaded app still passes checksum, code-signing team, Gatekeeper, and notarization verification. New clients cache by helper version + digest. Missing or invalid manifests/assets fail setup; they never derive a fallback URL.

| Artifact | Current coupling | Proposed release behavior |
| --- | --- | --- |
| TypeScript/npm package | CLI version and sources | Always build; current measured build is small. |
| Standalone CLI binary | CLI version embedded in bootstrap | Rebuild/sign/notarize each CLI version, in parallel with package build. |
| Keychain helper | No CLI version observed in build inputs | Reuse verified content-addressed artifact unless its inputs change. |
| Menu bar app | Native sources/assets/signing inputs | Reuse verified artifact unless its complete input digest changes. |
| Computer helper | CLI version currently stamped into `Info.plist` | Give it an independent helper version; rebuild only for helper-input changes, then map its digest from the CLI release manifest. |

Missing or unverifiable helper artifacts fail the release boundary. They do not fall back to a stale build. A helper source change triggers its builder before the release train can consume the new tree.

## Options considered

| Option | Expected result | Decision |
| --- | --- | --- |
| Add dependency cache to GitHub-hosted jobs | Saves roughly the 17-second install and some setup; tests still take 4–6 minutes | Reject as the primary fix; keep as hygiene for fork jobs. |
| Add more shards / more leased boxes | Shortens a single full sweep, increases fixed setup and burst contention; still runs 12,000 tests | Reject as the target architecture. Useful only during shadow validation. |
| One shared multi-repo Crabbox, but keep full suite | Removes lease/checkout churn but the test corpus remains the critical path | Necessary compute base, insufficient alone. |
| Affected tests + ownership manifest + standing isolated executor | Ordinary diffs execute only their real proof on warm capacity | **Adopt.** |
| Merge queue / batch testing | Amortizes full-suite compute but makes an individual PR wait for a batch | Secondary backstop, not the user-facing gate. |
| Pre-push speculative attestation | A branch push can arrive at GitHub with proof already computed | Add after the exact-SHA attestation format is stable; it can reduce post-push checks to attestation lookup. |

## Public Interface

- `scripts/ci-scope.ts --base <sha> --head <sha> --json` becomes the canonical impact-plan interface. Output is deterministic and versioned; non-JSON mode prints the human mapping table.
- `apps/cli/ci/test-ownership.yaml` is the only manual dependency surface for non-static relationships. CI validates that every production/build/config path is classified and every referenced test exists.
- The shared-executor request contains repository identity, candidate commit/tree, impact-plan digest, resource class, and check-run id. It never contains a box lease or mutable checkout path; the executor derives a namespaced worktree path and returns a run id.
- The required GitHub context remains one stable `Tests / test` aggregator during migration; its summary links to the `Tests / impact` plan and result so branch protection does not churn.
- Attestations are immutable JSON records addressed by SHA-256 and include selection range, candidate tree, base/head identities, plan digest, platform/toolchain, selected checks, controller-observed results, durations, and report/artifact digests. Only the controller constructs/signs them; workers cannot write a conclusion or access the signing identity.
- The release manifest adds independent helper versions/digests through the staged N/N+1 migration. The setup command is unchanged; no user-managed flag or environment variable is added.

## Implementation plan

- [ ] **Instrument the baseline.** Persist per-job queue/setup/test/report timings, selected test file counts, and top slow tests; publish a 30-day dashboard.
- [ ] **Build and test the impact planner.** Extend scope output, add the ownership manifest, test static/dynamic/subprocess/platform/global cases, and make unknown paths fail loud.
- [x] **Remove Windows from the gate.** PR #2717 is closed; retain at most a non-blocking post-merge smoke during the support-demand evidence window.
- [ ] **Provision the shared executor.** Designate one always-on Crabbox for all participating repositories; remove per-run acquisition/reclaim, trusted runners and tailnet access; add per-repo mirrors, namespaced candidate worktrees, Firecracker isolation, shared content caches, fair scheduling, per-repo concurrency caps, and no secrets.
- [ ] **Run shadow mode.** Execute impact and full suites together for 200 PRs/14 days; measure recall and latency without changing branch protection.
- [ ] **Switch the required gate.** Promote `Tests / impact`, retain the stable aggregator context, move full Linux/cross-platform sweeps to post-merge/nightly, and keep fork PRs isolated.
- [ ] **Create exact-candidate attestations.** Sign/store merge-candidate and main proofs, invalidate on base advance, require final-tree equality in the release script, and delete the pre-release duplicate full-suite invocation.
- [ ] **Decouple native helpers.** Build/sign/notarize on helper-input changes, introduce independent helper versions and the release manifest mapping, and verify artifacts before reuse.
- [ ] **Parallelize the remaining release.** Build the npm package and version-stamped standalone CLI concurrently, consume verified helper artifacts, publish, tag, and verify installed versions through the existing release train.
- [ ] **Enforce the targets.** Alert on p50/p90 regression, queueing, unmapped files, false-negative selection, stale attestations, and missing helper artifacts.

## Validation

| Scenario | Required result |
| --- | --- |
| One leaf source file changes | Companion + statically related tests only; check summary explains every selection. |
| CLI command definition changes | Command test owners, build/typecheck, command index, and docs verification selected; unrelated session/daemon suites absent. |
| A subprocess entrypoint changes | Explicit ownership selects non-interactive/CLI integration tests even though static imports do not. |
| Windows-only code changes | No required Windows check. Best-effort post-merge smoke records evidence without blocking the PR or release. |
| Test file changes | That test always runs. |
| Lockfile/Vitest/global setup changes | Manifest selects the declared broad group; no implicit fallback. |
| Unmapped production path changes | Fast red policy check lists the missing path and required manifest action. |
| Fork PR opens | Never scheduled on the persistent executor; isolated GitHub-hosted job has no secrets and restore-only caches. |
| Two agents test the same repository simultaneously | Distinct run-id worktrees and result directories; shared read-only mirror/cache; neither checkout can mutate the other. |
| Three repositories use the Crabbox simultaneously | Fair admission honors per-repo concurrency caps; jobs run concurrently within CPU/memory limits without acquiring the box. |
| Base advances after a green PR | Candidate tree changes; prior attestation is invalid and the new merge candidate is tested. |
| Same candidate tree is retried | Cache may accelerate execution, but attestation identity/result remains tied to that tree, base, and policy version. |
| Release PR changes version/changelog only | Validate version/changelog, package build/typecheck, tarball/prepack contents, version-stamped standalone build/smoke, and helper-manifest/asset resolution; candidate attestations satisfy functional-code validation. |
| Helper source unchanged | Existing signed artifact digest is verified and reused; no rebuild/notarization. |
| Helper source/signing input changes | New artifact must build, notarize, verify, and be recorded before release consumption. |
| Stale/missing attestation | Release fails with the missing exact key; it never accepts parent-commit evidence. |

End-to-end acceptance is measured from GitHub event receipt to required-check completion and from release command start to npm registry visibility. Success is P99 ≤90 seconds (cache-hit target ≤10 seconds) for ordinary PRs, P99 ≤180 seconds for routine releases with unchanged helpers, p90 ≤8 minutes when one native helper changed, zero selection misses during shadow mode, and zero persistent-runner executions for fork code.

## Risks

| Risk | Control |
| --- | --- |
| Static graph misses dynamic/subprocess consumers | Reviewed ownership manifest, fail-loud unclassified paths, 200-PR shadow comparison. |
| Persistent runner is contaminated | Dedicated untrusted host, one-use Firecracker microVM per job, read-only mirror, no tailnet/trusted runners/secrets/sockets, explicit cleanup, periodic image replacement. |
| Fork code compromises standing capacity | Forks never receive the persistent label; GitHub-hosted isolated path only. |
| Cached proof is stale or poisoned | Immutable digest keys, controller-constructed signatures, candidate/base verification, and final-main-tree equality. |
| Full sweep finds a missed failure after merge | Quarantine the attestation policy version, fix mapping, and block releases containing that tree until a corrected full proof exists. |
| One repository monopolizes the shared box | Fair queue plus per-repository concurrency caps; expose global and per-repo queue p90. Add a second always-on executor only when sustained p90 breaches the target, never one lease per run. |
| Helper reuse ships the wrong binary | Full input digest plus signature, Gatekeeper, stapling, architecture, and checksum verification; missing proof is a hard failure. |

## Evidence

- `.github/workflows/tests.yml:3-8,19-214` — scope fan-out, three full CLI shards, docs, preflight, platform jobs, and the required aggregator.
- `scripts/ci-scope.ts:5-69` — component booleans and the rule that any non-doc `apps/cli/**` change selects the whole CLI suite.
- `apps/cli/vitest.config.ts` — all CLI tests share one included pool and global setup.
- `apps/cli/scripts/release.sh:22-28,181-258,365-403,1007-1060,1101-1128,1190-1210,1294-1313` — duplicate Crabbox suite, PR/matrix wait, unconditional native builds, publish and verification.
- `apps/cli/scripts/sandbox.sh:123-186,292-310` — leased box selection/reclaim and copied task workspaces rather than git worktrees.
- `scripts/ci-runner/README.md:1-34` — directly owned standing runner model and the explicit warning against public-fork execution.
- `native/computer-mac/scripts/build.sh:30-33,76-100,141-185` — CLI release version stamped into helper bundle plus signing/notarization and checksum emission.
- [Vitest CLI: `related` and `changed`](https://vitest.dev/guide/cli) — static-import related-test selection; dynamic imports are not covered.
- [GitHub self-hosted runner access](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access) — public fork pull requests can execute dangerous code on persistent machines.
- [GitHub dependency cache security](https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching) — caches are untrusted inputs and fork access requires careful scope/write policy.
- [GitHub check runs](https://docs.github.com/en/rest/checks/runs) — checks attach to a specific commit SHA; write access is restricted to appropriate authenticated identities.

## Assumptions

- “Almost instant” defaults to the explicit percentile targets above, measured end to end rather than from process start.
- Ordinary PR means a trusted same-repository change touching at most three classified modules and not a global policy/toolchain dependency.
- Correctness is preserved by exact selection plus post-merge/nightly full sweeps; the full suite moves off the merge path rather than disappearing.
- The existing trusted standing host remains limited to main/schedule/release triggers. One always-on Crabbox becomes the shared untrusted-code executor for multiple repositories and agents, with no per-run or per-repository acquisition lease. Other leased boxes remain optional for ad-hoc full-suite work until acceptance.
- The repository remains public, so fork code is untrusted regardless of author intent.
- The release train remains the single publisher. This plan changes what evidence and artifacts it consumes, not release ownership.

## Tracking

No new ticket is created in Plan Mode. Implementation should be tracked as one CI/release epic with separate delivery units for impact selection, standing executor, attestations, and helper decoupling; the rendered plan URL belongs on the epic and each child ticket belongs back here.
