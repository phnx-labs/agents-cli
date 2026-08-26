---
kind: plan
title: agents-cli apps/cli — what else to clean up
summary: First real module graph of apps/cli. The leftover 190-file src/lib hub is a 43-module cycle; two launch tables still encode one decision; hooks.ts and the session files are still too big to hold.
header: code:refactor
footer: Scan-only. Structural moves wait for a pick.
project: agents-cli
context: apps/cli dominant package at origin/main e8578bcd4
repository: phnx-labs/agents-cli
branch: main
status: draft
surface: internal
facts:
  - '55 modules, 288 edges, 1 cycle of 43'
  - 'src/lib 190 files, 68,796 LOC, fan-in 1,087, api_ratio 0.88'
  - 'commands → src/lib x532'
  - '354 CLI commands, 0 orphans'
  - 'agent family bypassed: 261 arms, contract already exists'
links:
  - https://github.com/phnx-labs/agents-cli/pull/2793
  - url: https://linear.app/phnx/issue/RUSH-2833
    label: RUSH-2833
---

## Focus for review

Pick which structural moves to land. Scan-only; nothing has been moved.

1. **Hub drain first?** The 43-module cycle is a star through `src/lib` (190 files, fan-in 1,087, commands→lib x532). Extracting `lib/terminal` is blocked until this drops.
2. **Merge the two launch tables now?** `AGENT_COMMANDS` and `ROUTINE_AGENT_COMMANDS` are the same decision. The Aug 17 rank-1 move never landed.
3. **How far to split this round?** hooks.ts (3,898) and `commands/sessions.ts` (6,161) are the files agents actually edit. Secrets-backend contract is optional.

## Purpose

`/code:refactor` on `apps/cli` after the Aug 17 multi-repo scan, with the question *what else should we clean up*. That earlier run reported **0 module edges and 0 agent reads** for this package — a degraded graph. This run used `--scope apps/cli --depth 3`, the live `sessions.db`, and the installed `agents` 1.22.41 binary matching HEAD `e8578bcd4`.

What landed since Aug 17: `lib/installations/` and `lib/daemon/` already exist (versions.ts and migrate.ts moved). PR #2793 is already repointing stale citations. What did **not** land: the two launch tables, the hooks.ts split, or draining the rest of the `src/lib` junk drawer.

## Intent

Keep the claimed architecture (`one execution engine`, CLI owns state, ext consumes JSON) and make the **tree match it**, so an agent can change one harness or one domain without opening 190 files.

## Scorecard

| Metric | This run | Aug 17 (degraded) |
| --- | ---: | ---: |
| modules | 55 | 12 |
| module edges | 288 | 0 |
| cycles / largest | 1 / 43 | 0 / 0 |
| god modules | 3 | 0 |
| max fan-in | 1,087 (`src/lib`) | — |
| extraction candidates | 3 (all inside the cycle) | 0 |
| upward_imports | 0 (layer inference degraded: every module is `src/…`) | 0 |
| surface | 354 commands, 43 top-level, 0 orphans | 0 |
| families / bypassed / missing | 106 / 9 / 40 | 125 / 16 / 42 |
| collapsible arms | 1,810 | 2,347 |
| claims holds / drifted | 14 / 3 of 18 | — |
| files over 1,500 LOC | 43 | 47 |
| top file | `commands/sessions.ts` 6,161 | 6,159 |
| agent traffic | live (`degraded: []`) | 0 reads, 0 edits |

Coverage: 750 TS files parsed, 354 unparsed (md/yaml/swift — not missing TS). Surface census truncated 7 self-referential `--help` paths. Mode C file-level review was **not** re-run (named skip).

## Current architecture

9 of 55 modules shown — the hub subgraph every move below touches. Cycle membership is 43 of 55; the 12 outside are `pricing`, `startup`, `output`, `tickets`, benches, scripts, testdata.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 920 420" role="img" aria-label="System map: src/lib hub with 190 files and fan-in 1087, commands importing it 532 times, 43-module cycle">
    <text x="20" y="24" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="14">System map — 9 of 55 modules. Cycle = star through src/lib, not a mesh.</text>
    <rect x="340" y="150" width="240" height="88" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="2.5"/>
    <text x="460" y="178" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="13">src/lib  HUB</text>
    <text x="460" y="198" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">190 files · 68,796 LOC</text>
    <text x="460" y="216" text-anchor="middle" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">fan-in 1,087 · api 168/190</text>
    <rect x="340" y="20" width="240" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="460" y="42" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">src/commands</text>
    <text x="460" y="60" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">128 files · 74,943 LOC</text>
    <line x1="460" y1="76" x2="460" y2="150" stroke="#f59e0b" stroke-width="2"/>
    <text x="478" y="118" fill="#f59e0b" font-family="JetBrains Mono, monospace" font-size="11">x532</text>
    <rect x="20" y="150" width="200" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="120" y="172" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">lib/session</text>
    <text x="120" y="190" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">62 files · 29,494 LOC · in 259</text>
    <line x1="220" y1="178" x2="340" y2="178" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
    <text x="250" y="170" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">x67</text>
    <rect x="700" y="150" width="200" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="800" y="172" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">lib/installations</text>
    <text x="800" y="190" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">8 files · 7,412 LOC · in 77</text>
    <line x1="580" y1="178" x2="700" y2="178" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
    <text x="620" y="170" fill="#38bdf8" font-family="JetBrains Mono, monospace" font-size="10">x40 / x27</text>
    <rect x="20" y="280" width="200" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="120" y="302" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">lib/devices</text>
    <text x="120" y="320" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">26 files · 6,644 LOC · in 107</text>
    <line x1="220" y1="280" x2="360" y2="238" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
    <rect x="250" y="320" width="200" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="350" y="342" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">lib/secrets</text>
    <text x="350" y="360" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">31 files · 11,846 LOC · in 78</text>
    <rect x="480" y="320" width="200" height="56" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <text x="580" y="342" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">lib/terminal</text>
    <text x="580" y="360" text-anchor="middle" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">17 files · 1,640 LOC · extractable after cycle</text>
    <line x1="520" y1="320" x2="500" y2="238" stroke="#a3e635" stroke-width="1" stroke-dasharray="4 3"/>
    <text x="530" y="290" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10">out x4+x4</text>
    <rect x="700" y="280" width="200" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
    <text x="800" y="302" text-anchor="middle" fill="#c8c8c8" font-family="Inter, system-ui, sans-serif" font-size="12">lib/hosts</text>
    <text x="800" y="320" text-anchor="middle" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">24 files · 5,033 LOC · in 92</text>
    <text x="20" y="404" fill="#8a8a8a" font-family="Inter, system-ui, sans-serif" font-size="11">Dashed = subdomain ↔ hub (keeps the 43-module SCC). Solid amber = commands → hub x532. Lime = extraction candidate trapped in the cycle.</text>
  </svg>
  <figcaption><b>Figure 1.</b> Hub subgraph from modules.json. src/lib 190 files, 68,796 LOC, fan-in 1,087, api_ratio 0.88. commands→src/lib x532. session→src/lib x67. installations→src/lib x40 and src/lib→installations x27. terminal outbound lib x4 + session x4.</figcaption>
</figure>

Hot files by `agent_cost` (live session index, 90 days):

| File | LOC | cost | reads | edits |
| --- | ---: | ---: | ---: | ---: |
| `commands/exec.ts` | 3,445 | 1,092 | 38 | 52 |
| `commands/secrets.ts` | 3,179 | 1,044 | 36 | 72 |
| `lib/session/active.ts` | 2,625 | 964 | 70 | 51 |
| `commands/sessions.ts` | 6,161 | 932 | 29 | 25 |
| `lib/session/discover.ts` | 5,626 | 712 | 37 | 36 |
| `lib/session/db.ts` | 4,195 | 668 | 41 | 29 |
| `lib/exec.ts` | 2,565 | 612 | 29 | 22 |
| `lib/agents.ts` | 3,462 | 552 | 23 | 8 |
| `lib/runner.ts` | 2,601 | 488 | 20 | 13 |
| `lib/hooks.ts` | 3,898 | 268 | 8 | 5 |

## Proposed Changes

### Move 1 — Drain the `src/lib` hub (break the cycle)

**Class 3. Ladder rung 3** (move into homes that already exist). Harm 5 × exposure 5,612.

What an agent gets wrong today: every domain directory still imports the leftover 190-file bucket (`session→lib x67`, `devices→lib x44`, `installations→lib x40`). Changing `hooks.ts` or `agents.ts` looks local and is not. `lib/terminal` cannot be extracted: it sits in the same SCC (`terminal→lib x4`, `terminal→session x4`).

First PRs, no new directories: `shims.ts` → `installations/`; `runner.ts` → `daemon/`; `hooks.ts` → `hooks/` (dir exists); `agents.ts` → `agent-spec/` (dir exists); `computer-rpc.ts` + `ssh-tunnel.ts` → `computer/`. Kernel that stays: `exec.ts`, `state.ts`, `types.ts`, `capabilities.ts`, `resources.ts`.

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="modules.json: src/lib files=190 loc=68796 fan_in=1087; edges commands→src/lib x532; 36 subdomain→src/lib edges; cycle size 43">
    <svg viewBox="0 0 420 260" role="img" aria-label="Current: src/lib hub with 190 files, commands importing it 532 times, 43-module cycle">
      <text fill="currentColor" x="10" y="18" font-size="11" font-weight="600">BEFORE — 43-module cycle through the hub</text>
      <rect x="140" y="90" width="140" height="70" rx="4" fill="none" stroke="currentColor" stroke-width="2"/>
      <text fill="currentColor" x="150" y="112" font-size="10" font-weight="600">src/lib</text>
      <text fill="currentColor" x="150" y="128" font-size="9">190 files · 68,796 LOC</text>
      <text fill="currentColor" x="150" y="144" font-size="9">fan-in 1,087</text>
      <rect x="140" y="20" width="140" height="36" rx="4" fill="none" stroke="currentColor"/>
      <text fill="currentColor" x="150" y="42" font-size="10">commands 128 files</text>
      <line x1="210" y1="56" x2="210" y2="90" stroke="currentColor"/>
      <text fill="currentColor" x="216" y="78" font-size="9">x532</text>
      <rect x="20" y="200" width="110" height="36" rx="4" fill="none" stroke="currentColor"/>
      <text fill="currentColor" x="28" y="222" font-size="9">session 62</text>
      <rect x="155" y="200" width="110" height="36" rx="4" fill="none" stroke="currentColor"/>
      <text fill="currentColor" x="163" y="222" font-size="9">installations 8</text>
      <rect x="290" y="200" width="110" height="36" rx="4" fill="none" stroke="currentColor"/>
      <text fill="currentColor" x="298" y="222" font-size="9">terminal 17</text>
      <line x1="75" y1="200" x2="170" y2="160" stroke="currentColor" stroke-dasharray="4 3"/>
      <text fill="currentColor" x="70" y="178" font-size="9">x67</text>
      <line x1="210" y1="200" x2="210" y2="160" stroke="currentColor" stroke-dasharray="4 3"/>
      <text fill="currentColor" x="214" y="184" font-size="9">x40</text>
      <line x1="345" y1="200" x2="250" y2="160" stroke="currentColor" stroke-dasharray="4 3"/>
      <text fill="currentColor" x="300" y="178" font-size="9">x4 out</text>
    </svg>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="derived: move shims→installations, runner→daemon, hooks.ts→hooks/, agents.ts→agent-spec/, computer-rpc+ssh-tunnel→computer/; drop 36 subdomain→hub edges; kernel remains exec/state/types/capabilities/resources">
    <svg viewBox="0 0 420 260" role="img" aria-label="Proposed: src/lib is a small kernel; domains import each other, cycle gone">
      <text fill="currentColor" x="10" y="18" font-size="11" font-weight="600">AFTER — kernel, cycle gone</text>
      <rect x="140" y="90" width="140" height="70" rx="4" fill="none" stroke="currentColor"/>
      <text fill="currentColor" x="150" y="112" font-size="10" font-weight="600">src/lib kernel</text>
      <text fill="currentColor" x="150" y="128" font-size="9">exec · state · types</text>
      <text fill="currentColor" x="150" y="144" font-size="9">capabilities · resources</text>
      <rect x="140" y="20" width="140" height="36" rx="4" fill="none" stroke="currentColor"/>
      <text fill="currentColor" x="150" y="42" font-size="10">commands 128 files</text>
      <line x1="210" y1="56" x2="210" y2="90" stroke="currentColor"/>
      <text fill="currentColor" x="216" y="78" font-size="9">via kernel API</text>
      <rect x="20" y="200" width="110" height="36" rx="4" fill="none" stroke="currentColor"/>
      <text fill="currentColor" x="28" y="222" font-size="9">session 62</text>
      <rect x="155" y="200" width="110" height="36" rx="4" fill="none" stroke="currentColor"/>
      <text fill="currentColor" x="163" y="222" font-size="9">installations +shims</text>
      <rect x="290" y="200" width="110" height="36" rx="4" fill="none" stroke="currentColor"/>
      <text fill="currentColor" x="298" y="222" font-size="9">terminal (free)</text>
      <text fill="currentColor" x="20" y="252" font-size="9">subdomain→hub dashed edges removed — modules.ts largest_cycle 43→0 is the test</text>
    </svg>
  </div>
</div>

**Test:** `bun modules.ts` after each PR; `largest_cycle` and `src/lib.files` must fall. Canonical suite: `apps/cli` vitest for the moved file (e.g. `shims` tests, `runner.test.ts`).

**Blast radius:** import path updates only. No flag, no CLI output, no hook event change.

**Sequence:** first. Nothing extracts out of the SCC until this moves.

### Move 2 — Merge `ROUTINE_AGENT_COMMANDS` into `AGENT_COMMANDS`

**Class 1. Ladder rung 4.** Aug 17 rank 1, still open. Same decision: how to argv-launch a harness.

```diff title=apps/cli/src/lib/agents.ts
@@ ROUTINE_AGENT_COMMANDS (agents.ts:1178) vs AGENT_COMMANDS (exec.ts:682) @@
-export const ROUTINE_AGENT_COMMANDS: Record<string, string[]> = {
-  claude: ['claude', '-p', '--verbose', '{prompt}', '--output-format', 'stream-json', '--permission-mode', 'plan'],
-  codex: ['codex', 'exec', '{prompt}', '--json'],
-  cursor: ['cursor-agent', '-p', '{prompt}', '--output-format', 'stream-json'],
-  kimi: ['kimi', '--prompt', '{prompt}', '--output-format', 'stream-json'],
-  droid: ['droid', 'exec', '{prompt}', '-o', 'stream-json'],
-  muse: ['muse', 'exec', '{prompt}', '--json'],
-};
+// Routine jobs call buildExecCommand() with the job's mode/model/prompt.
+// ROUTINE_AGENT_IDS = agents that AGENT_COMMANDS can launch headlessly.
```

```diff title=apps/cli/src/lib/runner.ts
@@ buildJobCommand still hand-patches modes AGENT_COMMANDS already owns (runner.ts:596-617) @@
-  const template = ROUTINE_AGENT_COMMANDS[agent];
-  let cmd = template.map((part) => part.replace('{prompt}', resolvedPrompt));
-  if (config.agent === 'claude') {
-    if (mode === 'edit') { /* rewrite 'plan' → 'acceptEdits' */ }
-    else if (mode === 'skip') { /* splice --dangerously-skip-permissions */ }
-  }
+  return buildExecCommand({ agent, prompt: resolvedPrompt, mode, model, ... });
```

`runner.ts:720` already reads `AGENT_COMMANDS[agent].modelFlag` for the model flag — the tables are already coupled. Resume path (`['agents', 'run', …]`, runner.ts:591) stays; that is the teams/run-via-argv claim and must not become an in-process `execAgent` call.

**Test:** `runner.test.ts` + `exec.test.ts` before and after. Exercise both the daemon-job path and `agents run`. Quote both green.

**Sequence:** after or as the `runner.ts → daemon/` hop of move 1.

### Move 3 — Route `agent` arms through the table that exists

**Class 7, verdict `bypassed`.** 261 arms, contract+registry present, `same_contract: yes` (every member is a harness id). Not a new abstraction.

Top sites: `models.ts` 26, `exec.ts` 25, `shims.ts` 23, `plugins.ts` 20, `workflows.ts` 19, `commands/sessions.ts` 18, `session/discover.ts` 18.

In-repo exemplar to copy: `lib/terminal/backends/index.ts:19` (`BACKENDS` map, one file per backend). Do **not** merge the polluted `backend` family (concentration 0.44 = terminal + secrets).

**Test:** adding a harness requires one `AGENTS` row + one `AGENT_COMMANDS` row; `rg "=== 'newid'"` in `src/lib` is empty.

**Sequence:** after move 2 so arms are not migrated twice.

### Move 4 — Split `hooks.ts` into `lib/hooks/` adapters

**Class 3. Ladder rung 3.** File is 3,898 lines. `lib/hooks/` already has `cache.ts`, `match.ts`, `profile.ts`. Aug 17 rank 3, still open.

Keep `hooks.ts` as a thin facade for one PR if import churn is large; move discovery/install, runtime repair, and one adapter per harness into the existing directory. `agentId` family has 14 arms in this file.

**Test:** existing `hooks.test.ts` / `hooks/cache.test.ts`. No hook event, settings shape, or installed-file change.

### Move 5 — Draw a session public API

**Class 3.** `lib/session` is 62 files, 29,494 LOC, fan-in 259, **api_ratio 0.82** (51 of 62 files imported from outside). Plus `commands/sessions.ts` at 6,161 LOC (hottest file in the repo by size).

Over-holdable inside the module: `discover.ts` 5,626, `db.ts` 4,195, `active.ts` 2,625, `parse.ts` 2,188.

The two meanings of "session" (transcript vs live identity) stay — that is a documented split, not a merge. The move is encapsulation: commands import 2–3 entry files, not 51.

**Sequence:** after move 1 (`session→src/lib` is still x67).

**Test:** `session/*.test.ts` and `commands/sessions.test.ts`. `api_ratio` on `src/lib/session` falls.

### Move 6 — Secrets backends look like terminal backends

**Class 7.** `same_contract: yes` for secrets only (keychain / file / vault / linux / windows). `same_decision: no` vs terminal — do not invent one `Backend` type for both.

Today: `lib/secrets/{linux,windows,vault,filestore,sync-backend}.ts` exist, but `bundles.ts` still has 21 arms and `commands/secrets.ts` 19. Copy `lib/terminal/backends/index.ts` shape into `lib/secrets/backends/`.

**Test:** `secrets/bundles*.test.ts` and `commands/secrets` tests. Adding a store is one file + one registry row.

## Public Interface

No new command, flag, or export. Refactors are behavior-preserving. `agents fleet` stays an alias of `agents devices`. `agents run` stays the only execution entry.

```bash
# After each structural PR, the graph must move the way the AFTER panel said:
bun ~/.agents/.system/plugins/code/skills/refactor/modules.ts \
  "$RUN_DIR" --scope apps/cli --depth 3
# Expect: largest_cycle 43 → 0 (or strictly smaller after the first hub PR)
```

## Validation

| Check | Expected |
| --- | --- |
| `modules.ts` after each PR | `src/lib.files` and `largest_cycle` fall as the AFTER panel stated |
| `exec.test.ts` + `runner.test.ts` | both original launch paths green |
| `hooks.test.ts` | hook install bytes unchanged |
| `session/*.test.ts` | discover/db/active row shape unchanged |
| `agents --help` depth-2 | 43 top-level names unchanged |

## Risks

| Risk | Mitigation |
| --- | --- |
| Hub drain becomes a 184-file rename | One home per PR; start with the 7 over-holdable root files. No bulk rename. |
| Routine jobs change flags | Move 2 must call `buildExecCommand`; quote `runner.test.ts` before/after. |
| Racing PR #2793 (stale citations) | Do not touch the same AGENTS.md layout lines. Let #2793 merge first. |
| Extracting terminal now | Blocked. Hard line 4. |

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> the 43-module cycle is a star through a 190-file <code>src/lib</code> leftover, not a real mesh. Drain that hub into directories that already exist. Do not extract <code>lib/terminal</code> until the cycle is gone.</aside>

<aside class="artifact-callout artifact-callout-warn"><strong>Do not race PR #2793.</strong> Source-layout citations for the installations/daemon moves are already in flight. The remaining cleanup is the files that never moved.</aside>

## Dropped (8)

Extract `lib/terminal` / `monitors` / `self-heal` (in the SCC). Merge host/device/fleet (`same_decision: no`; fleet already aliases devices). Force a contract onto `kind`/`type`/`status` (generic names). Treat `backend` as one family (concentration 0.44). Shrink the 354-command surface (0 orphans). Move core types only (Aug 17: 587 imports, no boundary). Out-of-repo website/linear-cli/swarm archive moves.

## Bugs found, not fixed

The claim "UI surfaces must not own a timer that acts" is **drifted in code**. `apps/ext/src/vscode/agentPanel.vscode.ts:351` polls every 4s; `issuesPanel.vscode.ts:134` every 60s; `UnifiedAgentsPane.tsx:1420` every 2.5s. That is a second scheduler, not a refactor. Filed as [RUSH-2833](https://linear.app/phnx/issue/RUSH-2833); do not fold it into a behavior-preserving PR.

Resource-kinds list in `AGENTS.md:86` still says `profiles`; `ALL_RESOURCE_KINDS` is plugins+workflows. Doc is wrong — cheapest fix, reversible, but scan-only so it is listed not landed.

## Checklist

- [x] Phase 0–4 measurement (modules, exposure, surface, patterns, claims)
- [x] Rank and cut to 6
- [ ] User pick on moves 1–6 (structural gate)
- [ ] Worktree per move off `origin/main`
- [ ] Re-run `modules.ts` after each merge; correct the AFTER figure if the graph disagrees

## Tracking

- [PR #2793](https://github.com/phnx-labs/agents-cli/pull/2793) — stale citations after daemon/installations moves (in flight; do not race)
- [RUSH-2833](https://linear.app/phnx/issue/RUSH-2833) — AGI EXT acting poll timers (bug, not a refactor)
- Prior scan (degraded): `.agents/artifacts/2026-08-17/refactor-100723`
- This run: `.agents/artifacts/2026-08-20/refactor-161514`
