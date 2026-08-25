---
kind: visual
title: Every system rule and hook, with the remaining simplification work
summary: >
  The 23-rule personal distillation is live, while the shared system remains at 19 rules. This dashboard inventories every injected rule and registered hook, then audits whether each rule protects an outcome or over-prescribes the agent's exact maneuver.
status: final
date: 2026-08-25
context: status of rules, subrules, and hook messaging across muqsitnawaz/.agents and phnx-labs/.agents-system
facts:
  - "Personal layer: 23 rules, 1,583 compiled words, merged in .agents PR #288"
  - "Shared system: 14,695 to 6,042 words, merged in .agents-system PR #348"
  - "Shared-system 23-rule distillation PR #381 was closed, not merged"
  - "Hook refinement: major message and guard improvements merged; full 14-to-8 target not complete"
  - "Live system inventory: 19 injected subrules and 27 registered logical hooks"
  - "Agency audit: 8 keep, 6 loosen, 4 move to skills, 1 fold into another rule"
links:
  - https://linear.app/getrush/issue/PHNX-2678/fleet-session-audit-7d-23-rulehookguard-changes-for-agents
  - https://github.com/phnx-labs/agi-cli/pull/3067
---

## Story

The answer is **yes for your fleet, partly for the shared system, and partly for hooks**.

Your personal `muqsitnawaz/.agents` layer now shadows the shared rule corpus with the distilled version: **23 rules, 1,583 compiled words**, with no system-rule leaks. That is the strongest simplification and it is merged in [PR #288](https://github.com/muqsitnawaz/.agents/pull/288).

The same exact rewrite was proposed for everyone in `phnx-labs/.agents-system` as [PR #381](https://github.com/phnx-labs/.agents-system/pull/381), but it was **closed, not merged**. The recorded reason was scope: these were treated as Muqsit's personal operating instructions, so the user layer became their home. The shared system did independently receive a less aggressive but real cleanup in [PR #348](https://github.com/phnx-labs/.agents-system/pull/348): **14,695 → 6,042 words**, and its Stop-hook messages fell from roughly **30–40 lines to 6–12 lines**.

The hook cleanup is a program, not a single pending switch. The measurement artifact, [hooks battlefield](https://github.com/phnx-labs/agi-cli/pull/2919), proposed a **14→8 guard corpus**. Several high-value pieces landed, but not every proposed merge or deletion did.

<div class="artifact-callout"><strong>Bottom line:</strong> the fleet you use sees the distilled rules today. A fresh/shared system installation does not see that exact 23-rule corpus. Hook wording is substantially cleaner, while hook topology is still between the measured “before” and the proposed 8-guard end state.</div>

## Data

| Surface | Intended simplification | What is live now | Status |
|---|---|---|---|
| `muqsitnawaz/.agents` rules | Essence-only personal rulebook | 23 rules / 1,583 words via PR #288 | **Landed** |
| `phnx-labs/.agents-system` rules | Same 23-rule / ~1.5k corpus | Exact PR #381 closed; earlier 6,042-word cleanup from PR #348 is live | **Partial** |
| Stop-hook messaging | Replace 30–40-line lectures with direct instructions | 6–12-line messages via PR #348 | **Landed** |
| Low-value guards | Remove measured noise | `footer-guard` removed (#386); personal `user-message-guard` removed (#289) | **Landed** |
| Plan-mode overhead | Avoid irrelevant delivery checks while planning | Four delivery guards skip plan mode (#369) | **Landed** |
| Hook internals | Remove duplication and false states | shared JSON parser (#385), shared git parser (#387), orphan mq declaration removed (#388) | **Landed** |
| Stop escalation wording | Stop treating every completion as phone-worthy | plain feed post by default (#365) | **Landed** |
| Correctness follow-ups | Fix repeated/incorrect guard outcomes | RUSH-3032 follow-ups (#374), merge verdict fixes (#376/#382) | **Landed** |
| Proposed 14→8 topology | Merge four git guards; decide plan reminder; reduce guard count to eight | No single completion PR; several proposed merges/cuts remain | **Open gap** |

### What did not land as originally proposed

- The exact shared-system distillation in PR #381.
- The complete 14→8 hook topology from the battlefield verdict.
- A single closure artifact or ticket proving every battlefield recommendation was accepted, rejected, or shipped.

### Important nuance

The `plan-html-reminder` was initially treated as dangling in personal PR #291, then correctly restored in [PR #292](https://github.com/muqsitnawaz/.agents/pull/292) because the active script lives beside its system subrule. This is a useful warning: the cleanup is real, but one audit initially missed rule-adjacent hooks.

## Detailed inventory

This is the decision sheet the earlier dashboard lacked. “Current instruction” is the live shared-system text or emitted behavior as of `~/.agents/.system` at commit `2a0c0eb`. “Next change” is either a landed improvement or a proposal grounded in the closed distillation PR and the hook-battlefield analysis; proposed items are not presented as approved work.

<div class="artifact-callout"><strong>How to read it:</strong> rules are injected language. Hooks are runtime actions. The 14→8 target applies only to deny/reminder guards, not to all 27 lifecycle hooks; SessionStart injectors and state-recording hooks are a different surface.</div>

### System rules — all 19 injected subrules

| Rule | Purpose | Current instruction, in essence | Change / improvement status |
|---|---|---|---|
| `foundations` | Define F1–F5 autonomy, verification, communication, and safety | Act end-to-end; self-unblock; verify the visible outcome; involve the owner minimally; protect irreversible state | **Landed:** rewritten in #348. **Keep:** core spine; personal layer carries a shorter variant. |
| `research-discipline` | Make claims traceable and current | Fetch current code, follow the complete data path, quote file/line evidence, web-check time-sensitive facts | **Landed:** shortened in #348. **Keep distinct:** evidence discipline is not a workflow recipe. |
| `fleet-delegation` | Decide when and how to use the fleet | Mix harnesses, rotate healthy accounts, reserve expensive models, parallelize multi-dimensional work | **Proposed:** fold with `parallel-teams` and `remote-fleet-dispatch` into one “Running Agents & Teams” rule, as #381 proposed. |
| `code-quality` | Prevent local patches and prose/code bloat | No fallbacks, duplication, scope creep, ad-hoc consumer fixes, marketing filler | **Landed:** essence rewrite in #348. **Keep.** |
| `testing-strict` | Define meaningful verification | Tests beside source, real services, meaningful failure coverage, end-to-end proof | **Landed:** essence rewrite in #348. **Keep.** |
| `truly-agentic-git-workflow` | Own the worktree → PR → review → merge path | Never edit the primary checkout; use a fresh linked worktree; attach real evidence; merge on green | **Landed:** large rewrite in #348 plus auto-worktree/fetch fixes. **Proposed:** absorb `gh-merge-guard` prose while preserving its adjacent hook. |
| `gh-merge-guard` | State the non-author-review merge contract | Rebase-merge autonomously only after green CI and a verdict on this PR; never bypass protection | **Landed:** short rule; verdict correctness fixed in #376/#382. **Possible consolidation:** prose can live in git workflow; hook must remain registered. |
| `no-pr-footer` | Ban generated-by promotional footers | Never add Claude/agent promotional signatures to commits, PRs, or issues | **Landed:** `footer-guard` removed after zero useful fires; prose rule remains. **No further runtime work.** |
| `operational` | Cover execution mechanics that do not belong elsewhere | Act → verify → show → continue; bounded waits; keychain secrets; durable output; minimal handoffs | **Landed:** shortened and de-metaphored in #348. **Review candidate:** some lines duplicate Foundations and repo-local policy. |
| `conventions` | Pin memory, tickets, and coordination conventions | `AGENTS.md` is canonical; claim real work; do not create parking-lot tickets; use teams for multi-surface work | **Landed:** shortened. **Keep**, but ticket details may belong in the `tickets` skill rather than every prompt. |
| `agents-cli` | Teach three agents-cli-specific facts | Agent homes are symlinks; search prior sessions; inspect active agents before spawning | **Proposed removal:** #381 removed it from injected rules and delegated mechanics to skills. Still present in shared system. |
| `parallel-teams` | Provide the full multi-agent execution contract | Plan ownership boundaries, isolate worktrees, mix rosters, verify spawns, watch and land every track | **Partially simplified:** #348 cut repetition. **Proposed merge:** one Running Agents & Teams rule; mechanics stay in `teams` skill. |
| `tech-stack` | Route tasks to native tools | Tickets → skill, web → browser, native → computer, credentials → secrets, charts → inline SVG | **Landed:** concise map in #348. **Keep as a compact routing table.** |
| `ui-work-discipline` | Make visual verification mandatory | Render the real surface, screenshot it, read it back, and present real variations for genuine design choices | **Landed:** concise visual contract. **Keep.** |
| `plan-presentation` | Make plans reviewable and visual | Markdown source, inline-SVG architecture, real diffs, checklist, render/check/read-back before presentation | **Landed:** shortened; skill consolidation moved authoring detail to `artifacts`. **Keep guard-backed core, trim duplicated mechanics when safe.** |
| `task-checklists` | Keep multi-step work legible and bound to delivery | Create and advance a checklist for 3+ steps or ticketed work; close it with proof | **Landed:** shortened. **Keep.** |
| `feed-status-posts` | Separate activity history from phone-worthy updates | Plain posts record; `--level important` delivers sparingly; `--blocked` only for genuine owner needs | **Landed:** wording corrected in #365 so every done claim no longer asks for a phone ping. **Keep.** |
| `remote-fleet-dispatch` | Preserve non-derivable remote execution traps | Use native `--device`, never raw SSH launch; probe the actual operation; reconcile detached status | **Landed:** mechanics delegated to skills in #348. **Proposed merge:** fold remaining traps into Running Agents & Teams. |
| `unattended-verification` | Prevent silent-success automation | Assert postconditions, probe the real action class, key state per run, bound waits, fail loud only on real gaps | **Proposed consolidation/removal:** #381 removed it as a standalone rule; unique postcondition lines should survive under Foundations/F3. |

### Agency audit — protect intent, not choreography

The simplification question is not only “how many words?” It is whether the injected text helps an agent exercise judgment. A useful rule states the outcome, boundary, or non-derivable platform fact. A brittle rule dictates a universal command, model, teammate count, polling cadence, document shape, or test layout even when the task calls for another approach.

<div class="artifact-callout"><strong>Desired center:</strong> understand the user's intended outcome; explore the environment, prior work, and available tools; choose a safe effective path; verify real progress; adapt when evidence changes; and continue until the outcome is delivered or a genuine boundary needs the user.</div>

| Rule | Verdict | Instruction that constrains judgment | Recommended direction |
|---|---|---|---|
| `foundations` | **Loosen** | “Stop for exactly four things”; try three paths; diagnosis implies fixing; every build follows design → approval → implementation → release | Keep autonomy, scope fidelity, self-unblocking, outcome verification, and irreversible-state safety. Describe boundaries as principles rather than a closed lifecycle or attempt count. |
| `research-discipline` | **Loosen** | Every factual claim needs a quote; read every file in the path; every research brief ends with fixed text | Scale evidence to consequence, uncertainty, novelty, and risk. Trace enough of the real path to rule out competing explanations. |
| `fleet-delegation` | **Move to skills** | Spawn 3–7 agents from message one; diversify harnesses; select named model tiers; delegate before a third shell call | Keep one reminder that delegation is available. Let `run` and `teams` teach capabilities; delegate when independence and saved time exceed coordination cost. |
| `code-quality` | **Loosen** | “Every fallback hides a bug”; propose a refactor whenever no canonical source exists; prose punctuation quota | Reject fallbacks that conceal inconsistent state or false success. Permit explicit product degradation and focused local changes when justified. Drop stylistic micromanagement. |
| `testing-strict` | **Loosen** | Every source gets a 1:1 colocated test; no mocks; unit plus end-to-end for all changes | Test the highest-risk behavior at the lowest faithful level. Require real integration checks at critical boundaries; allow controlled substitutes for deterministic failure cases. |
| `truly-agentic-git-workflow` | **Keep invariant; move mechanics** | Exact worktree recipe, commit pathspec, evidence-upload chain, watcher command, and merge sequence | Inject only primary-checkout safety, isolated changes, review, green merge, and delivery ownership. Put recipes in Git/PR skills. Remove the known-stale `--fail-fast` watcher tactic. |
| `gh-merge-guard` | **Keep** | Asks on any review issue, test failure, or merge conflict | Preserve non-author review, green checks, and no bypass. Agents should investigate and repair ordinary failures without asking. |
| `no-pr-footer` | **Fold** | Standalone rule for one output preference | Keep the prohibition as one line in `conventions` or enforce it mechanically. |
| `operational` | **Loosen** | One exact wait implementation; no emojis, env credentials, local CLIs, `/tmp`, Markdown, toasts, or dev servers | Keep “ask about intent, decide implementation” and ACT → VERIFY → SHOW → CONTINUE. Move tool/file preferences to relevant skills or repo rules; scope security claims precisely. |
| `conventions` | **Keep** | Long historical ticket-count rationale is injected with the policy | Keep canonical memory and ticket restraint in a few lines. Move the incident history and tracker mechanics to docs/skills. |
| `agents-cli` | **Move to skills** | Always search sessions and active agents before starting/spawning | Preserve the non-derivable home-directory fact in product docs. Prompt session search when duplication or prior context is plausible, not for every task. |
| `parallel-teams` | **Move to skills** | Three-surface threshold; mandatory plan; fixed commands and prompt paragraphs; five-minute ticks; `sleep 300`; spawned agents cannot own handoff | Inject only independent boundaries, isolated edits, verified progress, and orchestrator-owned composition. Keep all command and monitoring tactics in `teams`. |
| `tech-stack` | **Keep** | Every web task “starts with” a browser | Retain the compact capability map. Choose the authoritative interface; require browser/computer when rendered, authenticated, or visual behavior matters. |
| `ui-work-discipline` | **Keep** | Exact browser/screenshot commands and mandatory two-or-three design variants | Preserve the visual-readback invariant and focus safety. Move commands to UI skills; show alternatives only for genuine unresolved design choices. |
| `plan-presentation` | **Move to skills** | Every nontrivial plan becomes Markdown + HTML + SVG + diffs + checklist + review + two themes | Plan when uncertainty, coordination, or risk benefits from it. Match depth and medium to the decision. Load `artifacts`/`plan-render` only when visual review adds value. |
| `task-checklists` | **Loosen** | Checklist at exactly 3+ steps; mirror milestones to the ticket | Use a checklist when state, duration, or coordination risk makes losing track plausible. Track outcomes, not every mechanical step. |
| `feed-status-posts` | **Keep principle; move mechanics** | Exact flags, levels, team exceptions, session fallbacks, and phone formatting in every prompt | Inject only “record meaningful asynchronous milestones; notify on material delivery or genuine needs-user blocks.” Put CLI syntax in the feed skill. |
| `remote-fleet-dispatch` | **Keep facts; move mechanics** | Exact dispatch, probe, and monitoring commands appear for tasks that never dispatch | Retain native-dispatch and truthful-status traps in `run`/`teams`; default rules only remind agents the fleet exists. |
| `unattended-verification` | **Keep and fold into F3** | One-list-per-run quota policy and GitHub REST/GraphQL tactics are universalized | Preserve postconditions, operation-faithful probes, bounded waits, run-specific state, and honest “unverified.” Move API tactics to operational skills. |

<figure>
<figcaption><strong>Figure 1 — The rule boundary.</strong> Inject the inner rings because they govern judgment and safety. Load the outer ring only when the relevant task or tool is active.</figcaption>
<svg viewBox="0 0 1120 520" role="img" aria-label="Concentric rule boundary separating intent, invariants, platform facts, and task-specific choreography">
  <circle cx="430" cy="260" r="205" fill="#172554" stroke="#60a5fa" stroke-width="4"/>
  <circle cx="430" cy="260" r="150" fill="#052e16" stroke="#84cc16" stroke-width="4"/>
  <circle cx="430" cy="260" r="92" fill="#18181b" stroke="#f4f4f5" stroke-width="4"/>
  <text x="430" y="245" text-anchor="middle" fill="#ffffff" font-size="25" font-weight="800">USER INTENT</text>
  <text x="430" y="278" text-anchor="middle" fill="#d4d4d8" font-size="17">desired outcome · scope</text>
  <text x="430" y="335" text-anchor="middle" fill="#bef264" font-size="20" font-weight="700">INVARIANTS</text>
  <text x="430" y="360" text-anchor="middle" fill="#ffffff" font-size="16">safety · evidence · verification</text>
  <text x="430" y="117" text-anchor="middle" fill="#bfdbfe" font-size="20" font-weight="700">NON-DERIVABLE FACTS</text>
  <text x="430" y="143" text-anchor="middle" fill="#ffffff" font-size="16">platform boundaries · irreversible traps</text>
  <path d="M650 150 C760 145 790 115 835 105" fill="none" stroke="#fb7185" stroke-width="4"/>
  <rect x="760" y="85" width="320" height="350" rx="24" fill="#3f0b0b" stroke="#fb7185" stroke-width="3"/>
  <text x="920" y="125" text-anchor="middle" fill="#fecdd3" font-size="24" font-weight="800">LOAD ON DEMAND</text>
  <text x="795" y="175" fill="#ffffff" font-size="18">exact commands</text>
  <text x="795" y="212" fill="#ffffff" font-size="18">model and roster choices</text>
  <text x="795" y="249" fill="#ffffff" font-size="18">polling cadence</text>
  <text x="795" y="286" fill="#ffffff" font-size="18">artifact format and layout</text>
  <text x="795" y="323" fill="#ffffff" font-size="18">test placement</text>
  <text x="795" y="360" fill="#ffffff" font-size="18">CLI flags and recipes</text>
  <text x="920" y="408" text-anchor="middle" fill="#fda4af" font-size="18" font-weight="700">skills teach tactics; rules protect outcomes</text>
</svg>
</figure>

#### Proposed compact default corpus

1. **Agency and scope** — pursue the intended outcome, act within authorization, ask only for genuine choices, and adapt while useful progress remains.
2. **Exploration and tools** — inspect context, prior work, live state, and capabilities; choose the authoritative interface; delegate when it materially helps.
3. **Evidence and verification** — ground consequential claims and verify the real outcome rather than proxies or exit codes.
4. **Safety and irreversible state** — protect primary checkouts, credentials, shared history, production, external communication, and review boundaries.
5. **Engineering quality** — fix canonical causes, avoid silent failure and accidental duplication, and test in proportion to risk.
6. **Coordination** — give parallel work clear ownership, verify progress, and own composed integration.
7. **Communication** — lead with outcomes, minimize human involvement, and notify only at meaningful boundaries.

This is a review proposal, not a rewrite already approved or landed. Exact commands, thresholds, diagrams, model names, file layouts, and monitoring recipes remain available through the relevant skills.

### Registered hooks — lifecycle injectors and state recorders

These are not candidates for the 14→8 guard count unless the “Next change” column explicitly says so.

| Hook | Event | Purpose | Current instruction / behavior | Change / improvement status |
|---|---|---|---|---|
| `session-identity` | SessionStart | Join pid, native session, launch, terminal, and transcript identity | Writes the live identity record; injects only intentional identity context | **Keep.** One canonical “who am I” hook. |
| `linear-tasks` | SessionStart | Put team, projects, milestones, and current tickets in context | Prints the current board brief; uses non-interactive Linear config | **Keep;** largest SessionStart context cost, so future work should measure usefulness rather than blindly trim. |
| `inject-device-topology` | SessionStart | Let dispatch choose a real available machine | Injects reachable hosts plus live load/memory/disk; cached for 60 seconds | **Keep;** cache and topology shape already corrected. |
| `inject-repo-inflight` | SessionStart | Prevent duplicate PR/session work | Injects open PRs and other active agents for the current project | **Keep;** deliberately not cached because output is session-relative. |
| `session-start-autosync` | SessionStart | Start from current config/resources | Pulls config repos, secrets metadata, and sessions; stays silent | **Keep;** side-effect hook, not messaging clutter. |
| `git-pull-forward` | SessionStart | Start a clean repo at its latest fast-forwardable state | Fast-forwards only when clean; never force/rebase/autostash | **Keep.** |
| `expand-promptcuts` | UserPromptSubmit | Expand named prompt shortcuts | Replaces trusted shortcut markers with their full instructions | **Keep;** public enable/disable CLI remains planned, YAML override works today. |
| `expand-bang-commands` | UserPromptSubmit | Execute explicit inline shell snippets in a prompt | Runs trusted backticked `!cmd` blocks concurrently and injects ordered output | **Keep with caution;** enabled by default; first-class CLI off-switch is still unshipped. |
| `vacation-recap` | UserPromptSubmit | Restore context after a long gap | Advises a back-from-vacation recap before continuing | **Keep;** advisory only. |
| `verify-work-goal-boundary` | UserPromptSubmit | Scope Stop evidence to the current goal | Stores a prompt hash and transcript byte offset, never prompt text | **Keep;** correctness foundation for Stop checks. |
| `worktree-law-reminder` | UserPromptSubmit | Keep primary-checkout law in every context window | Injects the one-line worktree reminder on each prompt | **Review after measuring:** hard enforcement exists; this reminder may still earn its context cost because violations are destructive. |
| `mailbox-inject` | PreToolUse | Deliver queued cross-agent messages during a running turn | Injects waiting mailbox content at a tool boundary | **Keep.** |
| `visual-readback-nudge` | PreToolUse | Catch visual delivery without inspection | Advises render → screenshot → `view_image` before delivery | **Keep;** advisory, and it caught a real contrast defect in this artifact. |
| `attention-sentinel` | Notification / Stop / UserPromptSubmit | Maintain per-session needs-attention state | Records and clears attention based on lifecycle events | **Keep;** state mechanism, not a prose guard. |
| `gather-before-reply` | Stop | Prevent instant agreement without checking reality | If no tool or skill was used after the last user message, inject “gather context first” | **Newly landed in #389.** Measure false nudges before making it blocking. |

### Registered hooks — guards and reminders in the 14→8 discussion

| Guard / reminder | Purpose | Current block or instruction | Landed change | Remaining decision |
|---|---|---|---|---|
| `git-guard` | Prevent destructive Git/history loss | `blocked_op` + reason + a safe alternative for reset, force-push, checkout/switch, stash, clean, branch deletion, and config writes | Shared git parser landed in #387 | **Battlefield proposal:** absorb `main-branch`, `large-file-add`, and `clean-tree` policy into one git guard; not landed. |
| `main-branch-guard` | Keep every tracked write out of the primary checkout | Blocks file tools and git writes there; now creates the correct fresh worktree instead of only lecturing | Auto-worktree behavior #368; bounded fetch #379 | **Merge was proposed**, but its runnable recovery is the strongest measured pattern. Consolidate only if that behavior survives exactly. |
| `large-file-add-guard` | Keep oversized files out of Git | Blocks `git add` when a target exceeds 5 MiB | Restored registration; skips explicit plan mode in #369; shared parser #387 | **Proposed merge into `git-guard`;** not landed. |
| `git-require-clean-tree` | Prevent pull/rebase over dirty work | Blocks pull, rebase, and autostash until the tree is clean | Skips explicit plan mode in #369 | **Proposed merge into `git-guard`;** not landed. |
| `rm-guard` | Prevent recursive deletion of protected paths | `blocked_op` + protected target + use trash/move or narrow the path | Message normalized in #348 | **Keep standalone:** filesystem deletion is not Git policy. |
| `secrets-guard` | Stop secret material from entering model/transcript output | Blocks plaintext export, bundle-key `get`, and non-TTY reveal; points to `agents secrets exec` | Parser fail-closed coverage and concise message landed | **Keep standalone.** |
| `public-artifact-guard` | Stop confidential strategy entering a public committed artifact | Blocks staging sensitive strategy under committed `.agents/artifacts/` | Added for RUSH-3033; measured high recovery | **Keep standalone.** |
| `merge-guard` | Enforce green, non-author-reviewed merges without bypass | Blocks admin merge, self-approval, red checks, or no verdict on this PR | Review-body lookup #376; accepts `APPROVED` #382; skips plan mode #369 | **Keep.** It protects an external irreversible boundary. |
| `pr-description-reminder` | Require honest run evidence and tracking in a PR | Nudges on PR create/edit when evidence or an honest no-run declaration is missing | Shortened in #348; skips plan mode #369 | **Keep reminder;** continue measuring delivery. |
| `plan-html-reminder` / Stop backstop | Ensure plans are rendered, checked, and paired with a checklist | On ExitPlanMode/Stop, points to the missing Markdown/HTML/figure/checklist requirement | Message shortened; rule/skill references corrected; active hook restored in personal docs #292 | **Unresolved:** battlefield proposed CUT after low delivery, but later audit proved it is active and intentional. Decide from fresh outcome data, not dangling-reference assumptions. |
| `verify-work-complete` | Refuse premature “done” and hand-back behavior | Goal-scoped checks ask for verification, delivery-chain proof, ticket closure, and one feed record | 30–40 lines → 6–12 in #348; phone escalation fixed #365; repeat cap and attribution fixes #374 | **Keep, but continue simplification:** it remains the highest-fire/lowest-obedience guard and should emit one actionable next step per failure. |
| `teams-roster-guard` | Prevent accidental same-harness monocultures | Blocks the third same-harness teammate when multiple harnesses exist unless the brief records `single-harness: <reason>` | Added and documented with `parallel-teams`; remains rule-adjacent | **Keep or re-measure:** it protects diversity, but its value should be compared with its block/recovery rate. The current hooks README omits it from the subrule table even though `parallel-teams/hooks.yaml` registers it. |

### Non-registered helpers (not extra hooks)

`verify-work-state.py`, `visual_readback.py`, and `verify-delivery-chain.py` are invoked by `verify-work-complete`; `check-outcome-backfill.py` is offline analysis. Counting them as separate hooks would exaggerate the runtime surface. `02-expand-prompt-skill-refs.py` is the one true orphan documented by the hook maintenance contract: register it or delete it.

<figure>
<figcaption><strong>Figure 2 — The real simplification surface.</strong> Nineteen injected rules can be consolidated as language. Twenty-seven logical hooks span context, state, advisory nudges, and enforcement; only the twelve guard/reminder entries belong in the 14→8 debate.</figcaption>
<svg viewBox="0 0 1120 430" role="img" aria-label="Three-lane map separating rules, lifecycle hooks, and guard simplification candidates">
  <defs><marker id="inv-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#84cc16"/></marker></defs>
  <rect x="45" y="55" width="290" height="290" rx="24" fill="#172554" stroke="#60a5fa" stroke-width="3"/>
  <text x="75" y="100" fill="#bfdbfe" font-size="25" font-weight="700">19 system rules</text>
  <text x="75" y="138" fill="#ffffff" font-size="18">language in every prompt</text>
  <text x="75" y="180" fill="#bfdbfe" font-size="18">keep distinct cores</text>
  <text x="75" y="210" fill="#bfdbfe" font-size="18">merge fleet/team trio</text>
  <text x="75" y="240" fill="#bfdbfe" font-size="18">remove/delegate 2</text>
  <text x="75" y="282" fill="#fbbf24" font-size="20" font-weight="700">shared end-state open</text>

  <path d="M350 200 L415 200" stroke="#84cc16" stroke-width="5" marker-end="url(#inv-arrow)"/>
  <rect x="430" y="55" width="290" height="290" rx="24" fill="#052e16" stroke="#84cc16" stroke-width="3"/>
  <text x="460" y="100" fill="#bef264" font-size="25" font-weight="700">27 logical hooks</text>
  <text x="460" y="138" fill="#ffffff" font-size="18">6 session injectors</text>
  <text x="460" y="168" fill="#ffffff" font-size="18">5 prompt/state hooks</text>
  <text x="460" y="198" fill="#ffffff" font-size="18">3 advisory/state hooks</text>
  <text x="460" y="228" fill="#ffffff" font-size="18">12 guards/reminders</text>
  <text x="460" y="258" fill="#ffffff" font-size="18">1 attention sentinel</text>
  <text x="460" y="302" fill="#bef264" font-size="18">do not flatten unlike jobs</text>

  <path d="M735 200 L800 200" stroke="#84cc16" stroke-width="5" marker-end="url(#inv-arrow)"/>
  <rect x="815" y="55" width="260" height="290" rx="24" fill="#3f0b0b" stroke="#fb7185" stroke-width="3"/>
  <text x="845" y="100" fill="#fecdd3" font-size="25" font-weight="700">12 → 8 debate</text>
  <text x="845" y="140" fill="#ffffff" font-size="18">merge 3 git policies</text>
  <text x="845" y="175" fill="#ffffff" font-size="18">keep 6 boundaries</text>
  <text x="845" y="210" fill="#ffffff" font-size="18">measure plan reminder</text>
  <text x="845" y="245" fill="#ffffff" font-size="18">simplify Stop output</text>
  <text x="845" y="292" fill="#fda4af" font-size="21" font-weight="700">not yet closed</text>
  <text x="560" y="400" text-anchor="middle" fill="var(--text)" font-size="19">Simplify within each lane. A context injector, a state recorder, and a deny guard are not duplicates merely because all three are called “hooks.”</text>
</svg>
</figure>

## Figure

<figure>
<figcaption><strong>Figure 3 — What an agent receives today.</strong> User rules shadow same-named system rules. The exact essence rewrite therefore reaches Muqsit's fleet without changing the shared default for everyone.</figcaption>
<svg viewBox="0 0 1120 470" role="img" aria-label="Layer diagram showing personal rules overriding shared system rules and hooks enforcing behavior">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="#84cc16"/></marker>
  </defs>
  <rect x="40" y="40" width="300" height="150" rx="18" fill="#172554" stroke="#60a5fa" stroke-width="3"/>
  <text x="70" y="78" fill="#bfdbfe" font-size="24" font-weight="700">Shared system layer</text>
  <text x="70" y="112" fill="#e5e7eb" font-size="18">PR #348 live</text>
  <text x="70" y="140" fill="#e5e7eb" font-size="18">6,042 words</text>
  <text x="70" y="168" fill="#fca5a5" font-size="17">PR #381 closed</text>

  <rect x="40" y="250" width="300" height="150" rx="18" fill="#052e16" stroke="#84cc16" stroke-width="4"/>
  <text x="70" y="288" fill="#bef264" font-size="24" font-weight="700">Personal user layer</text>
  <text x="70" y="322" fill="#e5e7eb" font-size="18">PR #288 live</text>
  <text x="70" y="350" fill="#e5e7eb" font-size="18">23 rules · 1,583 words</text>
  <text x="70" y="378" fill="#bef264" font-size="17">shadows same-name rules ↑</text>

  <path d="M350 320 C430 320, 430 150, 515 150" fill="none" stroke="#84cc16" stroke-width="5" marker-end="url(#arrow)"/>
  <text x="380" y="250" fill="#bef264" font-size="17" transform="rotate(-55 380 250)">effective composition</text>

  <rect x="530" y="85" width="250" height="160" rx="22" fill="#18181b" stroke="#f4f4f5" stroke-width="3"/>
  <text x="560" y="125" fill="#ffffff" font-size="24" font-weight="700">Agent session</text>
  <text x="560" y="162" fill="#bef264" font-size="30" font-weight="800">ESSENCE</text>
  <text x="560" y="194" fill="#d4d4d8" font-size="17">personal corpus wins</text>
  <text x="560" y="220" fill="#d4d4d8" font-size="17">on Muqsit's fleet</text>

  <path d="M790 165 L860 165" fill="none" stroke="#84cc16" stroke-width="5" marker-end="url(#arrow)"/>
  <rect x="875" y="85" width="205" height="310" rx="22" fill="#3f0b0b" stroke="#fb7185" stroke-width="3"/>
  <text x="905" y="125" fill="#fecdd3" font-size="24" font-weight="700">Hooks</text>
  <text x="905" y="162" fill="#ffffff" font-size="17">messages: cleaner</text>
  <text x="905" y="192" fill="#ffffff" font-size="17">noise: reduced</text>
  <text x="905" y="222" fill="#ffffff" font-size="17">parsers: shared</text>
  <line x1="905" y1="246" x2="1050" y2="246" stroke="#fb7185" stroke-width="2"/>
  <text x="905" y="282" fill="#fda4af" font-size="17">14→8 topology:</text>
  <text x="905" y="312" fill="#fda4af" font-size="22" font-weight="800">PARTIAL</text>
  <text x="905" y="350" fill="#d4d4d8" font-size="15">behavior guards remain</text>
  <text x="905" y="374" fill="#d4d4d8" font-size="15">more numerous than target</text>
</svg>
</figure>

<figure>
<figcaption><strong>Figure 4 — Delivery ledger.</strong> Thematic groups, not chronological order: green items are demonstrably merged; amber is the explicit missing closure.</figcaption>
<svg viewBox="0 0 1120 390" role="img" aria-label="Thematic ledger of merged rule and hook improvements followed by the remaining closure gap">
  <line x1="90" y1="195" x2="1030" y2="195" stroke="#71717a" stroke-width="6"/>
  <g fill="#84cc16" stroke="#365314" stroke-width="3">
    <circle cx="150" cy="195" r="18"/><circle cx="330" cy="195" r="18"/><circle cx="510" cy="195" r="18"/><circle cx="690" cy="195" r="18"/><circle cx="870" cy="195" r="18"/>
  </g>
  <circle cx="990" cy="195" r="18" fill="#f59e0b" stroke="#78350f" stroke-width="3"/>
  <g fill="var(--text)" font-size="17" text-anchor="middle">
    <text x="150" y="140" font-weight="700">#348</text><text x="150" y="225">system rules +</text><text x="150" y="247">messages slimmed</text>
    <text x="330" y="140" font-weight="700">#288</text><text x="330" y="225">personal essence</text><text x="330" y="247">corpus live</text>
    <text x="510" y="140" font-weight="700">#386 / #289</text><text x="510" y="225">two noisy guards</text><text x="510" y="247">removed</text>
    <text x="690" y="140" font-weight="700">#365 / #369</text><text x="690" y="225">messaging + plan</text><text x="690" y="247">mode corrected</text>
    <text x="870" y="140" font-weight="700">#374–#388</text><text x="870" y="225">correctness +</text><text x="870" y="247">dedup landed</text>
    <text x="990" y="140" font-weight="700" fill="#fbbf24">remaining</text><text x="990" y="225" fill="#fbbf24">14→8 closure</text><text x="990" y="247" fill="#fbbf24">not landed</text>
  </g>
  <rect x="80" y="292" width="960" height="62" rx="14" fill="#18181b" stroke="#52525b"/>
  <text x="560" y="330" text-anchor="middle" fill="#ffffff" font-size="20"><tspan fill="#84cc16" font-weight="700">Outcome:</tspan> meaningful improvements are live; the original end-state is not fully closed.</text>
</svg>
</figure>

## Evidence

- [Personal distilled corpus, merged](https://github.com/muqsitnawaz/.agents/pull/288)
- [Shared distilled corpus, closed as superseded](https://github.com/phnx-labs/.agents-system/pull/381)
- [Shared 60% rules + hook-message cleanup, merged](https://github.com/phnx-labs/.agents-system/pull/348)
- [Measured hook battlefield artifact, merged](https://github.com/phnx-labs/agi-cli/pull/2919)
- [Stop reminder phone-escalation fix, merged](https://github.com/phnx-labs/.agents-system/pull/365)
- [Plan-mode hook overhead fix, merged](https://github.com/phnx-labs/.agents-system/pull/369)
- [RUSH-3032 hook correctness follow-ups, merged](https://github.com/phnx-labs/.agents-system/pull/374)
- [Footer guard removal, merged](https://github.com/phnx-labs/.agents-system/pull/386)
- [User-message guard removal, merged](https://github.com/muqsitnawaz/.agents/pull/289)
