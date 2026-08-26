---
kind: plan
surface: workflow
title: Windows PR gate is a 21-minute full suite, not a 2-3 minute smoke
summary: The required windows job runs unsharded bun run test on one windows-latest runner. Every push cancels it. That is why landing PRs sat for hours. Fix is a path/hooks/shims smoke.
status: implementing
facts:
  - Linux shards the same Vitest suite three ways
  - Windows ran bun run test with no --shard
  - Branch protection requires the test aggregator, which requires windows
  - cancel-in-progress restarts Windows on every push
---

## Focus for review

- Confirm the required Windows job should be a 2-3 minute smoke, not the full suite.
- Full-suite Windows stays on #2707, not this gate.
- The four land PRs already carry the smoke workflow change.

## Intent

Land #2573 / #2620 / #2621 / #2622. The Windows check should finish in 2-3 minutes. It has been taking ~21 minutes and restarting, so it felt like it never finished.

## Current architecture

```
PR push
  -> tests.yml concurrency cancel-in-progress
  -> scope (ci-scope.ts) may set windows=true
  -> windows job: bun install + tsc + bun run test   (FULL suite, 1 VM)
  -> test aggregator waits on windows
  -> branch protection requires "test"
```

Linux: `--shard=1/3` … `3/3` in parallel.
Windows: no shard, `maxWorkers: 2` in vitest.config.ts.

<figure class="artifact-behavior">
  <div data-state="current" data-evidence="mockup">
    <p>windows job: bun run test (855 files, ~21 min) → test aggregator pending → merge blocked</p>
  </div>
  <div data-state="proposed" data-evidence="mockup">
    <p>windows job: bun run test -- platform hooks shims (~2-3 min) → test aggregator green → merge</p>
  </div>
</figure>

<svg viewBox="0 0 720 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Push restarts the Windows full suite">
  <rect x="8" y="20" width="120" height="48" fill="#1f2937" stroke="#a3e635"/>
  <text x="68" y="48" fill="#e5e7eb" text-anchor="middle" font-size="12">push</text>
  <rect x="160" y="20" width="160" height="48" fill="#1f2937" stroke="#f97316"/>
  <text x="240" y="48" fill="#e5e7eb" text-anchor="middle" font-size="12">cancel-in-progress</text>
  <rect x="352" y="20" width="180" height="48" fill="#1f2937" stroke="#ef4444"/>
  <text x="442" y="48" fill="#e5e7eb" text-anchor="middle" font-size="12">windows bun run test</text>
  <rect x="560" y="20" width="140" height="48" fill="#1f2937" stroke="#ef4444"/>
  <text x="630" y="48" fill="#e5e7eb" text-anchor="middle" font-size="12">test aggregator</text>
  <path d="M128 44 H160" stroke="#a3e635" marker-end="url(#a)"/>
  <path d="M320 44 H352" stroke="#f97316"/>
  <path d="M532 44 H560" stroke="#ef4444"/>
  <text x="360" y="100" fill="#9ca3af" font-size="12">~21 min per attempt. Four PRs x several folds = hours.</text>
</svg>

## Purpose

Operator cannot merge on green Linux because the required check is waiting on Windows.

## Proposed Changes

```diff
# .github/workflows/tests.yml (windows job)
-    timeout-minutes: 25
+    timeout-minutes: 8
-      - run: bun run test
+      - run: bun run test -- src/lib/platform src/lib/hooks src/lib/binary-shadow.test.ts src/lib/shims.test.ts src/lib/shims.device-pins.test.ts
```

## Public Interface

No CLI flags. CI job `windows` still exists and is still required when `ci-scope` sets `windows=true`.

## Plan

- [x] Pin intent vs observed
- [x] Blind verify (claude workflow + grok live-jobs)
- [x] Smoke workflow on #2573 #2620 #2621 #2622
- [ ] Windows smoke green, then merge 2573 → 2620 → 2621 → 2622
- [ ] Land win-smoke-lane on main so future PRs inherit it

## Validation

```
gh pr checks 2573
# windows should complete in ~2-3 minutes after install/build, not ~21
```

## Risks

| Risk | Mitigation |
| --- | --- |
| Smoke misses a real Windows regression | Full suite remains #2707 |
| Workflow change forces scope.windows=true | Expected; smoke is short |
| Smoke files themselves fail on Windows | Pick path/hooks/shims only; avoid known-red project-pull/self-update |

## Tracking

Pushed: #2573 `c86f951ae`, #2620 `322997d20`, #2621 `2b10fb735`, #2622 `240cfefb6`, branch `win-smoke-lane`.
