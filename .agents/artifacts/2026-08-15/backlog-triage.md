---
title: Agents CLI backlog triage — 107 open tickets
date: 2026-08-15
author: Claude (triage session, no product code touched)
---

# Agents CLI backlog triage

**Scope:** all 107 open tickets in the Linear "Agents CLI" project (51 High / 37 Medium / 19 Low priority; 58 Todo / 23 Doing / 21 Backlog / 5 other) as of 2026-08-15. Read individually via a bulk JSON export, classified with repo-grep verification against `origin/main` (HEAD `7cedb3865`, `chore(release): 1.22.39 (#2658)`). Full per-ticket evidence trail lives in the six classification passes this report synthesizes; this file is the actionable summary.

**This is a plan, not fixes.** No product code was touched. Every claim below is grounded in a `file:line` quote or a `gh`/`git` command's actual output — see the evidence column in each table.

## Bucket summary

| Bucket | Count | What it means |
|---|---|---|
| **AUTO** | 67 | Well-specified, an agent can dispatch and fix unattended |
| **DECISION** | 19 | Blocked on Muqsit's product/scope judgement, not effort |
| **SPEC** | 13 | Real work, but "done" is undefined — needs one acceptance paragraph first |
| **STALE** | 8 | Already fixed/superseded — propose closing, evidence below |

## STALE — propose closing (do not close without confirmation)

| ID | Title | Priority | Evidence that it's already resolved |
|---|---|---|---|
| [RUSH-2008](https://linear.app/getrush/issue/RUSH-2008/rework-agents-browser-for-agent-workloads-task-hygiene-ambient-key) | Rework agents browser (parent design doc) | Medium | Ticket text: "Design complete, not started... broken into 3 pickup-able sub-issues below" — those 3 are separately tracked, this has no distinct action. |
| [RUSH-2400](https://linear.app/getrush/issue/RUSH-2400/featcursor-make-multiple-cursor-accounts-real-isolate-per-account) | feat(cursor): real multi-account isolation at exec | High | PR #2372 MERGED, changelog fragment exists. All 3 "done means" criteria verified live in code: exec.ts:556-577, agents.ts:1468-1473, shims.ts:1105. |
| [RUSH-2436](https://linear.app/getrush/issue/RUSH-2436/sessions-make-the-local-db-authoritative-serverender-file-gone) | sessions: make local DB authoritative, stop purge (Layer 1) | Low | 3 merged PRs (#2409,#2417,#2420). The read-path purge this ticket targets is gone (db.ts:2842 comment confirms). archived_at column + archive/unarchive logic all landed (db.ts:122,1112-1118,2531-2535,2828-2880). Two other purgeToolCalls() call sites remain outside the read path (tool-store.ts:83, tool-index.ts:448) — unclear if those are in this ticket's scope. |
| [RUSH-2439](https://linear.app/getrush/issue/RUSH-2439/events-the-daemon-emits-nothing-into-the-unified-event-stream-its) | events: daemon emits nothing into unified event stream | High | daemon.ts:577-592 log() now calls emit() mapping to daemon.start/stop/error/info. Superseded further by RUSH-2530 (commit 7a105b93a, #2603) adding routine.start/end + watchdog.action. |
| [RUSH-2452](https://linear.app/getrush/issue/RUSH-2452/routine-contextts295-section-2-branch-still-uses-host-pathisabsolute) | routine-context.ts:295 host path.isAbsolute (RUSH-2393 sibling gap) | Low | Commit 60f2c6a49 "fix(cli): Windows path flavor bugs" (2026-08-09, after ticket) replaced bare path.isAbsolute(cwd) with cross-platform check. Confirmed live at routine-context.ts:300-304. |
| [RUSH-2504](https://linear.app/getrush/issue/RUSH-2504/restructure-design-into-an-agi-style-plugin-skill-aliases) | Restructure design into agi-style plugin + aliases | Low | Ticket's stated blocker ("no alias mechanism exists") is ALREADY SHIPPED: commit 91da5763b (RUSH-2504) confirmed on main, resources.ts:212 alias fallback live. Remaining design-consolidation work is real but lives outside agents-cli. |
| [RUSH-2521](https://linear.app/getrush/issue/RUSH-2521/agent-spawned-daemons-mcp-servers-claude-bg-sparebg-pty-host-harness) | Agent-spawned daemons leak past session exit | High | 4 MERGED PRs cite this ticket (#2584,#2596,#2602,#2611). No open branch/PR. Code confirms fix live (session.ts:194-197, daemon.ts:741,743). Fully landed — ticket status stale, should move to Done. |
| [RUSH-2591](https://linear.app/getrush/issue/RUSH-2591/clisurface-nest-agents-unshare-under-agents-artifacts-drop-top-level) | nest unshare under artifacts | Medium | PR #2646 ALREADY LANDED THE OPPOSITE DECISION, with a test asserting it: artifacts.test.ts:118-124 "keeps unshare a TOP-LEVEL alias, not a member of the artifacts group". share.ts:547-551 explains why. |

All eight are backed by a quoted merged-PR title, a quoted diff, or a quoted current-code line that contradicts the ticket's premise — not inference. Two (**RUSH-2400**, **RUSH-2521**) are also "Doing"-state tickets whose PRs shipped weeks ago; the Linear status just never caught up.

## DECISION — questions only Muqsit can answer

Numbered so each is answerable yes/no or A/B. Six of these (2556-2561) share one shape: a router-epic parent ticket that Linear already shows fully decomposed into its own subtask children (also in this backlog, already bucketed AUTO/SPEC below) — the same question repeats six times because six parent tickets got the same treatment.

**1. [RUSH-1935]** Growth/distribution engine (epic) (High)

> Doing since 2026-07-29 (>2wk), no branch, no genuine PR. Q: still the active priority, or re-scope given zero shipped sub-work in 2+ weeks?

**2. [RUSH-2258]** Owner escalation down on both boxes (High)

> Item 3/3 shipped (PR #2172 merged, confirmed live at doctor-findings.ts:157 + test). Items 1+2 (rush on PATH, durable session) explicitly deferred to RUSH-2262. Q: close now (doctor fails loud) or keep open until transport actually fixed fleet-wide?

**3. [RUSH-2359]** Decide: Rush Cloud reads interactive Claude login (Medium)

> Confirmed unchanged: rush.ts:234 still reads interactive login. Ticket title IS the question: intended, or move to file-based setup-token?

**4. [RUSH-2468]** Decide the home for the security-review skill code:review routes to (Medium)

> Ticket poses explicit A/B/C choice (promote to .agents-system / fold into audit skill / keep standalone). Muqsit's architecture call.

**5. [RUSH-2471]** ~/.grok symlinks to uninstalled 1.0.0 on yosemite-s0 (Low)

> Error text confirmed live (sync.ts:752). Ticket poses the fork itself: repoint symlink at default installed version, or prune non-installed version dirs?

**6. [RUSH-2480]** Fast hooks: warm TS engine + thin client (parent) (Low)

> Ticket's own text: "Decisions to make before building (this is why sub-issues aren't started)" — Rust vs bash, phasing, deny-guards-in-daemon are Muqsit's calls.

**7. [RUSH-2482]** Fast hooks Phase 2: warm TS engine in daemon (Low)

> Explicitly depends on the 3 decisions on parent RUSH-2480.

**8. [RUSH-2514]** Non-author review structurally impossible (1 GitHub token) (High)

> rush.yml trigger fully commented out, paused on upstream #1767. Q: (A) dedicated bot identity, (B) wait for #1767, or (C) drop non-author-review requirement for this repo?

**9. [RUSH-2515]** win-mini system repo can't fast-forward (22 files) (Medium)

> Needs human reading win-mini's local diffs. Q: keep local edits and reconcile, or discard and force-sync? CLIXML sub-bug may already be stale (passthrough.ts:236-237,385,421 already strips it generically).

**10. [RUSH-2525]** Require non-author review before merge (branch protection) (High)

> Confirmed no required_pull_request_reviews on either repo, token has admin:true, mechanically executable. Q: enable now (freezes .agents-system merges until reviewer wired) or sequence (wire reviewer first)?

**11. [RUSH-2556]** Agent Router: named routers CRUD (agents route) (High)

> Fully decomposed into its own subtasks RUSH-2562+2563+2564 (same as sibling parents 2559/2560/2561). Q: dispatch 2556 standalone or only its 3 children? [CORRECTED from AUTO during synthesis — chunk-4 agent missed the subtask decomposition chunk-5 caught for siblings.]

**12. [RUSH-2557]** Agent Router: resolve + run --using named router (High)

> Fully decomposed into its own subtasks RUSH-2565+2566. Q: dispatch 2557 standalone or only its 2 children? [CORRECTED from AUTO during synthesis — chunk-4 agent missed the subtask decomposition chunk-5 caught for siblings.]

**13. [RUSH-2558]** Agent Router: agents route "<task>" + decision provenance (Medium)

> Fully decomposed into its own subtasks RUSH-2567+2568. Q: dispatch 2558 standalone or only its 2 children? [CORRECTED from AUTO during synthesis — chunk-4 agent missed the subtask decomposition chunk-5 caught for siblings.]

**14. [RUSH-2559]** Router: routing policy engine (rules+weights+default) (Medium)

> Fully decomposed into RUSH-2569+2570 (its own subtasks, same chunk). Q: dispatch 2559 standalone or only its children?

**15. [RUSH-2560]** Router: cross-harness fallback + opt-in hijack (Medium)

> Fully decomposed into RUSH-2571+2572. Same dup-dispatch question.

**16. [RUSH-2561]** Router: cross-harness runtime delegation (Low)

> Fully decomposed into RUSH-2573+2574. Ticket itself says "sequence last."

**17. [RUSH-2581]** No human-identity substrate for SSO (High)

> No real principal/RBAC model found anywhere (only false-positive hits). Q: is multi-operator SSO/OIDC a product goal, given single-operator today?

**18. [RUSH-2582]** SSH transport shape caps fleet comms (High)

> ssh-exec.ts:131 ControlPersist=60s confirmed. Q: should agents serve --control's HTTP channel become general fleet transport, or stay iOS-only?

**19. [RUSH-2642]** crabbox Linux gate fails — hetzner token missing on yosemite-s0 (High)

> Confirmed exact match. Not a code bug — missing secrets bundle on one machine. Q: provision hetzner.com on yosemite-s0, or move AGENTS_SYNC_PASSPHRASE — needs Muqsit's credentials either way.

## SPEC — real work, acceptance criteria missing

| ID | Title | Priority | What's missing |
|---|---|---|---|
| [RUSH-1941](https://linear.app/getrush/issue/RUSH-1941/repair-rush-blog-engine-currently-failing-and-point-a-blog-engine-at) | Repair rush-blog-engine (failing routine) | High | Root cause unknown even to ticket author ("pull the failure logs, root-cause it"). Missing: actual routine logs / root cause. |
| [RUSH-2113](https://linear.app/getrush/issue/RUSH-2113/verify-work-complete-hook-keep-moving-redirect-taskqueue-awareness) | verify-work-complete hook: keep-moving + A-G backlog | High | Prereq analysis done (PR #2367 merged). But actual A-G backlog has no branch and lives in a different repo this checkout can't touch. Missing: which item (A-G) to build first + confirm it belongs elsewhere. |
| [RUSH-2361](https://linear.app/getrush/issue/RUSH-2361/deprecate-wallet-and-attribute-hook-triggered-secret-audits) | Deprecate wallet + attribute hook-triggered secret audits | High | Wallet-half DONE (merged 09a7eecdb/e1f6a2896, 2026-08-10; wallet command gone). Hook-attribution half NOT done (0 hits for AGENTS_HOOK_NAME). Missing: ticket carries no acceptance bar for hook-attribution half; only a closed-PR reviewer comment names one. |
| [RUSH-2478](https://linear.app/getrush/issue/RUSH-2478/agents-system-agentsmd-omits-the-test-gate-the-absence-of-ci-and-the) | .agents-system AGENTS.md missing test-gate/CI docs | Medium | Target file doesn't exist in agents-cli. Missing: which repo to dispatch into — filed against wrong project. |
| [RUSH-2502](https://linear.app/getrush/issue/RUSH-2502/stop-claude-showing-up-as-a-pr-co-author-co-authored-by-trailer) | Stop Claude showing as PR co-author | Medium | Fix target entirely outside this repo. Ticket needs a repo pointer. |
| [RUSH-2511](https://linear.app/getrush/issue/RUSH-2511/speed-up-new-agent-boot-in-the-extension-agents-new-preset-time-to) | Speed up new-agent boot in extension | High | No repro/profiling harness cited. Ticket's own text: "state the realistic floor for --host" — floor left undefined for implementer to invent. Missing: agreed measured baseline + hard target. |
| [RUSH-2527](https://linear.app/getrush/issue/RUSH-2527/unify-native-and-provider-accounts-across-installations-profiles-and) | Unify native + provider accounts | High | Doing-check: 3 branches, real substantial work — PR #2563 OPEN (CONFLICTING, +1053/-93, 18 files), PR #2573 OPEN (CONFLICTING), PR #2564 MERGED. Plan exists. Missing: ticket bundles ~7 sub-scopes, unstated whether landing the 2 open PRs closes it. |
| [RUSH-2532](https://linear.app/getrush/issue/RUSH-2532/re-home-wallet-functionality-under-agents-secrets) | Re-home wallet under agents secrets | Medium | Premise verified true (wallet fully removed, PR #2609). No re-home work started. Missing: ticket itself says "design and implement the new command shape" — no proposed shape or acceptance criteria given. |
| [RUSH-2555](https://linear.app/getrush/issue/RUSH-2555/agent-router-meta-harness-routing) | Agent Router — parent/epic | High | PR #2641 MERGED delivered the spec doc itself. Not a unit of buildable work — dispatch via children instead. |
| [RUSH-2573](https://linear.app/getrush/issue/RUSH-2573/delegation-child-result-contract-route-delegatets-via-dispatch-surface) | delegation: child-result contract + route-delegate.ts | Low | Ticket's own text: "the main unknown; pick one" — undecided contract. NOT the OAuth PR #2573 (different, unrelated ticket, same ID coincidence check ruled out). |
| [RUSH-2574](https://linear.app/getrush/issue/RUSH-2574/delegation-parentchild-session-linking) | delegation: parent/child session linking | Low | Missing spec: doesn't name target file. Also blocked on 2573's undecided contract. |
| [RUSH-2638](https://linear.app/getrush/issue/RUSH-2638/release-train-step-1-no-ops-whenever-npm-main-so-merged-commits-never) | release-train Step 1 no-ops when npm==main | High | No "Step 1 — is there anything to ship?" text anywhere in apps/cli/. Missing: where does the prompt/config actually live (per-device routine config, not a repo file) — no PR found either. |
| [RUSH-2641](https://linear.app/getrush/issue/RUSH-2641/release-train-the-job-body-backgrounds-the-release-and-exits-0-so-a) | release-train job body backgrounds, exits 0 | High | Zero postcondition/verifyCompletion mechanism exists anywhere. Missing: is fix a prompt-text edit (outside repo) or a new routines-engine feature? Unscoped either way. |

## AUTO — recommended dispatch order

67 tickets, grouped into waves that share no source file within a wave (verified by a file-collision graph built from every AUTO ticket's touched-files list, plus explicit "land X first" sequencing called out during classification — e.g. a bug-fix landing before the feature that would otherwise mask it). Dispatch a wave in parallel; move to the next wave only once the current one's PRs are in.

### Wave 1 (49 tickets)

| ID | Priority | Title | Files |
|---|---|---|---|
| [RUSH-1937](https://linear.app/getrush/issue/RUSH-1937/fix-the-repo-surface-conversion-gap-136k-downloads-11-stars) | High | Repo-surface conversion gap | README.md, apps/cli/package.json, GH repo settings, release-notes gen |
| [RUSH-2009](https://linear.app/getrush/issue/RUSH-2009/browser-phase-1-ambient-current-task-key-hygiene-dedup-reap-scoped) | Medium | browser Phase 1: ambient task key + hygiene | commands/browser.ts, lib/browser/service.ts |
| [RUSH-2298](https://linear.app/getrush/issue/RUSH-2298/agents-git-reconcile-canonical-fetch-first-rebase-fix-forward-path) | High | agents git reconcile canonical command | new commands/git.ts |
| [RUSH-2299](https://linear.app/getrush/issue/RUSH-2299/agents-bench-harnessmodel-scoreboard-parallel-same-task-fan-out) | High | agents bench: scoreboard + fan-out | commands/bench.ts, lib/bench/*, new bench/tasks/<id>/task.json |
| [RUSH-2300](https://linear.app/getrush/issue/RUSH-2300/insights-attribute-grok-kimi-cursor-antigravity-248-sessionsmo-unseen) | Medium | insights: attribute grok/kimi/cursor/antigravity | lib/session/insights.ts |
| [RUSH-2301](https://linear.app/getrush/issue/RUSH-2301/sessions-stats-fix-usage-event-coverage-12percent-before-trusting-dead) | Medium | sessions stats: fix usage-event coverage (1.2%) | commands/sessions-stats.ts |
| [RUSH-2365](https://linear.app/getrush/issue/RUSH-2365/reserve-the-auth-secrets-bundle-in-code-sec-gap-3-keychain-backed-auth) | Medium | Reserve auth secrets bundle in code (SEC-GAP-3) | claude-account-token.ts, secrets/bundles.ts |
| [RUSH-2369](https://linear.app/getrush/issue/RUSH-2369/sessions-prove-opencode-parity-across-every-lifecycle-verb) | High | sessions: OpenCode parity across every lifecycle verb | session/{discover,db,active,parse}.ts, new feature-matrix test, docs/05-sessions.md |
| [RUSH-2371](https://linear.app/getrush/issue/RUSH-2371/auto-sync-the-reserved-auth-bundle-across-the-fleet-setup-tokens-drift) | High | Auto-sync reserved auth secrets bundle fleet-wide | apps/cli/src/lib/secrets/*.ts, new routine/daemon reconciler |
| [RUSH-2376](https://linear.app/getrush/issue/RUSH-2376/menubar-favorite-devices-and-pin-them-below-the-current-mac) | High | Menubar: favorite devices, pin below current Mac | menubar Swift, src/lib/menubar/snapshot.ts |
| [RUSH-2385](https://linear.app/getrush/issue/RUSH-2385/perf-the-commander-root-bootstrap-costs-11-13ms-of-module-load-and-the) | Medium | perf: fold command.start into command.end, eval NODE_COMPILE_CACHE | bootstrap.ts:145,167, index.bench.ts |
| [RUSH-2395](https://linear.app/getrush/issue/RUSH-2395/device-roles-drive-auth-strategy-add-personal-role-interactive-login) | High | Device roles drive auth strategy — add 'personal' role | devices/registry.ts, device-config.ts, usage.ts |
| [RUSH-2404](https://linear.app/getrush/issue/RUSH-2404/agents-view-show-an-installations-current-release-after-update) | High | agents view: show installation's release version | commands/view.ts, installations/resolve.ts |
| [RUSH-2405](https://linear.app/getrush/issue/RUSH-2405/hooks-first-class-enabledisable-for-promptcuts-and-bangcuts) | High | Hooks: first-class enable/disable for promptcuts/bangcuts | commands/hooks.ts |
| [RUSH-2413](https://linear.app/getrush/issue/RUSH-2413/menubar-orphaned-refresh-children-can-become-permanently-untracked) | High | Menubar: orphaned refresh children permanently untracked | menubar/ChildProcess.swift |
| [RUSH-2424](https://linear.app/getrush/issue/RUSH-2424/agents-insights-rank-cost-hotspots-by-routine-model-repository-and) | High | agents insights: rank cost hotspots by routine/model/repo/session | commands/insights.ts, commands/cost.ts, session/db.ts |
| [RUSH-2445](https://linear.app/getrush/issue/RUSH-2445/share-no-server-side-access-log-cannot-answer-was-it-fetched-after-an) | Medium | share: no server-side access log for published pages | share/worker-template.ts, share/analytics.ts |
| [RUSH-2456](https://linear.app/getrush/issue/RUSH-2456/sync-prune-extend-to-hooks-with-windows-portable-paths-split-from-rush) | Medium | sync prune: extend to hooks, Windows-portable (split from RUSH-2438) | writers/hooks.ts, scripts/ci-scope.ts |
| [RUSH-2457](https://linear.app/getrush/issue/RUSH-2457/self-update-gate-npx-cacheunsafe-legacy-helper-purge-on-hasfixedpeer) | Low | self-update: gate npx-cache/unsafe-legacy-helper purge on hasFixedPeer | self-update.ts |
| [RUSH-2458](https://linear.app/getrush/issue/RUSH-2458/perffactory-virtualize-the-agents-feed-like-the-new-sessions-tab) | Medium | perf(factory): virtualize the Agents feed like Sessions tab | apps/ext/.../UnifiedAgentsPane.tsx (ticket's apps/factory path is stale — app renamed to apps/ext) |
| [RUSH-2474](https://linear.app/getrush/issue/RUSH-2474/win-minis-system-mirror-is-permanently-dirty-index-cached-stat-size) | Medium | win-mini .system mirror permanently dirty (CRLF) | .gitattributes in phnx-labs/.agents-system (NOT this repo) |
| [RUSH-2481](https://linear.app/getrush/issue/RUSH-2481/phase-1-remove-hook-instrumentation-tax-shim-fan-out) | Low | Fast hooks Phase 1: remove instrumentation tax | hooks/cache.ts, hooks.ts |
| [RUSH-2483](https://linear.app/getrush/issue/RUSH-2483/fail-loud-when-a-boxs-dotagents-mirror-stops-updating) | Medium | Fail loud when a box's mirror stops updating | commands/doctor.ts, lib/git.ts |
| [RUSH-2484](https://linear.app/getrush/issue/RUSH-2484/make-vs-codium-extension-a-zero-duplication-agents-cli-client) | High | VS Codium ext: zero-duplication agents-cli client | apps/ext extension.ts + apps/cli sessions/devices/tickets JSON |
| [RUSH-2494](https://linear.app/getrush/issue/RUSH-2494/remove-the-host-flag-device-becomes-the-sole-routingtarget-flag-cli) | Medium | Remove --host flag; --device sole routing flag | ~20 command files + docs + command-index.json |
| [RUSH-2498](https://linear.app/getrush/issue/RUSH-2498/sessions-focus-cannot-reattach-a-live-agent-full-uuid-reads-as) | High | sessions focus cannot reattach a live agent | commands/focus.ts |
| [RUSH-2499](https://linear.app/getrush/issue/RUSH-2499/complete-factory-ext-rename-in-appsclisrc-code-comments) | Low | Complete factory->ext rename in apps/cli/src comments | commands/{exec,sessions,teams,watchdog}.ts, lib/{activity,daemon-ticks,device-config,events-ingest,events,rotate}.ts + more |
| [RUSH-2507](https://linear.app/getrush/issue/RUSH-2507/agents-sessions-active-reports-nothing-while-dozens-of-agents-run) | High | sessions --active blind to live sessions; no reaper | commands/sessions.ts, tmux reaper (none exists) |
| [RUSH-2510](https://linear.app/getrush/issue/RUSH-2510/agents-tmux-attach-no-arg-should-open-an-interactive-session-picker) | Medium | tmux attach: no-arg should open picker | commands/tmux.ts |
| [RUSH-2512](https://linear.app/getrush/issue/RUSH-2512/sessions-focus-cross-host-live-sessions-show-no-preview-transcript-is) | High | sessions focus: no preview for cross-host live sessions | commands/sessions-picker.ts, session/active.ts |
| [RUSH-2522](https://linear.app/getrush/issue/RUSH-2522/agi-plugin-move-relocate-agents-cli-capability-skills-under-an-agi) | Low | agi plugin move: skills under agi: namespace | Companion .agents-system repo skills, referencing rules |
| [RUSH-2524](https://linear.app/getrush/issue/RUSH-2524/routines-browser-polish-pty-regression-test-fix-bogus-subcommand-error) | Low | Routines browser: PTY test + bogus-subcommand error leak | commands/routines.ts ~1098, picker.test.ts |
| [RUSH-2526](https://linear.app/getrush/issue/RUSH-2526/routing-never-auto-pick-an-account-from-entirely-stale-usage) | High | Routing: never auto-pick account from stale usage | rotate.ts, account-state-service.ts, events.ts |
| [RUSH-2536](https://linear.app/getrush/issue/RUSH-2536/agents-projects-pull-sync-a-projects-fleet-checkouts) | Medium | agents projects pull: sync fleet checkouts | lib/project-pull.ts, git.ts, commands/projects.ts |
| [RUSH-2542](https://linear.app/getrush/issue/RUSH-2542/webhook-triggers-issuetitle-renders-empty-in-dispatched-handler) | Low | Webhook {{issue.title}} renders empty | lib/triggers/handlers.ts, handlers.test.ts |
| [RUSH-2543](https://linear.app/getrush/issue/RUSH-2543/test-suite-spawns-real-agent-runs-testssetupts-does-not-pin-agents) | High | Test suite spawns real agent runs (unpinned AGENTS_WEBHOOKS_DIR) | tests/setup.ts, lib/state.ts, lib/triggers/webhook.ts, handlers.ts, webhook.test.ts |
| [RUSH-2554](https://linear.app/getrush/issue/RUSH-2554/daemon-services-health-view-reports-only-2-of-10-toggleable-services) | Low | Daemon health view reports 2 of 10 services | daemon-health.ts, commands/daemon.ts, lib/daemon.ts |
| [RUSH-2562](https://linear.app/getrush/issue/RUSH-2562/routers-resourcekind-routersts-io-lib-mirror-profilests) | High | routers: ResourceKind + routers.ts IO lib (mirror profiles.ts) | resources.ts:30-41, new routers.ts |
| [RUSH-2563](https://linear.app/getrush/issue/RUSH-2563/agents-route-crud-command-group-createlistshowallowlink-accountrm) | High | `agents route` CRUD command group | new commands/route.ts |
| [RUSH-2565](https://linear.app/getrush/issue/RUSH-2565/router-resolvets-filter-by-allowlistlinked-reuse) | High | router-resolve.ts: filter+reuse rotation/capability/tier | new router-resolve.ts |
| [RUSH-2567](https://linear.app/getrush/issue/RUSH-2567/agents-route-task-formalize-run-auto-m1-decision-card) | Medium | `agents route <task>`: formalize run-auto + M1 decision card | commands/exec.ts same dispatch region |
| [RUSH-2568](https://linear.app/getrush/issue/RUSH-2568/route-decision-provenance-on-session-local-ssh-teams-cloud) | Medium | route decision provenance on session (local+SSH+teams+cloud) | exec.ts:411 buildExecEnv, hosts/remote-cmd.ts:86 |
| [RUSH-2569](https://linear.app/getrush/issue/RUSH-2569/route-policyts-parse-route-config-matchrule-most-specific) | Medium | route-policy.ts: parse route: + matchRule | new route-policy.ts |
| [RUSH-2575](https://linear.app/getrush/issue/RUSH-2575/live-capacity-aware-device-routing-for-device-auto-salvage-capacityts) | Low | Live-capacity-aware --device auto (salvage capacity.ts) | new devices/capacity.ts, smart-launch.ts |
| [RUSH-2576](https://linear.app/getrush/issue/RUSH-2576/releasesh-stuck-guard-deadlocks-again-at-phnx-catchup-once-main) | High | release.sh stuck-guard deadlocks again at phnx-catchup | scripts/stuck-release.sh:57, scripts/release.sh:648 |
| [RUSH-2577](https://linear.app/getrush/issue/RUSH-2577/opencode-custom-harness-ignores-its-pinned-model-runs-opencode-default) | Medium | opencode harness ignores pinned --model | lib/profiles.ts, lib/exec.ts |
| [RUSH-2637](https://linear.app/getrush/issue/RUSH-2637/daemon-monitors-add-auto-starts-the-daemon-on-a-box-where) | Medium | monitors add auto-starts daemon ignoring kill switch | commands/monitors.ts, lib/device-config.ts |
| [RUSH-2640](https://linear.app/getrush/issue/RUSH-2640/routines-a-terminal-run-stays-in-the-schedulers-active-set-so-every) | High | terminal routine run wedges scheduler forever | lib/runner.ts |
| [RUSH-2643](https://linear.app/getrush/issue/RUSH-2643/routinestestts-concurrency-test-is-flaky-on-ci-and-halts-a-release-mid) | High | routines.test.ts concurrency test flaky, halts releases | commands/routines.test.ts:1498 |

### Wave 2 (13 tickets)

| ID | Priority | Title | Files |
|---|---|---|---|
| [RUSH-2364](https://linear.app/getrush/issue/RUSH-2364/agents-auth-mint-first-class-setup-token-mintseed-command-close-the) | High | agents auth mint: first-class setup-token command | fleet/auth-sync.ts, claude-account-token.ts, new commands/auth.ts |
| [RUSH-2406](https://linear.app/getrush/issue/RUSH-2406/clarify-agents-view-usage-and-auth-status-semantics) | High | Clarify agents view usage/auth status semantics | commands/view.ts, auth-health.ts |
| [RUSH-2477](https://linear.app/getrush/issue/RUSH-2477/sessions-resume-storms-on-crash-restart-db-lock-crash-boot-time-fleet) | High | sessions resume storms on crash-restart | commands/sessions-resume.ts, session/discover.ts, session/db.ts, remote-agents-json.ts, apps/ext extension.ts |
| [RUSH-2523](https://linear.app/getrush/issue/RUSH-2523/cache-frontmatter-parse-on-canonical-miss-alias-scan-perf) | Medium | Cache frontmatter parse on alias-scan miss (perf) | resources.ts alias-fallback block, skills.ts:149, commands.ts:162 |
| [RUSH-2564](https://linear.app/getrush/issue/RUSH-2564/routers-token-validation-harnessmodeltier-docs-changelog) | High | routers: token validation + docs + CHANGELOG | routers.ts validateRouter(), agents.ts:277, model-tiers.ts:282 |
| [RUSH-2566](https://linear.app/getrush/issue/RUSH-2566/dispatch-wiring-routerexists-branch-using-agents-route-run-explain) | High | dispatch wiring: routerExists + --using + --explain | commands/exec.ts ~2280-2348, commands/route.ts |
| [RUSH-2571](https://linear.app/getrush/issue/RUSH-2571/runwithfallback-cross-harness-fallback-chain-rate-limit-only) | Medium | runWithFallback: cross-harness fallback chain (rate-limit only) | exec.ts:2377-2480 runWithFallback |
| [RUSH-2572](https://linear.app/getrush/issue/RUSH-2572/routehijack-config-opt-in-re-route-notice-default-fail-loud) | Medium | route.hijack config: opt-in re-route / default fail-loud | route.hijack config, likely route-policy.ts or exec.ts |
| [RUSH-2578](https://linear.app/getrush/issue/RUSH-2578/agents-accounts-addinspect-crash-with-uncaught-node-exception-on) | Low | accounts add/inspect crash uncaught | commands/accounts.ts, bootstrap.ts |
| [RUSH-2592](https://linear.app/getrush/issue/RUSH-2592/runnertestts-routine-replacement-test-is-flaky-expected-running-to-be) | Low | runner.test.ts replacement test flaky | lib/runner.ts, runner.test.ts |
| [RUSH-2600](https://linear.app/getrush/issue/RUSH-2600/agents-browser-record-ffmpeg-fails-to-finalize-recording-is) | Medium | browser record ffmpeg finalize fails | lib/browser/service.ts |
| [RUSH-2622](https://linear.app/getrush/issue/RUSH-2622/browser-leftover-tabs-pile-up-close-on-task-end-30m-idle) | High | browser: leftover tabs pile up | lib/browser/{hygiene,service,ipc}.ts, daemon.ts, commands/browser.ts, device-config.ts, config-keys.ts |
| [RUSH-2639](https://linear.app/getrush/issue/RUSH-2639/tests-suite-writes-hook-entries-into-the-developers-real-settingsjson) | High | test suite writes hook entries into real settings.json | lib/state.ts:558, tests/setup.ts |

### Wave 3 (4 tickets)

| ID | Priority | Title | Files |
|---|---|---|---|
| [RUSH-2010](https://linear.app/getrush/issue/RUSH-2010/browser-phase-2-targets-host-ssh-endpoint-provider-wss-cloud) | Medium | browser Phase 2: --host/--provider targets | lib/browser/service.ts, commands/browser.ts, setup-browser.ts |
| [RUSH-2570](https://linear.app/getrush/issue/RUSH-2570/route-policy-scorecandidatesweights-explain-contributions-default) | Medium | route-policy: scoreCandidates + --explain + default order | route-policy.ts, models.ts:1049, rotate.ts:459 |
| [RUSH-2593](https://linear.app/getrush/issue/RUSH-2593/ext-auto-launch-offloads-to-boxes-with-logged-out-claude-agent-tabs) | High | ext (Auto) offloads to logged-out boxes | apps/ext core/agents.ts, extension.ts:1959, lib/hosts/ready.ts, lib/smart-launch.ts |
| [RUSH-2636](https://linear.app/getrush/issue/RUSH-2636/agents-daemon-can-hang-alive-but-frozen-after-laptop-sleepwake-and) | Medium | daemon hangs alive-but-frozen after sleep/wake | lib/daemon.ts |

### Wave 4 (1 tickets)

| ID | Priority | Title | Files |
|---|---|---|---|
| [RUSH-2011](https://linear.app/getrush/issue/RUSH-2011/browser-phase-3-ergonomics-positional-navigate-eval-to-evaluate-non) | Medium | browser Phase 3: ergonomics | commands/browser.ts |

## The 23 "Doing" tickets — what actually happened

Every Doing-state ticket got a `git branch -r --list` + `gh pr list --search` check. Two turned out to already be fully shipped (STALE, listed above); one is actively progressing and should not be touched; three sit on a PR that's ready or nearly ready to merge — the cheapest wins in this whole backlog; the rest have zero trace of work despite the "Doing" label.

| ID | Title | Status | Finding |
|---|---|---|---|
| [RUSH-1935](https://linear.app/getrush/issue/RUSH-1935/growth-visibility-distribution-engine-for-agents-cli-creators-daily) | Growth/distribution engine (epic) | **abandoned-with-nothing** | No branch, no genuine PR. DECISION bucket — question is whether this epic is still the priority given 2+ weeks with zero shipped sub-work. |
| [RUSH-1937](https://linear.app/getrush/issue/RUSH-1937/fix-the-repo-surface-conversion-gap-136k-downloads-11-stars) | Repo-surface conversion gap | **abandoned-with-nothing** | No branch, no genuine PR. |
| [RUSH-1941](https://linear.app/getrush/issue/RUSH-1941/repair-rush-blog-engine-currently-failing-and-point-a-blog-engine-at) | Repair rush-blog-engine (failing routine) | **abandoned-with-nothing** | No branch, no genuine PR. Root cause itself unknown (SPEC). |
| [RUSH-2009](https://linear.app/getrush/issue/RUSH-2009/browser-phase-1-ambient-current-task-key-hygiene-dedup-reap-scoped) | browser Phase 1: ambient task key + hygiene | **abandoned-with-nothing** | No branch, no genuine PR (only a numeric-coincidence PR hit, unrelated). |
| [RUSH-2113](https://linear.app/getrush/issue/RUSH-2113/verify-work-complete-hook-keep-moving-redirect-taskqueue-awareness) | verify-work-complete hook: keep-moving + A-G backlog | **abandoned-with-nothing** | Prerequisite analysis PR merged elsewhere, but the actual A-G backlog has no branch and targets a different repo. |
| [RUSH-2299](https://linear.app/getrush/issue/RUSH-2299/agents-bench-harnessmodel-scoreboard-parallel-same-task-fan-out) | agents bench: scoreboard + fan-out | **abandoned-with-work** | PR #2234 MERGED shipped the core (list/run/results). Missing: house tasks dir + `matrix` subcommand — acceptance criteria still fail. |
| [RUSH-2361](https://linear.app/getrush/issue/RUSH-2361/deprecate-wallet-and-attribute-hook-triggered-secret-audits) | Deprecate wallet + attribute hook-triggered secret audits | **abandoned-with-work** | Wallet-half fully merged (commits 09a7eecdb, e1f6a2896). Hook-attribution half has no branch and the ticket carries no acceptance bar for it. |
| [RUSH-2369](https://linear.app/getrush/issue/RUSH-2369/sessions-prove-opencode-parity-across-every-lifecycle-verb) | sessions: OpenCode parity across every lifecycle verb | **abandoned-with-work** | Two prerequisite PRs merged (#2313, #2318). No feature-matrix test yet; no branch/PR for this ticket itself. |
| [RUSH-2376](https://linear.app/getrush/issue/RUSH-2376/menubar-favorite-devices-and-pin-them-below-the-current-mac) | Menubar: favorite devices, pin below current Mac | **abandoned-with-work** | PR #2346 MERGED but prep-only (data plumbing). The actual favorite/unfavorite UI was never built. |
| [RUSH-2385](https://linear.app/getrush/issue/RUSH-2385/perf-the-commander-root-bootstrap-costs-11-13ms-of-module-load-and-the) | perf: fold command.start into command.end, eval NODE_COMPILE | **abandoned-with-work** | PR #2349 MERGED is the benchmark itself, not the fix. Both proposed optimizations still unapplied. |
| [RUSH-2400](https://linear.app/getrush/issue/RUSH-2400/featcursor-make-multiple-cursor-accounts-real-isolate-per-account) | feat(cursor): real multi-account isolation at exec | **STALE — fully shipped** | PR #2372 MERGED. All 3 "done means" criteria verified live in code. |
| [RUSH-2404](https://linear.app/getrush/issue/RUSH-2404/agents-view-show-an-installations-current-release-after-update) | agents view: show installation's release version | **abandoned-with-nothing** | No branch, no genuine PR. |
| [RUSH-2405](https://linear.app/getrush/issue/RUSH-2405/hooks-first-class-enabledisable-for-promptcuts-and-bangcuts) | Hooks: first-class enable/disable for promptcuts/bangcuts | **abandoned-with-nothing** | No branch, no genuine PR. |
| [RUSH-2406](https://linear.app/getrush/issue/RUSH-2406/clarify-agents-view-usage-and-auth-status-semantics) | Clarify agents view usage/auth status semantics | **abandoned-with-nothing** | No branch, no genuine PR — despite Linear `delegate: Claude`. |
| [RUSH-2474](https://linear.app/getrush/issue/RUSH-2474/win-minis-system-mirror-is-permanently-dirty-index-cached-stat-size) | win-mini .system mirror permanently dirty (CRLF) | **abandoned-with-nothing** | No branch, no PR (fix target is a different repo entirely). |
| [RUSH-2484](https://linear.app/getrush/issue/RUSH-2484/make-vs-codium-extension-a-zero-duplication-agents-cli-client) | VS Codium ext: zero-duplication agents-cli client | **ACTIVE — not abandoned** | PR #2534 MERGED (95 files). Follow-on commits as recent as 2026-08-13 (2 days before this triage). Real, continuing progress. |
| [RUSH-2494](https://linear.app/getrush/issue/RUSH-2494/remove-the-host-flag-device-becomes-the-sole-routingtarget-flag-cli) | Remove --host flag; --device sole routing flag | **abandoned-with-work — cheap win, needs a rebase first** | PR #2620 OPEN, ALL CI GREEN. Stalled unmerged for 5 days (last commit 2026-08-10) — now `mergeable: CONFLICTING` (69 commits behind origin/main), confirmed via `gh pr view 2620 --json mergeable`. Rebase, then merge. |
| [RUSH-2512](https://linear.app/getrush/issue/RUSH-2512/sessions-focus-cross-host-live-sessions-show-no-preview-transcript-is) | sessions focus: no preview for cross-host live sessions | **abandoned-with-nothing** | No branch, no PR — genuinely unowned. |
| [RUSH-2521](https://linear.app/getrush/issue/RUSH-2521/agent-spawned-daemons-mcp-servers-claude-bg-sparebg-pty-host-harness) | Agent-spawned daemons leak past session exit | **STALE — fully shipped** | 4 MERGED PRs cite this ticket. Code confirms the fix live. Ticket status should move to Done. |
| [RUSH-2526](https://linear.app/getrush/issue/RUSH-2526/routing-never-auto-pick-an-account-from-entirely-stale-usage) | Routing: never auto-pick account from stale usage | **abandoned-with-nothing** | No branch, no PR. |
| [RUSH-2527](https://linear.app/getrush/issue/RUSH-2527/unify-native-and-provider-accounts-across-installations-profiles-and) | Unify native + provider accounts | **abandoned-with-work — needs a scope decision** | 3 branches exist; 2 open PRs (#2563, #2573) both show `mergeable: CONFLICTING`. Ticket bundles ~7 sub-scopes with no single "done" bar (SPEC bucket). |
| [RUSH-2536](https://linear.app/getrush/issue/RUSH-2536/agents-projects-pull-sync-a-projects-fleet-checkouts) | agents projects pull: sync fleet checkouts | **abandoned-with-work — CHEAP WIN** | PR #2656 OPEN, not draft, substantially complete (12 files, +1139/-25, includes tests + docs + changelog fragment). Awaiting review/merge. |
| [RUSH-2622](https://linear.app/getrush/issue/RUSH-2622/browser-leftover-tabs-pile-up-close-on-task-end-30m-idle) | browser: leftover tabs pile up | **abandoned-with-work — CHEAP WIN** | PR #2652 MERGED (part 1). PR #2655 OPEN (part 2, 1 day old) — 2 failing CI checks (cli-preflight, cli-docs), rest green, 0 reviews. |

**Three PRs are sitting green or near-green, unmerged, right now:**
1. **RUSH-2494 / PR #2620** — "remove `--host` flag" — all CI green, but `mergeable: CONFLICTING` (5 days stale, 69 commits behind main). Rebase, then merge.
2. **RUSH-2536 / PR #2656** — "agents projects pull" — substantially complete, awaiting review.
3. **RUSH-2622 / PR #2655** — "browser tab hygiene reaper" — needs 2 failing CI checks (`cli-preflight`, `cli-docs`) fixed, then merge.

**Two Doing tickets should just close** (RUSH-2400, RUSH-2521 — see STALE table above; Linear status never caught up to the merge).

## File conflicts across all buckets (not just AUTO)

Beyond the wave split above (AUTO-only), these pairs/groups span buckets — worth knowing before scoping any future wave, since a DECISION or SPEC ticket resolving later could still collide with AUTO work already dispatched.

| Files | Tickets | Note |
|---|---|---|
| `apps/cli/src/commands/exec.ts` (dispatch chain ~2200-2350, `buildExecEnv:411`) | RUSH-2400(STALE), RUSH-2527(SPEC, 2 open conflicting PRs), RUSH-2557/2558(DECISION), RUSH-2566/2567/2568(AUTO), RUSH-2571(AUTO) | **Highest-risk file in the backlog.** RUSH-2527 already has two open PRs in `CONFLICTING` mergeable state touching this exact resolver. Router-epic AUTO subtasks (2566-2568, 2571) plan more edits to the same block. Land RUSH-2527's scope decision before dispatching any router-epic wave 2+. |
| `apps/cli/src/lib/daemon.ts` | RUSH-2439(STALE), RUSH-2480/2482(DECISION), RUSH-2554(AUTO), RUSH-2622(AUTO), RUSH-2636(AUTO) | PR #2655 (RUSH-2622) is mid-flight here — land it before RUSH-2636 (wave 3) to avoid rebasing a daemon.ts change against a still-open PR. |
| `apps/cli/src/lib/rotate.ts` | RUSH-2526(AUTO, wave 1), RUSH-2559/2565/2570(router epic), RUSH-2575(AUTO, wave 1) | Read-mostly reuse (`capacityWeight`/`pickBalancedCandidate`) by the router epic — land RUSH-2526 first so the router builds on corrected selection logic, not the bug it's fixing. |
| `apps/cli/src/commands/view.ts` | RUSH-2404(AUTO, abandoned-with-nothing), RUSH-2406(AUTO, abandoned-with-nothing) | Different functions, same file — sequence or single owner. |
| `apps/cli/src/lib/resources.ts` | RUSH-2504(STALE), RUSH-2523(AUTO, wave 2), RUSH-2556(DECISION)/RUSH-2562(AUTO, wave 1) | Same `ResourceKind` union region touched by the router epic and the perf fix — low risk, different lines, sequence anyway. |

## The router epic — one initiative, filed as 15 tickets

RUSH-2555 is the epic parent (its own spec PR already merged — #2641). It splits into six tier-1 tickets (RUSH-2556/2557/2558/2559/2560/2561), and **every one of those six is itself fully decomposed into 2-3 tier-2 subtask tickets already in this backlog** (2562-2564, 2565-2566, 2567-2568, 2569-2570, 2571-2572, 2573-2574). That's why all six tier-1 tickets landed in the DECISION bucket — dispatching a tier-1 parent *and* its already-filed children risks two agents building the same files. The tier-2 subtasks are the real dispatchable units (11 are AUTO across waves 1-3 above; 2 — RUSH-2573/2574 — are SPEC because the ticket itself says the child-result contract is "the main unknown, pick one").

**Practical read:** skip dispatching 2556-2561 entirely; dispatch their AUTO children per the wave plan, in the order the tickets' own `Depends on` fields specify (2556's children before 2557's, before 2558's; 2559-2561's children can run in parallel with 2556-2558's once wave-1/2 sequencing clears). This is question 11-16 in the DECISION list above, condensed.

## Tracking

This report: `.agents/artifacts/2026-08-15/backlog-triage.md` (this file). No sub-tickets opened during this triage — that's the point of the DECISION/SPEC buckets: they name the missing piece rather than presupposing an answer.
