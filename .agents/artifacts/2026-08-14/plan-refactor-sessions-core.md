---
kind: plan
title: "Refactor: sessions and the core modules of apps/cli"
surface: internal
---

# Refactor: sessions and the core modules of `apps/cli`

**Kicker:** architecture scan · `apps/cli/src` · 712 files · 269,147 lines · 3,498 import edges

**Problem statement:** The sessions domain layer lives inside a command file. Six
per-harness capabilities are dispatched by hand-written `if (agent === …)` chains that
disagree with each other about which harnesses they cover — and two of those
disagreements are live defects today. 308 of 712 files sit in one import cycle.

## Focus for review

Four calls are yours. Everything else I land without asking.

- **Move 1 — lift the sessions domain out of `commands/sessions.ts` into `lib/session/`.** Of 6,197 lines, ~290 are actual commander wiring. 111 exported symbols. It is the single most-churned file in the repo (135 commits/90d) and extracting it dissolves an 11-file import cycle outright. **One PR, or split by concern (query / gather / serialize / resume / render)?**
- **Move 2 — registry-ize the per-harness chains.** Six capabilities dispatch by name chain instead of a table, and the drift is no longer theoretical: `agents permissions list` returns nothing for 10 of 13 allowlist-capable harnesses, and antigravity MCP sync resolves a config path then writes nothing. `SUBAGENT_TARGETS` already proves the pattern in this repo. **Do all six, or start with the two that are actively broken?**
- **Move 6 — reorganize the flat `lib/` root** (193 files, no subdirectories). Cheapest to execute, most disruptive to the 10 open PRs. **Do you want it at all, and if so should it wait for the PR queue to drain?**
- **How far on the 308-file cycle.** I measured that no single edge cut breaks it — it needs a layer rule inside `lib/`, which is Move 6 plus lint enforcement. **Worth the churn, or settle for shrinking it to 279 with the cheap cuts?**

Scope note: every move here is behavior-preserving except the bug fixes called out
explicitly in Move 2. No command, flag, or output changes otherwise.

## Purpose

You asked to focus on sessions and the other core modules. I scanned `apps/cli/src` —
the published `@phnx-labs/agents-cli` — built its import graph, measured which files
agents and commits actually touch over 90 days, censused the per-harness dispatch
surface, and ranked the structural moves by `harm x exposure`. Below: the ranked list,
the evidence, and the diffs.

## What the scan measured

| Signal | Method | Result |
| --- | --- | --- |
| Import graph | static parse of every `import` / `export from` / `import()` in `src` | 712 non-test files, 269,147 loc, 3,498 edges |
| True cycles | Tarjan SCC, file level | 4 cycles: **308**, **11**, 4, 2 files |
| Layering inversion | `lib/*` importing `commands/*` | 92 edges — 82 from the lazy command registry (legitimate), **10 real violations** |
| Agent traffic | `tool_calls` in `~/.agents/.history/sessions/sessions.db`, 90d | `commands/sessions.ts` #3 by reads |
| Commit churn | `git log --since=90.days --name-only` | `commands/sessions.ts` **#1 (135 commits)**, `lib/agents.ts` #3 (92), `lib/session/discover.ts` #10 (64) |
| Per-harness dispatch | census of `agent === '…'` / `switch (agent)` across `src` | 6 capabilities on hand-written chains, membership disagreeing |
| Test net | tests covering the move targets | 100 in `lib/session/`, 17 for `commands/sessions*` |

Baseline `tsc --noEmit` on the scan worktree: **exit 0**.

## Current architecture

<figure>
<svg viewBox="0 0 900 500" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Current import structure of apps/cli/src: a 308-file cycle, an 11-file sessions cycle, 10 upward imports, and six per-harness dispatch chains that disagree">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#94a3b8"/></marker>
    <marker id="arR" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#ef4444"/></marker>
  </defs>
  <text x="14" y="24" font-family="JetBrains Mono, monospace" font-size="13" fill="#94a3b8">apps/cli/src — today</text>

  <rect x="30" y="44" width="380" height="126" rx="6" fill="#1e293b" stroke="#475569"/>
  <text x="46" y="68" font-family="JetBrains Mono, monospace" font-size="13" fill="#e2e8f0">commands/ — 127 files · 74,049 loc</text>
  <rect x="46" y="82" width="348" height="72" rx="4" fill="#3f1d1d" stroke="#ef4444"/>
  <text x="60" y="102" font-family="JetBrains Mono, monospace" font-size="12" fill="#fca5a5">sessions.ts — 6,197 loc · 111 exports</text>
  <text x="60" y="120" font-family="JetBrains Mono, monospace" font-size="11" fill="#fca5a5">~290 lines are commander wiring (5,658–5,945)</text>
  <text x="60" y="137" font-family="JetBrains Mono, monospace" font-size="11" fill="#fca5a5">the other 5,900 are domain + presentation</text>
  <text x="60" y="150" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">201 console. · 281 chalk. calls interleaved</text>

  <rect x="490" y="44" width="380" height="126" rx="6" fill="#1e293b" stroke="#475569"/>
  <text x="506" y="68" font-family="JetBrains Mono, monospace" font-size="13" fill="#e2e8f0">lib/ root — 193 flat files · 86,496 loc</text>
  <text x="506" y="90" font-family="JetBrains Mono, monospace" font-size="11" fill="#94a3b8">routine-* ×11 · project-* ×11 · account-* ×9</text>
  <text x="506" y="107" font-family="JetBrains Mono, monospace" font-size="11" fill="#94a3b8">feed-* ×6 · usage-* ×5 · event-* ×5</text>
  <text x="506" y="129" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">agents.ts ⇄ versions.ts ⇄ capabilities.ts</text>
  <text x="506" y="146" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">capabilities.ts duplicates compareVersions to dodge this cycle</text>
  <text x="506" y="161" font-family="JetBrains Mono, monospace" font-size="10" fill="#94a3b8">no subdirectories, no layer boundary</text>

  <rect x="30" y="196" width="840" height="88" rx="6" fill="#3f1d1d" stroke="#ef4444" stroke-dasharray="5 3"/>
  <text x="46" y="220" font-family="JetBrains Mono, monospace" font-size="13" fill="#fca5a5">308-file import cycle — 43% of the source tree in one strongly-connected component</text>
  <text x="46" y="241" font-family="JetBrains Mono, monospace" font-size="11" fill="#fca5a5">spans commands/ and lib/ alike · no single edge cut breaks it (measured, not assumed)</text>
  <text x="46" y="259" font-family="JetBrains Mono, monospace" font-size="11" fill="#fca5a5">already costing duplication: 5× compareVersions · 5× formatBytes · 4× formatAge · 3× formatDuration</text>
  <text x="46" y="276" font-family="JetBrains Mono, monospace" font-size="11" fill="#fca5a5">cutting the central agents.ts → versions.ts knot alone leaves it at 308 — it needs a layer rule, not an edge fix</text>

  <rect x="30" y="306" width="270" height="86" rx="6" fill="#3f1d1d" stroke="#ef4444"/>
  <text x="44" y="329" font-family="JetBrains Mono, monospace" font-size="12" fill="#fca5a5">11-file cycle</text>
  <text x="44" y="348" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">the sessions command family:</text>
  <text x="44" y="364" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">sessions.ts ⇄ go · focus · attach ·</text>
  <text x="44" y="378" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">detach · reconnect · sessions-{5}</text>

  <rect x="316" y="306" width="270" height="86" rx="6" fill="#3f1d1d" stroke="#ef4444"/>
  <text x="330" y="329" font-family="JetBrains Mono, monospace" font-size="12" fill="#fca5a5">10 upward imports</text>
  <text x="330" y="348" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">3 snapshot builders in lib/ import</text>
  <text x="330" y="362" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">commands/sessions.ts for its domain fns</text>
  <text x="330" y="378" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">3 more import commands/utils.ts</text>

  <rect x="602" y="306" width="268" height="86" rx="6" fill="#3f1d1d" stroke="#ef4444"/>
  <text x="616" y="329" font-family="JetBrains Mono, monospace" font-size="12" fill="#fca5a5">6 name-chain capabilities</text>
  <text x="616" y="348" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">mcp · permissions · workflows · hooks</text>
  <text x="616" y="362" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">routine mode-flags · session resume</text>
  <text x="616" y="378" font-family="JetBrains Mono, monospace" font-size="10" fill="#fca5a5">membership disagrees → 2 live defects</text>

  <path d="M 490 118 L 420 118" stroke="#ef4444" stroke-width="2" marker-end="url(#arR)"/>
  <path d="M 410 140 L 490 140" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar)"/>
  <text x="424" y="110" font-family="JetBrains Mono, monospace" font-size="10" fill="#ef4444">10 upward</text>
  <text x="418" y="158" font-family="JetBrains Mono, monospace" font-size="10" fill="#94a3b8">613 edges (correct direction)</text>

  <text x="14" y="428" font-family="JetBrains Mono, monospace" font-size="11" fill="#64748b">Every number is read off the import graph — no estimates.</text>
  <text x="14" y="447" font-family="JetBrains Mono, monospace" font-size="11" fill="#64748b">lib/session/ itself is clean: 57 files, 28,445 loc, zero internal cycles. The library is fine; half of it never moved in.</text>
</svg>
<figcaption>Current structure. The sessions <em>library</em> is healthy; the sessions <em>domain</em> is stranded in a command file, and the flat <code>lib/</code> root has no layer boundary to hold the graph acyclic.</figcaption>
</figure>

## Proposed Changes

### The ranked moves

Harm = what the structure costs on every change. Exposure = how much traffic it sees.

| # | Move | Harm | Exposure | Sequence |
| --- | --- | --- | --- | --- |
| 1 | Extract the sessions domain from `commands/sessions.ts` → `lib/session/` | dissolves the 11-file cycle (measured 11 → 4) and 3 of 10 upward imports | #1 churn file in the repo | first |
| 2 | Registry-ize the six per-harness dispatch chains | **two live defects today**; a new harness silently gets no MCP, no permissions read, no workflows | spans `mcp.ts`, `permissions.ts`, `workflows.ts`, `hooks.ts`, `runner.ts` | after 1, per-capability |
| 3 | Merge the duplicate MCP subsystem in `agents.ts` into `mcp.ts` | ~725 duplicated lines, byte-identical type, duplicated Hermes writer | `agents.ts` #3 churn | folds into Move 2's MCP slice |
| 4 | Collapse the duplicated utilities to canonical homes | latent semantic divergence in a capability gate | 12 files | independent, cheap |
| 5 | Cut the 10 upward `lib/ → commands/` imports | 308 → 279 SCC (measured) | 8 lib files | independent, cheap |
| 6 | Reorganize the flat `lib/` root | the only move that makes the 279-file blob tractable | every file in `lib/` | **last** |

Moves 4 and 5 are reversible and need no design call — those land without asking.

### Move 1 — lift the sessions domain out of the command file

#### 5.1 What the file actually is

`registerSessionsCommands` — the only thing a command file should export — occupies
lines **5,658–5,945**. Everything above it, *and 233 more lines below it*, is domain
logic. 111 exported symbols in total.

```
commands/sessions.ts:2640   sessionsAction  — 741 lines, the largest function in the file
commands/sessions.ts:5658   export function registerSessionsCommands(program: Command): void {
commands/sessions.ts:5945   end of wiring
commands/sessions.ts:5987   findClaudeHistoryEntry  — Claude-only domain logic, stranded after the wiring
```

Grouped by concern:

| Target module | Source lines | Symbols include |
| --- | --- | --- |
| `lib/session/gather.ts` | 1,537–1,846 | `gatherActiveSessions`, `backfillActiveRowsFromIndex`, `isRunningLiveSession`, `matchesLiveStatus` |
| `lib/session/active.ts` *(exists)* | 1,057–1,348 | `groupActiveSessions`, `groupSessionsByMachine`, `dedupeByMachineSession`, `mergeLocalFirst`, `isAwaitingUser` |
| `lib/session/serialize.ts` | 830–1,347 | `serializeActiveSessionsForJson`, `serializeSessionPickerRows`, `serializeSessionsJson` |
| `lib/session/query.ts` | 4,753–4,975 | `resolveSessionQuery`, `filterSessionsByQuery`, `parseAgentFilter`, `scoreSessionQuery` |
| `lib/session/fleet-query.ts` | 5,249–5,658 | `resolveSessionAcrossFleet`, `fleetCandidatesByQuery`, `metadataResolveOutcome` |
| `lib/session/resume-command.ts` *(exists, 8 lines)* | 4,520–4,664 | `buildResumeCommand`, `resumeArgv`, `resumeSpawnInvocation` |
| `lib/session/render.ts` *(exists, 1,162 lines)* | 379–1,057, 3,381–3,866, 4,185–4,370 | `renderActiveRowLines`, `flatSessionRow`, `pickerColumnsFor`, `formatPickerLabel` |

Four of those seven targets **already exist**. `lib/session/resume-command.ts` is an
8-line placeholder holding one function while the real 145-line resume logic sits in the
command file. This move finishes a split the codebase already started.

#### 5.2 Why it is first — measured, not argued

The 11-file cycle exists only because sibling command files import domain functions from
`commands/sessions.ts` while it imports their `registerX` functions. I measured the
extraction's effect on the graph directly:

```
baseline SCCs:                                 308, 11, 4, 2
after cutting every import OF sessions.ts:     308,  4, 4, 2    ← the 11-file cycle is gone
after also cutting the 10 upward lib→commands:  279,  4,     2
```

#### 5.3 A bug this move exposes: two disagreeing answers to "can this harness resume?"

`lib/exec.ts:947` documents `AGENT_COMMANDS[agent].resume` as **"the single source of
truth"** for native resume. It declares a resume form for 8 harnesses:

```
exec.ts:696  claude   resume: { flag: '--resume' }
exec.ts:701  codex    resume: { subcommand: 'resume' }
exec.ts:735  cursor   resume: { flag: '--resume', since: '2026.7.23' }
exec.ts:767  pi       resume: { flag: '--resume' }
exec.ts:859  grok     resume: { flag: '--resume', since: '0.2.91' }
exec.ts:872  kimi     resume: { flag: '--session', since: '0.19.2' }
exec.ts:890  droid    resume: { flag: '--resume', headlessFlag: '--session-id', since: '0.186.0' }
exec.ts:921  muse     resume: { flag: '--session-id' }
```

`commands/sessions.ts:4633` hardcodes a second, independent switch — and returns `null`
for four harnesses the registry says are resumable:

```
commands/sessions.ts:4652-4660
    case 'grok':
    case 'kimi':
    case 'droid':
    case 'cursor':
      // Grok (and some others) sessions are captured artifacts, not resumable the same way.
      return null;
```

`commands/sessions.ts` never imports `AGENT_COMMANDS` or `nativeResume`. The two answers
have drifted, and the comment explaining why is stale for cursor, grok, kimi, and droid.
Moving this logic to `lib/session/resume-command.ts` puts it next to the registry it
should have been reading.

#### 5.4 The diff shape

```diff
--- a/apps/cli/src/commands/sessions.ts
+++ b/apps/cli/src/commands/sessions.ts
@@
-export async function gatherActiveSessions(
-  options: SessionsOptions,
-): Promise<ActiveSession[]> {
-  // ~300 lines of fleet fan-out, dedupe, backfill
-}
+import { gatherActiveSessions } from '../lib/session/gather.js';
```

```diff
--- a/apps/cli/src/lib/session/resume-command.ts
+++ b/apps/cli/src/lib/session/resume-command.ts
@@
 export function buildCanonicalResumeCommand(sessionId: string): string[] {
   return ['agents', 'resume', sessionId];
 }
+
+/**
+ * Per-harness resume argv. Reads AGENT_COMMANDS — the single source of truth —
+ * instead of the second hardcoded switch this replaces.
+ */
+export function buildResumeCommand(session: SessionMeta): string[] | null {
+  if (!nativeResume(session.agent, session.version)) return null;
+  …
+}
```

```diff
--- a/apps/cli/src/lib/menubar/snapshot.ts
+++ b/apps/cli/src/lib/menubar/snapshot.ts
@@
-import { backfillActiveRowsFromIndex, isRunningLiveSession,
-         serializeActiveSessionsForJson, serializeSessionsJson } from '../../commands/sessions.js';
+import { backfillActiveRowsFromIndex, isRunningLiveSession } from '../session/gather.js';
+import { serializeActiveSessionsForJson, serializeSessionsJson } from '../session/serialize.js';
```

The 17 `commands/sessions*.test.ts` files move with their subjects. The 100 tests in
`lib/session/` are the net that proves behavior was preserved.

#### 5.5 Cleanups inside `lib/session/` that ride along

| Duplication | Occurrences | Fix |
| --- | --- | --- |
| JSONL read-stream scaffold | 6× in `discover.ts` (`:2815`, `:3310`, `:3769`, `:4102`, `:4409`, `:4618`) — two of them near line-for-line identical | one `readJsonlUntil(path, reducer, predicate)` helper |
| "is this pid alive" | 3× (`active.ts:699`, `detached.ts:82`, `db.ts:1417`) with **two different** pid-reuse defenses — a tolerance window vs an exact start-time match | share one primitive; `db.ts`'s lock-scoped copy can stay |
| `id.slice(0, 8)` | 9× despite `short-id.ts:19 deriveShortId()` existing *specifically* because that raw pattern was buggy on prefix-only ids | call `deriveShortId` |
| Ad-hoc Claude path | `commands/sessions.ts:5988` builds `~/.claude/history.jsonl` directly, bypassing `discover.ts:1041 getAgentSessionDirs()` — so it misses version-home and backup installs | use the canonical resolver |

### Move 2 — registry-ize the per-harness chains

The repo already documents the target pattern, and already executed it once.
`subagents-registry.ts:6-10`:

> Generic install / list / detect / orphan / remove logic iterates the table instead of
> the near-identical `else if (agent === '...')` chains that used to be copy-pasted
> across `subagents.ts`, the staleness writer, and the staleness detector — roughly
> O(agents x operations) arms.

Six capabilities never got that treatment. Membership per chain, against the harnesses
the capability table marks capable:

| Capability | Chains | Arms per chain | Silently omitted |
| --- | --- | --- | --- |
| **MCP** | 3 (`resources/mcp.ts:143`, `mcp.ts:749`, `mcp.ts:1039`) | 11 / 12 / 9 | different sets per chain; `capabilities.mcp` is `true` for every harness |
| **Permissions** | write `permissions.ts:1613` (13 arms) vs read `:1383` and export `:2130` (3 arms each) | 13 vs 3 | 10 harnesses readable-but-not-readable |
| **Workflows** | 4 functions in `workflows.ts` (`:1016`, `:1025`, `:1196`, `:1270`) | ~5 each, ~20 arms total | must move in lockstep or list/sync/remove diverge |
| **Hooks** | `hooks.ts:1993` → 11 registrars at `:2155–3768` | 12 | 1,629 lines, 43% of the file |
| **Routine mode flags** | `runner.ts:585` duplicating `AGENT_COMMANDS.modeFlags` | 7 | 9+ harnesses get no mode flag at all |
| **Session resume** | `commands/sessions.ts:4633` duplicating `AGENT_COMMANDS.resume` | 12 | 4 harnesses wrongly marked non-resumable (§5.3) |

#### 6.1 Two of these are live defects — verified

**(a) Antigravity MCP sync resolves a path, then writes nothing.**
`resources/mcp.ts:155-157` returns a real config path for antigravity:

```
    case 'antigravity':
      // agy nests under ~/.gemini/antigravity-cli/ (shared parent with Gemini, distinct subdir).
      return path.join(versionHome, '.gemini', 'antigravity-cli', 'mcp_config.json');
```

`mcp.ts:749 writeMcpConfig` has **no antigravity case and no `default` arm** — verified
by reading every `case` label in the switch and grepping the function body for
`default:` (zero matches). The sync path resolves the path, falls through the switch,
and returns. No error, no warning, no write.

**(b) `agents permissions list` / `export` is blind to 10 of 13 harnesses.**

```
permissions.ts:1389   switch (agentId) {
permissions.ts:1390     case 'claude':
permissions.ts:1392     case 'opencode':
permissions.ts:1394     case 'codex':
permissions.ts:1396     default:
permissions.ts:1397       return null;
```

The *write* path (`applyPermissionsToVersion`, `permissions.ts:1613`) handles 13
harnesses. So permissions are written for cursor, antigravity, grok, goose, kimi, droid,
copilot, kiro, openclaw and hermes — and then `agents permissions list` (which calls
`readAgentPermissions` from `commands/permissions.ts:115` and `:198`) reports nothing for
any of them.

Both get their own ticket and a test that pins the registry against `capableAgents(...)`,
which is what stops this class from recurring.

#### 6.2 The diff shape

```diff
--- /dev/null
+++ b/apps/cli/src/lib/mcp-registry.ts
@@
+/**
+ * One entry per MCP-capable harness: where its config lives, and how to read and
+ * write it. Replaces three independently-maintained switches whose membership had
+ * already drifted apart (antigravity had a path but no writer).
+ */
+export const MCP_TARGETS = {
+  claude:      { path: ['.claude', 'settings.json'],                 codec: claudeSchema },
+  antigravity: { path: ['.gemini', 'antigravity-cli', 'mcp_config.json'], codec: claudeSchema },
+  …
+} as const satisfies Partial<Record<AgentId, McpTarget>>;
```

```diff
--- a/apps/cli/src/lib/mcp.ts
+++ b/apps/cli/src/lib/mcp.ts
@@
-  switch (agentId) {
-    case 'claude': case 'cursor': case 'kimi': case 'droid': case 'pi': case 'warp': { … }
-    …ten more arms, no default…
-  }
+  const target = MCP_TARGETS[agentId];
+  if (!target) {
+    throw new Error(`mcp: ${agentId} is marked mcp-capable but has no MCP_TARGETS entry`);
+  }
+  target.codec.write(resolveTargetPath(target, versionHome), server);
```

```diff
--- /dev/null
+++ b/apps/cli/src/lib/mcp-registry.test.ts
@@
+// The test that stops this class of drift from recurring.
+it('has an MCP_TARGETS entry for every mcp-capable agent', () => {
+  for (const agent of capableAgents('mcp')) {
+    expect(MCP_TARGETS[agent], `${agent} is mcp-capable but has no target`).toBeDefined();
+  }
+});
```

The `throw` is deliberate. Today an unlisted harness falls off the end of the chain and
`installMcpServers` returns `{ success: true, applied: [], errors: [] }` — the
silent-no-op-that-reports-success shape the repo's own review conventions ban.

### Moves 3–5 — the reversible tier

**Move 3 — `agents.ts` reimplements MCP alongside `mcp.ts`.** `agents.ts:2526–3251`
(~725 lines) duplicates the dedicated module. The type is byte-identical in both:

```
agents.ts:2625-2630   export interface McpTargetOperationResult { agentId; version?; success; error? }
mcp.ts:50-55          export interface McpTargetOperationResult { agentId; version?; success; error? }
```

as is the Hermes writer (`agents.ts:2763-2771` vs `mcp.ts:622-651`). A per-agent MCP
format change has to be made twice today. This folds into Move 2's MCP slice.

**Move 4 — collapse the duplicated utilities.**

| Symbol | Copies | Canonical home |
| --- | --- | --- |
| `compareVersions` | 5 — `agent-spec/primitives.ts:50`, `capabilities.ts:24`, `commands.ts:60`, `bootstrap.ts:336`, `commands/view.ts:213` | `lib/agent-spec/primitives.ts` |
| `formatBytes` | 5 — `commands/prune.ts:197`, `commands/share.ts:185`, `commands/inspect.ts:870`, `commands/sessions.ts:373`, `lib/browser/sessions-list.ts:122` | `lib/format.ts` |
| `formatAge` | 4 — `commands/pty.ts:435`, `commands/browser.ts:2260`, `commands/browser-picker.ts:24`, `commands/tmux.ts:460` | `lib/format.ts` |
| `formatDuration` | 3 — `commands/browser.ts:2276`, `lib/routine-notify.ts:65`, `lib/session/render.ts:268` | `lib/format.ts` |
| `truncate` | 3 — `lib/events.ts:621`, `lib/format.ts:84`, `lib/deeplink/url.ts:94` | `lib/format.ts` |
| `expandHome` | 2 — `lib/secrets/index.ts:1670`, `lib/browser/service.ts:260` | `lib/paths.ts` |
| `~/.local/bin/{droid,muse}` literal | 3 — `versions.ts:1084`/`:1095`, `shims.ts:698`/`:714`, `shims.ts:1230`/`:1241` | the `AGENTS` registry |

`compareVersions` is worth singling out, because the code documents *why* the duplicate
exists:

```
capabilities.ts:21-23
 * Compare semver-like versions ("0.116.0" vs "0.115.9"). Local copy to avoid
 * importing versions.ts (which imports agents.ts, which imports this file).
```

The cycle is already costing duplicated code. The duplicate also drops the canonical
version's OpenClaw `-N` rebuild-suffix tiebreak — **verified latent, not live**: no
`since`/`until` gate in `AGENTS` currently uses a `-N` version string, so no capability
gate misfires today. The stated reason is stale regardless: the canonical
`compareVersions` lives in `agent-spec/primitives.ts`, a leaf module, not `versions.ts`.

**Move 5 — cut the 10 upward imports.** They are not equal, and I measured which ones
actually hold the cycle together:

| Edge | Cost to cut | Effect on the 308-file SCC |
| --- | --- | --- |
| `lib/drift-sync.ts`, `lib/refresh.ts`, `lib/secrets/list-filter.ts` → `commands/utils.ts` | trivial — the 3 symbols are generic | **none** — landed already, cycle stayed 308 |
| `lib/computer/dispatch.ts` → `commands/computer-actions.ts` | move `resolveTargetPidDecision`, `emitComputerAction` into `lib/computer/` | these 4 together: **308 → 279** |
| `lib/menubar/snapshot.ts` → `commands/routines.ts` | move `buildRoutineListJson` into `lib/routines.ts` | ” |
| `lib/smart-launch.ts` → `commands/ssh.ts` | move `collectFleetHarnesses` into `lib/devices/` | ” |
| `lib/snapshot.ts` → `commands/view.ts` | move the `ViewJsonAgent` type into `lib/types.ts` | ” |
| `lib/{,menubar/,factory/}snapshot.ts` → `commands/sessions.ts` | gated on Move 1 | none alone; Move 1 kills the 11-file cycle |

Corrected from an earlier draft of this plan, which credited the `commands/utils.ts`
cuts with the 308 → 279 drop. They are worth doing — they remove the layering
inversion — but the drop comes from the other four, each of which needs a small
extraction of its own.

The three symbols `lib/` needed from `commands/utils.ts` (`isInteractiveTerminal`,
`isPromptCancelled`, `parseCommaSeparatedList`) are generic and now live in
`lib/format.ts`, re-exported from `commands/utils.ts` for its ~50 command-layer
callers — the pattern that file already used for `VersionNotInstalledError`.

### Move 6 — reorganize the flat `lib/` root

193 files, no subdirectories, 86,496 lines. The filenames already name the directories:

| Latent directory | Files today |
| --- | --- |
| `lib/routines/` | `routines`, `routine-activation`, `routine-context`, `routine-notify`, `routine-notify-owner`, `routine-process-cleanup`, `routine-readiness`, `routines-format`, `routines-placement`, `routines-project`, `scheduler` |
| `lib/projects/` | `projects`, `project-doctor`, `project-focus`, `project-import`, `project-key`, `project-launch`, `project-probe`, `project-resources`, `project-root`, `project-schedule`, `project-status` |
| `lib/accounts/` | `account-catalog`, `account-provider-registry`, `account-registry`, `account-schema`, `account-state-service`, `claude-account-token`, `auth-health`, `rotate`, `signin-badge` |
| `lib/feed/` | `feed`, `feed-broadcast`, `feed-outcome`, `feed-policy`, `feed-post`, `feed-ranking` |
| `lib/usage/` | `usage`, `usage-backoff`, `usage-fleet`, `usage-refresh`, `byok-usage` |
| `lib/events/` | `events`, `events-ingest`, `event-families`, `event-provenance`, `event-stream` |

My hesitation is not technical. There are 10 open PRs on this repo and a 60-file rename
conflicts with all of them. It is also the only move that makes the 279-file blob
tractable, because the blob has no single bad edge — I measured that cutting the central
`agents.ts → versions.ts` knot leaves it at 308. Breaking it needs a layer rule
(`lib/core/` may not import `lib/features/`) that a flat directory cannot express and a
lint rule cannot enforce.

### Sequence

```
Move 4 (utility collapse) ──┐
Move 5 (upward imports)   ──┘ land now, no design call needed

Move 1 (sessions domain)  ──┐
Move 2 (registries)       ──┼── independent of each other, parallel-safe
Move 3 (MCP merge)        ──┘ (folds into Move 2)
                             └──> Move 6 (tree reorg) — last, after the PR queue drains
```

Cycles first, tree moves last.

## Public Interface

Every move is behavior-preserving. The CLI surface — commands, flags, output shapes — is
unchanged, with two deliberate exceptions, both of which make the surface match what it
already claims:

| Surface | Today | After |
| --- | --- | --- |
| `agents permissions list <agent>` | returns nothing for cursor, antigravity, grok, goose, kimi, droid, copilot, kiro, openclaw, hermes | returns the permissions the write path already wrote |
| MCP sync for antigravity | resolves a config path, writes nothing, reports success | writes the config, or fails loud |
| `agents sessions resume` for cursor / grok / kimi / droid | refuses (`buildResumeCommand` returns `null`) | follows `AGENT_COMMANDS`, the documented single source of truth |
| everything else | — | byte-identical |

No exported symbol leaves the package surface: `commands/sessions.ts` is not a public
entry point, and the moved functions keep their names at their new paths.

## Validation

Each move is proven behavior-preserving by the tests that already exist, not by new ones:

| Move | Proof |
| --- | --- |
| 1 — sessions domain | 100 tests in `lib/session/` + 17 `commands/sessions*.test.ts` move with their subjects and must stay green unmodified. A test that needs editing means the move was not a move. |
| 2 — registries | per-capability completeness test pinning the registry against `capableAgents(cap)` — the mechanism that stops the drift recurring. Plus a regression test per live defect. |
| 4 — utility collapse | `compareVersions` gains coverage for the OpenClaw `-N` tiebreak the duplicates drop |
| 5 — upward imports | the import-graph script re-runs and must report SCCs `279, 4, 2` |
| all | `tsc --noEmit` (baseline: exit 0) and `bun run test:remote` on a crabbox |

The graph script itself is the acceptance check: it is re-run after each move and its
cycle counts must match the numbers predicted in this plan.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Move 6 conflicts with all 10 open PRs | high | sequence it last, after the queue drains; it is the one move gated on timing rather than design |
| A "pure move" silently changes behavior via import-order side effects | medium | move files whole, never retype them; the 117 existing tests are the net; review the diff as `git log --follow` renames |
| Move 2 fixing a silent no-op surfaces errors users never saw | medium | intended — but it means antigravity MCP sync starts writing where it previously did nothing; call it out in the CHANGELOG rather than shipping it as a quiet fix |
| The resume-registry fix enables resume for 4 harnesses that were refused | medium | gate on `nativeResume(agent, version)` so the version floors in `AGENT_COMMANDS` apply; test each of the four |
| Scan ran against `origin/main` at the time of the scan; the repo moves fast | low | re-run the graph script at the head of each move PR and diff the numbers |

<aside class="artifact-callout"><strong>Load-bearing takeaway:</strong> the sessions <em>library</em> is well built — 57 files, zero internal cycles. The problem is that its domain layer never moved in, and six per-harness capabilities are dispatched by hand-written name chains that have already drifted into two live defects. Move 1 and Move 2 are the plan; the rest is cleanup.</aside>

## Documentation drift the scan turned up

The scan read `apps/cli/docs/` as claims and checked each against the code. Four are
wrong about behavior, not just stale pointers — all verified directly:

| Claim | Doc | Reality |
| --- | --- | --- |
| "`SESSION_AGENTS` — **exactly these 12**" | `specifications.md:163`, restated in `architecture.md:155` | 13 today. `lib/session/types.ts:17` includes `muse`. A reader concludes Muse sessions aren't discoverable — false. |
| `agents sessions sync` exists, and `SES-IF-2` requires `sync --json` to emit a documented shape | `specifications.md:817`, `:834` | No `sync` is registered under `sessions` — verified, zero matches. `sync` is an unrelated top-level command the spec's own coverage inventory lists as *Unspecified*. The spec contradicts itself. |
| `@agents/session-tracker` writes the authoritative live-identity record at `terminals/sessions/<pid>.json` | `architecture.md:107-123`, root `CLAUDE.md:33`, `packages/session-tracker/AGENTS.md` | Production reads `~/.agents/.cache/state/sessions/<pid>.json` (`lib/session/hook-sessions.ts:12`, `:59`). Three independent in-code comments state the documented package is **not deployed on the fleet and its directory stays empty**. The real path appears in none of the docs. |
| `attach` / `focus` / `go` / `reconnect` are first-class sessions verbs | `specifications.md:817` | `655b22512` retired them behind `resume`; all four are hidden and three print deprecation warnings. That commit updated the README, `AGENTS.md`, and the command index, but never touched `specifications.md`. |

Plus systemic locator rot: every `file:line` citation spot-checked in the Sessions
section points 130–350 lines away from the symbol it names (`buildSessionDescription`
cited at `:343`, actually `:504`; `getAgentSessionDirs` cited at `:772`, actually
`:1037`; `deriveShortId` cited as living in `db.ts`, actually `short-id.ts:17`). The
described behavior is almost always still right — only the pointers are wrong, which
argues for a mechanical re-audit rather than a manual one.

The first two land in the reversible tier. The `session-tracker` one is a real
architectural question — the docs describe a component that is not running — and gets a
ticket rather than a doc patch.

## To-do

- [x] Build the import graph, cycle census, and upward-import list for `apps/cli/src`
- [x] Measure agent traffic and commit churn over 90 days
- [x] Census the sessions surface, the core-module responsibilities, and the per-harness chains
- [x] Verify the two live defects against the code rather than taking the scan's word
- [x] Confirm the baseline typecheck is green before touching anything
- [ ] **Pick on Moves 1, 2 and 6** ← you
- [ ] Land Moves 4 + 5 (reversible tier) as one behavior-preserving PR
- [ ] File tickets for the two live defects found in §6.1
- [ ] Land Move 1 — sessions domain extraction
- [ ] Land Move 2 — per-harness registries, one capability per PR
- [ ] Land Move 6 — `lib/` tree reorganization, if approved
- [ ] Fix the verified doc drift in §10 (`SESSION_AGENTS` count, phantom `sessions sync`)
- [ ] File a ticket for the `session-tracker` / `state/sessions` documentation gap

## Tracking

Filled in when the moves are picked and their tickets exist.
