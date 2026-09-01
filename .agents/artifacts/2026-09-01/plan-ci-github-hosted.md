---
kind: plan
template: plan.v1
title: "The CI bottleneck is `bun install`, not the runner"
summary: >-
  A release check spends 19s installing 273 packages and 0.27s running tests.
  The fix is a dependency cache on stock GitHub runners — not a self-managed
  Firecracker executor. This supersedes the Crabbox direction in the 2026-08-15
  plan, which the owner has declined.
project: AGI
repository: phnx-labs/agi-cli
branch: docs/ci-direction-github-hosted
status: awaiting-review
surface: workflow
date: 2026-09-01
harness: claude
agent: claude-opus-5
host: zion
session: 4d7e7269-3ba1-4867-b678-52d92a135f71
facts:
  - "Release PR check: 62s wall, of which bun install 19.18s and test execution 0.27s"
  - "The required job has an actions/cache for the impact PROOF but none for dependencies"
  - "Repo is PUBLIC with 7 forks, so fork code must never touch a tailnet host"
links:
  - "https://linear.app/getrush/issue/PHNX-3705"
---

## Purpose

The 2026-08-15 plan proposed running CI on a self-managed Crabbox with
Firecracker microVMs. The owner has declined that direction: *"I definitely
don't want to manage my own executor because that will probably run into more
issues… for now maybe you can keep the runners on GitHub as long as we can
actually improve the conditions for what runs."*

That is also what the measurements support. This plan replaces the executor work
with the change the data actually points at.

## Current architecture

Measured on the real 1.22.69 release check (run for `849b86499`):

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 900 250" role="img" aria-label="Where the 62 seconds of a release check go">
    <text x="20" y="26" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="15">Release PR check — 62s wall</text>
    <rect x="20" y="44" width="115" height="34" rx="4" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="77" y="66" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="12">queue ~8s</text>
    <rect x="139" y="44" width="158" height="34" rx="4" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="218" y="66" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="12">checkout 11s</text>
    <rect x="301" y="44" width="273" height="34" rx="4" fill="#1a0d0d" stroke="#dc2626" stroke-width="2.5" />
    <text x="437" y="66" text-anchor="middle" fill="#dc2626" font-family="JetBrains Mono, monospace" font-size="13" font-weight="600">bun install 19.2s — NO CACHE</text>
    <rect x="578" y="44" width="30" height="34" rx="4" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="593" y="97" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">tests</text>
    <text x="593" y="112" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">0.27s</text>
    <rect x="612" y="44" width="268" height="34" rx="4" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="746" y="66" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="12">plan / proof / publish ~23s</text>
    <line x1="578" y1="82" x2="593" y2="90" stroke="#a3e635" stroke-width="1.5" />
    <text x="20" y="160" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="15">Same check with a lockfile-keyed dependency cache</text>
    <rect x="20" y="178" width="115" height="34" rx="4" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="77" y="200" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="12">queue ~8s</text>
    <rect x="139" y="178" width="90" height="34" rx="4" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="184" y="200" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">checkout</text>
    <rect x="233" y="178" width="60" height="34" rx="4" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="263" y="200" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">restore</text>
    <rect x="297" y="178" width="30" height="34" rx="4" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="312" y="231" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">tests</text>
    <rect x="331" y="178" width="180" height="34" rx="4" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="421" y="200" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="12">plan / proof / publish</text>
    <text x="530" y="200" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="14">≈ 25-30s — under the 60s bar</text>
  </svg>
  <figcaption><b>Figure 1.</b> Actual step timings from the 1.22.69 release check. Test execution is 0.27s; a cold <code>bun install</code> of 273 packages is 70x that. No runner upgrade changes this ratio.</figcaption>
</figure>

```
bun install v1.4.0 … 273 packages installed [19.18s]
Test Files  2 passed (2)
   Duration  268ms
```

**Not one favourable sample.** Sampling the `bun install` step across recent
required-check runs (273 packages = the Linux required job; 268 = the Windows
lane, listed separately so the two are not blended):

| run | packages | install | test files selected |
|---|---|---|---|
| 33508900541 | 273 | 14.45s | 78 |
| 33508738157 | 273 | 18.48s | 35 |
| 849b86499 (release) | 273 | 19.18s | 2 |
| 33508792871 | 273 | 21.74s | 2 |
| 33509687074 | 268 (win) | 33.70s | 17 |
| 33508677587 | 268 (win) | 38.74s | 17 |

Install is **14-22s on every Linux required run regardless of how many tests are
selected** — 78 files or 2, the install is the same constant. That is what makes
the cache a general win rather than a release-PR trick: it removes a fixed cost
that every PR pays. The projection below uses the release check because that is
the R2 path, but the same seconds come off a normal PR.

The impact planner is already doing its job: the release commit selects
`suite: "selected"` with exactly two test files
(`gen-changelog.test.ts`, `version.test.ts`). The 2026-08-17 finding that a
release PR ran essentially the whole suite is **fixed**.

The job has one `actions/cache`, and it is for the impact **proof**
(`.github/workflows/tests.yml:48`). There is no dependency cache, so every run
reinstalls from scratch.

## Why the Crabbox / Firecracker direction is superseded

Two independent reasons.

1. **It does not address the measured bottleneck.** A faster or larger executor
   cannot make a 0.27s test run meaningfully faster. It would shave the install,
   but so does a cache, at no operational cost.
2. **The owner has declined to operate one**, and the isolation constraint that
   motivated it is real but orthogonal: the repo is **public with 7 forks**, and
   `AGENTS.md` forbids fork code on a persistent tailnet host. Stock GitHub
   runners satisfy that constraint by construction.

`scripts/ci-runner/` (Firecracker launcher, supervisor, janitor, provisioning)
stays in the tree as unused machinery; it is not on the path to the 60s bar.

## Proposed Changes

<div class="artifact-behavior">
<div class="artifact-behavior-panel" data-state="current" data-evidence="capture">

**Today**

```
checkout                11s
bun install          19.18s   273 packages, cold
selected tests        0.27s
plan/proof/publish     ~23s
queue                   ~8s
                     ------
                        62s
```
</div>
<div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">

**With a lockfile-keyed cache**

```
checkout                11s
restore deps          ~2-3s   cache hit
selected tests        0.27s
plan/proof/publish     ~23s
queue                   ~8s
                     ------
                    ~25-30s
```
</div>
</div>

1. **Cache dependencies keyed on the lockfile digest.** Reuse the existing
   `actions/cache` pattern, keyed on `cli/bun.lock`'s digest — the same digest
   the attestation already computes, so the key is already a first-class concept
   in this repo.
2. **Trim the checkout.** 11s is large for a job whose only history need is
   `base..head` for `ci-scope`. Tune `fetch-depth` rather than fetching all refs.
3. **Larger runners only where execution actually dominates.** Irrelevant for a
   release PR (0.27s of tests); potentially useful for full-suite lanes. Treat as
   a later, separately-measured step — not part of reaching the bar.

## Public Interface

No CLI surface changes. The only user-visible effect is latency:

```yaml
# .github/workflows/tests.yml — the added step, keyed on the lockfile digest
- name: Restore dependencies
  uses: actions/cache@<pinned>
  with:
    path: |
      ~/.bun/install/cache
      cli/node_modules
    key: bun-${{ runner.os }}-${{ hashFiles('cli/bun.lock') }}
```

## Validation

| Check | Expected |
|---|---|
| Release PR check, warm cache | under 60s end to end (R2) |
| `bun install` step on a cache hit | seconds, not ~19s |
| Cache key | changes if and only if the lockfile changes |
| Fork PR | still runs on a GitHub-hosted runner, no tailnet access |
| Selection | release commit still resolves `suite: selected`, 2 files |

## Risks

| Risk | Mitigation |
|---|---|
| A poisoned cache changes what is tested | Key on the lockfile digest and restore only `node_modules`/bun cache; the attestation still binds tree → tarball independently |
| Cache miss makes a run slower than today | Restore is best-effort; a miss is exactly today's path |
| Shallow checkout breaks `ci-scope`'s base..head diff | It needs both SHAs reachable — verify against a real PR before merging, fail loud rather than silently selecting wrong |

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> tests are 0.27s and installs are 19s. Every remaining second of the required check is setup, so cache the setup — do not buy a bigger machine.</aside>

## Checklist

- [x] Measure where the release check actually spends its time
- [x] Confirm the impact planner already selects 2 files for a release commit
- [x] Establish why self-hosted is refused (public repo, 7 forks, tailnet)
- [ ] Add the lockfile-keyed dependency cache to `tests.yml`
- [ ] Re-measure a release PR and confirm under 60s
- [ ] Tune checkout depth, re-measure
- [ ] Supersede the Crabbox sections in `AGENTS.md` and the 2026-08-15 plan

## Tracking

- Supersedes the executor direction in `.agents/artifacts/2026-08-15/plan-ci-release-near-instant.md`
- Builds on `.agents/artifacts/2026-08-17/release-latency-breakdown.md` (owner 60s directive, 2026-08-17)
- PHNX-3705 — attestation starvation (PR #3386 merged 2026-09-01; ticket still open at time of writing)
