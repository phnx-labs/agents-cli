---
kind: plan
title: "Refactor apps/cli — reconciled panel plan"
surface: internal
---

# Refactor apps/cli — reconciled from a 3-panelist review

## Focus for review

Pick which moves to greenlight — this is a big refactor of a shipping CLI, so scope is yours:

1. **Move 1 first, always.** All three panelists rank *break the 38-module import cycle* as #1 and gate every other structural move on it. Land it as its own 2–3 PR track before anything else?
2. **Move 2 — one launch planner + registry.** `exec.ts` and `runner.ts` each carry their own per-harness `if (agent === 'claude'/'codex'/…)` mode/argv table. Fold them into one planner, then route the **455 bypassed harness arms** through the `AGENTS` registry (the pattern the just-merged #2689/#2685 already set). Greenlight now, or hold until Move 1 lands?
3. **How far down the list?** Moves 3–5 (draw `src/lib` boundaries → shrink the CLI surface → extract `lib/terminal`) are all gated on Move 1 and sequence around in-flight PR #2621. Land all five as a track, or stop after 1–2?
4. **Two bugs → tickets, not this refactor:** double `computer` registration, and the ext reading a harness-native store directly. File them separately?

## Purpose

You invoked `/code:refactor --teams grok,codex,kimi,claude` on `apps/cli`: measure the codebase, have four independent harnesses each propose a ranked, sequenced refactor against the *same* evidence, then reconcile into one plan for your pick. The panel settled 3 done / 1 failed (grok produced nothing); this reconciles codex, kimi, and claude. **No code was changed** — every panelist re-checked its claims read-only against live `HEAD` (`e38f58464`, still current).

What the depth-3 module measurement found (`.agents/artifacts/2026-08-15/refactor-080727/`, coverage 1.0):

| Metric | Value | Source |
|---|---|---|
| Modules / edges | 49 / 200 | `modules.json` |
| Import cycles | **1 cycle of 38 modules** | `modules.json cycles[0]` |
| God module `src/lib` | fan_in **1117**, 195 files, 90k LOC, api_ratio 0.84 | `god_modules` |
| God module `src/lib/session` | fan_in 251, 61 files, cohesion 0.53 | `god_modules` |
| God module `src/lib/devices` | fan_in 110, cohesion 0.40, api_ratio 1.0 | `god_modules` |
| Provider-pattern families | 103 — **2 exemplars, 10 bypassed**, 1943 collapsible arms | `patterns.json` |
| Bypassed harness arms | `agent` **287** + `agentId` **168** = **455** route around `AGENTS` | `patterns.json` |
| CLI surface | **346 commands**, 46 top-level, 27 undocumented, 74 untested, 7 orphans, 19 recursive paths | `surface.json` |
| Extraction candidate | `lib/terminal` cohesion 0.84, 17 files — has an exemplar backend registry | `extraction_candidates` |

The shape: one 38-module strongly-connected component welds `src/commands` to most of `src/lib` because **library code imports command implementations** (upward edges). `src/lib` is a flat 195-file bucket with no real internal boundaries, and the harness-dispatch logic that a registry is *supposed* to own is instead 455 hand-written `if (agent === …)` arms.

## Proposed Changes

### The cycle, before and after

<figure>
<svg viewBox="0 0 900 340" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Before and after module dependency direction" font-family="ui-monospace, monospace">
  <defs>
    <marker id="aB" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="aA" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>

  <text x="20" y="24" fill="currentColor" font-size="13" font-weight="700" font-family="ui-sans-serif, system-ui">BEFORE — one 38-module SCC (library imports commands)</text>
  <rect x="30" y="44" width="150" height="40" rx="6" fill="#dc262622" stroke="#dc2626" stroke-width="1.5"/><text x="46" y="69" fill="currentColor" font-size="13" font-weight="600">src/commands</text>
  <rect x="30" y="150" width="150" height="46" rx="6" fill="#dc262622" stroke="#dc2626" stroke-width="1.5"/><text x="40" y="170" fill="currentColor" font-size="13" font-weight="600">lib/startup</text><text x="40" y="187" fill="currentColor" font-size="11">command-registry</text>
  <rect x="30" y="250" width="150" height="46" rx="6" fill="#dc262622" stroke="#dc2626" stroke-width="1.5"/><text x="52" y="270" fill="currentColor" font-size="13" font-weight="600">src/lib</text><text x="36" y="287" fill="currentColor" font-size="10">session ⇄ devices ⇄ terminal</text>
  <path d="M105,150 L105,86" fill="none" stroke="#dc2626" stroke-width="1.6" marker-end="url(#aB)"/><text x="112" y="120" fill="currentColor" font-size="11">83 up-imports</text>
  <path d="M85,250 L85,198" fill="none" stroke="#dc2626" stroke-width="1.6" marker-end="url(#aB)"/>
  <path d="M150,250 C210,230 210,120 150,86" fill="none" stroke="#dc2626" stroke-width="1.6" marker-end="url(#aB)"/><text x="190" y="175" fill="currentColor" font-size="11">back-edges</text>

  <line x1="450" y1="20" x2="450" y2="320" stroke="#9ca3af" stroke-dasharray="4 4"/>

  <text x="480" y="24" fill="currentColor" font-size="13" font-weight="700" font-family="ui-sans-serif, system-ui">AFTER — layered, acyclic</text>
  <rect x="500" y="44" width="230" height="40" rx="6" fill="#16a34a22" stroke="#16a34a" stroke-width="1.5"/><text x="512" y="61" fill="currentColor" font-size="13" font-weight="600">src/cli</text><text x="512" y="77" fill="currentColor" font-size="10">bootstrap + command registry</text>
  <rect x="500" y="140" width="230" height="40" rx="6" fill="#16a34a22" stroke="#16a34a" stroke-width="1.5"/><text x="512" y="164" fill="currentColor" font-size="13" font-weight="600">src/commands (thin adapters)</text>
  <rect x="500" y="230" width="230" height="46" rx="6" fill="#16a34a22" stroke="#16a34a" stroke-width="1.5"/><text x="512" y="250" fill="currentColor" font-size="13" font-weight="600">src/lib</text><text x="512" y="267" fill="currentColor" font-size="10">session · devices · terminal · …</text>
  <path d="M615,140 L615,84" fill="none" stroke="#16a34a" stroke-width="1.6" marker-end="url(#aA)"/>
  <path d="M615,230 L615,180" fill="none" stroke="#16a34a" stroke-width="1.6" marker-end="url(#aA)"/>
  <text x="740" y="253" fill="currentColor" font-size="10">serializers +</text><text x="740" y="268" fill="currentColor" font-size="10">types live here</text>
</svg>
<figcaption>Direction, not deletion: command-independent serializers/types move down into their lib domain; the command registry lifts to a top-level <code>src/cli</code> layer. Cycle 1 → 0.</figcaption>
</figure>

<div class="artifact-callout">
The lead move is not a rewrite — it is <strong>reversing import direction</strong>. Move only command-independent serializers and types down into the <code>lib</code> domain they already describe, and lift the bootstrap up. Every panelist gates package extraction on this landing first.
</div>

The upward edges that close the cycle, exactly:

```ts
// library code importing command implementations — the edges to invert
lib/startup/command-registry.ts  →  import('../../commands/view.js')  // ×46, lazy
lib/menubar/snapshot.ts          →  buildRoutineListJson from '../../commands/routines.js'
lib/factory/snapshot.ts          →  serializeActiveSessionsForJson from '../../commands/sessions.js'
lib/computer/dispatch.ts         →  emitComputerAction from '../../commands/computer-actions.js'
lib/snapshot.ts                  →  type ViewJsonAgent from '../commands/view.js'
```

### Where the panelists agreed (and where they split)

Three independent harnesses, same evidence. Convergence was tight:

| Claim / move | codex | kimi | claude | Reconciled |
|---|---|---|---|---|
| Break the 38-module cycle | #1 | #1 | #1 | **Move 1 — unanimous lead, gates all structure** |
| Route 455 bypassed harness arms via `AGENTS` | #3 | #3 | #2 | **Move 2b — unanimous** |
| Unify `exec.ts`/`runner.ts` launch planning (C1 drift) | #2/#5 | #4 | folded | **Move 2a — front of Move 2** |
| Draw `src/lib` / `session` / `devices` boundaries | #3/#4/#6 | #4 | #3 | **Move 3 — unanimous, gated on 1** |
| Shrink the 346-command surface | note | #6 | #4 | **Move 4 — after in-flight #2621** |
| Extract `lib/terminal` package | dropped (in SCC) | #5 | #6 | **Move 5 — LAST, gated on 1** |
| C5 harness registry drifted | drifted | drifted | drifted | **Consensus: drifted → Move 2** |
| host/device, session, account/profile merges | keep distinct | keep distinct | keep distinct | **Consensus: do NOT merge; Move-3 seams** |
| `backend` family (terminal+secrets) | don't merge | don't merge | don't merge | **Consensus: two concepts, never force-merge** |

The one real disagreement — **C1 "one execution engine"**: codex graded it *drifted* (`runner.ts:580` builds its own command + `runner.ts:585-676` its own per-harness mode table, bypassing `buildExecEnv`); claude/kimi graded it *holds* (runner wraps exec). Both are right about the facts: `runner.ts` *does* call `buildExecEnv` **and** carries a second mode-translation table. That duplication is exactly Move 2a. The other split verdicts (C2, C7, C8) were **measurement artifacts** — the surface walker never expanded the `computer` subtree (a separate `src/computer.ts` binary), so "browser/computer parity" only looked broken; kimi confirmed the verbs match by running `computer --help`. None of those became moves.

### The plan — 5 moves, sequenced

Skill dependency order: **cycle → merge/contract → boundary → surface → package.** Each move is behavior-preserving.

**Move 1 — Break the 38-module cycle · rank #1 · gates 3 & 5.** Invert the upward `lib → commands` edges. Lift `lib/startup/command-registry.ts` (83 lazy `import('../../commands/…')`) into a top-level `src/cli` bootstrap layer; move command-independent serializers/types down into their `lib` domain homes. ≥2 PRs, moves-only diffs.

**Move 2 — One launch planner, then route 455 arms through `AGENTS` · rank #2.**
- *2a.* Fold `runner.ts`'s per-harness argv/mode table (`:585–676`) into the `exec.ts` launch planner so there is **one** planner. `runner.ts` keeps routine lifecycle + detached spawn; it stops owning a second mode table. (Excludes Codex Cloud transport — a provider op, not a local launch.)
- *2b.* Collapse the remaining `agent`/`agentId` hand-branches into registry lookups / capability rows, following the **already-merged** #2689 (`PERMISSION_TARGETS`) and #2685 (`MCP_TARGETS`) exemplars. Scope **out** permissions/mcp (done) and the polluted generic `agent` arms; lead with the clean `agentId` family (168 arms, 0.96 concentration).

**Move 3 — Draw boundaries inside `src/lib` · rank #3 · gated on Move 1.** Split the god modules on real seams, one boundary per PR: `lib/session` on the **transcript (`db.ts`) vs live-identity (`active.ts`)** seam the docs already name; `lib/devices` behind its registry; group the execution root files. Consolidate into existing homes — no new `utils`, no package yet.

**Move 4 — Shrink the CLI surface · rank #4 · after in-flight #2621.** Scope to the safe wins: 7 orphan candidates, the `timeline` alias (RUSH-2692), the phantom `profile <preset>` entries, the `--host`/`--device` focus-flag alias, the 19 recursive paths. Deprecation aliases, not hard deletes; **grep the companion `.agents-system` repo for every name before removing it.**

**Move 5 — Extract `lib/terminal` into a package · rank #5 (LAST) · gated on Move 1.** `lib/terminal` is cohesive (0.84) and already has the exemplar `backends/index.ts` registry — but it sits **inside** the SCC, so extraction is illegal until Move 1 lands. Expose only the backend registry + inject API. **Do NOT fold the secrets `backend` family in** — it's a different concept (22 arms in secrets vs 9 in terminal).

## Public Interface

**No user-visible CLI change is intended by Moves 1–3 and 5** — they are behavior-preserving structural moves (moved files, inverted imports, one launch planner). The `agents --help` tree, every `--json` surface, and all argv/version-home/mode behavior stay byte-identical; that invariance *is* the acceptance test.

The two interfaces that do change are internal-contract, not user-facing:

- **The `AGENTS` registry becomes the single harness-dispatch contract** (Move 2). Adding a harness moves from editing 455 scattered `if (agent === …)` arms to declaring one registry row + capability flags — the same shape #2689/#2685 already shipped for permissions/mcp.
- **`src/cli` appears as a new top-level bootstrap layer** (Move 1); `src/commands` becomes thin adapters over `lib` domain functions.

**Move 4 is the only one with a user-visible surface delta** — it removes/aliases orphan and duplicate commands (`timeline`, `profile <preset>`, `--device` focus flag). Each ships a deprecation alias, and every removed name is grepped across the companion `.agents-system` repo first, so no external caller breaks silently.

## Validation

Every move proves behavior preservation the same way, per move:

```bash
bun run test:remote        # full vitest suite, offloaded to a crabbox (laptop-safe)
# then re-run the module graph and diff the measured surfaces:
node scripts/modules.ts    # Move 1/3/5: assert cycles 1→0, fan_in/api_ratio drop, no NEW cycle
agents-dev --help          # Move 1/4: help tree still lists all expected commands
```

| Move | Behavior-preservation proof |
|---|---|
| 1 | `modules.ts`: `cycles 1 → 0`; `agents --help` lists all 46 top-level; moves-only `git diff` |
| 2a | table-driven real-path argv assertions for every agent × supported mode; `exec.test.ts` + `runner.test.ts` compare generated argv / cwd / version-home / mode before-after |
| 2b | capability completeness tests equate registry keys with launch-capable agents; two harnesses exercised per migrated site |
| 3 | `fan_in` / `api_ratio` drop on the split module; **no new cycle**; normalized `sessions --json` / `--active --json` byte-equal |
| 4 | `surface.ts` command-count drop; companion-repo caller grep clean for every removed name |
| 5 | all inbound edges route through the package API; terminal + secrets tests green |

## Risks

- **Cross-cutting import churn (Moves 1, 3).** Inverting the cycle and grouping `src/lib` touches many import paths; a bad move looks like a build break, not a behavior change. Mitigation: moves-only diffs (`git diff --stat` shows renames, zero semantic edits), one boundary per PR, module-graph re-run gating each.
- **Registry migration hiding a per-harness quirk (Move 2).** Collapsing 455 arms can silently drop a harness-specific special case. Mitigation: lead with the clean `agentId` family (0.96 concentration), migrate per-site, and assert exact argv for every agent × mode — never a bulk sweep of the polluted generic `agent` arms.
- **Deleting a surface an external caller depends on (Move 4).** `orphan_candidate` is a *candidate* list; names resolved dynamically or consumed by companion repos are invisible to the census. Mitigation: deprecation aliases (never hard deletes), and a mandatory `.agents-system` grep per name before removal.
- **Extracting a module still inside the cycle (Move 5).** Extracting `lib/terminal`, `lib/monitors`, or `lib/self-heal` before Move 1 would package the SCC rather than remove it. Mitigation: hard gate — no package extraction until `cycles = 0`.
- **Sequencing collision with in-flight PRs.** Move 4 overlaps #2621 (nest top-level commands, open); Move 2 builds on #2689/#2685 (both merged). Mitigation: land Move 4 after #2621; Move 2 reuses the already-merged registry exemplars.

**Not refactor PRs — file as tickets:**

- Double `computer` registration (`commands/computer.ts:112` + `setup-computer.ts:138`) — verify canonical.
- `apps/ext/src/vscode/sessions.vscode.ts:732` reads a harness-native store (Cursor chat DB) directly — ext-scope consumer-contract note, not an `apps/cli` move.

### Checklist

- [ ] Move 1 — break the 38-module cycle (≥2 PRs) · **gates 3 & 5**
- [ ] Move 2a — fold `runner.ts` mode table into the `exec.ts` launch planner
- [ ] Move 2b — route the 455 bypassed harness arms through `AGENTS`
- [ ] Move 3 — draw `src/lib` / `session` / `devices` boundaries (one per PR)
- [ ] Move 4 — shrink the CLI surface (after #2621; companion-repo grep first)
- [ ] Move 5 — extract `lib/terminal` package (last)
- [ ] File 2 tickets — double `computer` registration; ext direct store read
