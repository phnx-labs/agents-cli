---
kind: plan
title: "Refactor the sibling-repository workspace"
summary: "Consolidate six duplicated ownership boundaries across nine sibling repositories while preserving every public CLI, hook, metadata, website, and extension contract."
surface: internal
project: agents-cli
repository: phnx-labs/agents-cli
branch: refactor-workspace-2772
harness: codex
agent: gpt-5
human: redacted
host: redacted
session: redacted
date: 2026-08-17
tracking: RUSH-2772
links:
  - https://linear.app/getrush/issue/RUSH-2772/refactor-workspace-architecture-across-sibling-repositories
  - https://github.com/phnx-labs/agi-cli/pull/2764
  - https://github.com/muqsitnawaz/agents/pull/1658
---

# Refactor the sibling-repository workspace

## Focus for review

- **Canonical website:** approve `agi-cli-web` as the source for both domains, with `agents-cli.sh` retaining its curl installer and redirecting browser traffic.
- **Archive identity:** retain `swarmify` as the historical extension archive because the frozen Marketplace publisher is `swarmify`; archive the byte-identical `swarm` repository.
- **Execution order:** approve the six ranked moves below as separate, behavior-preserving PR tracks. The launch planner lands first inside `agents-cli`; the cross-repository tracks can then proceed independently.
- **Deliberate exclusions:** confirm that the already-landed svatlas regroup, the non-production `agents` cycle, `tickets-cli`, and agents-cli core types/state stay out of this refactor.

## Purpose

**Intent:** run the code-refactor evidence pipeline against every Git repository directly under the sibling workspace, verify the repository claims against fresh default branches, rank the structural work by harm × exposure, land only reversible correctness fixes immediately, and stop at the genuine repository-ownership decisions before deleting or consolidating structure.

The scan covers nine repository snapshots fetched from each default branch at the commits recorded in [`refactor-100723/repositories.json`](refactor-100723/repositories.json). Later default-branch changes do not silently become part of this evidence set; every move starts by fetching again and re-running its affected measurements. The active execution ticket is [RUSH-2772](https://linear.app/getrush/issue/RUSH-2772/refactor-workspace-architecture-across-sibling-repositories), managed with `linear-cli`.

## Current architecture

The repositories are not one build graph. They form an ownership graph: two sites document one package, two frozen repositories point at one extension, two Go modules share one metadata database contract, and two tracker CLIs overlap without sharing a provider boundary.

| Repository | Fresh-default measurement | What the evidence says |
|---|---:|---|
| `agents-cli` | 2,965 tracked files; `apps/cli` 55 modules / 288 edges | One execution template exists in `exec.ts`, but `runner.ts` still translates six harnesses again. `hooks.ts` is 3,899 lines. |
| `agents` | 9,917 tracked files; 70 modules / 85 edges | Its measured seven-module cycle closes only through a build-ignored generator, tests, and an example. The real shared seam is the `agent_extensions` metadata contract. |
| `agents-cli-web` | 170 tracked files | Claims `agents-cli.sh`; shares 163 paths with `agi-cli-web`, of which 85 differ. |
| `agi-cli-web` | 229 tracked files | Claims `agi-cli.sh`; the live `agents-cli.sh` browser route redirects here. |
| `linear-cli` | 37 tracked files | The extensionless executable is 4,944 lines; its paired test is 2,019 lines. Generic source scanners under-count both. |
| `svatlas` | 214 tracked files | The OpenSpec, substantive `AGENTS.md`, and domain regroup already landed, including commit `f572283`. No structural move remains from RUSH-2672's original code scope. |
| `swarm` | 506 tracked files | Frozen extension history at commit `f14d50b`; stale pointer to `apps/factory`. |
| `swarmify` | 506 tracked files | Exact same commit and tree as `swarm`; same stale pointer. |
| `tickets-cli` | 6 tracked files | A distinct 1,342-line multi-provider prototype. No workspace caller was found, but that does not prove no external consumer. |

<div class="artifact-callout">
The raw analyzers are evidence generators, not verdicts. Two high-looking signals were rejected after source inspection: the `agents` cycle is non-production, and svatlas's apparent flat `src/lib` is a depth-setting artifact over directories that are already grouped by domain.
</div>

### Before and after ownership map

<figure>
<svg viewBox="0 0 1080 650" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Current and proposed ownership map across nine sibling repositories" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
  <defs>
    <marker id="redArrow" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#dc2626"/></marker>
    <marker id="greenArrow" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#65a30d"/></marker>
  </defs>
  <text x="28" y="30" fill="currentColor" font-size="15" font-weight="700">CURRENT — duplicated ownership and planners</text>
  <text x="590" y="30" fill="currentColor" font-size="15" font-weight="700">PROPOSED — one owner per contract</text>
  <line x1="540" y1="15" x2="540" y2="625" stroke="#64748b" stroke-dasharray="5 6"/>

  <rect x="30" y="60" width="190" height="62" rx="8" fill="#dc26261a" stroke="#dc2626"/><text x="45" y="83" fill="currentColor" font-size="13" font-weight="700">agents-cli-web [2]</text><text x="45" y="104" fill="currentColor" font-size="11">official-site claim</text>
  <rect x="300" y="60" width="190" height="62" rx="8" fill="#dc26261a" stroke="#dc2626"/><text x="315" y="83" fill="currentColor" font-size="13" font-weight="700">agi-cli-web [2]</text><text x="315" y="104" fill="currentColor" font-size="11">official-site claim</text>
  <path d="M220,91 H298" stroke="#dc2626" stroke-width="1.7" marker-end="url(#redArrow)"/><text x="235" y="81" fill="currentColor" font-size="10">live redirect</text>

  <rect x="30" y="158" width="190" height="62" rx="8" fill="#dc26261a" stroke="#dc2626"/><text x="45" y="181" fill="currentColor" font-size="13" font-weight="700">swarm [6]</text><text x="45" y="202" fill="currentColor" font-size="11">frozen duplicate</text>
  <rect x="300" y="158" width="190" height="62" rx="8" fill="#dc26261a" stroke="#dc2626"/><text x="315" y="181" fill="currentColor" font-size="13" font-weight="700">swarmify [6]</text><text x="315" y="202" fill="currentColor" font-size="11">same commit + tree</text>
  <path d="M220,189 H298" stroke="#dc2626" stroke-width="1.7" marker-end="url(#redArrow)"/><text x="245" y="179" fill="currentColor" font-size="10">identical</text>

  <rect x="30" y="256" width="460" height="76" rx="8" fill="#dc26261a" stroke="#dc2626"/><text x="45" y="279" fill="currentColor" font-size="13" font-weight="700">agents-cli [1][3]</text><text x="45" y="301" fill="currentColor" font-size="11">exec.ts planner ⇄ runner.ts planner</text><text x="45" y="319" fill="currentColor" font-size="11">hooks.ts: discovery + repair + 11 harness writers</text>

  <rect x="30" y="368" width="460" height="70" rx="8" fill="#dc26261a" stroke="#dc2626"/><text x="45" y="391" fill="currentColor" font-size="13" font-weight="700">agents [4]</text><text x="45" y="413" fill="currentColor" font-size="11">harness reader ⇄ rush/cli writer duplicate slug contract</text>

  <rect x="30" y="474" width="220" height="70" rx="8" fill="#dc26261a" stroke="#dc2626"/><text x="45" y="497" fill="currentColor" font-size="13" font-weight="700">linear-cli [5]</text><text x="45" y="519" fill="currentColor" font-size="11">4,944-line entrypoint</text>
  <rect x="270" y="474" width="220" height="70" rx="8" fill="#64748b1a" stroke="#64748b"/><text x="285" y="497" fill="currentColor" font-size="13" font-weight="700">tickets-cli</text><text x="285" y="519" fill="currentColor" font-size="11">distinct; evidence insufficient</text>

  <rect x="590" y="60" width="430" height="74" rx="8" fill="#65a30d1a" stroke="#65a30d"/><text x="608" y="84" fill="currentColor" font-size="13" font-weight="700">agi-cli-web = canonical source [2]</text><text x="608" y="106" fill="currentColor" font-size="11">agents-cli.sh preserves installer + redirects browsers</text>

  <rect x="590" y="164" width="430" height="74" rx="8" fill="#65a30d1a" stroke="#65a30d"/><text x="608" y="188" fill="currentColor" font-size="13" font-weight="700">agents-cli/apps/ext + swarmify archive [6]</text><text x="608" y="210" fill="currentColor" font-size="11">one live source; one accurate historical pointer</text>

  <rect x="590" y="268" width="430" height="82" rx="8" fill="#65a30d1a" stroke="#65a30d"/><text x="608" y="292" fill="currentColor" font-size="13" font-weight="700">agents-cli canonical contracts [1][3]</text><text x="608" y="314" fill="currentColor" font-size="11">exec launch planner · hooks adapter registry</text><text x="608" y="334" fill="currentColor" font-size="11">runner and hooks facade retain lifecycle/API only</text>

  <rect x="590" y="382" width="430" height="74" rx="8" fill="#65a30d1a" stroke="#65a30d"/><text x="608" y="406" fill="currentColor" font-size="13" font-weight="700">harness/agentextensions contract [4]</text><text x="608" y="428" fill="currentColor" font-size="11">one slug validator; reader + writer keep their DB roles</text>

  <rect x="590" y="488" width="430" height="74" rx="8" fill="#65a30d1a" stroke="#65a30d"/><text x="608" y="512" fill="currentColor" font-size="13" font-weight="700">linear entrypoint + command modules [5]</text><text x="608" y="534" fill="currentColor" font-size="11">same CLI/JSON contract; provider transport isolated</text>

  <path d="M500,91 H582" stroke="#65a30d" stroke-width="1.7" marker-end="url(#greenArrow)"/>
  <path d="M500,189 H582" stroke="#65a30d" stroke-width="1.7" marker-end="url(#greenArrow)"/>
  <path d="M500,294 H582" stroke="#65a30d" stroke-width="1.7" marker-end="url(#greenArrow)"/>
  <path d="M500,403 H582" stroke="#65a30d" stroke-width="1.7" marker-end="url(#greenArrow)"/>
  <path d="M500,509 H582" stroke="#65a30d" stroke-width="1.7" marker-end="url(#greenArrow)"/>
</svg>
<figcaption>Ownership map, not a build dependency graph. Sources: [1] <code>apps/cli/src/lib/{exec,runner,hooks}.ts</code> and deep module scan; [2] both site READMEs, path comparison, and live HTTPS redirect; [3] <code>hooks.ts</code> symbol map; [4] both <code>agent_extensions.go</code> files; [5] manual extensionless-file counts and 54-command surface scan; [6] matching commit/tree hashes and archive instructions.</figcaption>
</figure>

## Proposed Changes

Priority is `structural harm (1–5) × exposure (1–5)`. Ranking and implementation order are distinct: the two governance moves rank high but wait for the decisions at the top of this plan.

| Rank | Move | Harm × exposure | Delivery unit |
|---:|---|---:|---|
| 1 | One agents-cli launch planner | 5 × 5 = **25** | RUSH-2746, one behavior-preserving PR |
| 2 | One website source for both CLI domains | 5 × 4 = **20** | one content-migration PR + one alias/redirect PR |
| 3 | Split `hooks.ts` behind one adapter registry | 4 × 5 = **20** | three moves-only PRs, then one registry PR |
| 4 | One Rush agent-extension metadata contract | 4 × 4 = **16** | one cross-Go-module PR |
| 5 | Split the `linear-cli` executable by command family | 4 × 2 = **8** | three moves-only PRs |
| 6 | Collapse duplicate frozen extension archives | 5 × 1 = **5** | pointer PRs + one GitHub archive action |

### Move 1 — one launch planner

`buildJobCommand` keeps workflow/resume delegation. For a new routine agent run, each primary or failover attempt constructs `ExecOptions` from that attempt's agent and version, then calls the same `buildExecCommand` used by `agents run`. `runner.ts` retains placement, home, timeout, spawn, failover, and transcript lifecycle. Merged correctness PR #2764 is the proof of the drift and the argv baseline, not the architectural endpoint.

```diff
// apps/cli/src/lib/runner.ts
-const baseCmd = buildJobCommand(config, resolvedPrompt, launch.forwardAccount !== false);
+const delegatedCmd = dispatchesViaAgentsRun(config)
+  ? buildJobCommand(config, resolvedPrompt, launch.forwardAccount !== false)
+  : null;
 
 for (const entry of chain) {
   const attemptAgent = entry.agent;
   const attemptVersion = entry.version;
-  const cmd = dispatchesViaAgentsRun(config)
-    ? baseCmd
-    : pinJobBinary(baseCmd, attemptAgent, attemptVersion);
+  const model = config.config?.model;
+  const cmd = delegatedCmd ?? buildExecCommand({
+    agent: attemptAgent,
+    version: isSelfUpdatingAgent(attemptAgent) ? undefined : attemptVersion,
+    prompt: resolvedPrompt,
+    mode: normalizeMode(config.mode),
+    effort: config.effort as ExecEffort,
+    ...(typeof model === 'string' ? { model } : {}),
+    addDirs: normalizedRoutineDirs(config),
+    json: true,
+    headless: true,
+  });
 }

// apps/cli/src/lib/agents.ts
-export const ROUTINE_AGENT_COMMANDS = { claude: [...], codex: [...], droid: [...] };
+export const ROUTINE_AGENT_IDS = ['claude', 'codex', 'droid', ...] as const;
```

Tests change in `runner.test.ts` and `exec.test.ts`: every routine agent × supported mode must produce the same argv as merged commit `c9ceb888`, and both the primary and failover attempt must resolve their own agent/version pair.

### Move 2 — one website source

Keep `agi-cli-web` because the live redirect already makes it canonical. First audit the seven `agents-cli-web`-only paths and port only content still absent from the canonical information architecture. Then reduce the alias repository to installer compatibility and browser redirect behavior.

```diff
// agents-cli-web/functions/index.ts
 export const onRequestGet: PagesFunction = async (context) => {
   if (SHELL_UA.test(userAgent)) return installerResponse();
-  return context.next();
+  const target = new URL(context.request.url);
+  target.hostname = 'agi-cli.sh';
+  return Response.redirect(target, 308);
 };

// agents-cli-web/README.md
-This repository is the site deployed at agents-cli.sh.
+This repository preserves the agents-cli.sh installer and browser redirect.
+The canonical site source is phnx-labs/agi-cli-web.
```

The migration must not bulk-copy the 85 divergent shared paths. Each is reconciled against the live page and current CLI behavior.

### Move 3 — split hooks behind an adapter registry

Preserve `hooks.ts` exports as a facade while moving one responsibility at a time. The final adapter registry must be completeness-tested against every harness whose capability table declares hooks support.

```diff
// apps/cli/src/lib/hooks.ts
-function registerHooksForClaude(...) { ... }
-function registerHooksForCodex(...) { ... }
-function registerHooksForDroid(...) { ... }
+export { installHooks, removeHook } from './hooks/install.js';
+export { checkVersionHookWiring } from './hooks/runtime.js';
+export { registerHooksToSettings } from './hooks/adapters/index.js';

// apps/cli/src/lib/hooks/adapters/index.ts
+export const HOOK_ADAPTERS = {
+  claude: claudeHookAdapter,
+  codex: codexHookAdapter,
+  droid: droidHookAdapter,
+  // every hooks-capable harness; completeness test forbids omissions
+} satisfies Partial<Record<AgentId, HookAdapter>>;
```

The 3,899-line source splits into `discovery.ts`, `install.ts`, `runtime.ts`, `manifest.ts`, and `adapters/<agent>.ts`; corresponding tests sit one-to-one beside those sources. No harness support change belongs in these PRs.

### Move 4 — one Rush metadata contract

Create a harness-owned package because `rush/cli` already depends on the harness Go module through its checked-in replace directive. Share slug validation there; keep SQL reading in harness/config and SQL writing in rush/cli/internal/metadata.

```diff
// agents/harness/config/agentextensions/slug.go
+package agentextensions
+var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
+func IsValidSlug(slug string) bool { return slugPattern.MatchString(slug) }

// agents/harness/config/agent_extensions.go
-var agentSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
-if !agentSlugPattern.MatchString(agentSlug) { ... }
+if !agentextensions.IsValidSlug(agentSlug) { ... }

// agents/rush/cli/internal/metadata/agent_extensions.go
-var agentSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
-return agentSlugPattern.MatchString(slug)
+return agentextensions.IsValidSlug(slug)
```

The shared package gets its own `slug_test.go`; reader behavior remains in `harness/config/agent_extensions_test.go`, writer behavior in `rush/cli/internal/metadata/agent_extensions_test.go`.

### Move 5 — split linear-cli by command family

Keep the installed `linear` file as the executable facade. Extract in dependency order: transport/config first, read commands second, write/delegation commands last. Preserve command names, exit codes, human output, JSON shapes, config paths, and delegate-only ownership.

```diff
// linear-cli/linear
-def cmd_tasks(args): ...
-def cmd_update(args): ...
-def cmd_comments(args): ...
+from linear_cli.commands.tasks import register_tasks
+from linear_cli.commands.update import register_update
+from linear_cli.commands.comments import register_comments
+
+register_tasks(subparsers, client)
+register_update(subparsers, client)
+register_comments(subparsers, client)
```

Each extracted source gets a discoverable paired test (`client.py` → `test_client.py`, `commands/tasks.py` → `commands/test_tasks.py`). The current `test_linear.py` remains the executable-level contract until the last move; CI continues to discover every module with `python3 -m unittest -v`.

### Move 6 — collapse frozen extension archives

Correct both stale pointers before any GitHub archive action. Retain `swarmify` as the recommended historical URL because the published extension identity remains `swarmify.swarm-ext`; the live source remains `agents-cli/apps/ext`.

```diff
// swarm/extension/AGENTS.md and swarmify/extension/AGENTS.md
-This extension moved to the agents-cli monorepo at apps/factory/.
+This extension moved to the agents-cli monorepo at apps/ext/.
+This repository is frozen history; do not build or release from it.
```

After both redirects land, archive `muqsitnawaz/swarm` in GitHub settings. Do not delete git history or rewrite either repository.

## Public Interface

Moves 1, 3, 4, and 5 are behavior-preserving. Their acceptance condition is that CLI argv, hook settings, metadata rows, command help, JSON output, and exit codes remain unchanged.

Move 2 changes browser ownership but preserves both public URLs and the `curl agents-cli.sh | sh` installer. Move 6 changes contributor guidance and GitHub archive state only; the published extension identifier and its source in `apps/ext` do not change.

Two reversible correctness fixes are already separated from this design gate:

- Merged `agents` PR [#1658](https://github.com/muqsitnawaz/agents/pull/1658) replaces stale Halo commands in developer settings and adds the previously missing `prix/web` CI job.
- Merged `agents-cli` PR [#2764](https://github.com/phnx-labs/agi-cli/pull/2764) makes routine model selection use the canonical per-agent model flag; focused proof is 6 passing cases, including Droid `-m`.

## Validation

| Move | Required proof before merge | Post-merge proof |
|---|---|---|
| 1 | exact argv snapshot for every routine agent × mode; `runner` and `exec` suites; `apps/cli/scripts/build.sh` | installed `agents` routine fire uses the declared model on one `--model` harness and Droid `-m` |
| 2 | compare all 163 shared paths and seven alias-only paths; build both deployments; curl-vs-browser behavior tests | both live domains: shell UA receives installer, browser reaches canonical content |
| 3 | one-to-one tests for each moved source; adapter keys equal hooks-capable agents; full remote CLI suite | `agents hooks` install/check on two structurally different formats plus one live SessionStart hook |
| 4 | both Go module suites; invalid/valid slug table; real temporary SQLite read/write round-trip | `rush connection` toggle is observed by the harness reader |
| 5 | executable-level golden contract before/after for all 54 surface entries; module tests | installed `linear tasks RUSH-2772 --json` and one update/comment round-trip |
| 6 | both archive READMEs link to `apps/ext`; canonical extension build remains green | retained repository is readable and frozen; duplicate repository reports archived |

The raw analyzer corpus remains local because it contains absolute machine paths and noisy fixture excerpts. The public, reviewable evidence is the sanitized set beside this plan: `repositories.json`, `metrics-summary.json`, `apps-cli-deep-summary.json`, `workspace-graph.json`, `claims.json`, `claims-results.json`, `architecture-findings.json`, and `ranking.json`.

## Risks

| Risk | Control |
|---|---|
| A planner merge drops a harness quirk | exact argv parity for every supported mode; one harness at a time; no lifecycle edits in the same PR |
| Hook moves silently omit a harness | registry completeness test against the capability table; preserve the facade until all callers migrate |
| Website merge overwrites newer content | reconcile divergent paths individually; canonical repo choice before any deletion; live before/after captures |
| Shared Go package grows into database ownership | share validation/row vocabulary only; keep reads and writes in their present modules |
| Linear module split changes output order or JSON | executable-level golden tests remain authoritative through the final move |
| Archive choice breaks a historical URL | archive, never delete; fix both pointers first; retain the publisher-matching `swarmify` URL |
| Analyzer false positive becomes work | every candidate requires source-level proof; rejected candidates stay recorded in `ranking.json` |

## Checklist

- [x] Claim RUSH-2772 with `linear-cli` and record all nine fresh-default commits.
- [x] Run module, exposure, surface, pattern, claim-drift, and file-level evidence passes.
- [x] Correct the agents-cli Droid model-flag drift in isolated PR #2764.
- [x] Correct the Rush settings copy and wire its regression test into CI in isolated PR #1658.
- [x] Reject the non-production `agents` cycle and the already-landed svatlas regroup.
- [ ] Approve `agi-cli-web` as canonical and `swarmify` as the retained archive.
- [ ] Move 1: finish RUSH-2746 with one canonical launch planner.
- [ ] Move 3: split hooks discovery/runtime/manifest/adapters behind the existing facade.
- [ ] Move 4: centralize the Rush agent-extension slug contract.
- [ ] Move 5: split `linear-cli` in three behavior-preserving PRs.
- [ ] Move 2: reconcile site content, then reduce the alias repository to installer + redirect.
- [ ] Move 6: fix both stale pointers, then archive the duplicate repository.
- [ ] Re-run every repository measurement and compare the final ownership graph to this plan.

## Tracking

- [RUSH-2772 — workspace architecture refactor](https://linear.app/getrush/issue/RUSH-2772/refactor-workspace-architecture-across-sibling-repositories)
- [RUSH-2746 — agents-cli launch planner follow-through](https://linear.app/getrush/issue/RUSH-2746)
- [agents-cli PR #2764](https://github.com/phnx-labs/agi-cli/pull/2764)
- [agents PR #1658](https://github.com/muqsitnawaz/agents/pull/1658)
