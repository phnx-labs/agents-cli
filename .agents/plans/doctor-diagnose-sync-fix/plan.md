---
kind: plan
title: "doctor diagnoses, sync fixes — collapse the two reconcile paths"
surface: cli
summary: >
  Make `agents doctor` diagnose-only and `agents sync` the single fixer (a superset of
  what `doctor --fix` does today), with no new `agents fix` verb. Collapses two divergent
  reconcile orchestrators (sync.ts vs heal.ts) into one tested path — the likely root of
  config drift across the fleet.
---

# doctor diagnoses, sync fixes — collapse the two reconcile paths

## Purpose

`doctor --fix` and `sync` are **two independent orchestrators over one shared low-level
writer** (`syncResourcesToVersion`, `lib/installations/versions.ts`). They diverge in policy —
`sync` prunes and verifies against the staleness manifest; `heal()` (what `doctor --fix` runs)
is additive-only and diff-driven against the live home. Two fix paths that can disagree is a
drift generator, and the command surface is already inconsistent: `doctor` routes *some*
findings to `agents sync --yes` and *others* to `agents doctor --fix`
(`doctor.ts:906,917` vs `doctor.ts:1097`).

**Goal (locked):** `doctor` = diagnose only, so *identification* is a pure, testable
`state → issues` function. `sync` = the one fixer, so *fixing* has a single hardened path.
**No new `agents fix` verb** — less surface, not more.

| Command | Today | After |
|---|---|---|
| `agents doctor` | diagnoses **and** mutates (`--fix`) | diagnoses only; every fix points at `agents sync …` |
| `agents sync` | fixes resources, but **not** shim-repair / home-rot | the single fixer — superset of `doctor --fix` |
| `agents fix` | — | **not created** |

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="mockup">
    <strong>Today — doctor both diagnoses and fixes, inconsistently</strong>
    <pre><code>$ agents doctor
  ⚠ hook shim source mismatch  → agents doctor claude --fix
  ⚠ never synced (5 resources) → agents sync claude@all --yes
       # two different fixers suggested for one diagnosis run

$ agents doctor claude --fix     # doctor MUTATES (heal + 3 extra passes)</code></pre>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <strong>After — doctor only diagnoses; sync is the one fixer</strong>
    <pre><code>$ agents doctor
  ⚠ hook shim source mismatch  → agents sync claude@all
  ⚠ never synced (5 resources) → agents sync claude@all
       # every finding points at the same command

$ agents sync claude@all         # the ONE fixer (now repairs shims too)</code></pre>
  </div>
</div>

## Current architecture

One shared writer, two orchestrators on top of it:

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 780 360" role="img" width="100%" aria-label="Before: doctor and sync are two separate orchestrators over one writer. After: doctor only diagnoses and points at sync, the single fixer." xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif">
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>

  <text x="20" y="26" fill="currentColor" font-size="12" font-weight="700" opacity="0.6">BEFORE — two fix paths</text>
  <rect x="20" y="44" width="150" height="40" rx="6" fill="none" stroke="#d9534f" stroke-width="1.5"/>
  <text x="30" y="62" fill="currentColor" font-size="13">doctor --fix</text><text x="30" y="77" fill="currentColor" font-size="11" opacity="0.7">heal + 3 passes</text>
  <rect x="20" y="150" width="150" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="30" y="168" fill="currentColor" font-size="13">sync</text><text x="30" y="183" fill="currentColor" font-size="11" opacity="0.7">prune + write</text>
  <rect x="20" y="270" width="290" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="30" y="290" fill="currentColor" font-size="13">syncResourcesToVersion</text><text x="30" y="305" fill="currentColor" font-size="11" opacity="0.7">shared low-level writer</text>
  <path d="M95 84 L95 268" fill="none" stroke="#d9534f" stroke-width="1.5" marker-end="url(#a)"/>
  <path d="M120 190 L150 268" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="182" y="112" fill="currentColor" font-size="11" opacity="0.7">shim-repair, home-rot,</text>
  <text x="182" y="127" fill="currentColor" font-size="11" opacity="0.7">stale-CLI purge —</text>
  <text x="182" y="142" fill="#d9534f" font-size="11">only doctor --fix has these</text>

  <line x1="400" y1="30" x2="400" y2="330" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.4"/>

  <text x="440" y="26" fill="currentColor" font-size="12" font-weight="700" opacity="0.6">AFTER — one fixer</text>
  <rect x="440" y="44" width="150" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="450" y="62" fill="currentColor" font-size="13">doctor</text><text x="450" y="77" fill="currentColor" font-size="11" opacity="0.7">diagnose only</text>
  <rect x="440" y="150" width="150" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="450" y="168" fill="currentColor" font-size="13">sync</text><text x="450" y="183" fill="currentColor" font-size="11" opacity="0.7">reconcileAndRepair</text>
  <rect x="440" y="270" width="300" height="44" rx="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <text x="450" y="290" fill="currentColor" font-size="13">writer + heal + shim-repair</text><text x="450" y="305" fill="currentColor" font-size="11" opacity="0.7">one shared, tested path</text>
  <path d="M515 84 L515 148" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#a)"/>
  <text x="524" y="120" fill="currentColor" font-size="11" opacity="0.7">"run agents sync"</text>
  <path d="M515 190 L515 268" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#a)"/>
</svg>
<figcaption>Two orchestrators with divergent policy (heal never prunes, sync does) collapse into one: doctor points at sync, sync owns every repair.</figcaption>
</figure>

- **`sync`** → calls `syncResourcesToVersion` directly (`sync.ts:518,874,1016,1087`),
  manifest-driven, **prunes** orphans, runs a post-write `verifyReconciled` convergence check.
- **`doctor --fix`** → `runFix()` (`doctor.ts:1438`) → **`heal({mode:'full'})`** (`lib/heal.ts:359`),
  diff-driven, **never deletes**. Then three more passes `sync` never runs:

```
runFix (doctor.ts:1438)
  ├─ heal({ mode: 'full' })              # home-rot + plugin-manifest repair + stale-plugin refresh
  ├─ rewireUnwiredHooks()                # re-wire present-but-unwired hooks
  ├─ repairManagedHookRuntimeArtifacts() # THE shim "source mismatch" fixer  ← sync lacks this
  └─ purgeStaleAgentsCliCopies()         # machine-wide, bare `doctor --fix` only
```

> `sync` is **NOT** a superset of `doctor --fix` today. Critically it never calls
> `repairManagedHookRuntimeArtifacts` — the fixer for the "hook shim source mismatch" findings
> (the 57 CRITICAL on yosemite-s1). `heal()` also powers the self-heal daemon at `mode:'safe'`,
> which **must keep working** untouched.
{.artifact-callout}

## Proposed Changes

Mandatory order — **make `sync` the superset FIRST, then strip `doctor`**; reversed, the
shim-mismatch briefly has no fixer.

1. **New shared step `reconcile-and-repair.ts`** (additive, low risk). Export
   `repairAfterSync({ agent, versions, cwd, pruneClis, purgeInjection })` that runs, over the
   agents/versions sync just touched: `heal({ mode:'full' })` →
   `repairManagedHookRuntimeArtifacts({ filter })` → hook-rewire. Sync's own prune+write runs
   first (unchanged); repair runs after, so prune stays sync's job and heal only fills/fixes.
   The destructive stale-CLI purge is **not** part of this automatic set (see item 2).
2. **Wire it into every sync handler** — `runInteractiveReconcile` (`sync.ts:427`),
   `runUmbrella` (`sync.ts:571`), `runSync` (`sync.ts:680`). The drift-fixers (heal + rewire +
   shim repair) run on **every** sync path. The **destructive** machine-wide
   `purgeStaleAgentsCliCopies` (it `fs.rmSync`s OTHER agents-cli installs) is **NOT** automatic:
   it runs only on the umbrella path AND only when the user passes the new opt-in
   `agents sync --prune-clis` flag (`pruneClis` threaded into `repairAfterSync`; no new verb).
   The purge scan+delete is injectable (`purgeInjection`) so tests never touch real paths.
3. **`doctor` read-only** — remove `--fix` (`doctor.ts:1709`) and its action branch
   (`doctor.ts:1837`), delete `runFix` + the render helpers only it uses, and rewrite every
   remediation `fix:` string to point at `agents sync …` (`doctor.ts:882,906,917,1097,1106`).
   `heal()` stays for the daemon.
4. **Deprecation stub** — `doctor --fix` prints "moved to `agents sync` — run
   `agents sync <agent>@all`" and exits non-zero for one release.

## Public Interface

- `agents doctor [target]` — diagnosis only. `--fix` removed (stub for one release).
- `agents sync [agentSpec] [repo]` — unchanged invocation; now also repairs shim runtime
  artifacts + home-rot as part of its reconcile.
- `agents sync --prune-clis` — opt-in, umbrella-only: additionally runs the DESTRUCTIVE
  stale-CLI purge (deletes npx-cache / pre-1.22.30 / unsafe-helper copies when a fixed peer
  exists). Off by default — the purge NEVER runs on a routine sync.
- New internal: `repairAfterSync(...)` in `cli/src/lib/reconcile-and-repair.ts`.
- Unchanged: `syncResourcesToVersion` (writer), `heal()` `mode:'safe'` daemon caller,
  `agents prune cleanup` (still the only deleter).

## Validation

```
cd cli && bun run test          # vitest green, incl. new tests
cd cli && bunx tsc --noEmit     # compiles
```

- New `doctor.test.ts` case: every diagnostic finding's remediation command parses to an
  `agents sync …` invocation (never `doctor --fix`).
- New integration test: after `agents sync`, a seeded hook-shim source-mismatch is repaired
  (superset proof), reusing `cli/src/lib/hooks/install.test.ts` fixtures.
- `doctor.check.test.ts` (the `--check` CI gate) stays green.
- **Real-world proof:** on yosemite-s1, `agents sync claude@all` alone clears the 57
  shim-mismatch CRITICALs — something only `doctor --fix` could do before.

## Risks

| Risk | Mitigation |
|---|---|
| Removing `--fix` strands the shim fixer | Superset lands first; `--fix` removal is step 3 |
| Break the self-heal daemon (`heal` `mode:'safe'`) | Don't touch `heal()`; only add a new caller |
| Sync's prune fights heal's fill | Order: prune+write (sync) → repair (heal fills/fixes only) |
| Destructive stale-CLI purge running on every sync deletes real installs | Purge is NOT automatic — gated behind the explicit `agents sync --prune-clis`; scan+delete is injectable so tests are sandbox-scoped and never touch real paths |
| Scripts still call `doctor --fix` | One-release deprecation stub with a signpost |

## Checklist

- [ ] `reconcile-and-repair.ts` + `repairAfterSync` (superset behavior)
- [ ] Wire into `runInteractiveReconcile` / `runUmbrella` / `runSync`
- [ ] `doctor` read-only + remediation strings → `agents sync`
- [ ] `doctor --fix` deprecation stub
- [ ] Tests: doctor remediation contract + sync-repairs-shim integration
- [ ] `bun run test` + `tsc --noEmit` green
- [ ] PR opened with run evidence; code-reviewer verdict; rebase-merge on green
- [ ] Prove on yosemite-s1: `agents sync claude@all` clears the 57 CRITICALs

## Tracking

- Worktree: `agents-cli/.agents/worktrees/doctor-diagnose-sync-fix`
- Branch: `doctor-diagnose-sync-fix`
- PR: _(pending)_
