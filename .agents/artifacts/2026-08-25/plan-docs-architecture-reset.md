---
kind: visual
title: "Make the docs explain the system, not recite the repository"
summary: "The 58 Markdown files under apps/cli/docs have grown into a 27,829-line mixture of architecture, CLI manuals, setup guides, source maps, raw transcripts, implementation plans, and volatile product research. This plan keeps durable feature behavior and architectural decisions in the authored corpus, generates mechanically derivable reference, and moves task-oriented instructions into a separate user/runbook surface."
status: draft
context: "RUSH-3199 · apps/cli/docs architecture reset"
links:
  - label: "RUSH-3199"
    url: "https://linear.app/rush/issue/RUSH-3199"
  - label: "PR #3038"
    url: "https://github.com/phnx-labs/agi-cli/pull/3038"
facts:
  - "58 Markdown files audited; 27,829 lines total"
  - "12 feature docs carry hand-maintained Command Reference sections"
  - "11 feature docs carry recipe/how-to sections"
  - "Two correctness contradictions surfaced during the audit"
---

## Story

The problem is not that the documentation is long. The problem is that a single directory is doing five incompatible jobs.

Today, an agent looking for the watchdog's ownership model encounters a source-file inventory and a stale roadmap. An agent looking for browser task ownership crosses hundreds of lines of flags, setup, recipes, and mutable command behavior. A contributor can already discover those details from `agents <group> --help`, generated command metadata, `mq`, `rg`, and the source tree. Repeating them in authored Markdown makes the architectural signal harder to find and creates a second, drifting source of truth.

The desired corpus answers five durable questions:

1. What problem and feature boundary does this subsystem own?
2. Which component owns state, scheduling, execution, and presentation?
3. How does data and control move through the system?
4. Which invariants and failure behaviors must survive refactors?
5. Why were the important tradeoffs chosen?

It does not manually enumerate commands, flags, directories, functions, setup sequences, provider model IDs, troubleshooting recipes, rollout checklists, or ticket-era roadmaps.

### Audit boundary and evidence

- Scope: every `*.md` under `apps/cli/docs`, including provider guides and the three checked-in session traces.
- Corpus: **58 files / 27,829 lines** (`rg --files apps/cli/docs -g '*.md'`; `wc -l`).
- Structural cross-check: `mq apps/cli/docs '.tree | depth(2)'` plus targeted searches for Setup, Command Reference, Recipes, File map, Source map, Key Functions, Roadmap, and New files.
- Byte-level review: parallel file-by-file reads, completed before implementation; the matrix below records the proposed disposition for every file.
- Concrete examples: `watchdog.md:177` is a source-file map; `browser.md:196–582` is a hand-maintained command reference; `sessions.md:806–904` is a query tutorial; `optimizations.md:236–250` and `:301–318` inventory new/modified files.

## Data

### Before → after

| Today | Why it fails the requested standard | After |
|---|---|---|
| One `docs/` directory mixes architecture, onboarding, manuals, runbooks, plans, research, and captured transcripts | Readers cannot tell what is normative, durable, generated, historical, or user-facing | Three named surfaces with an explicit ownership rule |
| Feature docs repeat complete commands and flags | Commander/help is the actual command source; Markdown drifts | Generated command reference remains discoverable but is not part of architectural reading |
| File maps and “key functions” tables name current implementation symbols | `mq`, `rg`, code navigation, and tests answer this more accurately | Architecture names component boundaries and stable seams; a small source pointer is optional |
| Setup, recipes, and troubleshooting sit beside invariants | Task instructions dominate the mental model | User guides/runbooks are separate and task-oriented |
| Roadmaps, “not yet,” rollout phases, and ticket-era implementation diaries live in canonical docs | Current behavior becomes ambiguous and stale | Plans/history live in tickets and dated artifacts; docs describe current truth |
| Capability/provider/model matrices are manually copied | Registry-backed facts change faster than prose | Generated tables are sourced from registries/types and visibly marked generated |
| Raw session traces live under docs | They are bulky, volatile, and may expose reasoning or sensitive context | Minimal synthetic/redacted fixtures live beside tests when they protect behavior |

### Target information architecture

| Surface | Owns | Must not own |
|---|---|---|
| **Authored architecture** (`apps/cli/docs/architecture/` or a shallow equivalent) | feature boundary, owners, data flow, lifecycle/state machine, invariants, failure semantics, tradeoffs, accepted ADRs | command catalogs, setup, recipes, file maps, rollout status |
| **Generated reference** (`apps/cli/docs/reference/`, produced by scripts) | command tree, flags, schemas, capability matrices, provider/model catalogs | hand-edited prose or duplicated architecture |
| **User guides / runbooks** (website or explicitly named guide surface) | install, setup, task recipes, troubleshooting, operator recovery | normative architecture or implementation plans |
| **Dated artifacts / tickets** (`.agents/artifacts/`, Linear, PRs) | research, comparisons, benchmarks, rollout plans, incident evidence | claims presented as current canonical behavior |
| **Testdata beside source** | synthetic/redacted fixtures that catch parser/renderer regressions | real/raw transcripts or published chain-of-thought |

### File-by-file disposition

The action names are intentional:

- **Rewrite** means retain the filename/topic but reduce it to durable architecture.
- **Split** means keep an architecture document and move or generate the other material.
- **Generate** means the file may remain, but only as derived output with a source and regeneration command.
- **Relocate** means the content is useful, but it is not canonical feature architecture.
- **Delete** means it is redundant, unsafe, or has no durable role after relocation.

| File | Action | Keep | Remove / move / generate |
|---|---|---|---|
| `AGENT-CHEATSHEET.md` | Delete after merge | Unique execution/resource invariants | File map and contributor rules; fold into architecture/AGENTS |
| `QUICKSTART.md` | Relocate | Devices-vs-hosts and credential-custody concepts | All installation/setup/smoke-test content to user onboarding |
| `README.md` | Rewrite | Short architecture/ADR/spec index | Feature catalog, onboarding order, doc-authoring procedure |
| `architecture.md` | Rewrite | CLI-vs-UI ownership, session identity, exec/data flow, honest state | Storage/file inventory, writer/function choreography |
| `browser.md` | Split | task/profile ownership, identity routing, consent, cleanup guarantees | setup, commands, flags, schemas, recipes to user/generated docs |
| `cloud.md` | Split | provider boundary, placement, lifecycle, budget boundary | provider/flag catalog and recipes |
| `command-index.md` | Generate | discoverability | hand maintenance; mark generated and exclude from architecture nav |
| `computer.md` | Split | native-helper boundary, permissions/trust, local-vs-remote ownership | setup, exhaustive verbs/options, recipes |
| `concepts.md` | Major rewrite | 5–7 canonical mental models and resolution semantics | directory trees, mutable matrices, config/command inventory |
| `credential-management.md` | ADR rewrite | custody invariants, native-vs-provider account decision | migration diary, command catalog, concrete code fix |
| `entrypoints-and-loops.md` | ADR rewrite | invocation axes, composition, fail-closed grammar, loop guards | proposal-status table and CLI mechanics |
| `examples/sessions/claude/trace.md` | Delete/relocate | only minimal fixture semantics if tested | raw full conversation |
| `examples/sessions/codex/trace.md` | Delete/relocate | only minimal fixture semantics if tested | raw full conversation |
| `examples/sessions/gemini/trace.md` | Delete immediately | synthetic event shape only if required | published agent reasoning and raw conversation |
| `fleet.md` | Split | reconciliation boundary, idempotency, credential custody | YAML, flags, bootstrap recipes, source map |
| `hooks.md` | Split | resolution/registration flow, AND semantics, dual-evaluator invariant | commands, schema, cache tuning, recipes; generate event matrix |
| `hosts.md` | Major rewrite | placement, brokerless/provider boundary, remote context and non-goals | historical plan, commands, incidents, code maps, open phases |
| `landscape.md` | Relocate | dated strategic positioning if still useful | canonical technical-doc status |
| `menubar.md` | Split + resolve | read-model/action boundary, lifecycle, single-instance behavior | setup, UI spec, files table; move acting timer out of UI ownership |
| `mine.md` | Rewrite | white-label shim/profile boundary and foreground-vs-background invariant | commands, examples, licensing guidance |
| `model-tiers.md` | Rewrite + generate | stable tier semantics, precedence, clamping | mutable provider/model/price tables and source map |
| `monitors.md` | Split | event-source → detection → claimed action architecture, ownership and idempotency | commands/config recipes and key-functions table |
| `observability.md` | Major rewrite | event model, provenance, state ownership, aggregation boundaries | exhaustive schemas, commands, queries, file paths, rollout history |
| `optimizations.md` | Relocate/split | accepted performance decisions with measured tradeoffs | new/modified file inventories and implementation-plan residue |
| `plugins.md` | Split | package boundary, layered resolution, consent/security model | commands, manifest/layout reference, recipes |
| `product-acceptance.md` | Relocate | durable product acceptance principles if still canonical | templates, proof commands, copied examples; likely AGENTS/process docs |
| `profiles.md` | Split | custom-harness identity, resolution, auth ownership, override precedence | command catalog, YAML schema, presets, recipes |
| `profiles/INDEX.md` | Relocate/generate | provider guide navigation | hand-maintained provider/caveat matrix |
| `profiles/bedrock.md` | User guide | Bedrock-specific compatibility constraints | quick start/generated YAML/troubleshooting out of architecture |
| `profiles/deepinfra.md` | User guide | provider transport/auth constraint | commands/current endpoints and operational rendering |
| `profiles/foundry.md` | User guide | Foundry-vs-TrueFoundry distinction and transport constraint | setup/YAML/troubleshooting/current-version caveats |
| `profiles/litellm.md` | User guide | gateway/tool-use compatibility boundary | setup/config recipes/troubleshooting |
| `profiles/ollama.md` | User guide | local-host and protocol compatibility constraint | setup/model recommendations/troubleshooting |
| `profiles/openrouter.md` | User guide + generate | reasoning-vs-print behavior | setup, mutable preset/model list, key rotation recipes |
| `profiles/truefoundry.md` | User guide | gateway/validation/TLS trust boundaries | setup/YAML/current-version troubleshooting |
| `profiles/vertex.md` | User guide | credential and region/model-ID constraints | setup/YAML/current availability claims |
| `profiles/vllm.md` | User guide | native Anthropic/tool-call parser boundary | deployment recipe/model tuning/troubleshooting |
| `projects.md` | Major rewrite | project identity, directory ownership, attribution, safe reconciliation | YAML, output specimens, commands, cache experiments, bug history |
| `pty.md` | Rewrite | sidecar/process boundary and normalized screen model | setup, command reference, recipes |
| `release.md` | Split | exact-artifact promotion, attestation/helper reuse, latency invariant | temporary/manual producer runbook and historical workaround |
| `resource-sync.md` | Major rewrite | layered resolution, detection, projection, prune/decline invariants | selector flags, transform internals, key-functions map |
| `routines.md` | Major split | sole scheduler, placement, readiness, isolation, state machine, catch-up | YAML/webhook setup, auth runbook, commands, key-functions map |
| `secrets-agent-process-model.md` | ADR rewrite | broker-vs-scheduler requirements, decision and consequences | stale process-state diary and pid/socket incident detail |
| `secrets-trust-boundaries.md` | Fix + ADR rewrite | storage/materialization boundary and transcript consequences | copied code; resolve contradictory `get`/human-gate claims |
| `secrets.md` | Major split | bundle/backend architecture, injection, broker, remote trust model | command reference, schemas, recipes, platform setup runbooks |
| `self-healing.md` | Light rewrite | failure model, three defenses, conservative probe, limits | pseudocode, regex, source/test map |
| `sessions.md` | Major split | transcript/live identity, indexing, lifecycle, state, remote/migration boundaries | schemas, flags, tutorials, benchmark procedure |
| `share.md` | Split | publication data flow, provenance, revisions, capability/security model | walkthroughs, Worker deploy runbook, file/command maps |
| `specifications.md` | Split normative exception | RFC behavior and Given/When/Then invariants by subsystem | generated schemas/parity tables and transient known-gap ledgers |
| `ssh-transport.md` | Concise ADR rewrite | one-engine decision, trust, multiplexing, alternatives, risks | symbol walkthrough, dated measurements/rollout |
| `subagents.md` | Split | layered projection and registry/capability lockstep | file-layout map, commands, schema, recipes |
| `teams.md` | Major split | DAG, isolation, boundary contracts, distributed placement, budgets | options, resume tutorial, recipes, JSON shapes |
| `terminal-engine.md` | Rewrite | attended-vs-autonomous boundary, backend contract, layout/selection | backend file map, API examples, integration implementation detail |
| `toolchain-thesis.md` | Relocate | dated product thesis | canonical architecture status and stale market claims |
| `version-management.md` | Split | resolution, isolation, adoption/reversal, shim process contract | install tutorials, duplicate resource sync, key-functions map |
| `vs-gastown.md` | Relocate | dated competitive research | canonical architecture status |
| `watchdog.md` | Light rewrite | scheduler ownership, state loop, decider, confirmed delivery, rotation/fleet boundary | file map, commands, contradictory roadmap |
| `workflows.md` | Split | layered resolution, composition, projection and fail-closed scoping | commands, full schema, recipes/demo |

## Figure

<div class="artifact-panel">
<svg viewBox="0 0 1200 620" role="img" aria-labelledby="docs-title docs-desc" width="100%">
  <title id="docs-title">Before and after information architecture for the CLI documentation</title>
  <desc id="docs-desc">The current mixed documentation corpus is separated into authored architecture, generated reference, user runbooks, dated artifacts, and test fixtures.</desc>
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#a3e635"/></marker>
  </defs>
  <rect x="20" y="30" width="430" height="550" rx="8" fill="#241414" stroke="#f87171" stroke-width="2"/>
  <text x="50" y="75" font-family="ui-monospace,monospace" font-size="24" font-weight="700" fill="#e8e8e8">BEFORE · one mixed corpus</text>
  <text x="50" y="115" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">Architecture + invariants</text>
  <text x="50" y="150" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">Commands + every flag</text>
  <text x="50" y="185" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">Install + setup + recipes</text>
  <text x="50" y="220" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">File maps + key functions</text>
  <text x="50" y="255" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">Schemas + mutable matrices</text>
  <text x="50" y="290" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">Plans + roadmaps + gaps</text>
  <text x="50" y="325" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">Competitive research</text>
  <text x="50" y="360" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">Raw session traces</text>
  <line x1="50" y1="400" x2="415" y2="400" stroke="#5c2d2d"/>
  <text x="50" y="445" font-family="ui-monospace,monospace" font-size="24" font-weight="700" fill="#facc15">27,829 lines</text>
  <text x="50" y="480" font-family="ui-monospace,monospace" font-size="16" fill="#888">The reader must infer what is</text>
  <text x="50" y="510" font-family="ui-monospace,monospace" font-size="16" fill="#888">durable, generated, current,</text>
  <text x="50" y="540" font-family="ui-monospace,monospace" font-size="16" fill="#888">historical, or operational.</text>

  <path d="M470 305 C520 305 535 305 575 305" stroke="#a3e635" stroke-width="4" fill="none" marker-end="url(#arrow)"/>
  <text x="482" y="278" font-family="ui-monospace,monospace" font-size="16" fill="#a3e635">classify by ownership</text>

  <rect x="595" y="30" width="585" height="102" rx="8" fill="#10190b" stroke="#a3e635" stroke-width="2"/>
  <text x="625" y="70" font-family="ui-monospace,monospace" font-size="24" font-weight="700" fill="#e8e8e8">AUTHORED ARCHITECTURE</text>
  <text x="625" y="101" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">boundaries · flows · states · invariants · decisions</text>

  <rect x="595" y="147" width="585" height="90" rx="8" fill="#141414" stroke="#333" stroke-width="2"/>
  <text x="625" y="184" font-family="ui-monospace,monospace" font-size="24" font-weight="700" fill="#e8e8e8">GENERATED REFERENCE</text>
  <text x="625" y="214" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">commands · flags · schemas · capability matrices</text>

  <rect x="595" y="252" width="585" height="90" rx="8" fill="#141414" stroke="#333" stroke-width="2"/>
  <text x="625" y="289" font-family="ui-monospace,monospace" font-size="24" font-weight="700" fill="#e8e8e8">USER GUIDES / RUNBOOKS</text>
  <text x="625" y="319" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">install · setup · recipes · troubleshooting · recovery</text>

  <rect x="595" y="357" width="585" height="90" rx="8" fill="#141414" stroke="#333" stroke-width="2"/>
  <text x="625" y="394" font-family="ui-monospace,monospace" font-size="24" font-weight="700" fill="#e8e8e8">DATED ARTIFACTS / TICKETS</text>
  <text x="625" y="424" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">research · benchmarks · plans · incidents · rollout</text>

  <rect x="595" y="462" width="585" height="90" rx="8" fill="#141414" stroke="#333" stroke-width="2"/>
  <text x="625" y="499" font-family="ui-monospace,monospace" font-size="24" font-weight="700" fill="#e8e8e8">TESTDATA BESIDE SOURCE</text>
  <text x="625" y="529" font-family="ui-monospace,monospace" font-size="16" fill="#b8b8b8">minimal · synthetic · redacted · regression-protecting</text>
</svg>
<p>One authored corpus becomes five explicit ownership surfaces. The green lane is what agents read for system understanding; the other lanes remain discoverable without competing with it.</p>
</div>

### Implementation sequence

1. **Write and enforce the documentation contract.** Rewrite `apps/cli/docs/README.md` to define the three documentation surfaces, the retained architecture template, generated-file markers, and the rule that architectural docs do not carry setup, command catalogs, recipes, file maps, or transient roadmaps. Update the nearest `AGENTS.md` review guidance so regressions are reviewable.

2. **Fix correctness before reshaping prose.** Resolve the contradictory secret-materialization claims against current code and real tests. Resolve the menubar acting-timer conflict by moving restart ownership to the CLI control plane or explicitly changing the normative singularity decision. Remove the contradictory watchdog roadmap phrasing and stale secrets process state.

3. **Build canonical generated reference.** Make the existing Commander-derived command index visibly generated and reproducible. Extend generation only where the canonical registry/type already exists: command flags, capability matrices, provider/model tables, and stable schemas. Generated output is linked from architecture but excluded from its reading order.

4. **Rewrite the architectural spine first.** Reduce `architecture.md`, `concepts.md`, and subsystem ownership docs (`sessions`, `routines`, `hosts`, `browser`, `secrets`, `resource-sync`, `teams`) to the retained template. Split the monolithic normative specification by subsystem without weakening its RFC requirements.

5. **Process the remaining feature docs by domain.** In focused commits, retain architecture/ADRs, move task instructions to user/runbook surfaces, generate reference, and delete duplication. Each domain commit updates links and passes a docs link/check-generation test.

6. **Remove non-doc artifacts from canonical docs.** Delete or relocate the raw session traces, competitive landscape/thesis files, implementation diaries, rollout matrices, and benchmark histories. Any fixture that remains must be synthetic, redacted, minimal, beside the test that consumes it, and proven by that test.

7. **Add drift gates.** CI fails when generated reference is stale; architecture lint flags forbidden structural headings (`Setup`, `Command Reference`, `Recipes`, `File map`, `Key Functions`, `Roadmap`) unless a file is explicitly typed as user guide, generated reference, runbook, ADR, or dated artifact. The gate checks structure, not prose keywords in legitimate architectural discussion.

8. **Verify the result as an agent would use it.** Run a cold navigation test: answer representative architecture questions using only the new docs index and authored corpus, then verify every command/schema lookup resolves to generated help/reference and every setup/recovery lookup resolves to a user guide/runbook. Check all links and render the docs surface.

### Retained architecture template

Every authored feature document should be recognizable without reading its filename:

1. **Purpose and boundary** — the problem owned, plus explicit non-goals.
2. **Owners** — who owns state, scheduling, execution, transport, and presentation.
3. **Data/control flow** — a small diagram or state machine where structure matters.
4. **Invariants and failure behavior** — what must remain true, including fail-loud semantics.
5. **Decisions and tradeoffs** — accepted choice, alternatives, and consequences.
6. **Normative links** — specifications and focused ADRs.
7. **Source seam** — at most a few stable component-level pointers, never a file inventory.

### Acceptance criteria

- Every one of the 58 current Markdown files has been rewritten, generated, relocated, or deleted according to an explicitly reviewed disposition.
- The authored architecture reading path contains no install/setup walkthroughs, exhaustive command/flag tables, recipes, file maps, key-function tables, rollout phases, open-ticket roadmaps, or raw transcripts.
- CLI command and schema details remain available from canonical generated sources and have a stale-generation CI gate.
- Architecture retains every durable ownership boundary, data flow, lifecycle, invariant, failure semantic, and accepted tradeoff identified in this audit.
- `secrets` materialization semantics and menubar scheduler ownership agree with code, tests, and `specifications.md`; no contradiction is papered over.
- Raw session/reasoning traces are gone from public docs; any replacement fixture is synthetic, redacted, minimal, and test-bound.
- Docs links pass, the architecture index has a clear reading order, and an agent can answer representative architecture questions without searching command manuals.

### Tracking

- Linear: **RUSH-3199 — Refocus apps/cli/docs on architecture and durable decisions**
- Pull request: **#3038 — docs(plan): reset the architecture documentation corpus**
- Delivery model: one worktree and PR for the plan plus implementation, with domain-sized commits, CI, non-author review, merge, and post-merge verification.
