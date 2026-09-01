---
kind: plan
template: plan.v1
title: Sub-60s CI and a CLI release that rebuilds nothing else
summary: Trace the owner's five release requirements to code, close the attestation gate that has made every release a manual errand since 2026-08-15, halve the required CI check, and give the installed CLI a self-update path.
project: AGI
repository: phnx-labs/agi-cli
branch: plan/release-under-60s
status: awaiting-review
harness: claude
agent: claude-opus-5
host: zion
session: 4d7e7269-3ba1-4867-b678-52d92a135f71
surface: workflow
date: 2026-09-01
tracking: PHNX-3696
facts:
  - "Required Tests workflow today: p50 120s, p90 133s over the last 26 green runs on main"
  - "Every release.sh --apply has wedged at 'missing exact attestation key' since bfa1b4eed (2026-08-15)"
  - "cli/scripts/release.test.ts: 55 source-text assertions vs 9 real invocations"
links:
  - "https://linear.app/getrush/issue/PHNX-3696"
  - "https://github.com/phnx-labs/agi-cli/pull/3370"
---

## Purpose

The owner stated five requirements for how this repo ships. This plan traces each to
the code that must change, and fixes the one defect that currently makes requirement R2
impossible: **a mandatory release gate with no automated producer.**

### The requirements, verbatim in intent

| # | Requirement | Bar | Where it lives today | Status |
|---|---|---|---|---|
| **R1** | Required CI check, event → terminal | **< 60 s** | `.github/workflows/tests.yml` | p50 **120 s**, p90 **133 s** — 2x over |
| **R2** | Ordinary release, start → registry + install smoke | **< 60 s** | `cli/scripts/release.sh` | **never completes unattended** |
| **R3** | A CLI release rebuilds only the CLI | absolute | `release.sh` + `release.test.ts` | **held and pinned by tests** |
| **R4** | AGI Menu + computer helpers release separately | absolute | `helper-versions.ts`, `publish-*.sh` | **held** |
| **R5** | Installed CLI + helpers auto-update from the public channel | absolute | `helper-download.ts` | helpers yes; **CLI no** |

R1 and R2 are hard ceilings. R3/R4/R5 are structural — they hold or the build is wrong.
All five are now recorded as binding law in [`AGENTS.md`](../../../AGENTS.md), with two
blocking review conventions so no future agent can quietly weaken them.

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> R4 is already
done and R3 is nearly done. The work is R2 (a gate that ships without its producer),
R1 (halve a 120 s check), and R5 (the CLI cannot update itself).</aside>

## Current architecture

A release passes through six phases. Phase 4 requires an attestation for the
**release-commit tree**. CI produces one for `main` automatically; nothing produces one
for the release commit — so every release stops there and waits for a human.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 940 300" role="img" aria-label="Release pipeline showing the attestation gap at phase 4">
    <defs>
      <marker id="relArrow" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#38bdf8" /></marker>
      <marker id="relArrowDead" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#dc2626" /></marker>
    </defs>
    <text x="30" y="30" fill="#8b8b8b" font-family="JetBrains Mono, monospace" font-size="12">release.sh --apply</text>
    <rect x="30" y="52" width="120" height="62" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="90" y="78" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">1 preflight</text>
    <text x="90" y="98" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">~20s ok</text>
    <line x1="150" y1="83" x2="178" y2="83" stroke="#38bdf8" stroke-width="2" marker-end="url(#relArrow)" />
    <rect x="180" y="52" width="140" height="62" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="250" y="78" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">2 attest main</text>
    <text x="250" y="98" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">instant · from CI</text>
    <line x1="320" y1="83" x2="348" y2="83" stroke="#38bdf8" stroke-width="2" marker-end="url(#relArrow)" />
    <rect x="350" y="52" width="130" height="62" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="415" y="78" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">3 open PR</text>
    <text x="415" y="98" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">~30s ok</text>
    <line x1="480" y1="83" x2="508" y2="83" stroke="#dc2626" stroke-width="2" marker-end="url(#relArrowDead)" />
    <rect x="510" y="42" width="180" height="82" rx="8" fill="#1a0d0d" stroke="#dc2626" stroke-width="2.5" />
    <text x="600" y="68" text-anchor="middle" fill="#f5f5f5" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600">4 attest release tree</text>
    <text x="600" y="90" text-anchor="middle" fill="#dc2626" font-family="JetBrains Mono, monospace" font-size="11">STOPS HERE</text>
    <text x="600" y="110" text-anchor="middle" fill="#dc2626" font-family="JetBrains Mono, monospace" font-size="10">no producer exists</text>
    <line x1="690" y1="83" x2="718" y2="83" stroke="#3a3a3a" stroke-width="2" stroke-dasharray="4 4" />
    <rect x="720" y="52" width="90" height="62" rx="8" fill="#141414" stroke="#3a3a3a" stroke-width="1.5" />
    <text x="765" y="78" text-anchor="middle" fill="#6b6b6b" font-family="Inter, system-ui, sans-serif" font-size="13">5 tag</text>
    <text x="765" y="98" text-anchor="middle" fill="#6b6b6b" font-family="JetBrains Mono, monospace" font-size="11">unreached</text>
    <line x1="810" y1="83" x2="838" y2="83" stroke="#3a3a3a" stroke-width="2" stroke-dasharray="4 4" />
    <rect x="840" y="52" width="80" height="62" rx="8" fill="#141414" stroke="#3a3a3a" stroke-width="1.5" />
    <text x="880" y="78" text-anchor="middle" fill="#6b6b6b" font-family="Inter, system-ui, sans-serif" font-size="13">6 publish</text>
    <text x="880" y="98" text-anchor="middle" fill="#6b6b6b" font-family="JetBrains Mono, monospace" font-size="11">unreached</text>
    <rect x="180" y="176" width="300" height="76" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5" />
    <text x="330" y="202" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">attest-main.yml (CI)</text>
    <text x="330" y="222" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">attests every push to main</text>
    <text x="330" y="240" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">automated</text>
    <line x1="330" y1="176" x2="290" y2="120" stroke="#a3e635" stroke-width="2" marker-end="url(#relArrow)" />
    <rect x="510" y="176" width="300" height="76" rx="8" fill="#1a0d0d" stroke="#dc2626" stroke-width="1.5" />
    <text x="660" y="202" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">release-attestation-produce.sh</text>
    <text x="660" y="222" text-anchor="middle" fill="#dc2626" font-family="JetBrains Mono, monospace" font-size="11">"interim ... run by hand"</text>
    <text x="660" y="240" text-anchor="middle" fill="#dc2626" font-family="JetBrains Mono, monospace" font-size="11">never called by release.sh</text>
    <line x1="660" y1="176" x2="620" y2="128" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#relArrowDead)" />
    <text x="600" y="285" text-anchor="middle" fill="#6b6b6b" font-family="Inter, system-ui, sans-serif" font-size="11" font-style="italic">the human errand this plan deletes</text>
  </svg>
  <figcaption><b>Figure 1.</b> Phases 1–3 pass in ~50 s. Phase 4 requires proof for the release-commit tree; CI attests only <code>main</code>, and the producer that would attest the release commit is a manual script <code>release.sh</code> never invokes. Measured live on 2026-09-01.</figcaption>
</figure>

### Why review did not catch it

`bfa1b4eed` replaced the test guarding the working mechanism with assertions that the
working mechanism is **gone**:

```diff title=cli/scripts/release.test.ts
@@ release.sh attestation promotion (RUSH-2666) @@
-    expect(RELEASE_SH).toContain('wait_for_ci_green "$PR_NUMBER" "$RELEASE_CI_HEAD"');
-    expect(RELEASE_SH).toContain('wait_for_ci_green "$MERGED_RELEASE_PR" "$CI_TESTED_HEAD"');
+    expect(RELEASE_SH).not.toContain('wait_for_ci_green');
+    expect(waitFunction).toContain('release-attestation.sh require');
```

`RELEASE_SH` is the script read as a **string**. The suite greps source text — 55
source-string assertions against 9 real invocations — so it proves the gate is wired and
never that the gate can be satisfied.

## Proposed Changes

<div class="artifact-behavior">
<div class="artifact-behavior-panel" data-state="current" data-evidence="capture">

**Today — `release.sh 1.22.69 --apply`**

```console
[1/6] Preflight + version validation      ✓ zion
      mac-mini can promote + publish      ✓
[2/6] Require origin/main attestation     ✓ from CI
[3/6] Open release PR                     ✓ PR #3370
[4/6] Require release-tree attestation
error: missing exact attestation key:
  tree=5859dbf3... suite=selected

  -> operator hand-runs release-attestation-produce.sh
  -> operator copies .tgz + .json into the store
  -> operator re-runs release.sh
```

Unattended completion: **never**.
</div>

<div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">

**Proposed — same command**

```console
[1/6] Preflight + version validation      ✓ zion
      mac-mini can promote + publish      ✓
[2/6] Require origin/main attestation     ✓ from CI
[3/6] Open release PR                     ✓ PR #3370
[4/6] Derive release-tree attestation     ✓ inherited
      base be52cafd -> tree 5859dbf3
      diff within allowlist, suite reused
[5/6] Tag v1.22.69                        ✓
[6/6] Promote + publish (mac-mini)        ✓ 1.22.69

published in 48s
```

Unattended completion: **every time**.
</div>
</div>

### R2 — `release.sh` derives its own release-tree attestation

`--inherit-suite-from` already exists (PHNX-3237) and is sound precisely here: the
release commit differs from `main` only by files inside the derive allowlist. Verified
by hand on 2026-09-01 — derived on a Linux worker in seconds, tarball byte-exact
`sha256:168351f4…fd804`.

```diff title=cli/scripts/release.sh
@@ wait_for_attestation() @@
   # A release commit differs from its attested base ONLY by the version bump,
   # the folded changelog, and the regenerated command index -- exactly the set
-  # `release-attestation.sh derive` allowlists. Nothing produced that record, so
-  # the release stopped here and waited for an operator (RUSH-2666 / PHNX-3696).
+  # `release-attestation.sh derive` allowlists, so it is derivable with no suite
+  # re-run. Producing it here is what makes an unattended release possible.
+  if ! scripts/release-attestation.sh require --dir "$store" --tree "$tree" \
+       --repo-root "$REPO_ROOT" >/dev/null 2>&1; then
+    base="$(scripts/release-attestation.sh require --dir "$store" \
+              --tree "$(git rev-parse "$BASE_REF^{tree}")" --repo-root "$REPO_ROOT")" \
+      || die "no attested base for $BASE_REF -- attest-main.yml has not produced one yet"
+    scripts/release-attestation-produce.sh "$RELEASE_COMMIT" \
+      --inherit-suite-from "$base" --dir "$store" \
+      || die "could not derive the release-tree attestation from $base"
+  fi
```

### R1 — halve the required check

Today's 120 s is spent on work that does not depend on the diff. The Aug-15 plan's
affected-test selection is the load-bearing change and is unchanged by this plan; what
this plan adds is the **budget** (60 s, down from 90 s) and the measurement that says
where the remaining 120 s goes before optimising blind.

### R3 — already satisfied, no work

Verified while implementing R2: `cli/scripts/release.test.ts` §"an ordinary release is
CLI-only" already asserts the ordinary path does **not** touch the helper manifest, does
**not** rebuild or notarize, and that `--with-helpers` defaults OFF. An earlier draft of
this plan claimed R3 needed a new pin; that was wrong, and no R3 task is proposed.

### R5 — the CLI updates itself

Helpers already self-download against `cli/src/lib/helper-versions.ts`. The CLI has
neither a self-update check nor a Homebrew formula — the only `homebrew` string on the
release path is an unrelated comment. This is genuinely new work and is scoped as its
own deliverable, not bundled into the R2 fix.

## Public Interface

```bash
# unchanged -- the point is that no new step appears
agents-cli$ cli/scripts/release.sh <version> --apply

# no longer required by a human:
#   scripts/release-attestation-produce.sh <commit> --inherit-suite-from <base.json>
```

## Validation

| Check | Expected result |
|---|---|
| `release.sh --apply` on a clean tree | reaches publish with **zero** human steps |
| Derived attestation | `candidateTree` == release-commit tree; `derivedFrom.baseTree` == attested main |
| Tarball bind | promoted `.tgz` sha256 equals the attestation's recorded digest |
| Allowlist guard | a code file in the release diff makes `derive` **fail closed**, not pass |
| R3 pin | ordinary release path invokes no `codesign` / `notarytool` / menubar build |
| Release test honesty | new coverage **executes** `release.sh`; does not grep `RELEASE_SH` |

## Risks

| Risk | Mitigation |
|---|---|
| Auto-derive weakens the supply-chain guarantee | It does not: `derive` fails closed unless the tree diff is inside the allowlist (`package.json`, `.changelog/**`, `CHANGELOG.md`, `docs/command-index.*`). A code change still demands a real suite. |
| No attested base when releasing | Fail loud naming `attest-main.yml`, never silently fall back to an unattested tree. |
| Deriving on macOS trips the sign step | Producer skips signing off-macOS; PHNX-3631 (BSD `mktemp`) is a separate open bug — derive on the Linux lane. |
| 60 s R1 target forces test deletion | `AGENTS.md` already forbids removing tests that protect a distinct invariant; move slow suites post-merge instead. |

## Checklist

- [x] Trace R1–R5 to the code that owns each
- [x] Record R1–R5 as binding law in `AGENTS.md` + two blocking review conventions
- [x] Blame the regression to `bfa1b4eed` with the diff that hid it
- [x] File PHNX-3696
- [ ] R2 — `release.sh` derives its own release-tree attestation
- [ ] R2 — test that executes the release path instead of grepping it
- [x] R3 — verified already pinned by `release.test.ts` (no work needed)
- [ ] R1 — measure where the 120 s goes, then cut to 60 s
- [ ] R5 — CLI self-update + public channel

## Tracking

- PHNX-3696 — attestation gate has no automated producer (blocks R2)
- PHNX-3631 — BSD `mktemp` collision blocks the macOS attestation producer
- PR #3370 — the 1.22.69 release this defect stalled
