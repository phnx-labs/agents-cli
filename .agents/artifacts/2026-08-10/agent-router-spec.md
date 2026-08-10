---
kind: report
title: Agent Router — Source-of-Truth Specification
surface: cli
kicker: agents-cli · meta-harness routing
---

# Agent Router Specification

## Summary

The **Agent Router** picks the best `(harness, account, model/tier, device)` for a task at the **meta-harness** layer agents-cli already owns — one level above a model router like Ramp's. It is mostly a *formalization*: four selectors already ship (`run auto`, balanced rotation, cost tiers, `--where`), and the router adds task-aware scoring, a declarative policy, cross-harness fallback, opt-in hijack, and cross-harness delegation on top — all inside two hard constraints (execution singularity + no-cred-transfer). Requirements are tagged **[Exists]** (reuses guaranteed behavior, anchored to code) or **[New]** (proposed contract, no code yet).

**The primary user-facing unit is a _named router_** (Group E): a reusable, task-typed collection a user creates — a set of allowed harnesses with, per harness, an allowlist of models/tiers and a set of linked accounts. `research`, `prod-refactor`, `cheap-bulk` are each a logical router the user routes tasks through; the router will never resolve a target outside its allowlist or linked accounts. A named router is a generalization of today's profile (a profile is a router pinned to one harness and one account), and it becomes a new **resource kind** (`routers`) alongside `profiles`.

<figure>
<svg viewBox="0 0 860 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Agent Router selection pipeline">
  <defs><marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#a3e635"/></marker></defs>
  <rect x="8" y="70" width="120" height="56" rx="8" fill="#0f1729" stroke="#334155" stroke-width="1.5"/>
  <text x="22" y="96" fill="#e2e8f0" font-family="monospace" font-size="13">task</text>
  <text x="22" y="114" fill="#94a3b8" font-family="monospace" font-size="11">shape · tier</text>
  <rect x="172" y="70" width="130" height="56" rx="8" fill="#0f1729" stroke="#334155" stroke-width="1.5"/>
  <text x="184" y="96" fill="#e2e8f0" font-family="monospace" font-size="13">policy rules</text>
  <text x="184" y="114" fill="#94a3b8" font-family="monospace" font-size="11">B1 · specific-first</text>
  <rect x="346" y="70" width="130" height="56" rx="8" fill="#0f1729" stroke="#334155" stroke-width="1.5"/>
  <text x="358" y="96" fill="#e2e8f0" font-family="monospace" font-size="13">capability gate</text>
  <text x="358" y="114" fill="#94a3b8" font-family="monospace" font-size="11">A2 · exclude unfit</text>
  <rect x="520" y="70" width="130" height="56" rx="8" fill="#0f1729" stroke="#334155" stroke-width="1.5"/>
  <text x="532" y="96" fill="#e2e8f0" font-family="monospace" font-size="13">score</text>
  <text x="532" y="114" fill="#94a3b8" font-family="monospace" font-size="11">cost·win·room</text>
  <rect x="694" y="55" width="158" height="90" rx="8" fill="#12210a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="706" y="79" fill="#a3e635" font-family="monospace" font-size="12">target tuple</text>
  <text x="706" y="98" fill="#94a3b8" font-family="monospace" font-size="11">harness · account</text>
  <text x="706" y="114" fill="#94a3b8" font-family="monospace" font-size="11">model/tier · device</text>
  <text x="706" y="132" fill="#94a3b8" font-family="monospace" font-size="11">→ execAgent</text>
  <path d="M128,98 L170,98" stroke="#a3e635" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <path d="M302,98 L344,98" stroke="#a3e635" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <path d="M476,98 L518,98" stroke="#a3e635" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <path d="M650,98 L692,98" stroke="#a3e635" stroke-width="1.5" fill="none" marker-end="url(#a)"/>
  <text x="10" y="24" fill="#94a3b8" font-family="monospace" font-size="11">Selection function only — no scheduler, no inline probes (D1).</text>
  <text x="10" y="40" fill="#94a3b8" font-family="monospace" font-size="11">Degrade via fallback chain (C2); re-route a pin only when hijack:true (C3).</text>
</svg>
</figure>

## Focus for review

- **The boundary claim:** a *model router* (Ramp, OpenRouter, Cursor) picks a model behind one OpenAI-compatible endpoint; the **Agent Router** picks a whole **harness** (Claude Code, Codex, Kimi, Grok, Gemini, Droid, …) and then the account, model/tier, and device beneath it. Is that the right altitude for us?
- **It is mostly a formalization, not a greenfield build.** Four of the router's selectors already ship: `agents run auto` (harness), balanced rotation (account), cost tiers `cheap|default|best|ultra` (model), `--where`/smart-launch (device). The genuinely new parts are **task-aware scoring**, a **declarative routing policy**, **cross-harness fallback** (degrade the harness, not just the account), **hijack/interception**, and **cross-harness runtime delegation**. Are those the right net-new pieces?
- **Two hard constraints the router must not break:** the execution-singularity contract (SING-1…16 — one scheduler, one executor; cache-only usage reads) and no-cred-transfer across devices. Every routing requirement below is written to sit inside them.
- **Named routers as the main surface (Group E):** users create logical routers per task type — each an allowlist of harnesses × models/tiers + linked accounts. Is `~/.agents/routers/<name>.yml` (a new resource kind, layered like profiles) the right home, and is `agents run <router>` / `agents route --using <name>` the right invocation?
- **Default posture on the surprising behaviors:** hijack (silently re-routing a *pinned* run) is **opt-in, off by default**; delegation is explicit. Agree?

## Purpose

The Agent Router selects and drives the best **execution target** — the tuple `(harness, account, model/tier, device)` — for a given task, across every harness agents-cli integrates, subject to capability, cost tier, headroom, and availability. Where a model router chooses a model inside one endpoint, the Agent Router operates one level up, at the **meta-harness** layer agents-cli already owns: it chooses which agent *loop* runs (each harness has its own tool surface, context format, and account pool), then routes account, model, and device beneath it.

It does not invent a new execution path. It is a **selection function** that resolves a target and then hands off to the one execution engine (`buildExecEnv → execAgent / runWithFallback`, `apps/cli/src/lib/exec.ts:408,1329,2377`). It unifies four selectors that already exist independently, adds task-awareness and an explainable policy on top, and can degrade along a fallback chain, delegate a subtask to another harness, or re-route ("hijack") a pinned execution whose target is exhausted or down.

**This spec is the contract for that capability.** Each requirement is tagged **[Exists]** (the router reuses guaranteed behavior, anchored to the code that enforces it today) or **[New]** (proposed contract with no code yet — do not assume it until it lands, per the repo's truthful-capability-table rule).

---

## Requirements

### Group A — The routing decision

#### Requirement A1 — Resolve a target tuple for a task
The router SHALL, given a task with no harness explicitly named, resolve a concrete `(harness, account, model/tier, device)` target and execute it through the single execution engine, or fail loud (D3) when none is eligible. **[Exists → extend]** — `agents run auto` already resolves the harness via `collectHarnessCandidates()` + `pickHarnessWeighted()` and dispatches through the same engine.

- **Scenario: auto-route a bare task**
  - GIVEN two harnesses are installed and signed in (e.g. `claude`, `codex`)
  - WHEN the user runs `agents route "refactor the exec pipeline"` (no harness named)
  - THEN the router picks one eligible harness, one account, resolves the tier to a concrete model, picks a device, and starts exactly one run through `execAgent`
  - AND the chosen target is recorded on the session (A6).

_Evidence: `apps/cli/src/commands/exec.ts:2283-2308` (`collectHarnessCandidates`, `pickHarnessWeighted` on `run auto`); engine entry `apps/cli/src/lib/exec.ts:1329` (`execAgent`). The cross-harness layer is tested at `apps/cli/src/lib/rotate.test.ts:610` ("run auto — the cross-harness layer, RUSH-2132")._

#### Requirement A2 — Capability gate (never route to an unsupported harness)
The router MUST NOT select a harness whose registry capabilities do not satisfy the task's declared requirements (mode, subagents, workflows, MCP, …); an ineligible harness is excluded before scoring, with a stated reason. **[Exists]**

- **Scenario: a workflow task excludes a harness that lacks workflows**
  - GIVEN a task that requires `workflows`
  - WHEN the router filters candidates
  - THEN a harness whose `capabilities.workflows` is `false` is excluded, and the exclusion reason is available under `--explain`
  - AND if the required mode is unsupported for the resolved version, `supports()` returns `too_old`/`too_new` and that candidate is excluded, never silently downgraded.

_Evidence: `apps/cli/src/lib/capabilities.ts:60-99` (`supports`, `capableAgents`); registry `apps/cli/src/lib/agents.ts:277-979` (`AGENTS[...].capabilities`, incl. `modes`, `subagents`, `workflows`, `headlessPlan`)._

#### Requirement A3 — Honor the cost tier
The router SHALL treat a task's cost tier (`cheap|default|best|ultra`) as a cross-harness intent and resolve it to a concrete model **per the chosen harness+version**; a tier a harness cannot distinctly satisfy clamps to the nearest rung with a stated note, and a single-model harness maps the tier to reasoning effort. **[Exists]**

- **Scenario: `best` resolves per harness**
  - GIVEN the task requests tier `best`
  - WHEN the router selects `codex@<v>` vs a single-model harness like `grok`
  - THEN for codex it forwards `--model <the best-rung model for that catalog>`, and for grok it forwards the effort dial for `best`, each with any clamp note surfaced
  - AND a tier that resolves to no model on that harness falls back to the harness default with a printed note, never a hard error.

_Evidence: `apps/cli/src/lib/model-tiers.ts:27` (`MODEL_TIERS`), tier→model/effort resolution `apps/cli/src/lib/exec.ts:1079-1235`; per-harness/version overrides `apps/cli/src/lib/model-tier-overrides.ts` (`agents config set run.<agent@version>.tier.<tier>`)._

#### Requirement A4 — Exclude unavailable accounts; weight by headroom
The router SHALL exclude any target whose account is not signed in or has no remaining headroom, and among eligible accounts of the chosen harness SHOULD pick by balanced rotation (headroom-weighted, org-deduped). It MUST read usage/headroom **from cache only** and MUST NOT trigger a live provider fetch, credential refresh, or transcript scan as part of a routing decision. **[Exists]**

- **Scenario: skip an exhausted account, weight the rest**
  - GIVEN three `claude` accounts, one rate-limited and two healthy with different remaining headroom
  - WHEN the router selects an account
  - THEN the rate-limited account is excluded (`hasUsageAvailable` false) and the pick is weighted-random by `capacityWeight` across the two healthy ones
  - AND accounts sharing one org/rate-limit bucket are deduped to a single candidate.

_Evidence: `apps/cli/src/lib/rotate.ts:387-411` (`pickBalancedCandidate`), `:459-467` (`capacityWeight`), `:706-782` (`collectRunCandidates`, cache-only via `getUsageInfoByIdentity({readOnly:true})`); cache-only mandate SING-1a `apps/cli/docs/specifications.md:2541-2546`._

#### Requirement A5 — Place on a device without moving credentials
The router SHALL place the run on a device by the existing placement cascade (explicit pin > pool-of-one > health/harness/load-aware pick > local), and MUST use the **target device's own accounts** — it MUST NOT transfer native OAuth/session credentials across the device boundary to satisfy a route. **[Exists]**

- **Scenario: route to a remote device uses that device's login**
  - GIVEN the best harness for a task is signed in on `yosemite-s0` but not locally
  - WHEN the router places the run there
  - THEN it dispatches over SSH with actor/provenance env forwarded, and the remote CLI authenticates with `yosemite-s0`'s own credentials
  - AND if no pool device can run it, the router raises `NoViableDeviceError` naming each device's reason rather than silently falling back to local.

_Evidence: placement cascade `apps/cli/src/lib/teams/scheduler.ts:1-36,304-358`, fail-loud `:107-136`; `--where local|device|auto|lease|cloud` `apps/cli/src/commands/exec.ts:837-877`; env forwarding `apps/cli/src/lib/hosts/dispatch.ts:77-96` (`withActorEnv`, `remoteRunShellPrelude`); no-cred-transfer is enforced fleet-wide (PR #2573, "refuse native OAuth/session transfer on every cross-device path")._

#### Requirement A6 — Record the decision (auditable provenance)
The router SHALL record the routing decision — the chosen target and the reason it won — on the session so it is inspectable in `agents sessions`, and this provenance SHALL ride the exec env through every boundary the run crosses (local spawn, SSH dispatch, teams, cloud), consistent with the surface-parity rule. **[New]**

- **Scenario: the decision is visible after the fact**
  - GIVEN a routed run completed on a remote device
  - WHEN the user inspects it with `agents sessions <id>`
  - THEN the target `(harness, account, model, device)` and the routing reason are present
  - AND the same fields are present whether the run executed locally, over SSH, inside a team, or in the cloud.

_Evidence (boundaries to wire): `buildExecEnv` `apps/cli/src/lib/exec.ts:408`; SSH forwarding contract `apps/cli/src/lib/hosts/remote-cmd.ts:86-161` (`RUN_OPTION_FORWARDING`); the surface-parity rule (actor provenance precedent, RUSH-2028) in the repo CLAUDE.md §Code review conventions._

### Group B — The routing policy engine

#### Requirement B1 — Declarative rules take precedence
The router SHALL read a routing policy from config (`agents.yaml`, same layered resolution as run defaults) mapping a task label/pattern to a harness and/or tier preference, and SHALL apply the most-specific matching rule before any scored selection. **[New]** — reuses the existing selector shape and config layering.

- **Scenario: a rule pins research tasks to a cheap tier**
  - GIVEN a policy rule `route: [{ when: "label:research", tier: cheap, prefer: [gemini, kimi] }]`
  - WHEN a task labelled `research` is routed
  - THEN the router restricts candidates to the preferred harnesses at tier `cheap`, falling through to the next rule / scoring only if none is eligible
  - AND a more-specific selector (`agent@version`) wins over a wildcard, mirroring tier-override resolution.

_Evidence (shape to mirror): selector precedence `apps/cli/src/lib/model-tier-overrides.ts`; run-defaults layering `apps/cli/src/lib/run-defaults.ts` / `getConfiguredRunStrategy` (`rotate.ts:132-136`)._

#### Requirement B2 — Scored selection when no rule decides
The router SHOULD, when no rule fully determines the target, score eligible targets by a configurable weighted function of cost, measured success, latency, and headroom, and pick the top-scoring one. **[New]** — measured success is sourced from the existing bench + cost history.

- **Scenario: score across eligible harnesses**
  - GIVEN two eligible harnesses with different `$/token`, measured success on the task class, and headroom
  - WHEN the router scores them with the configured weights
  - THEN it selects the higher composite score and can show the per-signal contribution under `--explain`.

_Evidence (signal sources): cost catalog `$/token` `apps/cli/src/lib/models.ts:1049`; spend history `apps/cli/src/commands/cost.ts` (`agents cost`); measured strength `apps/cli/src/commands/bench.ts` + `apps/cli/bench/tasks`; headroom `capacityWeight` (`rotate.ts:459-467`)._

#### Requirement B3 — Online learning is optional and never opaque
The router MAY update per-`(harness, task-class)` scores from observed outcomes (success / latency / cost) using an online estimator (e.g. EWMA / Thompson sampling, as Ramp's router does), but any learned score MUST remain explainable and overridable by a B1 rule. **[New]**

- **Scenario: a learned preference is still overridable**
  - GIVEN the estimator has learned harness X is best for "large refactor"
  - WHEN a B1 rule pins large-refactor tasks to harness Y
  - THEN the rule wins, and `--explain` shows both the learned ranking and the overriding rule.

_Evidence (external contract): Ramp Router uses "a dynamic, failure-aware routing system using Thompson Sampling and EWMA to learn real-time latency and failure distributions" — see Research. This requirement inherits its authority from that source, not from our weights, and is marked MAY on purpose._

#### Requirement B4 — Deterministic default order
The router SHALL, when neither a rule nor a score decides (no policy, no history), select from a documented default order rather than an undocumented or purely random pick. **[Exists → tighten]** — `run auto` today is weighted-random by headroom; the router documents and pins the tie-break.

- **Scenario: cold start is documented**
  - GIVEN no policy and no measured history for any candidate
  - WHEN the router selects
  - THEN it uses the documented default (e.g. headroom-weighted among capable+available, ties broken by a stated order), and `--explain` says "default order (no policy/history)".

_Evidence: current cold-start behavior `pickHarnessWeighted` (`apps/cli/src/lib/rotate.ts`, tested `rotate.test.ts:610`)._

### Group C — Modes and surfaces

#### Requirement C1 — Auto-route surface (`agents route` / `agents run --route`)
The router SHALL expose an entry point that takes a task with no harness named, resolves a target, and executes it; and SHALL support a dry-run/`--explain` form that resolves and prints the decision **without executing**. **[New]** — sits beside `run auto` and profiles.

- **Scenario: dry-run explains without running**
  - GIVEN a task
  - WHEN the user runs `agents route "<task>" --explain`
  - THEN the router prints the chosen target, the ranked alternatives, and the reason each was chosen/rejected, and starts no agent process.

_Evidence (siblings): `run auto` `apps/cli/src/commands/exec.ts:2283-2308`; profiles `agents run <profile>` `apps/cli/src/lib/profiles.ts:696-731` (name → `{agent, version, env(model/baseURL/token), tier map}`)._

#### Requirement C2 — Degrade along a fallback chain
A routed execution that fails on a recoverable, rate-limit-class error SHALL cascade to the next-best target and record the switch. The router SHALL be able to build that chain across **accounts of the same harness** and across **different harnesses**; auth failures MUST NOT cascade. **[Exists (same-harness) → extend (cross-harness)]**

- **Scenario: exhaust one harness, degrade to another**
  - GIVEN the primary target hits a rate-limit pattern mid-run
  - WHEN the router has a cross-harness fallback available
  - THEN it hands off to the next target with a continuation prompt and records which entry actually ran
  - AND a non-rate-limit auth failure stops at the primary and returns, rather than cascading.

_Evidence: `runWithFallback` `apps/cli/src/lib/exec.ts:2377-2480`, cascade gate on `RATE_LIMIT_PATTERNS` `:2166-2181`; same-harness cross-account chain `rotationFailoverChain` `apps/cli/src/lib/rotate.ts:976-989` (capped at 3). Cross-harness chain is the extension._

#### Requirement C3 — Hijack / interception (opt-in, off by default)
WHEN an execution pins a harness/account that is exhausted or down, AND hijack is enabled in config, the router SHALL re-route to an equivalent eligible target and emit a **visible notice** naming the original and the substitute. WHEN hijack is disabled (the default), the router SHALL fail loud with the reason and MUST NOT silently substitute. **[New]**

- **Scenario: hijack on**
  - GIVEN `route.hijack: true` and a run pinned to an exhausted `claude` account
  - WHEN the run would start
  - THEN the router re-routes to an equivalent target and prints `[router] pinned claude/<acct> exhausted → codex/<acct> (hijack on)`
- **Scenario: hijack off (default)**
  - GIVEN `route.hijack` unset and the same exhausted pin
  - THEN the run fails loud (`no headroom on pinned target; enable route.hijack to re-route`) and starts nothing.

_Evidence (why default-off): re-routing a pin is a surprising, effect-bearing substitution; the repo's fail-loud-at-boundaries and no-silent-fallback rules (CLAUDE.md §Code review conventions) require the surprising path be opt-in and the safe path be an explicit error._

#### Requirement C4 — Cross-harness runtime delegation
The router SHALL expose a way for one running harness to delegate a subtask to a **different** harness as a child execution (e.g. Claude delegates a large refactor to Codex, or a cheap classification to a `cheap`-tier harness), returning the child's result to the parent. This delegation MUST run through the teams/cloud dispatch surface, NOT the subagent file-materialization pipeline (which cannot spawn another harness at runtime). **[New]**

- **Scenario: delegate a subtask to a stronger harness**
  - GIVEN a Claude run identifies a subtask better suited to Codex
  - WHEN it delegates via the router
  - THEN a child Codex execution is dispatched (local or on a device where Codex is signed in), its result returns to the parent, and both runs are linked in `agents sessions`
  - AND the delegation is subject to A2/A4/A5 (capability, headroom, no-cred-transfer) exactly like a top-level route.

_Evidence (the gap this fills): subagents are file-materialization only — `SUBAGENT_TARGETS` `apps/cli/src/lib/subagents-registry.ts:289-347` writes definitions into each harness's native `agents/` dir; there is no runtime cross-harness spawn. The correct dispatch surfaces are `dispatchAgentsCommand` `apps/cli/src/lib/hosts/dispatch.ts:679-689` and `executeCloudDispatch` `apps/cli/src/lib/cloud/dispatch.ts:133` (single path for `cloud run` and `run --cloud`; provider interface `cloud/types.ts:326-360`)._

### Group D — Constraints (must-not-break)

#### Requirement D1 — Execution singularity (no second scheduler)
The router MUST be a selection function invoked by the daemon or an `agents run`/`agents route` command. It MUST NOT introduce a timer, watcher, or loop that detects a condition and acts; detection and decision live in the CLI. If routing becomes a fleet-affecting recurring behavior (e.g. auto-rebalancing running work), it MUST be a daemon-owned routine fired by the single pid-claimed scheduler, not a UI or ad-hoc loop. **[Exists — normative]**

- **Scenario: a UI cannot own routing**
  - GIVEN the ext wants an "auto-route my next task" control
  - WHEN it is built
  - THEN the control calls a CLI route command (the CLI holds the trigger); the ext MUST NOT run its own loop that picks a target and dispatches.

_Evidence: SING-1/2/5/6 `apps/cli/docs/specifications.md:2516-2518,2552-2555,2578-2582,2611-2614`; repo CLAUDE.md §"One scheduler, one executor" and §Code review conventions "No second scheduler"._

#### Requirement D2 — Truthful capability table
The router MUST NOT route a capability a harness's registry marks unsupported, and a harness becomes routable for a capability only in the same change that lands its real path. **[Exists — normative]**

- **Scenario: a lying table cannot enable a route**
  - GIVEN a harness whose registry marks `subagents: false`
  - WHEN a delegation route would target it
  - THEN it is excluded; flipping the flag without the real path is a review-blocking violation.

_Evidence: registry `apps/cli/src/lib/agents.ts:277-979`; the "capability table stays truthful, in lockstep with the code" rule (repo CLAUDE.md §Code review conventions)._

#### Requirement D3 — Fail loud at boundaries
An unroutable task (no capable harness, all accounts exhausted, all devices offline) SHALL raise a clear error naming which condition blocked it, and MUST NOT silently pick a wrong harness, no-op, or return exit 0. **[Exists — pattern]**

- **Scenario: nothing eligible**
  - GIVEN a task requiring a capability no installed harness supports
  - WHEN routed
  - THEN the router errors `no capable harness for <capability>` (distinct from `all candidates exhausted` and `all devices offline`) and starts nothing.

_Evidence: fail-loud precedent `NoViableDeviceError` `apps/cli/src/lib/teams/scheduler.ts:107-136`; no-account/no-harness formatters referenced at `apps/cli/src/commands/exec.ts:2206` (`formatNoHealthyHarnessError`, `formatNoHealthyAccountError`)._

#### Requirement D4 — Cost attribution
A routed execution's cost SHALL be attributed to its session so `agents cost` rolls it up per harness/project/day, and the router MAY consume that history as a scoring input (B2). **[Exists]**

- **Scenario: routed spend shows up in the rollup**
  - GIVEN several routed runs across harnesses
  - WHEN the user runs `agents cost --by agent`
  - THEN each routed run's `$` is attributed to the harness that actually executed it.

_Evidence: `apps/cli/src/commands/cost.ts` (rollup by agent/project/day); `$/token` catalog `apps/cli/src/lib/models.ts:1049`._

### Group E — Named (logical) routers

#### Requirement E1 — Define a named router scoped to a task type
The system SHALL let a user create a named router — a reusable, task-typed collection that declares which harnesses it may use and, per harness, an allowlist of models and/or tiers — persisted as a layered resource (`routers`, resolved project > user > system like other resources). The router MUST NOT resolve a target outside its declared harness/model/tier allowlist. **[New]**

- **Scenario: a research router constrains the model set**
  - GIVEN a router `research` allowing `{ gemini: [cheap, default], kimi: [kimi-k2] }`
  - WHEN a task is routed under `research`
  - THEN only those harness × model/tier combinations are eligible
  - AND a request for `ultra`, or for `claude`, under this router is rejected or clamped per policy — never silently routed outside the allowlist.

_Evidence (shape to build on): profiles name→target `apps/cli/src/lib/profiles.ts:696-731`; per-harness tier allow/override `apps/cli/src/lib/model-tier-overrides.ts`; resource layering `apps/cli/src/lib/resources.ts` (`resolveResource`, `listResources`). Allowlisting the *set* (vs picking one model) is the new part._

#### Requirement E2 — Link accounts to a router
A named router SHALL let a user link specific provider accounts; when routing under the router, only linked accounts of the chosen harness are eligible, and balanced rotation (A4) runs **within that linked set**. An unlinked account MUST NOT be selected under the router. **[New]**

- **Scenario: routing stays inside the linked accounts**
  - GIVEN a router `prod` with two `claude` accounts linked, and a third `claude` account also signed in on the machine
  - WHEN a task is routed under `prod`
  - THEN only the two linked accounts are candidates (headroom-weighted, org-deduped), and the third is never selected.

_Evidence: durable account credential `--account` `apps/cli/src/commands/exec.ts:802`; credential resolution `resolveProfileEnv` / `resolveCredentialAccount` `apps/cli/src/lib/profiles.ts:609-626`; rotation within a candidate set `apps/cli/src/lib/rotate.ts:387-411`._

#### Requirement E3 — Invoke a named router
The router group SHALL expose invoking a named router for a task — resolving a target strictly within the router's allowlist and linked accounts, then executing (or resolving under `--explain` without executing). A named router SHALL resolve in the same dispatch precedence as a profile. **[New]**

- **Scenario: route a task through a named router**
  - GIVEN the `research` router exists
  - WHEN the user runs `agents route "<task>" --using research` (equivalently `agents run research "<task>"`)
  - THEN the target is resolved only among the router's in-allowlist, linked, capable, available candidates, and `--explain` shows only those.

_Evidence (precedence sibling): profile dispatch is checked before native-agent dispatch — `profileExists` `apps/cli/src/commands/exec.ts:2314` precedes `isValidAgent` `:2348`; a router slots into the same chain._

#### Requirement E4 — A router is a scoped policy; an empty scope fails loud
A named router MAY carry its own rules/weights (Group B) applied **within its scope**. WHEN the router's eligible set — allowlist ∩ capable ∩ available ∩ linked — is empty, the router SHALL fail loud (D3), naming whether capability, headroom, or account-linkage emptied it, and MUST NOT widen beyond the router to satisfy the task. **[New]**

- **Scenario: exhausted scope does not leak outside the router**
  - GIVEN every linked account of the only allowed harness in `prod` is rate-limited
  - WHEN a task is routed under `prod`
  - THEN the router errors `router 'prod': all linked accounts exhausted (resets in …)` and starts nothing — it does not fall back to an unlinked account or an unlisted harness.

_Evidence: fail-loud pattern `NoViableDeviceError` `apps/cli/src/lib/teams/scheduler.ts:107-136`; no-silent-fallback rule (repo CLAUDE.md §Code review conventions)._

#### Requirement E5 — Routers generalize profiles; the global policy composes them
A named router SHALL be a generalization of a profile (a profile ≡ a router with one harness and one account pinned). A global B1 rule MAY select a router by task label (`when: label:x → using: <router>`), delegating the in-scope decision to that router. **[New]**

- **Scenario: a label maps to a router**
  - GIVEN a global rule `route.rules: [{ when: "label:research", using: research }]`
  - WHEN a bare `agents route "<task>"` runs on a task labelled `research`
  - THEN the decision is delegated to the `research` router (its allowlist, linked accounts, and weights apply).

_Evidence (composition point): B1 policy resolution + the profile-as-single-target precedent `apps/cli/src/lib/profiles.ts:696-731`._

---

## Mockups

The router is a CLI surface. These states are part of the contract; requirements that mention a surface point at a state by name.

### M1 — Decision card (`agents route "<task>"`) → referenced by A1, A6
Today the closest thing is `run auto` printing a one-line harness pick banner (`formatHarnessPickBanner`, exec.ts:2206). Proposed: a compact routing card, then the run.

```
$ agents route "refactor the exec pipeline to remove the tmux branch"
+-- agent router --------------------------------------------------+
| task      refactor . code . large            tier  best          |
| > target  codex @ 0.47.1                                         |
|           account  work (headroom 71%)                           |
|           model    gpt-5.3-codex   (best -> per-catalog)          |
|           device   yosemite-s0  (signed in . load 9%)            |
| why       policy rule "label:refactor->prefer codex" . then      |
|           headroom-weighted account . best-rung model            |
| est cost  ~$0.38   .   alts: claude(0.72) grok(0.55)             |
+------------------------------------------------------------------+
[router] starting codex@0.47.1 on yosemite-s0 ...
```

### M2 — Dry-run scoreboard (`--explain`, no execution) → referenced by A2, B2, C1
```
$ agents route "summarize these 400 issues into themes" --tier cheap --explain
task: research . long-context . cheap        (no rule matched -> scored)

  harness        cap   acct headroom  $/1M   bench(research)  score   picked
  ------------------------------------------------------------------------
  gemini@..      ok    83%           $0.10   0.71             0.82    < pick
  kimi@..        ok    64%           $0.14   0.68             0.71
  claude@..      ok    58%           $3.00   0.80             0.44
  codex@..       ok    71%           $1.25   0.66             0.49
  grok@..        --    n/a           --      --               excl: no headless plan
                                                                    (headlessPlan:false)

decision: gemini@<v> . account personal . model <cheap-rung> . device local
(dry run -- nothing started)
```

### M3 — Routing policy in `agents.yaml` → referenced by B1, B2, C3
```yaml
route:
  hijack: false                 # C3 -- default off; re-route a pinned run only when true
  weights: { cost: 0.4, success: 0.4, latency: 0.1, headroom: 0.1 }   # B2
  rules:                        # B1 -- most-specific first
    - when: "label:refactor"    #   task label / glob / path predicate
      prefer: [codex, claude]
      tier: best
    - when: "label:research"
      prefer: [gemini, kimi]
      tier: cheap
    - when: "path:apps/ios/**"  #   Swift -> prefer a harness strong there
      prefer: [claude]
  default: headroom             # B4 -- documented cold-start order
```

### M4 — Hijack notice (C3, opt-in) and fail-loud (D3)
```
# route.hijack: true
[router] pinned target claude/work exhausted (0% headroom, resets 47m)
[router]   -> re-routing to codex/work  (hijack on)  .  set route.hijack:false to disable

# route.hijack unset (default) -- same exhausted pin:
error: no headroom on pinned target claude/work (resets in 47m)
       enable route.hijack to auto-re-route, pick another account, or wait.
```

### M5 — Cross-harness delegation (C4)
```
[claude . main run] subtask detected: "port native/computer-win UIA bridge" -> better on codex
[router] delegating to codex@0.47.1 (device: yosemite-s0, signed in) ...
[codex . child a1f2] ... done (exit 0, 4m12s, $0.21)
[claude . main run] child result folded in; continuing.
  linked: agents sessions a1f2  (parent 9c7e)
```

### M6 — Named (logical) router: create, scope, link, use → referenced by E1-E5
```
$ agents route create research --harness gemini,kimi --tier cheap,default
+ created router "research"   (~/.agents/routers/research.yml)

$ agents route research allow kimi kimi-k2        # narrow kimi's model set
$ agents route research link-account gemini personal
$ agents route research link-account kimi work

$ agents route show research
router: research     task type: research / long-context
  gemini    models: [default, cheap]     accounts: [personal]
  kimi      models: [kimi-k2]            accounts: [work]
  weights:  cost .5 . success .3 . headroom .2      hijack: off

$ agents route list
  research      2 harnesses . 2 accounts . tier<=default
  prod-refactor 2 harnesses . 3 accounts . tier=best
  cheap-bulk    3 harnesses . 4 accounts . tier=cheap

$ agents route "summarize these 400 issues into themes" --using research --explain
task routed under router "research" -- candidates limited to its allowlist + linked accounts
  harness   model      account   headroom  $/1M   score   picked
  --------------------------------------------------------------
  gemini    <default>  personal  83%       $0.10  0.82   < pick
  kimi      kimi-k2    work      64%       $0.14  0.71
  (claude, ultra, unlinked accounts: excluded -- not in router "research")
decision: gemini . personal . <default> . device local     (dry run)
```

The router file (`~/.agents/routers/research.yml`) — a new resource kind, layered project > user > system:
```yaml
name: research
task: research               # the task type this router serves
harnesses:                   # allowlist: only these harness x model/tier combos
  gemini: { models: [default, cheap], accounts: [personal] }
  kimi:   { models: [kimi-k2],        accounts: [work] }
weights: { cost: 0.5, success: 0.3, headroom: 0.2 }   # E4 -- scoped policy
hijack: false
```

---

## Research

State-of-the-world grounding (August 2026), for the boundary claim and the B3 online-learning contract.

- **Ramp Router** — Ramp (a fintech) opened the model router it ran internally for ~3 years; OpenAI-compatible endpoint ("one-line base-URL change"), routes to the cheapest approved model that clears a quality bar across "latest frontier models from OpenAI, plus select open-source models, including Kimi," with failure-aware fallback when a provider rate-limits or goes down. Claims a ~30% LLM cost cut. Decision engine: "Thompson Sampling and EWMA to learn real-time latency and failure distributions." This is a **model** router (one endpoint, many models) — the layer *below* a harness. Sources: [ramp.com/router](https://ramp.com/router), [Enterprise DNA](https://enterprisedna.co/resources/ai-pulse/ai-pulse-2026-07-21-ramp-opens-its-internal-model-router-to-the-public-claiming/), [ZenML LLMOps DB](https://www.zenml.io/llmops-database/cost-efficient-llm-routing-with-online-learning-and-thompson-sampling).
- **Cursor / Meta / Ramp are all shipping model routers** — [The New Stack](https://thenewstack.io/cursor-ramp-meta-model-router/) (article body not machine-readable; headline + landscape corroborated by the Ramp and Entelligence sources).
- **The harness-router layer is a distinct, emerging category.** Kilo Code's "Helix" routes by *coding task type* (generation / refactor / debug / test). OpenClaw dispatches coding work to Claude Code / Codex CLI / Cursor as sub-agents via the Agent Client Protocol. "AgentHarness" offers a unified interface over CLI agents with provider switching, circuit breakers, health monitoring, token tracking. Warp runs multiple harnesses in parallel. Sources: [9 Best LLM Routers 2026 / Entelligence](https://entelligence.ai/blogs/9-best-llm-routers-and-model-routing-tools-in-2026), [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents), [Agentic Coding 2026](https://halallens.no/en/blog/agentic-coding-in-2026-the-complete-guide-to-plugins-multi-model-orchestration-and-ai-agent-teams).

**Takeaway for the boundary:** everyone else routes *models*. agents-cli already lives one level up (it installs, runs, and dispatches whole harnesses), so its differentiated product is a **harness** router — and it already owns the primitives (tiers, cost, balanced rotation, `run auto`, `--where`, cloud/teams dispatch) a model router has to build from scratch.

---

## Evidence

Two independent Explore agents (Sonnet) reverse-mapped the execution/routing surface and the subagents/teams/cloud/singularity surface from the code, blind to this draft. Convergence and the one contradiction they resolved:

- **Converged (high confidence):** `run auto` is the existing cross-harness selector (`collectHarnessCandidates`/`pickHarnessWeighted`, exec.ts:2283-2308; RUSH-2132 test); cost tiers are cross-harness and resolve per harness+version (model-tiers.ts:27, exec.ts:1079-1235); balanced rotation is headroom-weighted and cache-only (rotate.ts:387-467,706-782); `runWithFallback` cascades **only** on rate-limit patterns, not auth (exec.ts:2377-2480,2166-2181); the placement cascade fails loud via `NoViableDeviceError` (teams/scheduler.ts:107-136).
- **Divergence resolved — the delegation surface.** The subagents map established that **cross-harness runtime subagent spawning does not exist** — `SUBAGENT_TARGETS` only materializes definition files into each harness's native dir (subagents-registry.ts:289-347). This corrected the initial framing that C4 could reuse "subagents"; the correct surfaces are `dispatchAgentsCommand` (hosts/dispatch.ts:679-689) and `executeCloudDispatch` (cloud/dispatch.ts:133). C4 is written to that resolution.
- **Drift found — none of the [Exists] requirements contradict the code.** Each [Exists] tag was checked against the cited file:line and holds. The **[New]** requirements (A6 provenance, B1–B3 policy engine, C1/C3/C4 surfaces) have **no enforcing code** and are marked as proposed contract, not current guarantee — do not treat them as implemented (truthful-table rule).

Singularity is the load-bearing constraint the verification surfaced: SING-1a (cache-only usage consumers, specifications.md:2541-2546) and SING-1/5/6 (one scheduler/executor) mean the router must be a pure selection function over the daemon's cached snapshots, never an inline prober or a second scheduler. D1 encodes this.

## Findings

_Coverage gaps and ambiguities — what the spec could not pin down, named rather than papered over._

- **Task classification is unspecified — but named routers soften it.** Every task-aware requirement (A3 tier intent, B1 label rules, B2 task-class scoring) presumes a task carries a *shape* (code/research/refactor/long-context) and/or a label. Today no code classifies a free-text prompt into a task class. **Named routers (Group E) largely dissolve this**: the user picks the router (`--using research`), or a single top-level rule maps `label → using: <router>`, so the router never has to classify free text — it inherits the user's explicit choice. Auto-classification of a bare `agents route "<task>"` with no `--using` and no label remains the one case that needs a classifier; options are explicit `--label`/`--tier`, a lightweight classifier, or convention from the invoking command.
- **Bench→score mapping is unspecified.** B2 wants "measured success on the task class" from `agents bench`, but the bench task taxonomy is not yet aligned to routing task-classes. The join between them needs its own small spec.
- **Delegation result contract (C4).** How a child harness returns a structured result to the parent (stdout convention, a result file, a session-linked artifact) is unspecified; the dispatch surface exists, the return channel does not.
- **Hijack scope (C3).** Whether hijack may switch harness (not just account) mid-stream on an already-running process — vs only at launch — is left to the design; this spec only guarantees the launch-time behavior and the visible notice.

## Relationship to change

This document specifies the **is + the proposed contract**, not a build plan. If we proceed, the delta divides cleanly:

1. **Formalize `run auto` into `agents route`** — task shape/label input, the `--explain` scoreboard (M2), decision provenance on the session (A6). Small, reuses existing selectors.
2. **Named routers** (E1–E5) — the `routers` resource kind (`~/.agents/routers/<name>.yml`), the `agents route create/list/show/allow/link-account` surface (M6), and resolution within a router's allowlist + linked accounts. This is the primary user-facing slice and the natural first thing to ship — it generalizes profiles and needs no classifier.
3. **The policy engine** (B1–B4) — config schema (M3), scoring, optional online learning; composes named routers via `label → using`.
4. **Cross-harness fallback + hijack** (C2 extend, C3) — extend `runWithFallback` to cross-harness chains + the opt-in re-route. Medium; touches the engine.
5. **Cross-harness delegation** (C4) — the genuinely new surface; needs the child-result contract first.

Hand these to `/swarm:plan` to propose the delta. Named routers (slice 2) are the recommended first build: they deliver the user-visible value, generalize the existing profile mechanism, and sidestep the classification gap since the user selects the router explicitly.
