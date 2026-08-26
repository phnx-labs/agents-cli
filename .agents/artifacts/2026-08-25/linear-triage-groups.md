---
kind: visual
template: visual.v1
title: AGI CLI — remaining 170, grouped for close/keep
summary: The group-review page is back, scoped to the AGI (CLI) project only. AGI UI Wednesday work is a different project. Scan a bucket, then name it to cancel or keep.
status: draft
date: "2026-08-25"
header: Phoenix Labs / agi-cli
footer: AGI CLI group review — name a bucket
facts:
  - "170 open on AGI"
  - "137 still in Cycle 26"
  - "AGI UI is a separate project"
links:
  - url: https://linear.app/getrush/issue/RUSH-2512
    label: RUSH-2512
---

## Story

This is the review UI for **AGI (the CLI project)**. Not AGI UI.

Each card is id, status, cycle, and a short description. Click an id only for the full Linear thread. Name a group and I will close or keep it.

AGI UI Wednesday windows live on the other project. Do not review those here.

<aside class="artifact-callout">Name a group. I will not cancel a bucket until you do.</aside>

## Data

| Group | Count | Proposed |
| --- | --- | --- |
| Keep | 4 | keep |
| Hold | 8 | hold |
| Umbrella parents | 6 | cancel-parent |
| Lying Doing | 6 | cancel |
| Growth / bench / git-reconcile | 3 | cancel |
| Sessions leftovers (not 2512) | 37 | review |
| Daemon / sync / mirrors | 19 | review |
| Accounts / usage / auth | 22 | review |
| CI / release / tests | 25 | review |
| Guards / merge / stop-gate | 3 | review |
| Rest of AGI CLI | 37 | review |

AGI open: **170**. Cycle 26 still holds most of them.

## Figure

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 960 280" role="img" aria-label="AGI CLI remaining tickets by review group">
<rect x="20" y="20" width="220" height="70" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/><text x="36" y="48" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Keep</text><text x="36" y="70" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">4</text><rect x="260" y="20" width="220" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/><text x="276" y="48" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Hold</text><text x="276" y="70" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">8</text><rect x="500" y="20" width="220" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/><text x="516" y="48" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Umbrellas</text><text x="516" y="70" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">6</text><rect x="740" y="20" width="200" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/><text x="756" y="48" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Lying Doing</text><text x="756" y="70" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">6</text><rect x="20" y="110" width="220" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/><text x="36" y="138" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Growth</text><text x="36" y="160" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">3</text><rect x="260" y="110" width="220" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/><text x="276" y="138" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Sessions+</text><text x="276" y="160" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">37</text><rect x="500" y="110" width="220" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/><text x="516" y="138" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Daemon/sync</text><text x="516" y="160" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">19</text><rect x="740" y="110" width="200" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/><text x="756" y="138" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Accounts</text><text x="756" y="160" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">22</text><rect x="20" y="200" width="300" height="60" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/><text x="36" y="228" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">CI / release</text><text x="36" y="250" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">25</text><rect x="340" y="200" width="300" height="60" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/><text x="356" y="228" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Guards</text><text x="356" y="250" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">3</text><rect x="660" y="200" width="280" height="60" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/><text x="676" y="228" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Rest</text><text x="676" y="250" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">37</text>
</svg>
<figcaption>Lime is already decided keep. Blue is review. Amber is proposed cancel.</figcaption>
</figure>

## Keep — already decided this walk

<a id="keep"></a>

Leave these. 2512 due Wed. 3193 in flight. 3182 real auth bug. 2526 still your call. Proposed: **keep**. 4 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2512/sessions-focus-cross-host-live-sessions-show-no-preview-transcript-is">RUSH-2512</a> · sessions focus: cross-host live sessions show no preview — transcript is only indexed on the box that ran it</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Urgent</span> <span class="artifact-tag">cycle 26</span></p>
  <p>What the user saw Running agents sessions focus from zion in ~/.agents , most rows for sessions running on other boxes render as [host/yosemite-s0] / [host/yosemite-s1] with — for repo/branch/topic and no preview . Selecting one shows: Live session — full transcript not indexed here. (e.g. dd6c1554, 0 msgs, host/yosemite-s1). Local zion sessions preview fine (topic, msg count,…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3182/accounts-setup-token-accounts-are-invisible-to-strategy-balanced">RUSH-3182</a> · accounts: setup-token accounts are invisible to --strategy balanced; attach is inert (make the account the load-balancing unit)</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem --strategy balanced only load-balances across accounts that have a native oauthAccount in a version home&#x27;s .claude.json . Setup-token accounts added via agents accounts add / attach are invisible to balancing and unselectable by --account , even though they run fine when injected at exec. On the yosemite workers this means balanced rotates across only 2 accounts…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3193/daemon-service-supervisor-per-service-contract-error-boundaries">RUSH-3193</a> · Daemon service supervisor: per-service contract, error boundaries, deadlines, health, live start/stop</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem The agents daemon is an OS-supervised single process, not a supervisor. It has exactly one property of a real service manager — the outer one (launchd KeepAlive + ThrottleInterval=30 / systemd Restart=always restart the whole process). Internally it is the opposite of isolated: ~13 background services are inline setInterval / setTimeout closures in runDaemon() (…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2526/routing-never-auto-pick-an-account-from-entirely-stale-usage">RUSH-2526</a> · Routing: never auto-pick an account from entirely stale usage</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Balanced and available routing currently fall back to the entire stale candidate pool when no usage snapshot is newer than USAGE_DECISION_MAX_AGE_MS. Implement verified-only initial selection. If every snapshot is stale, interactive runs show the account picker and unattended runs exit with NO_VERIFIED_USAGE. Preserve stale candidates only for bounded post-rejection failover.…</p>
</article>
</div>
## Hold — In Review / Plan / shipped-unverified

<a id="hold"></a>

Do not cancel blindly. 3036 waits on released usage bars. 2848 needs signing. Proposed: **hold**. 8 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2847/npm-i-g-mutates-the-machine-3x-before-any-command-runs-move-install">RUSH-2847</a> · npm i -g mutates the machine 3x before any command runs — move install side effects into agents setup</h3>
  <p><span class="artifact-tag">Plan</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Security review before the HN launch found no vulnerability , but a disclosure problem: postinstall.js performs three unprompted state mutations before the user runs any command. 1. Appends export PATH=... to ~/.bash_profile or ~/.profile ( scripts/postinstall.js:336 ) — no prompt 2. Symlinks agents / ag into ~/.local/bin ( scripts/postinstall.js:317 ) — no prompt 3.…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2848/pr-merge-on-green-has-never-fired-poll-runs-gh-pr-list-with-no-repo">RUSH-2848</a> · pr-merge-on-green has never fired: poll runs gh pr list with no --repo from a non-repo daemon cwd</h3>
  <p><span class="artifact-tag">In Review</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>pr-merge-on-green has never worked. It is registered, enabled, and has polled 2,133 times , but its poll command errors on every single run, so it can never select a PR to merge. Root cause: the poll command is repo-relative but the daemon has no repo cwd. poll: gh pr list --author @me --state open --limit 50 --json number,reviewDecision,statusCheckRollup --jq &#x27;...&#x27; There is…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3036/usage-per-account-429-backoff-derive-auth-verdict-from-fresh-usage">RUSH-3036</a> · usage: per-account 429 backoff + derive auth verdict from fresh usage fetch — 4 accounts starve behind provider-wide parking</h3>
  <p><span class="artifact-tag">In Review</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up to RUSH-2998. After the 20-min probe throttle (1.22.44+), 4 of 8 Claude accounts (gmail, social@swarmify, team@agentsmores, tech@prix) still show &#x27;usage unavailable&#x27; — probed directly: 429 retry-after 3600, tokens valid. Two code defects compound the residual load: (1) usage-backoff.ts is PER-PROVIDER — the first account to 429 in a refresh pass parks &#x27;claude&#x27;…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3099/gh-merge-guard-a-review-saying-approved-does-not-clear-the-gate-the">RUSH-3099</a> · gh-merge-guard: a review saying APPROVED does not clear the gate — the regex only matches the bare stem APPROVE</h3>
  <p><span class="artifact-tag">In Review</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>gh-merge-guard refuses to recognise the word APPROVED , so a correct non-author review does not clear the merge gate. rules/subrules/gh-merge-guard/pr-verdict.py:31 : python APPROVE = re.compile(r&quot;\bAPPROVE\b&quot;) The trailing D in APPROVED is a word character, so the \b cannot match: &#x27; APPROVED. &#x27; - False &#x27;APPROVED&#x27; - False &#x27;APPROVE&#x27; - True &#x27;Verdict: APPROVE&#x27; - True APPROVED is…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2697/fold-the-permissions-write-path-into-permission-targets">RUSH-2697</a> · Fold the permissions WRITE path into PERMISSION_TARGETS</h3>
  <p><span class="artifact-tag">Plan</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>RUSH-2676 (PR 2689) put the permissions read path behind a PERMISSION_TARGETS registry. The write path, applyPermissionsToVersion ( apps/cli/src/lib/permissions.ts ), is still a ~440-line chain of if (agentId === &#x27;...&#x27;) arms — one per harness — which is exactly the shape the repo&#x27;s review conventions call out (&quot;not near-identical else if (agent === &#x27;...&#x27;) arms&quot;). Keeping them…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2771/consolidate-the-planning-front-doors-plan-swarmplan-swarmspec-bmad">RUSH-2771</a> · Consolidate the planning front doors: /plan, swarm:plan, swarm:spec, /bmad, /adhd</h3>
  <p><span class="artifact-tag">Plan</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>What There are now five front doors for &quot;help me think about this before I build it&quot;, and a reader has no rule for picking between them: | Surface | Its stated job | | -- | -- | | /plan | grounded design: research, read code, create artifacts | | /swarm plan | independent plans produced blind, then reconciled | | /swarm spec | the durable &quot;what this capability guarantees&quot; spec…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3017/agents-system-main-ruleset-blocks-owner-prs-from-cli-merge-outside">RUSH-3017</a> · .agents-system main ruleset blocks owner PRs from CLI merge: &#x27;outside contributions require review&#x27; has no outside-only scoping</h3>
  <p><span class="artifact-tag">In Review</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Ruleset 21020497 (&#x27;main: outside contributions require review&#x27;) requires 1 approving code-owner review + squash for every PR, but the sole code owner is the PR author for own PRs, so agents cannot merge on green at all: the plain merge fails (&#x27;base branch policy prohibits the merge&#x27;), merge-guard rightly blocks the admin-bypass flag, and the auto-mode classifier blocks…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3091/sessions-surface-background-shells-and-armed-monitors-per-session">RUSH-3091</a> · sessions: surface background shells and armed monitors per session (Claude/Kimi/Grok; Codex+Cursor unsupported)</h3>
  <p><span class="artifact-tag">In Review</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Ask Surface the background shell processes and active monitors an agent has running, in agents sessions preview and other session surfaces. Claude&#x27;s own TUI already shows this ( 2 shells still running , and a backgrounded Bash(...) block with &quot;Running in the background&quot;), but agents-cli does not. Harness support — probed against real transcripts on yosemite-s1 | Harness |…</p>
</article>
</div>
## Umbrella parents — cancel or pull off cycle

<a id="umbrella"></a>

Duplicate children. 2652 already off cycle; only 2512 remains. These inflate 164/182. Proposed: **cancel-parent**. 6 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2652/sessions-cross-fleet-lifecycle-and-visibility">RUSH-2652</a> · Sessions: cross-fleet lifecycle &amp; visibility</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle -</span></p>
  <p>Sessions: cross-fleet lifecycle &amp; visibility Goal: agents sessions should tell the truth about every agent running anywhere on the fleet, and let you get back into any of them — regardless of which box ran it or which harness it is. Today the surface has structural gaps: --active reports nothing while dozens of agents run, cross-host live sessions show no preview because the…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2654/fleet-daemon-and-config-sync-reliability">RUSH-2654</a> · Fleet daemon &amp; config-sync reliability</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Fleet daemon &amp; config-sync reliability Goal: the background plumbing that keeps every fleet box current and healthy — the daemon, agents sync , and the DotAgents/.system mirrors — must never silently freeze, hang, or drift without warning. These are the failures that cost hours because nothing shouts: a daemon that hangs alive-but-frozen after sleep/wake (~51h observed),…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2667/insights-bench-and-cost-attribution">RUSH-2667</a> · Insights, bench &amp; cost attribution</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Umbrella: measure agent work — harness×model bench, session optimization reporting, cost-hotspot ranking, cross-harness attribution, usage-event coverage.</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2668/identity-and-pr-review-governance">RUSH-2668</a> · Identity &amp; PR-review governance</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Umbrella: a real principal model + non-author review — human-identity substrate (SSO/SAML), per-agent PR identity, branch-protection required review.</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2669/performance-startup-and-hooks">RUSH-2669</a> · Performance — startup &amp; hooks</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Umbrella: reduce startup and hook overhead — commander bootstrap cost, warm TS hook engine, frontmatter parse caching.</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2678/fleet-session-audit-7d-23-rulehookguard-changes-for-agents">RUSH-2678</a> · Fleet session audit (7d): 23 rule/hook/guard changes for ~/.agents</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>7-day fleet session audit. Ranked ~3,500 sessions (zion, yosemite-s0, yosemite-s1) by where the owner corrected the agent, read the 14 highest-friction ones with 6 parallel readers, and filtered every finding against current code (killed 4 already-fixed items). 23 findings. Artifact (prioritized suggestion): https://claude.ai/code/artifact/bd8bb179-ba1b-4033-ae9a-5a321ec67113…</p>
</article>
</div>
## Lying Doing — cancel

<a id="lying"></a>

Doing with no PR for weeks. Same abandoned set as Aug 15. Proposed: **cancel**. 6 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-1937/fix-the-repo-surface-conversion-gap-136k-downloads-11-stars">RUSH-1937</a> · Fix the repo-surface conversion gap (13.6k downloads, 11 stars)</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Parent: RUSH-1935. 13,632 downloads last month, 11 stars, 0 watchers. Roughly one star per 1,200 installs. Already shipped — do not redo (verified 2026-07-29) Topics set — ai-agents , claude , claude-code , cli , codex , coding-agents , cursor , developer-tools , gemini , mcp . About/description set , homepage field populated. Star nudge shipped — PR 1426 merged 2026-07-29:…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-1941/repair-rush-blog-engine-currently-failing-and-point-a-blog-engine-at">RUSH-1941</a> · Repair rush-blog-engine (currently failing) and point a blog engine at agents-cli</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Parent: RUSH-1935. rush-blog-engine (routine, wf:blog-engine , Mon/Wed/Fri 8:00 AM, repo muqsitnawaz/agents, devices yosemite-s0/s1) has last status failed . A broken content engine is worse than none — it looks staffed and produces nothing. Fix first, then extend 1. Pull the failure logs: agents routines logs rush-blog-engine . Root-cause it. Do not paper over with a retry.…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2113/verify-work-complete-hook-keep-moving-redirect-taskqueue-awareness">RUSH-2113</a> · verify-work-complete hook: keep-moving redirect + task/queue awareness + cross-session coordination</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Context PR phnx-labs/.agents-system 158 (merged, live on claude 2.1.219) fixed the looping failure of the verify-work-complete Stop hook: recognize a live background gh pr checks --watch / ScheduleWakeup / Monitor as a valid stop, de-escalate after the 3rd fire, and add plan-mode / reviewer-down awareness. Analysis report:…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2406/clarify-agents-view-usage-and-auth-status-semantics">RUSH-2406</a> · Clarify agents view usage and auth status semantics</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem agents view claude --device &lt;host renders several unlabeled signals in one row. A user cannot tell whether unverified or ◐ 11h ago means logged out, unable to run, stale usage, or rate-limited. On yosemite-s0 , unverified followed the quota bars because their live refresh could not read a file-based Claude credential and fell back to cached usage. The trailing ◐ came…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2385/perf-the-commander-root-bootstrap-costs-11-13ms-of-module-load-and-the">RUSH-2385</a> · perf: the commander root bootstrap costs 11-13ms of module load, and the audit hooks 195us per command (index.ts:10, 262-371)</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Measured with the committed vitest bench apps/cli/src/lib/index.bench.ts . Two full runs on yosemite-s1 , linux, node v24.11.1, vitest 4.1.9. Every number below is a real npx vitest bench --run mean; the raw logs are linked from the PR. What was measured | Row (bench group) | Run 1 mean | Run 2 mean | | -- | -- | -- | | FLOOR: bare node --input-type=module -e &quot;&quot; (commander…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2474/win-minis-system-mirror-is-permanently-dirty-index-cached-stat-size">RUSH-2474</a> · win-mini&#x27;s .system mirror is permanently dirty — index cached stat size (6736) disagrees with the file and blob (6611)</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>On win-mini, &#x27;agents sync system&#x27; has been refusing with &#x27;Working tree has uncommitted changes&#x27; — and it always will, by construction. Evidence (win-mini, 2026-08-09): git -C $HOME/.agents/.system status --short D cli/AGENTS.md ... (6 tracked files under cli/ showing deleted; &#x27;git restore cli/&#x27; fixed those) then, still dirty: M skills/agents-cli/SKILL.md M…</p>
</article>
</div>
## Growth / bench / git-reconcile — cancel

<a id="growth"></a>

Not CLI robustness. Zero shipped sub-work. Proposed: **cancel**. 3 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2298/agents-git-reconcile-canonical-fetch-first-rebase-fix-forward-path">RUSH-2298</a> · agents git reconcile — canonical fetch-first rebase / fix-forward path</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem — the 3 friction workflow Agents re-derive the safe reconcile sequence (fetch-first → rebase onto origin/&lt;default → resolve conflicts fix-forward → push) per session, and periodically reach for a destructive shortcut the git-guard then blocks. From agents insights --since 30d : Git reconcile recipe automation signal: \~887 occurrences (codex 302 + gmail-acct 235 +…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2299/agents-bench-harnessmodel-scoreboard-parallel-same-task-fan-out">RUSH-2299</a> · agents bench: harness×model scoreboard + parallel same-task fan-out</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>agents bench — harness × model scoreboard + parallel fan-out Why agents-cli already unifies run/teams/harness/output. We have no product surface to: 1. Run the same task across multiple harnesses/models 2. Produce a comparable scorecard (pass/fail, wall time, tokens, $) 3. Publish a public table that can go viral on X 4. Use results to tune custom harnesses ( agents harness…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2834/agents-cli-launch-freeze-the-name-then-run-the-48-hour-ignition">RUSH-2834</a> · agents-cli launch: freeze the name, then run the 48-hour ignition</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Research report: .agents/artifacts/2026-08-20/github-stars-playbook.md (PR 2797). The repo has 15 stars in 194 days (0.18/day). Language-specific GitHub Trending starts around 50 stars/day. No coordinated launch has ever been run, so every star so far arrived by accident. The blocking decision is the name. The star equity is split across five identities: phnx-labs/agi-cli (15…</p>
</article>
</div>
## Sessions leftovers (not 2512)

<a id="sessions"></a>

Search, fan-out timeout, orphan detect. You said only 2512 remains of the epic. Proposed: **review**. 37 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2525/require-non-author-review-before-merge-on-agents-cli-agents-system">RUSH-2525</a> · Require non-author review before merge on agents-cli + .agents-system (branch protection)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Process gap observed this session: THREE PRs merged with NO non-author review - .system 289 and 293 (self-merged, no reviewer; .agents-system has no bot), and agents-cli 2544 (prix-cloud never posted, self-merged on green CI). Branch protection on both repos does not REQUIRE an approving review, so agents merge on green CI alone, bypassing the gh-merge-guard&#x27;s intent. Fix:…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2727/agents-teams-messaging-a-running-teammate-spawns-a-duplicate-session">RUSH-2727</a> · agents teams: messaging a running teammate spawns a duplicate session in the SAME worktree</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Two orchestrator-side defects in agents teams (agents-cli 1.22.39) that together caused a real merge race on phnx-labs/artifacts-cli today. Filed from the orchestrator session that hit them: 595657ee-c87f-4cd8-bca3-fd51aef960f0. 1. &#x27;teams message&#x27;/&#x27;teams resume&#x27; on a RUNNING teammate starts a second session in the same worktree Worktree isolation is per-teammate, so every…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2767/sessions-search-content-queries-return-0-while-transcripts-match-tmux">RUSH-2767</a> · sessions search: content queries return 0 while transcripts match — &#x27;tmux pane&#x27; misses 5 project transcripts</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Repro on zion, agents-cli 1.22.40, cwd ~/src/github.com/muqsitnawaz/agents-cli: &#x27;agents sessions &quot;tmux pane&quot;&#x27; and &#x27;agents sessions &quot;dead pane&quot; --all&#x27; both return &#x27;0 sessions&#x27;, yet grep over ~/.agents/.history/versions/claude/ /home/.claude/projects/-Users-muqsit-src-github-com-muqsitnawaz-agents-cli/ .jsonl finds 5 transcripts containing &#x27;dead pane&#x27;/&#x27;Pane is dead&#x27;/&#x27;pane-died&#x27;…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2768/fleet-update-stranded-zion-without-the-agents-binary-package-at-12240">RUSH-2768</a> · fleet update stranded zion without the agents binary — package at 1.22.40 but /opt/homebrew/bin symlinks gone</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>During the 1.22.40 rollout (agents fleet update, owner session d1df356f, 2026-08-17, log /tmp/fleet-update.log: &#x27;11 ok / 3 not upgraded / 1 failed&#x27;; &#x27;zion unverified — could not resolve agents on this box&#x27;), zion ended with /opt/homebrew/lib/node_modules/@phnx-labs/agents-cli upgraded to 1.22.40 but /opt/homebrew/bin/{agents,ag,browser,computer} symlinks MISSING — every…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2773/crabbox-fleet-unhealthy-ci-runner-fsn1-locked-out-blocks-moving">RUSH-2773</a> · crabbox fleet unhealthy + ci-runner-fsn1 locked out — blocks moving required CI off GitHub VMs</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Live probes 2026-08-17 (session c4ea55f3). (1) ci-runner-fsn1 (Hetzner fsn1, the intended crabbox-ci executor host per scripts/ci-runner + provision-phnx-runners.sh, and the crabbox-ci org runner pool used by tests-windows-host-e2e.yml) refuses ssh from zion as BOTH muqsit and root: &#x27;Permission denied (publickey,password)&#x27;. Recent tests-windows-host-e2e runs are all &#x27;skipped&#x27;,…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2815/sessions-fleet-fan-out-pays-10s-connecttimeout-for-dead-peers-stale">RUSH-2815</a> · sessions fleet fan-out pays 10s ConnectTimeout for dead peers: stale reachability.reachable (no TTL) overrides fresh tailscale.online=false</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Every fleet-wide agents sessions query on zion currently takes 11-14s. Measured (2026-08-19, agents-cli 1.22.40): agents sessions --active : 11.5s (repeat within ControlPersist=60s window: 1.0s) agents sessions (plain listing): 14.0s agents sessions &quot;&lt;query &quot; : 12.7s Same queries with --local : 0.6-3.0s Root cause Seven registered devices (yosemite-m0..m6) are dead: ping 100%…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2938/entitlementjs-reads-sessionaccess-token-from-rushuseryaml-but-current">RUSH-2938</a> · entitlement.js reads session.access_token from ~/.rush/user.yaml, but current rush blanks it (keychain-only) — paid/admin tier resolves to free</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>On zion, rush stores the session JWT only in Keychain (service dev.prix.rush) and leaves session.access_token empty in ~/.rush/user.yaml (rush whoami: &#x27;Session: valid&#x27;). agents-cli lib/entitlement.js readRushToken() reads only the yaml field, gets null, and getTier() short-circuits to free BEFORE consulting the cache — so &#x27;agents accounts add&#x27; caps an admin-tier user at 3…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2946/owner-notify-path-broken-fleet-wide-rush-signed-out-on-yosemite-s1-mac">RUSH-2946</a> · owner notify path broken fleet-wide: rush signed out on yosemite-s1 + mac-mini, pinnacles missing owner.channels + stale 1.22.41 shadow install</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Found 2026-08-20 while closing out the GTM landscape session (7cba9893): an agents feed post --level important recorded to the feed but the owner forward failed, and direct agents notify failed on every probed box. Evidence (three live probes, quoted): yosemite-s1: agents feed post --level important → → owner failed: Error: not signed in — run rush login or sign in via the…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3023/agent-armed-shell-watchers-are-silently-dead-exit-based-notify-cross">RUSH-3023</a> · Agent-armed shell watchers are silently dead: exit-based notify + cross-session /tmp task paths mean &#x27;will re-invoke me&#x27; never fires</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Symptom Muqsit: &quot;it starts like a shell command and then you expect that whatever monitor is running is going to work — it never works, never wakes up, never alerts me, never resumes working. It just stays there with the shell process running.&quot; Screenshot: session 56e305a5 (Resume work, yosemite-s0) shows &quot;Baked for 3m 1s · 5 shells still running&quot; after the agent claimed…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3183/orphan-detection-defaults-to-healthy-when-blind-and-never-fires-for-a">RUSH-3183</a> · orphan detection defaults to healthy when blind, and never fires for a running agent</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>The orphaned state exists and its derivation is thoughtfully written — but it has four blind spots that make it miss the case that matters most. Surveyed 2026-08-25; full plan in .agents/artifacts/2026-08-25/plan-daemon-owns-session-state.md (branch plan/reconnect-architecture ). How it works today lib/session/host-link.ts — classifyHostLink : ts if…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2300/insights-attribute-grok-kimi-cursor-antigravity-248-sessionsmo-unseen">RUSH-2300</a> · insights: attribute grok / kimi / cursor / antigravity (248 sessions/mo unseen)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem The insights engine only attributes three harnesses. From agents insights --since 30d , the harness list is: claude 697 · codex 245 · droid 2 But agents trends --days 30 sees nine: claude 4658 · codex 360 · grok 106 · kimi 84 · cursor 44 · droid 36 · antigravity 14 · rush 5 · muse 1 . So \~248 sessions/month (grok 106 + kimi 84 + cursor 44 + antigravity 14) get zero…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2301/sessions-stats-fix-usage-event-coverage-12percent-before-trusting-dead">RUSH-2301</a> · sessions stats: fix usage-event coverage (1.2%) before trusting dead-weight</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem agents sessions stats dead-weight analysis is unusable because usage-event coverage is near zero. From agents sessions stats --since 30d : coverage: sessionsWithUsage 72 / sessionsIndexed 5,780 (1.2%) totals: invokedResources 28 · zeroInvoked 116 The engine&#x27;s own note: skill invocations record for Claude + Kimi only , slash-commands Claude only — so codex / grok /…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2478/agents-system-agentsmd-omits-the-test-gate-the-absence-of-ci-and-the">RUSH-2478</a> · .agents-system AGENTS.md omits the test gate, the absence of CI, and the registration check</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Surfaced incidentally by a review session that drifted off its brief, but the three gaps are real and each was verified by grep rather than asserted: 1. The pre-PR test gate is undocumented. hooks/run_tests.sh describes itself as &#x27;the pre-PR gate for this repo&#x27;s hooks and guard rules — run it before opening a PR that touches hooks/, rules/subrules/, or agents.yaml&#x27;, and it is…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2502/stop-claude-showing-up-as-a-pr-co-author-co-authored-by-trailer">RUSH-2502</a> · Stop Claude showing up as a PR co-author (Co-Authored-By trailer)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>From a /blame this session: PRs/commits show &#x27;muqsitnawaz and claude&#x27; because Claude Code appends a Co-Authored-By: Claude Opus 5 (1M context) &lt;noreply@anthropic.com trailer (native attribution, default-on — no includeCoAuthoredBy key in ~/.claude/settings.json). The repo&#x27;s no-pr-footer/footer-guard.sh only blocks the &#x27;Generated with Claude Code&#x27; promo footer (patterns at…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2739/re-land-the-codex-trust-key-fix-dropped-with-superseded-pr-2720">RUSH-2739</a> · Re-land the codex trust-key fix dropped with superseded PR #2720</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>PR 2720 (branch agents/tracker, closed as superseded by 2728) bundled a &#x27;+ codex trust-key fix&#x27; beyond the session-tracker brief. The tracker work landed via 2728; the codex trust-key piece was not carried over. If it fixes a real defect, re-land it as its own scoped PR from the agents/tracker branch history (repo phnx-labs/agi-cli).</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2744/agents-system-6-hook-test-suites-red-on-pristine-main">RUSH-2744</a> · .agents-system: 6 hook test suites red on pristine main</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>hooks/run_tests.sh on untouched origin/main (f381b27) fails: git-guard, large-file-add-guard, rm-guard, session-start/04-session-identity, stop/visual_readback, user-prompt-submit/02-expand-prompt-user-shortcuts. Verified 2026-08-15 in a clean worktree while baselining PR 322/ 324. A red baseline hides new regressions. Green them or quarantine with written reasons.</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2778/artifacts-cli-plan-quality-gate-disabled-by-kindsurface-self">RUSH-2778</a> · artifacts-cli: plan quality gate disabled by kind/surface self-declaration</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Traced from a session audit of why plans ship without before/after mockups (see phnx-labs/.agents-system PR 334 for the repo-side fixes). Two validator holes in @phnx-labs/artifacts-cli dist/lib/validate.js: (1) the entire mockup/SVG/behavior gate is keyed on the exact literal kind === &#x27;plan&#x27; (validate.js:136) and REQUIRED_SECTIONS[kind] ?? [] (validate.js:90) — any other…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2827/agents-browser-daemon-holds-an-unlinked-socket-after-the-file-is">RUSH-2827</a> · agents browser: daemon holds an unlinked socket after the file is deleted, so every verb times out</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>agents browser was unusable on zion for the whole of a session on 2026-08-20, and the failure mode gives no clue what is wrong. Symptom: every agents browser verb exits with an unhandled exception — Error: Timeout waiting for browser daemon socket at waitForSocket (.../dist/lib/browser/ipc.js:127:11) Reproduced across three profiles (comet-local, sheets-agent, default), both…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2835/agents-artifacts-share-og-cover-auto-capture-fails-brave-no-screenshot">RUSH-2835</a> · agents artifacts share: OG cover auto-capture fails (brave: no screenshot written) and AGENTS_SHARE_BROWSER override is ignored</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Repro (agents-cli 1.22.40, yosemite-s1, Linux): every &#x27;agents artifacts share &lt;file.html &#x27; this session printed &#x27;OG cover capture failed (brave: no screenshot written) - publishing without a preview image. Set AGENTS_SHARE_BROWSER to override.&#x27; and published with NO og:image, so shared links do not unfurl a preview card. Tried the documented override:…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2935/sessions-stamp-the-custom-harness-name-on-runs-launched-via-a-profile">RUSH-2935</a> · Sessions: stamp the custom-harness name on runs launched via a profile (deepseek shows as claude)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>A run of a custom harness (&#x27;agents run deepseek&#x27;, a deepseek teammate, or now a deepseek routine/monitor after RUSH-2930) is recorded everywhere as its HOST agent: exec.ts sets AGENTS_AGENT_NAME to the resolved host (&#x27;claude&#x27;), writePidSessionEntry records agent=&#x27;claude&#x27;, and the session index has no harness/profile column — so &#x27;agents sessions&#x27; cannot distinguish a deepseek…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2942/session-attributed-to-a-ticket-by-transcript-text-alone-then-moves-it">RUSH-2942</a> · Session attributed to a ticket by transcript text alone, then moves it to Doing — RUSH-2858 was mislabelled by a session that only discussed it</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem A session gets attributed to a Linear ticket merely because the identifier appears as text in its transcript — no commit, no branch, no PR required. The attribution then drives real board state. Observed Session 8662c823 was a test-suite cleanup (PRs 2808, 2812, 2814, 2816, 2817, 2819 — all merged, closing RUSH-2838/2839/2840/2843/2862). It never touched balanced…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2985/headless-dispatch-monitoring-has-no-fast-digest-surface-sessions">RUSH-2985</a> · Headless dispatch monitoring has no fast digest surface: sessions preview hangs on fleet fan-out, teams status is teams-only, so operators fall back to devices ps + raw log tails</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Observed 2026-08-20 while supervising agents run --device dispatches (RUSH-2968 fix work). The operator-facing gap: (1) &#x27;agents sessions preview &lt;dispatch-name &#x27; — the surface designed to show the compact digest (recent tools, files, tests, last response) — did not complete within 120s for a live headless dispatch (rush-2968-kimi on yosemite-s0) because id resolution fans out…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3070/agents-run-tell-the-user-when-a-bare-interactive-session-is-not">RUSH-3070</a> · agents run: tell the user when a bare interactive session is not addressable (needs a post-spawn signal)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem With tmux.enabled defaulting to false (RUSH-3066, PR 2942), a lot more interactive runs spawn bare. A bare run on a terminal with no addressable inject rail cannot be reached by agents message , injection, or agents focus — and today nothing tells the user that. It just silently does not work later. An attempt to warn at launch was removed from 2942 because it cannot…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3073/feed-attention-stamp-sourcecursor-at-block-write-time-else-a-new-open">RUSH-3073</a> · feed attention: stamp sourceCursor at block-write time (else a new open block with unresolvable session cursor is suppressed)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up from Track A review (PR 2958, comment https://github.com/phnx-labs/agi-cli/pull/2958 issuecomment-5386611221). coveredByResolution in apps/cli/src/lib/feed/attention.ts defaults to suppress (return true) when a candidate has no comparable sourceCursor.lastActivityMs and its generation differs from the tombstone. Correct conservative anti-resurrection default for a…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3104/stop-feedback-help-dump-leak-60-line-cli-help-precedes-injected-hook">RUSH-3104</a> · Stop-feedback help-dump leak: ~60-line CLI help precedes injected hook messages — attribute the emitter in the live harness path</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Split from RUSH-3032 (its other six items merged in PR 374). Symptom: injected Stop/PreToolUse feedback is preceded by full &#x27;Usage: agents monitors&#x27; (Stop path, observed 3x in session 9b1defee and in f045b577&#x27;s fires) or &#x27;agents browser&#x27;+&#x27;agents computer&#x27; help dumps (PreToolUse path, reproduced 2026-08-22 creating PR 359 whose body named those subcommands). Eliminated with…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3176/releasesh-a-backgrounded-apply-exits-0-having-published-nothing-when">RUSH-3176</a> · release.sh: a backgrounded --apply exits 0 having published nothing when the [y/N] prompt hits EOF</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>What happened apps/cli/scripts/release.sh 1.22.48 --apply was run from a non-interactive shell. It printed Mode: APPLY (real publish) , built the shim, printed the tarball preview — and then exited 0 having done nothing . No attestation, no release branch, no PR, no tag, no publish. npm stayed at 1.22.47. The cause is the confirmation gate at apps/cli/scripts/release.sh:851 :…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3181/tmux-wrap-leaks-into-the-ui-for-users-who-never-opted-into-tmux-status">RUSH-3181</a> · tmux wrap leaks into the UI for users who never opted into tmux — status bar and prefix keys they don&#x27;t know</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Surveyed 2026-08-25. Full survey: .agents/artifacts/2026-08-25/survey-session-recovery.md . Context RUSH-3125 makes every remote interactive agent run inside a tmux pane, because that is what keeps it alive across a dropped link. That is correct for durability, but tmux is now in the path of users who never chose it. What is already handled (do not re-litigate) Existing tmux…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2504/restructure-design-into-an-agi-style-plugin-skill-aliases">RUSH-2504</a> · Restructure design into an agi-style plugin + skill aliases</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Two parts, owner-approved this session but not yet built. (1) Consolidate the 3 competing design front doors (.system plugins/design, ~/.agents/skills/design, create:design) into one; fold in the &#x27;anticipate&#x27; mode + an anti-tells catalog; REPLACE the hardcoded examples/ with a &#x27;browse the web for inspiration&#x27; behavior (use the browser skill to screenshot real sites live). (2)…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2748/merge-guard-parallelize-review-probes-regression-tests-for-the-324">RUSH-2748</a> · merge-guard: parallelize review probes + regression tests for the #324 review fixes</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Fast-follows from PR .agents-system 324 review: (1) two sequential 3s gh api probes can exceed the hook&#x27;s registered timeout:5 - background them in parallel like hooks/session-start/08-inject-repo-inflight (its test asserts worst+margin &lt;= declared); (2) the three review fixes (perl-absent prefix gate, whitespace-tolerant laundering regex, AGENTS.md regeneration) shipped…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2865/browser-sessions-profile-takes-a-runtime-dir-name-not-a-profile-name">RUSH-2865</a> · browser sessions --profile takes a runtime DIR name, not a profile name</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>agents browser sessions --profile comet-local returns nothing for a profile whose captures live under comet-local@endpoint-0 . listBrowserSessions treats its argument as a runtime directory : apps/cli/src/lib/browser/sessions-list.ts:106-109 — if (only) { profiles = [only]; } — while apps/cli/src/commands/browser.ts:2415 advertises it as --profile &lt;name , &#x27;Only this profile…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3063/sessions-trace-content-aware-compare-alignment-lineage-text-truncation">RUSH-3063</a> · sessions trace: content-aware compare alignment + lineage-text truncation cap (post-PR3 follow-ups)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Two non-blocking SHOULDs deferred from the agents sessions trace PRs (all merged: 2923 single, 2926 compare, 2931 lineage): 1. diffTrajectories (apps/cli/src/lib/session/trajectory-compare.ts) aligns steps by TOOL NAME only, so two runs doing the same tools on different content report &#x27;no divergence&#x27;. Make alignment content-aware (include the redacted label/target), or surface…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3071/tmux-a-backslash-in-the-user-config-path-silently-skips-sourcing-it">RUSH-3071</a> · tmux: a backslash in the user config path silently skips sourcing it (source-file glob resolution)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem writeStartupConfig ( apps/cli/src/lib/tmux/session.ts ) generates a tmux config that ends by sourcing the user&#x27;s own tmux.conf , which is what preserves user precedence over agents-cli&#x27;s defaults. The path is emitted through tmuxConfigArgument , which escapes \ , &quot; and $ . That escaping is not sufficient, because source-file resolves its argument as a glob pattern , a…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3086/browser-screenshot-o-path-is-accepted-then-silently-ignored-file-lands">RUSH-3086</a> · browser screenshot: -o &lt;path&gt; is accepted then silently ignored; file lands in the session cache as .jpg</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>agents browser screenshot -o &lt;path accepts the short flag, prints no error, and writes the file to the session cache instead — the path the user named is silently discarded. Observed on zion, comet-local, agents-cli at HEAD: $ agents browser screenshot --task plan-view -o /Users/.../shots/plan-top.png Saved screenshot to /Users/.../sessions/plan-view/1787503561500.jpg (100 KB,…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3087/browser-page-verbs-multi-task-ambiguity-error-lists-url-for-every-task">RUSH-3087</a> · browser page verbs: multi-task ambiguity error lists url=- for every task, so it cannot disambiguate itself</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>When a session owns more than one browser task, every page verb fails with an ambiguity error instead of doing anything, and the error does not say which task is the likely one. $ agents browser navigate --url file://.../plan.html Multiple browser tasks for this session - pass --task &lt;name : untitled id=api-surface url=- age=34m untitled id=plan-view url=- age=19s (exit 1) Two…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3122/sessions-a-label-already-indexed-before-a-derivation-change-is-never">RUSH-3122</a> · sessions: a label already indexed before a derivation change is never re-derived (needs a SCHEMA_VERSION bump to backfill)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Split out of PR 2995, which changed how SessionMeta.label is derived (collapsing a harness-generated ai-title built from a skill&#x27;s injected preamble). The derivation fix is correct for any transcript that gets re-scanned — but already-indexed sessions keep their stored label , so historical rows still show the old value. Mechanism Two layers cache the derived label, and…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3123/sessions-harness-auto-title-parity-cursors-chatmetatitle-bypasses-the">RUSH-3123</a> · sessions: harness auto-title parity — Cursor&#x27;s chatMeta.title bypasses the label cleaner</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Found during review of PR 2995, which cleaned Claude&#x27;s generated ai-title at the label composition point in finalizeClaudeScan ( apps/cli/src/lib/session/discover.ts:3875 ). readCursorMeta ( apps/cli/src/lib/session/discover.ts ~5252) takes Cursor&#x27;s own chatMeta.title verbatim: ts label: title, It is entirely independent of finalizeClaudeScan , so any scaffolding Cursor bakes…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3206/accounts-native-labels-are-device-local-labeling-personal-on-one-box">RUSH-3206</a> · accounts: native labels are device-local — labeling &#x27;personal&#x27; on one box does not select codex#personal on any other</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Discovered in the RUSH-3114/RUSH-3126 sessions: agents accounts label writes the native-account record into the local ~/.agents meta only, so a label set on yosemite-s0 renders nothing in agents view codex on zion and agents run codex personal --device zion cannot resolve until the label is repeated there by hand (which is exactly what the session had to do — label the same…</p>
</article>
</div>
## Daemon / sync / mirrors

<a id="daemon"></a>

3193 covers supervisor. Rest may be subsumed or real. Proposed: **review**. 19 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2371/auto-sync-the-reserved-auth-bundle-across-the-fleet-setup-tokens-drift">RUSH-2371</a> · Auto-sync the reserved &#x27;auth&#x27; bundle across the fleet (setup-tokens drift per-box; mac-mini had 0, yosemite-s1 had 6)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle -</span></p>
  <p>Surfaced while seeding a Claude setup-token (PR 2306 follow-through). The reserved file-based auth bundle (setup-tokens) is supposed to be &quot;the one thing that crosses the fleet&quot; (docs/design/credential-management.md), but in practice it drifts badly per-box because sync is manual. Observed 2026-08-07: yosemite-s1 auth bundle: 6 accounts seeded (dev@example.com,…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2405/hooks-first-class-enabledisable-for-promptcuts-and-bangcuts">RUSH-2405</a> · Hooks: first-class enable/disable for promptcuts and bangcuts</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Add agents hooks enable|disable for friendly promptcuts and bangcuts names, show effective enabled/disabled state in hooks list, enable both system hooks by default, sync installed harnesses after changes, and document the reversible control surface.</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2955/agents-sync-no-agentspec-reports-plugins-synced-but-never-refreshes">RUSH-2955</a> · agents sync (no agentSpec) reports plugins synced but never refreshes per-version marketplace copies — skill fixes stay dead fleet-wide</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem agents sync (no agentSpec) prints Synced: commands, skills, hooks, memory, permissions, plugins but does not refresh the per-version plugin marketplace copies. A skill edit that has landed on origin/main and been pulled into ~/.agents/.system stays invisible to every agent until someone runs agents sync &lt;agent @&lt;version for each version individually. Repro (2026-08-20,…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3113/cli-suite-drift-sync-apply-path-and-self-heal-isolated-home-test-fail">RUSH-3113</a> · CLI suite: drift-sync apply path and self-heal isolated-home test fail on main (all non-Windows CI legs)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Two apps/cli test files fail on main on every non-Windows CI matrix leg (ubuntu 22/24, macOS 22/24). Windows passes. FAIL src/lib/drift-sync.test.ts promptDriftSync --yes — apply path overwrites a drifted resource with its source and installs a missing one FAIL src/lib/self-heal/self-heal.integration.test.ts runSelfHeal — resources never sync into isolated homes heals the…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2010/browser-phase-2-targets-host-ssh-endpoint-provider-wss-cloud">RUSH-2010</a> · browser Phase 2: targets — --host ssh endpoint + --provider / wss cloud</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Part of the agents browser rework (see parent epic). Phase 2 — targets. Reuses the daemon&#x27;s existing endpoint-scheme dispatch. Goal Drive local, remote, and cloud browsers on one axis — no bespoke per-host ssh:// profile. Build --host &lt;device — synthesize an ssh:// endpoint from the device registry ( resolveDeviceTarget → sshTargetFor ); no hand-built profile. remoteControl:…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2456/sync-prune-extend-to-hooks-with-windows-portable-paths-split-from-rush">RUSH-2456</a> · sync prune: extend to hooks with Windows-portable paths (split from RUSH-2438)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Split from RUSH-2438. That PR ( 2429) landed commands+skills prune; hooks-prune was scoped OUT because it edits apps/cli/src/lib/hooks.ts, which flips the CI windows gate on (ci-scope.ts:29 isWindowsSensitive), and the hooks-prune code + its gap-2 settings.json GC were not Windows-path-portable: prune.test.ts &#x27;(hook) prunes a hook deleted from source&#x27; failed with &#x27;expected []…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2483/fail-loud-when-a-boxs-dotagents-mirror-stops-updating">RUSH-2483</a> · Fail loud when a box&#x27;s DotAgents mirror stops updating</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Split out of RUSH-2467, which fixed the blocking half (agents-cli 550ab3e4 / 2475: a dirty tree now fast-forwards when that is provably safe instead of refusing outright). This is the half that PR does not touch. A mirror can still stop receiving updates — a genuine path collision, local commits needing a rebase, or a box-specific git fault — and nothing anywhere says so. You…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2636/agents-daemon-can-hang-alive-but-frozen-after-laptop-sleepwake-and">RUSH-2636</a> · agents daemon can hang alive-but-frozen after laptop sleep/wake and never self-restart (wedged ~51h)</h3>
  <p><span class="artifact-tag">Doing</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Summary The agents scheduler daemon (launchd com.phnx-labs.agents-daemon ) can hang alive-but-frozen after a laptop sleep/wake cycle and stay dead indefinitely, because nothing external restarts it. Observed on a macOS laptop where the daemon was wedged for \~51 hours — its scheduled jobs ( check-updates , pr-merge-on-green monitor, internal cache-warm/device-probe/watchdog)…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2637/daemon-monitors-add-auto-starts-the-daemon-on-a-box-where">RUSH-2637</a> · daemon: &#x27;monitors add&#x27; auto-starts the daemon on a box where devices.&lt;name&gt;.daemon=false</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>agents monitors add started the daemon on yosemite-s0 even though agents config get devices.yosemite-s0.daemon reads false . The documented contract (apps/cli/AGENTS.md, daemon.enabled) says the kill switch is top-level: nothing auto-starts the daemon while it is set, explicitly including routines add / routines start / routines catchup /webhook triggers. monitors add is not…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2698/every-staleness-writer-that-can-decline-should-report-it-not-just-mcp">RUSH-2698</a> · Every staleness writer that can decline should report it, not just mcp</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>RUSH-2677 (PR 2685) added an error channel to WriteResult ( apps/cli/src/lib/staleness/writers/types.ts ) and a declined: string[] field to SyncResult , so agents sync prints a Not written to &lt;agent @&lt;version : block and --json reports ok: false . Only the mcp writer populates it. Every other writer ( commands , skills , hooks , rules , permissions , subagents , plugins ,…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2741/menubar-self-heal-bootstraps-a-real-launchd-job-under-a-redirected">RUSH-2741</a> · menubar self-heal bootstraps a real launchd job under a redirected HOME (sandbox/version home)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem On darwin, apps/cli/src/bootstrap.ts:1277-1285 runs the menu-bar self-heal on every CLI invocation unless AGENTS_SKIP_MIGRATION=1 : ts if ( process.platform === &#x27;darwin&#x27; &amp;&amp; process.env.AGENTS_SKIP_MIGRATION !== &#x27;1&#x27; &amp;&amp; !helpOrVersionRequested ) { const { installMenubarLaunchAgentOnUpgrade } = await import(&#x27;./lib/menubar/install-menubar.js&#x27;);…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2746/refactor-appscli-move-2a-unify-exectsrunnerts-launch-planning-core">RUSH-2746</a> · Refactor apps/cli: Move 2a (unify exec.ts/runner.ts launch planning) + core-domain decision</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up to RUSH-2708 after 9 moves landed (cycle break, registry routing, terminal extract; Move-3 domains accounting/plugins/feed/installations/scheduling/daemon — all merged + composed-verified on main). REMAINING: 1. Move 2a — fold runner.ts&#x27;s per-harness mode/argv table (runner.ts:585-676) into the exec.ts launch planner so there is ONE launch planner (resolves the C1…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3072/test-harness-testssetupts-sandboxes-home-but-not-path-so-a-test-can">RUSH-3072</a> · test harness: tests/setup.ts sandboxes HOME but not PATH, so a test can spawn the developer&#x27;s browser</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem apps/cli/tests/setup.ts sandboxes HOME , the events path, and the daemon dir, but not PATH . So a unit test that reaches a real spawn / spawnSync of a system binary silently runs it against the developer&#x27;s machine. This is not hypothetical — it shipped and was caught only in review. A test in src/lib/open-url.test.ts drove the non-injected viewer path, which on macOS…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3075/monitor-notify-action-fails-under-the-daemon-path-lacks-rushbin">RUSH-3075</a> · Monitor notify action fails under the daemon (PATH lacks ~/.rush/bin) — watcher polls forever, never delivers</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>A monitor&#x27;s notify action fails under the daemon while the same notify succeeds from a shell, so the monitor detects changes and silently never delivers. Reproduced on yosemite-s1, 2026-08-23: $ command -v rush /home/user/.rush/bin/rush $ agents notify --text &quot;monitor wiring test&quot; --dry-run --json {&quot;ok&quot;:true,&quot;channel&quot;:&quot;imessage&quot;,&quot;id&quot;:&quot;+1...&quot;,&quot;text&quot;:&quot;monitor wiring…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3210/interactive-tty-browser-for-agents-daemon-services-rush-3193-p4-follow">RUSH-3210</a> · Interactive TTY browser for agents daemon services (RUSH-3193 P4 follow-up)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up to RUSH-3193 4 (PR phnx-labs/agi-cli 3051), deferred out of that PR per its explicit scope allowance. agents daemon services currently renders a plain table + --json . Add a TTY-only interactive browser reusing dynamicPicker (cli/src/lib/picker.ts — the same infra agents sessions uses, see cli/src/commands/sessions-browser.ts): One row per registered daemon service…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2592/runnertestts-routine-replacement-test-is-flaky-expected-running-to-be">RUSH-2592</a> · runner.test.ts routine-replacement test is flaky (&#x27;expected running to be skipped&#x27;)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>src/lib/runner.test.ts command-mode routines (executeJobDetached — daemon/cron path) &quot;a replacement while a failed record still owns a live process is skipped, linking the live run&quot; failed once in CI on PR 2646: AssertionError: expected &#x27;running&#x27; to be &#x27;skipped&#x27; It is a flake, not a diff-caused failure. Established during the PR 2646 non-author review: PR 2646 touches no…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2734/sync-hook-registration-runs-twice-per-agent-after-pr-2720-idempotent">RUSH-2734</a> · sync: hook registration runs twice per agent after PR #2720 (idempotent but redundant)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>PR 2720 made syncResourcesToVersion register hooks for every hooks-capable agent (apps/cli/src/lib/versions.ts hooks branch), required for the per-agent sync spellings — but the umbrella flows still carry their own registration loops (refresh.ts step 4, commands/sync.ts runInteractiveReconcile + runUmbrella loop), so a full &#x27;agents sync&#x27; now calls registerHooksToSettings twice…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2742/scrub-watchdog-references-from-shipped-agents-system-skillsrules">RUSH-2742</a> · Scrub watchdog references from shipped .agents-system skills/rules (watchdog kept disabled)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Follow-up to RUSH-2723 (Canceled — watchdog kept DISABLED, not fixed). Muqsit&#x27;s fleet now has a user-level rule (muqsitnawaz/.agents PR 273) overriding system guidance so agents never enable/build/recommend the watchdog. But the SHIPPED phnx-labs/.agents-system repo (all agents-cli users) still points agents at it, now stale/contradictory: (1) skills/monitors/SKILL.md:29 row…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3084/releasesh-a-stuck-bump-pr-lets-a-later-release-re-drain-changelognext">RUSH-3084</a> · release.sh: a stuck bump PR lets a later release re-drain .changelog/next (cross-version)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Follow-up from PR 2966 (RUSH-2395 decouple). The decoupled release merges the version-bump PR asynchronously/best-effort after publish. If that merge fails (e.g. a real CHANGELOG conflict needing a human) the bump PR for v1.2.3 stays open and .changelog/next/ remains populated on origin/main (the fold only landed inside the unmerged release-branch commit). If a DIFFERENT later…</p>
</article>
</div>
## Accounts / usage / auth

<a id="accounts"></a>

3182 is the keep. Rest may duplicate usage session 01a03867. Proposed: **review**. 22 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2364/agents-auth-mint-first-class-setup-token-mintseed-command-close-the">RUSH-2364</a> · agents auth mint: first-class setup-token mint+seed command (close the mint-auth manual-recipe gap)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle -</span></p>
  <p>Context: PR 2306 stopped the usage/auth-health probe from reading the interactive Claude login (fixes the token revocations). The tradeoff is that an account with no minted setup-token shows &quot;usage pending&quot; until seeded. Today, minting + seeding that token is a manual agent recipe ( ~/.agents/.system/plugins/fleet/commands/mint-auth.md ), not a command — that&#x27;s the friction to…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2685/dispatch-dies-on-a-logged-out-default-version-version-selection">RUSH-2685</a> · dispatch dies on a logged-out default version — version selection ignores per-device auth state</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Symptom Dispatching a teammate to a worker box kills it in ~1 second with no tool calls and no useful error. Two agents teams teammates died instantly on yosemite-m0 today; re-pinning them to yosemite-s0 fixed it with no other change. What is actually true, per box agents view claude , counted read-only across the fleet (2026-08-15): | Box | versions | logged out | authed | |…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2738/routines-release-1-22-40-routine-fired-on-3-devices-at-once-the">RUSH-2738</a> · routines: release-1-22-40 routine fired on 3 devices at once; the sibling&#x27;s release.sh force-rebuilt release/v1.22.40 and dropped a fix commit</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>What happened The release-1-22-40-balanced-watch routine fired at 2026-08-15T11:50:00Z and spawned the same release task on at least three devices at once , each with an identical prompt (&quot;Own agents-cli v1.22.40 through shipped verification … then run apps/cli/scripts/release.sh 1.22.40 --apply --device mac-mini --yes&quot;): yosemite-s0 pid 1238528, session dc20f1bd yosemite-s1…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2842/agents-monitors-dispatched-agents-have-no-gh-auth-so-merge-on-green">RUSH-2842</a> · agents monitors: dispatched agents have no gh auth, so merge-on-green monitors fire ok and never merge</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>An agent dispatched by agents monitors --run claude inherits an environment with no authenticated gh , so every merge-on-green monitor is decorative: it fires, the agent cannot reach the GitHub API, and the PR is never merged. The monitor&#x27;s own bookkeeping still records the fire as ok , so nothing surfaces the failure. Observed Monitor merge-pr-1682 (poll - match READY - --run…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2939/accounts-add-promises-policy-never-no-touch-id-but-stores-the-keychain">RUSH-2939</a> · accounts add promises &#x27;policy never — no Touch ID&#x27; but stores the keychain item WITH the biometry ACL: headless --account launches fail on macOS</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>agents accounts add claude-dev-getrush --provider anthropic --auth setup-token --from-secrets auth:... printed: &#x27;Secret bundle claude-dev-getrush is the account and uses policy never, so agent launches never request Touch ID.&#x27; But a headless &#x27;agents run claude --account claude-dev-getrush --mode plan&#x27; fails with: Keychain item &#x27;agents-cli.secrets.claude-dev-getrush.TOKEN&#x27;…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2944/merge-guard-false-positives-on-carried-over-from-in-innocent-review">RUSH-2944</a> · merge-guard false-positives on &#x27;carried over from&#x27; in innocent review prose, blocking legitimate merges</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem merge-guard.sh blocks a legitimate merge when a genuine non-author APPROVE verdict happens to contain the phrase &quot;carried over from&quot; in innocent prose. The anti-laundering filter at rules/subrules/gh-merge-guard/merge-guard.sh:220 : python if re.search(r&quot;\bcarried\s+(?:over\s+)?from\b|\bAPPROVE\s+(?:on|from)\s+ \d+&quot;, body): continue exists to reject a verdict imported…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3196/cursor-view-trusts-stale-identity-while-cursor-cli-is-unauthenticated">RUSH-3196</a> · Cursor view trusts stale identity while Cursor CLI is unauthenticated; restore real usage collection</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Live Zion proof on 2026-08-25: agents view cursor --refresh reports signedIn=true from .cursor/cli-config.json authInfo, then fails with No readable Cursor credential because .config/cursor/auth.json is absent. The exact current Cursor 2026.08.04 binary in that version home reports status=unauthenticated, hasAccessToken=false, hasRefreshToken=false. Fix auth truth at the…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3197/grok-usage-ignores-current-exhaustion-and-can-only-reread-expired">RUSH-3197</a> · Grok usage ignores current exhaustion and can only reread expired billing logs</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Live Zion proof on 2026-08-25: both Grok rows have real historical weekly meters (29% ending Aug 16; 35% ending Aug 20), correctly dropped as expired. Collector is network:false and only reads unified.jsonl. A later current log for one account explicitly records HTTP 402 Payment Required: Grok Build usage balance exhausted, but agents view renders only the plan and no…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2365/reserve-the-auth-secrets-bundle-in-code-sec-gap-3-keychain-backed-auth">RUSH-2365</a> · Reserve the &#x27;auth&#x27; secrets bundle in code (SEC-GAP-3): keychain-backed auth silently ignored</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle -</span></p>
  <p>Bug / spec-drift (SEC-GAP-3, already open in the spec). Surfaced while working PR 2306 (the setup-token path). resolveClaudeSetupToken ( apps/cli/src/lib/claude-account-token.ts:98 ) requires the auth bundle to be file-backed : if (bundleBackend(AUTH_BUNDLE) !== &#x27;file&#x27;) return null . If a user accidentally creates a keychain-backed auth bundle, the setup-token is silently…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2445/share-no-server-side-access-log-cannot-answer-was-it-fetched-after-an">RUSH-2445</a> · share: no server-side access log — cannot answer &#x27;was it fetched?&#x27; after an accidental publish</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>When a page is published to a public URL by mistake, the first question is &quot;did anyone fetch it?&quot; — and today the CLI cannot answer it. During the RUSH-2428 incident a page carrying account emails was public for ~8 minutes. agents share status reported: analytics not configured so there were no access logs to consult. The honest answer to the owner had to be &quot;I cannot tell you…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2785/plans-render-architecture-as-a-table-figure-gate-was-document-scoped">RUSH-2785</a> · Plans render architecture as a table: figure gate was document-scoped and both plan templates omitted the section</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem Agent-authored plans render Current architecture as a row-per-module table. A table lists the parts and drops every relationship between them — which module calls which, where a contract is duplicated, what the change moves — which is the whole reason a reviewer opens that section. Two causes, both mechanical: | Layer | Gap | | -- | -- | | artifacts-cli…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2869/agents-run-balanced-rotation-ignores-the-plan-tier-account-cap">RUSH-2869</a> · agents run balanced rotation ignores the plan-tier account cap (rotate.ts)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up from PR 2822 (RUSH-2424) non-author review. collectRunCandidates (apps/cli/src/lib/accounting/rotate.ts:706) iterates listInstalledVersions(agent) directly and has no reference to entitlement.ts / accountsForHarness / any cap. The RUSH-2424 account cap only counts and restricts NAMED accounts (accounts add / accounts name), which gate accounts switch/set-default and…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2954/follow-ups-from-rush-2860-statets-ignores-agents-user-dir-assert-has">RUSH-2954</a> · Follow-ups from RUSH-2860: state.ts ignores AGENTS_USER_DIR, assert has no runner-path test, Windows no-op</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Two follow-ups split out of PR 2848 (RUSH-2860) so the gh-auth fix could ship narrowly. Both were raised by the non-author reviewer on that PR. 1. Sandboxed nested agents CLI reports &quot;agents-cli is not set up&quot; A sandboxed routine/monitor child that shells out to agents prints agents-cli is not set up. Run: agents setup , because the overlay HOME has no .agents . Root cause,…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2960/dead-code-merged-by-pr-2850-agents-internal-mergeable-prs-and">RUSH-2960</a> · Dead code merged by PR #2850: agents _internal mergeable-prs and lib/github/* have no callers, and duplicate the merge-guard verdict rule</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up from the non-author review of PR 2850 (https://github.com/phnx-labs/agi-cli/pull/2850 issuecomment-5364667270), which merged before the review landed. This is the residual debt only; the RUSH-2848 defect itself stays on that ticket. 1. No callers PR 2850 added: apps/cli/src/lib/github/pr-mergeable.ts (190 lines) apps/cli/src/lib/github/pr-verdict.ts (107 lines) the…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3052/agi-cli-web-sweep-site-wide-open-source-branding-blog-vs-pages-seo">RUSH-3052</a> · agi-cli-web: sweep site-wide &#x27;open source&#x27; branding (blog, /vs pages, SEO meta) for FSL accuracy</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>PR 55 fixed the in-diff &#x27;Open source&#x27; label to &#x27;Source-available&#x27; (app/page.tsx:596) and corrected the FAQ/jsonld/CHANGELOG license summaries. The non-author review flagged, and deliberately left, the site&#x27;s pervasive &#x27;open source&#x27; branding elsewhere (vs/ comparison pages, blog posts, SEO meta descriptions) — FSL-1.1-Apache-2.0 is fair-source/source-available, not OSI open…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3055/phoenix-id-consent-screen-shows-the-supabase-host-not-phoenix-needs">RUSH-3055</a> · phoenix-id: consent screen shows the Supabase host, not Phoenix (needs OAuth verification)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem The Google consent screen reads: Sign in to scwdzslajfmlzojqqxru.supabase.co not &quot;Phoenix&quot;. Users approving a Phoenix login see a random Supabase project host, which looks like a phishing page. Cause Google shows the OAuth redirect host for unverified apps. The consent screen&#x27;s app name is set to &quot;Phoenix&quot; (verified in the console 2026-08-23), but that branding does…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3068/ext-releasesh-pre-tag-sends-the-already-suffixed-version-to-the">RUSH-3068</a> · ext release.sh: --pre &lt;tag&gt; sends the already-suffixed version to the publish host, failing the remote X.Y.Z regex</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Found by the non-author reviewer on PR 2941 (RUSH-2987) and confirmed by isolating and running the exact heredoc construction. Pre-existing, untouched by that diff, not blocking a plain release. route_to_publish_host in apps/ext/scripts/release.sh hand-rebuilds the remote invocation. It passes $VERSION — which already carries the -&lt;tag suffix when --pre was given — as the…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3198/kimi-expired-usage-state-should-say-run-kimi-once-expose-refresh">RUSH-3198</a> · Kimi expired usage state should say run Kimi once; expose refresh result deterministically</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Live Zion proof on 2026-08-25: Kimi 0.32.0 credential was expired and agents view kimi --refresh rendered re-auth for usage. A minimal normal Kimi run refreshed its own credential safely; the next real GET https://api.kimi.com/coding/v1/usages returned Standard, 23% used, reset Aug 30, and agents view rendered W:23%. Keep refresh ownership in Kimi (agents view must not rotate…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2578/agents-accounts-addinspect-crash-with-uncaught-node-exception-on">RUSH-2578</a> · agents accounts add/inspect crash with uncaught Node exception on missing/locked bundle</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Summary agents accounts add --from-secrets &lt;bundle and agents accounts inspect &lt;name crash with an uncaught Node exception (raw throw , Node.js vXX stack dump) instead of a clean CLI error, when the referenced bundle/account is missing or a keychain bundle is not unlocked in the secrets agent. Repro agents accounts add x --provider openrouter --auth api-key --from-secrets…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3030/phoenix-id-consolidation-link-products-by-google-sub-when-user-overlap">RUSH-3030</a> · Phoenix ID consolidation: link products by Google sub when user overlap is real</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Successor to RUSH-2581&#x27;s own-backend phase. When Phoenix-family products have overlapping users, consolidate identities under a top-level Phoenix ID (Apple-ID style): Users re-auth once via Google against the unified project — NO cross-project Supabase auth-row copying (unsupported; id-preserving copies are manual Postgres surgery). The Google sub is the deterministic join;…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3083/browser-profiles-rename-dual-store-error-names-an-escape-that-hard">RUSH-3083</a> · browser profiles rename: dual-store error names an escape that hard-fails for auto-chrome/default</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Follow-up to PR 2962 (non-blocking finding from the non-author re-review of 87de50465). What renameProfile refuses a name present in BOTH the local and fleet stores, and its error tells the user to collapse the duplicate first: agents browser profiles scope &lt;name fleet That is correct for ordinary profiles. It hard-fails for the two machine-local names, auto-chrome and default…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3120/devices-devices-rm-name-leaves-the-boxs-row-in-fleet-statsjson-so-a">RUSH-3120</a> · devices: &#x27;devices rm &lt;name&gt;&#x27; leaves the box&#x27;s row in .fleet-stats.json, so a reused device name can inherit the old hardware&#x27;s spec</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Non-blocking finding from the non-author review of PR 3001 (RUSH-3096): https://github.com/phnx-labs/agi-cli/pull/3001 issuecomment-5391176374 Problem agents devices rm &lt;name removes the device from the registry but never purges its entry from the stats cache ( ~/.agents/.cache/.fleet-stats.json ). writeStatsCache merges by device NAME, and nothing ever evicts a row. Before…</p>
</article>
</div>
## CI / release / tests

<a id="ci"></a>

3100/3034 already canceled. Rest is flaky CI, leases, Windows. Proposed: **review**. 25 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2404/agents-view-show-an-installations-current-release-after-update">RUSH-2404</a> · agents view: show an installation&#x27;s current release after update</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>After agents update claude@&lt;old-label installs a newer Claude release, agents view still renders the frozen installation label as the version. Render installation.releaseVersion as the user-facing version while keeping the stable label for routing and allowing multiple account installations on the same release. Add a regression test and update user-facing docs/CHANGELOG.</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2576/releasesh-stuck-guard-deadlocks-again-at-phnx-catchup-once-main">RUSH-2576</a> · release.sh stuck-guard deadlocks again at phnx-catchup once main carries the new version</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Observed live on 2026-08-10 while releasing 1.22.37. PR 2628 added a patch-from-main exemption to the stuck-tag guard so a release could step over the permanently-unpublishable v1.22.36. That worked — 1.22.37 got merged and tagged. But once main carries 1.22.37, a retry of the publish resolves the bump as phnx-catchup (target == the version main already carries), NOT…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2736/ci-the-windows-gate-is-a-path-allowlist-so-platform-divergent-tests">RUSH-2736</a> · CI: the Windows gate is a path allowlist, so platform-divergent tests break main invisibly</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>The defect isWindowsSensitive ( scripts/ci-scope.ts:28-36 ) decides whether the required windows job runs, using a path allowlist : ts function isWindowsSensitive(file: string): boolean { return file === &#x27;apps/cli/src/lib/hooks.ts&#x27; || file.startsWith(&#x27;apps/cli/src/lib/hooks/&#x27;) || file.startsWith(&#x27;apps/cli/src/lib/platform/&#x27;) || /^apps\/cli\/src\/lib\/shims[^/]…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2759/release-lease-discovery-is-root-relative-so-it-misses-agents-clis-own">RUSH-2759</a> · Release lease discovery is root-relative, so it misses agents-cli&#x27;s own lease and green-lights a concurrent release</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>The defect The release skill&#x27;s Phase 1.0 ( plugins/code/skills/release/SKILL.md in phnx-labs/.agents-system ) tells agents to discover whether a repo serializes releases with a lease by running: bash grep -rl &#x27;release-lease&#x27; scripts/ 2 /dev/null a lease = already serialized That path is repo-root-relative . On agents-cli — the monorepo this entire rule was written about —…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2760/pretooluse-guards-match-forbidden-commands-inside-quoted-argument-text">RUSH-2760</a> · PreToolUse guards match forbidden commands inside quoted argument text, blocking prose about them</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>What Several PreToolUse guards decide whether to block by substring-matching the command string. They cannot tell a command being INVOKED from the same characters appearing inside a quoted argument — a prompt body, a heredoc, a commit message, a ticket comment. So writing about a forbidden operation is blocked as if you were performing it. This is a different mechanism from…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2764/stop-gate-intent-detection-tier-0-preconditions-stop-intentpy">RUSH-2764</a> · Stop-gate intent detection: Tier 0 preconditions + stop-intent.py, replacing the prose-regex classifier</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Why Stop-gate intent detection is ~165 prose regexes across two files, and it is inconsistent with the rest of the repo: every PreToolUse guard decides from structured state, while the Stop gates pattern-match the agent&#x27;s final message. Demonstrated failure: re-running no-permission-stop-guard.sh &#x27;s classifier over four real messages returned ACT/block on all four, including…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3033/confidential-gtm-strategy-leaked-to-public-repo-r2-exposure">RUSH-3033</a> · Confidential GTM strategy leaked to PUBLIC repo + R2 — exposure remediation (history purge outstanding)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Incident: the agi-cli GTM/monetization strategy (real revenue figures, the &quot;~no users&quot; assessment, competitor intel, pricing model, launch plan) was committed to .agents/artifacts/ — PUBLIC on the OSS repo — and published to public R2 share links. Public for ~2 days (since ~2026-08-20). REMEDIATED: 18 public R2 shares deleted (gtm-strategy, pricing-models, byo-subscription…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2729/artifacts-cli-four-commits-landed-directly-on-main-bypassing-the">RUSH-2729</a> · artifacts-cli: four commits landed directly on main, bypassing the worktree+PR rule</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Noticed while verifying today&#x27;s releases on phnx-labs/artifacts-cli. Four commits have a single parent and no merge commit — they were pushed straight to main rather than through a worktree + PR: 8a30933 fix(worksheet): parse CRLF field fences 2d9a3b6 fix: retain worksheet touch confirmation f1852b1 fix(worksheet): compute dirty state from baseline 42c16af fix: align chart…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2747/monitors-view-json-recentfires-and-runs-lack-reconciled-machine">RUSH-2747</a> · monitors: view --json recentFires and runs lack reconciled machine-readable output</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up to RUSH-2690 / agi-cli PR 2748: render-time reconciliation fixed the human-readable runs/view text, but &#x27;agents monitors view --json&#x27; recentFires still returns the frozen fire-time ok, and &#x27;agents monitors runs&#x27; has no --json at all - the only machine-readable surfaces still show the stale value. Route both through resolveFireOutcome.</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2762/conflict-marker-gate-is-inert-without-corehookspath-install-it-fleet">RUSH-2762</a> · Conflict-marker gate is inert without core.hooksPath - install it fleet-wide or move it into CI</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>What The pre-commit conflict-marker gate landed in 328 and 330 only fires on a checkout that has run core.hooksPath . Nothing in the repo installs it — the instruction exists solely as a comment at .githooks/pre-commit:3 — and there is no CI workflow. So on most boxes the gate is inert, and the defect it exists to stop (raw merge-conflict markers committed into CHANGELOG.md,…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2765/collapse-the-stop-gate-option-menus-to-one-option-and-recall-forgotten">RUSH-2765</a> · Collapse the Stop-gate option menus to one option, and recall forgotten tools by absence</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Why Three Stop gates (PRGATE, TASKGATE, HBGATE in 00-agent-verify-work-complete.sh ) print their entire fixed option set every time they fire — &quot;do ONE of: 1. 2. 3. 4.&quot; — regardless of which circumstance triggered them. That menu is the hook admitting it does not know which option applies, so it offloads the triage onto the agent. The repo already contains the better pattern…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2788/required-check-10s-cache-hit-budget-is-unreachable-on-ubuntu-latest">RUSH-2788</a> · Required-check 10s cache-hit budget is unreachable on ubuntu-latest: checkout+setup-bun alone cost 15-18s</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>The RUSH-2666 acceptance bar sets a 10s cache-hit budget for the required check ( scripts/ci-bench/types.ts : CI_CACHE_HIT_BUDGET_MS = 10_000 ). Measured on origin/main 9edeab0d1 , that budget cannot be met on ubuntu-latest regardless of how well impact mapping works. Evidence — run 32024813145 is a true cache hit: step Selected proof conclusion = skipped (exact-tree proof…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2817/memory-notes-are-pinned-to-one-harness-version-dir-invisible-to-every">RUSH-2817</a> · Memory notes are pinned to one harness version dir — invisible to every other version</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Memory files live under ~/.agents/.history/versions/claude/&lt;VERSION /home/.claude/projects/&lt;project /memory/. A note written on 2.1.207 (cowriting-social-posts.md) was not loaded on 2.1.186 in the same project — the memory dir there was empty. Any lesson saved as memory silently vanishes on harness upgrade. Found in session db8329e1 (svatlas, 2026-08-20) during a /learn pass;…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2927/test-suite-has-three-competing-homes-and-one-shared-fixture-18-modules">RUSH-2927</a> · Test suite has three competing homes and one shared fixture: 18 modules split, active.ts alone has 17 test files and 11 copies of the same fixture</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem The test suite has three competing homes and no rule picking between them, so nobody edits an existing test file — they add a new one. That is the mechanism behind 216,863 lines of tests. Measured on 2026-08-20 ( apps/cli + apps/ext ): | Measure | Value | | -- | -- | | Test files | 1,037 | | Test LOC / source LOC | 216,863 / 346,722 | | Homes in use | 3 — 845 colocated…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2943/release-attestation-produce-computer-mac-input-changed-advice-is-a">RUSH-2943</a> · release-attestation-produce: computer-mac &#x27;input changed&#x27; advice is a dead loop — nothing records the new digest</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Hit live during the 1.22.43 release (2026-08-21). When the computer-mac input digest drifts, release-attestation-produce.sh dies with &#x27;run agents secrets exec apple.com -- scripts/publish-computer-helper-mac.sh ... then re-run this producer so the new digest is recorded&#x27; (release-attestation-produce.sh:246). But publish-computer-helper-mac.sh never writes release-manifest.json…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3029/ship-the-signed-agents-binary-as-a-per-release-github-asset-gh-actions">RUSH-3029</a> · Ship the signed agents binary as a per-release GitHub asset + GH Actions publish job (RUSH-3026 slice 2)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up to RUSH-3026 (PRs 2887/ 2889). The npm tarball no longer carries dist/bin/agents, so macOS installs currently fall back to the JS entrypoint — the 315 EDR mitigation is paused. Restore it the computer-mac way: sign-cli-binary.sh output uploaded as a v&lt;version GitHub release asset, postinstall downloads + verifies it on macOS. Then add a GH Actions publish job…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3041/scripts-add-device-to-testshbuildsh-so-tests-can-run-on-any-fleet-box">RUSH-3041</a> · scripts: add --device to test.sh/build.sh so tests can run on any fleet box, not just the crabbox</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>scripts/release.sh already routes its privileged phase to a named machine with --device &lt;name (alias --host , release.sh:114-140 , dispatched via agents ssh ). Nothing else does: | Script | --device | Where work runs | | -- | -- | -- | | scripts/release.sh | yes | named box, default mac-mini | | scripts/build.sh | no (zero occurrences of device ) | always local | |…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3093/docs-published-command-reference-goes-stale-release-regenerates-it-but">RUSH-3093</a> · docs: published command reference goes stale — release regenerates it but never republishes</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem The published agents CLI command reference on share.agents-cli.sh is a snapshot artifact that nobody refreshes. It is currently stale and actively misleading: it lists agents unshare &lt;targets... as a top-level command, which was retired in PR 2863 (RUSH-2989). The installed CLI disagrees with the published reference: $ agents --version 1.22.46 $ agents unshare --help…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3118/merge-guard-pr-verdictpy-reads-a-refusal-and-a-code-sample-as">RUSH-3118</a> · merge-guard: pr-verdict.py reads a refusal and a code sample as approvals — no negation guard, no code-fence stripping</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem pr-verdict.py decides a PR is merge-clearing by matching a bare verdict token anywhere in a review or comment body. It has no notion of whether the body is using the word or talking about it. Three distinct failures fall out of that one root cause: 1. Negation is not understood. An explicit refusal clears the gate. Probed against fix-approved-verdict-regex (PR 382): |…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3200/ci-scope-rename-aware-impact-analysis-a-pure-git-mv-must-not-select">RUSH-3200</a> · ci-scope: rename-aware impact analysis — a pure git mv must not select cli-full</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Surfaced by the flatten PR ( 3033): the selector reads changed files as names only, so a 100% rename of the whole tree classified ~2100 files as changed and selected suite=cli-full plus tripped zero-selection for 19 pre-existing test-less scripts (exempted per-file in 3033). Fix at the source: feed the selector rename-aware status (git diff --find-renames --name-status) and…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2543/test-suite-spawns-real-agent-runs-testssetupts-does-not-pin-agents">RUSH-2543</a> · Test suite spawns real agent runs: tests/setup.ts does not pin AGENTS_WEBHOOKS_DIR</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle 26</span></p>
  <p>bun run test in apps/cli spawns real agents run claude jobs against a production Linear ticket. Every suite run, every worktree, every box. This is the source of the RUSH-1459 re-fire loop (13 duplicate planning dispatches on a Done ticket; see that thread for the process-tree evidence). Root cause apps/cli/tests/setup.ts is the fork-hermeticity file. It pins…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2575/live-capacity-aware-device-routing-for-device-auto-salvage-capacityts">RUSH-2575</a> · Live-capacity-aware device routing for --device auto (salvage capacity.ts from auto-host-dispatch)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Idea (salvaged from a stranded branch before pruning) --device auto / smart-launch.ts on origin/main today picks a device from launch affinity (14-day history) only. It has two known holes, both called out in CLAUDE.md (&quot;Distribute Teams Across Devices&quot; — &quot;the built-in scheduler&#x27;s least-loaded counts pool teammates , NOT real CPU/mem utilization ... True utilization-aware…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2786/share-labelmeta-headers-are-latin1-only-so-a-non-ascii-title-publishes">RUSH-2786</a> · share: label/meta headers are latin1-only, so a non-ASCII title publishes as (unnamed)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Problem publishToEndpoint puts free text straight into HTTP headers — x-share-label , x-share-repo , x-share-host , x-share-meta . fetch encodes header values as a ByteString , so any code point above 255 throws: TypeError: Cannot convert argument to a ByteString because the character at index 89 has a value of 8230 which is greater than 255. at async put…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3043/typests-mode-docblock-still-asserts-the-uniform-smart-classifier-claim">RUSH-3043</a> · types.ts Mode docblock still asserts the uniform smart-classifier claim (deferred from RUSH-3040 for CI budget)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>apps/cli/src/lib/types.ts carries the Mode docblock: auto smart classifier auto-approves safe operations, prompts for risky ones That is false for codex ( approval_policy=never , never prompts) and for muse ( --disable-approval , never prompts) since agents-cli 2908. It is the last place still asserting the uniform smart-classifier claim; every user-visible surface was…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3190/sandboxsh-post-file-remote-path-breaks-on-a-filename-with-a-space-same">RUSH-3190</a> · sandbox.sh: --post-file remote path breaks on a filename with a space (same arg-splicing class as RUSH-3178)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Found during the RUSH-3178 review sweep, deliberately left out of PR 3027 because no commit there touches sandbox.sh. apps/cli/scripts/sandbox.sh:427-431 builds a remote path by concatenation and hands it to a shell that re-parses it: bash remote_path=&quot;\$HOME/$workspace_dir/$POST_FILE&quot; crabbox run --id &quot;$box_id&quot; ... -- bash -c &quot;cat $remote_path&quot; A --post-file whose name…</p>
</article>
</div>
## Guards / merge / stop-gate

<a id="guards"></a>

Process, not product runtime. Proposed: **review**. 3 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2745/ask-user-question-guard-identical-re-issued-question-clears-the-gate">RUSH-2745</a> · ask-user-question-guard: identical re-issued question clears the gate</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>The guard denies an AskUserQuestion once per sha256(tool_input); re-issuing the IDENTICAL question immediately passes (hook comment lines 23-24 admit it). Harden: second identical hash within a session escalates (block + feed record). Canonical source is NOT in .agents-system/hooks - locate it (version homes: ~/.agents/.history/versions/claude/…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2779/guards-merge-time-pr-evidence-re-check-cover-fill-bodies-and-gh-pr">RUSH-2779</a> · guards: merge-time PR-evidence re-check — cover --fill bodies and gh pr comment backfills</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>pr-description-reminder only fires on gh pr create/edit with a readable body; --fill/--template/editor bodies fail open by design, gh pr comment is uncovered, and nothing re-verifies evidence at the merge boundary. Fleet reality check on phnx-labs/.agents-system (15 merged PRs): 5 had image embeds, 3 had declarations, 7 had neither ( 329 324 323 322 320 318 317). Fix: at gh pr…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3124/git-guard-no-guard-permitted-path-to-restore-the-primary-checkout-to">RUSH-3124</a> · git-guard: no guard-permitted path to restore the primary checkout to default after a subagent strands it</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Found 2026-08-23 while driving a dispatched-PR batch. A code-reviewer subagent ran gh pr checkout &lt;n inside the primary checkout (/home/user/src/github.com/muqsitnawaz/agents-cli), switching it onto the PR branch. git-guard then denies git checkout main / git switch main on the primary in BOTH directions, so neither the agent nor the owner (via the guarded shell) can restore…</p>
</article>
</div>
## Rest of AGI CLI

<a id="rest"></a>

Everything else still open on the AGI project. Proposed: **review**. 37 tickets.

<div class="artifact-grid artifact-grid-2">
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2310/fleet-wide-linear-api-frugality-client-cache-shared-rate">RUSH-2310</a> · Fleet-wide Linear API frugality — client cache + shared rate-limiter/backoff so N concurrent agents on one key dont blow the 2500/hr limit</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>With ~13 concurrent drain agents on one Linear API key, the 2500 req/hr limit was exhausted, throttling ticket status updates fleet-wide. Add client-side caching for reads + a shared token-bucket/backoff so concurrent agents degrade gracefully instead of hard-failing.</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2582/ssh-transport-controlpersist60s-and-pull-only-shape-cap-fleet-comms">RUSH-2582</a> · SSH transport: ControlPersist=60s and pull-only shape cap fleet comms; the control channel is the built alternative</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Surfaced while reviewing the agent-router market scan (RUSH-2555). Measured on the live fleet from yosemite-s0 on 2026-08-10, not estimated. Measurements | Case | Result | | -- | -- | | Cold SSH connect | 427-730ms (mark-1, relayed, worst) | | Multiplexed, warm ControlMaster | 3-5ms (100-200x faster) | | 1MB transfer, warm | 3-5ms | | 8 hosts, parallel, cold | 727ms (bounded…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2656/devices-list-loadmem-cache-has-no-ttl-and-no-writer-since-rush-2061">RUSH-2656</a> · devices list: load/mem cache has no TTL and no writer since RUSH-2061 — serves a 9-day-old snapshot as current fleet state</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>GitHub: https://github.com/phnx-labs/agents-cli/issues/2666 agents devices list renders its load/mem columns from .fleet-stats.json , a cache with no age bound and no remaining background writer . Those columns fossilize at the last manual --refresh and re-render as current fleet state indefinitely. Caught it serving a 9-day-old snapshot. Symptom Default agents devices list…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2740/agents-pty-fails-on-macosarm64-node-pty-prebuild-missing-for-darwin">RUSH-2740</a> · agents pty fails on macOS/arm64: node-pty prebuild missing for darwin, MODULE_NOT_FOUND</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>agents pty start (and any command touching the pty server) fails on mac-mini (macOS arm64, node v26.5.1) with the installed 1.22.39 CLI: Error: PTY server failed to start within 5 seconds. Spawned: &quot;/opt/homebrew/Cellar/node/26.5.1/bin/node&quot; &quot;.../dist/index.js&quot; &quot;pty&quot; &quot;_server&quot; PTY server process exited with code 1 before listening. ... innerError Error: Cannot find module…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2777/fork-pr-merges-into-fleet-config-repos-cant-be-gated-server-side">RUSH-2777</a> · Fork-PR merges into fleet-config repos can&#x27;t be gated server-side without a second-identity approver</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Trigger External user an external contributor opened fork PR 325 ( feat(commands): add BMAD and ADHD prompts ) against phnx-labs/.agents-system and it merged to main under the muqsitnawaz token at 2026-08-17T10:01Z with zero reviews . Content was benign (two markdown skills, no executable payload; on-roadmap per RUSH-2771), so no damage — but it exposed a structural gap. The gap…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2814/stop-gate-a-state-db-schema-failure-silently-weakens-the-delivery-gate">RUSH-2814</a> · Stop gate: a state-DB schema failure silently weakens the delivery gate (test D8b failing on main)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>hooks/stop/tests/00-agent-verify-work-complete_test.sh case D8b fails on unmodified origin/main ( e83c724 ), so the whole stop-hook suite exits 1. The assertion (test line 603): grep -q &quot;STOP GATE (delivery)&quot; &quot;$SANDBOX/stderr&quot; || { echo &quot;FAIL - state failure weakened delivery gate&quot;; fail=1; } Its stated invariant (lines 597-598): &quot;State is a precision aid, not a safety…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2951/agents-teams-reports-a-teammate-done-with-zero-commits-278-insertions">RUSH-2951</a> · agents teams reports a teammate &#x27;done&#x27; with zero commits — 278 insertions left stranded in its worktree</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>agents teams status reports a teammate as done when it has produced no durable output at all — no commit, no branch, no PR. The work exists only as uncommitted changes in a worktree, one teams cleanup away from being lost. Reproduced 2026-08-20 in team bugfix-swarm (3 teammates: codex / grok / cursor). Final status: Team bugfix-swarm (0 working, 2 done, 1 failed, 0 stopped)…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2957/system-repo-auto-pulls-shell-hooks-with-no-pinning-or-signature">RUSH-2957</a> · System repo auto-pulls shell hooks with no pinning or signature verification — document, then harden</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">High</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Not a live vulnerability — a supply-chain hardening + disclosure gap that a public launch will surface. What happens today 1. agents setup clones gh:phnx-labs/.agents-system into ~/.agents/.system/ ( lib/types.ts:444 , DEFAULT_SYSTEM_REPO ). 2. That repo ships hooks , which are registered into each harness as command strings executed on tool events (…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2009/browser-phase-1-ambient-current-task-key-hygiene-dedup-reap-scoped">RUSH-2009</a> · browser Phase 1: ambient current-task key + hygiene (dedup / reap / scoped status)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Part of the agents browser rework (see parent epic). Phase 1 — the core win. Browser-only; no launcher/exec change. Why Agents re-declare the task handle on 95% of commands, tasks pile into 70+ graveyards (one status showed 73 tasks aged 54–115h), and 13% probe blindly for &quot;is anything open?&quot;. Root cause: there&#x27;s no default &quot;current task&quot;, and no server-side hygiene. Build…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2011/browser-phase-3-ergonomics-positional-navigate-eval-to-evaluate-non">RUSH-2011</a> · browser Phase 3: ergonomics — positional navigate, eval to evaluate, non-zero unknown subcommand</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Part of the agents browser rework (see parent epic). Phase 3 — ergonomics. Small, independent polish. Build Positional navigate &lt;url (drop the flag for the common case). eval → evaluate (name the command what it does). Unknown subcommand exits non-zero (today it can silently no-op). Auto-pull remote screenshots back to the caller (kills the 9% of sessions that scp a screenshot…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2523/cache-frontmatter-parse-on-canonical-miss-alias-scan-perf">RUSH-2523</a> · Cache frontmatter parse on canonical-miss alias scan (perf)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>From the 2547 review: a canonical resolution MISS for skills/commands now re-reads + YAML-parses every candidate&#x27;s frontmatter to check aliases (resources.ts:217-237, resourceAliases - parseSkillMetadata/parseCommandMetadata, no cache). This lands on a documented-common miss path - resolveResourceProvenance (db.ts:1758) called from writeResourceUsage during session…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2577/opencode-custom-harness-ignores-its-pinned-model-runs-opencode-default">RUSH-2577</a> · opencode custom harness ignores its pinned --model (runs opencode default)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Summary An opencode custom harness ( agents harness fork opencode &lt;name --model &lt;id ) ignores its pinned model at run time and falls back to opencode&#x27;s default model. Repro agents harness fork opencode oc-test --model openai/gpt-5.4-mini agents run oc-test &quot;hi&quot; Running: opencode run --agent plan hi &lt;-- no --model plan · glm-4.7 &lt;-- opencode default, not the pin Root cause…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2600/agents-browser-record-ffmpeg-fails-to-finalize-recording-is">RUSH-2600</a> · agents browser record: ffmpeg fails to finalize, recording is empty/corrupt</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>agents browser record start + record stop produces a corrupt/empty file — ffmpeg fails to finalize. What happened Two independent attempts on zion (comet-local profile), recording a live page in an existing browser task, both failed identically at record stop : ffmpeg exited abnormally (code 187) while finalizing the recording at…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2655/linear-projects-merge-move-milestones-issues-without-dropping">RUSH-2655</a> · linear: projects merge (move milestones + issues without dropping milestone links)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle -</span></p>
  <p>Two things surfaced while consolidating the RUSH board (Rush App+Rush CLI - Rush, Agents CLI+Linear CLI+artifacts-cli - CLIs). 1. projects update --priority — DONE. Shipped in PR 37 (merged, commit c6e286c), released as v0.19.0 in PR 38. linear projects update &lt;name --priority urgent|high|medium|low|none , and priority is now shown in linear projects (column) and linear…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2664/linear-cli-installsh-is-posix-only-windows-boxes-can-never-self">RUSH-2664</a> · linear-cli: install.sh is POSIX-only — Windows boxes can never self-upgrade</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>win-mini sat on v0.11.1 for months and nobody noticed, because install.sh is POSIX sh and has never been runnable there. The only reason it surfaced: a fleet-wide version survey during unrelated work. Worse, the staleness hid a total outage. v0.18.0 added import fcntl at module scope, which does not exist on Windows — every command died with ModuleNotFoundError. Fixed in PR 39…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2696/mcp-implement-the-four-unwritten-config-formats-copilot-amp-kiro-or">RUSH-2696</a> · MCP: implement the four unwritten config formats (copilot, amp, kiro) or mark them mcp: false</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>MCP_TARGETS ( apps/cli/src/lib/mcp-registry.ts , landed in RUSH-2677 / PR 2685) declares format: null for copilot, amp, kiro and goose with a stated reason: no schema verified against an installed harness. They now fail loud — agents sync copilot prints Not written to Copilot@1.0.0: mcp: ... schema not verified against an installed Copilot CLI — instead of the previous silent…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2703/codex-permissions-the-writer-emits-agents-denyrules-but-the-reader">RUSH-2703</a> · codex permissions: the writer emits agents-deny.rules but the reader never opens it</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Found while reviewing PR 2696 (RUSH-2702). convertToCodexFormat / applyPermissionsToVersion DO record a sub-command deny for codex — the writer emits .codex/rules/agents-deny.rules containing e.g. prefix_rule(pattern=[&quot;rm&quot;], decision=&quot;forbidden&quot;) (see convertDenyToCodexRules , apps/cli/src/lib/permissions.ts:52 , and CODEX_RULES_FILENAME ). The reverse projection never opens…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2720/re-land-the-readback-claim-check-safely-fix-its-macos-test-plan">RUSH-2720</a> · Re-land the readback claim-check safely + fix its macOS test + plan-presentation self-contradiction (RUSH-2712 follow-up)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up to the RUSH-2712 / PR 308 revert (PR 308 self-merged an over-firing Stop hard-block; the hard block is being reverted in a separate fix PR). The GOAL of 308 is still worth landing — just correctly. Three items: 1. RE-LAND the visual read-back CLAIM check WITHOUT the false-positive storm. The reverted design (hooks/stop/visual_readback.py + the Stop gate) fired on ANY…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2728/artifacts-cli-no-share-endpoint-configured-so-agents-cannot-attach">RUSH-2728</a> · artifacts-cli: no share endpoint configured, so agents cannot attach image proof to PRs</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Blocked three PRs today from carrying inline screenshot proof of a user-visible feature (persistent reader highlights, worksheet rendering, chart primitives). Filed rather than worked around because both fixes need a credential only the owner holds. State on yosemite-s0: $ artifacts share status endpoint not configured worker unknown bucket unknown token not stored Two routes…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3006/tsc-does-not-type-check-appscliscripts-a-green-build-hid-a-dangling">RUSH-3006</a> · tsc does not type-check apps/cli/scripts/ — a green build hid a dangling import</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>apps/cli/tsconfig.json:18 sets &quot;include&quot;: [&quot;src/ / &quot;] , so tsc never type-checks apps/cli/scripts/ — even though that directory contains real, imported, test-covered TypeScript ( scripts/sample-session-shell-commands.ts has a companion scripts/sample-session-shell-commands.test.ts ). How it surfaced During RUSH-3001 (PR 2872, removing agents serve + the control DeviceRole),…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3042/gh-pr-checks-watch-fail-fast-reports-a-superseded-runs-failure-as-the">RUSH-3042</a> · gh pr checks --watch --fail-fast reports a superseded run&#x27;s failure as the current verdict</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>--fail-fast makes gh pr checks --watch exit on a check that is already failed from a superseded run, before the new run&#x27;s checks register. The watcher then reports a stale red for a commit whose CI is actually green. Observed On agents-cli PR 2908, 2026-08-22: 1. cf54bd11 pushed → CI test fail (a genuine failure: stale docs/command-index.json ). 2. Fixed and pushed a859d311 .…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3056/linear-cli-long-proof-crashes-and-then-poisons-every-later-done">RUSH-3056</a> · linear CLI: long --proof crashes and then poisons every later --done</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem linear update &lt;id --done --proof &quot;&lt;long text &quot; fails, and worse, it persists the long text and replays it on every subsequent --done , so the ticket can never be closed through that path again. Observed 2026-08-23 closing RUSH-3035: $ linear update RUSH-3035 --done --proof &quot;End-to-end sign-in COMPLETED on installed agents-cli 1.22.46: ...&quot; OSError: [Errno 36] File name…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3065/browser-agents-ssh-bypasses-the-remote-control-consent-marker">RUSH-3065</a> · browser: agents ssh bypasses the remote-control consent marker</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Problem agents ssh &lt;host &#x27;agents browser ...&#x27; reaches a remote machine&#x27;s browser without ever setting the fleet-remote consent marker, so the target cannot tell it is being driven remotely and browser.remote-control is not consulted. AGENTS_FLEET_REMOTE is set in exactly two places, both on the passthrough path: apps/cli/src/lib/hosts/passthrough.ts:433 (fan-out, via…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3074/feed-attention-python-hook-terminal-answer-path-userpromptsubmit">RUSH-3074</a> · feed attention: Python hook terminal-answer path (UserPromptSubmit) clears a block with no resolution tombstone</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up from Track A review (PR 2958). Track A wired resolution tombstones into the TypeScript answer/continue/clear paths (recordAnswer/recordContinued/removeBlock in apps/cli/src/lib/feed/feed.ts). The Python feed hook&#x27;s terminal-answer path (UserPromptSubmit in FEED_PUBLISH_HOOK_SCRIPT) also removes the block file but writes NO tombstone, so once a consumer of…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3085/phoenix-id-store-user-activity-and-signup-metadata-identity-is-modeled">RUSH-3085</a> · phoenix-id: store user activity and signup metadata — identity is modeled, lifecycle is not</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Ask Muqsit: &quot;We should be storing all the users who sign up with Phoenix, their metadata and everything — check how other apps do it, like rush.&quot; What we already store (this part is good) migrations/001_init.sql models identity well, and deliberately better than Prix/Rush: users — id uuid PK, google_sub unique, email , email_verified , name , avatar_url , created_at…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3143/phoenix-evals-m4-evals-grow-in-score-a-flagged-run">RUSH-3143</a> · Phoenix Evals M4 — evals grow in (score a flagged run)</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>From a flagged trajectory: score/add-to-suite. Persist trajectory.ts spans (eval_spans), llm_judge criterion on bench engine, baseline/regression. Demand-pulled eval engine. Plan PR 3011.</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3179/browser-stop-profile-is-an-ungated-fleet-remote-path-under-remote">RUSH-3179</a> · browser: stop --profile is an ungated fleet-remote path under remote-control off</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up to RUSH-3064 (PR 3021), surfaced in that PR&#x27;s review. Problem RUSH-3064 closed the fleet-remote ATTACH bypass by gating the top of resolveOrCreateTask — the chokepoint every task-scoped verb flows through. But agents browser stop --profile &lt;name (terminate a whole profile&#x27;s browser, no task) takes a different route: ipc.ts:413 early-returns from bindTask for stop +…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3201/agents-system-sweep-appscli-path-guidance-after-the-agi-cli-flatten">RUSH-3201</a> · .agents-system: sweep apps/cli path guidance after the agi-cli flatten</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Medium</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Follow-up to RUSH-3189 (agi-cli PR 3033, merged 360ae7895: apps/cli - cli/). Live guidance files in phnx-labs/.agents-system still teach apps/cli/... paths: AGENTS.md, monitors/AGENTS.md, plugins/AGENTS.md, plugins/code/skills/refactor/SKILL.md, subagents/README.md (~5 live files; the other ~350 hits are CHANGELOG/artifacts/worktrees — historical, leave untouched). Sweep…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2457/self-update-gate-npx-cacheunsafe-legacy-helper-purge-on-hasfixedpeer">RUSH-2457</a> · self-update: gate npx-cache/unsafe-legacy-helper purge on hasFixedPeer, same as pre-fixed-version</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>classifyRemovableAgentsCliInstalls (apps/cli/src/lib/self-update.ts:534-580, shipped in PR 2438 / RUSH-2415) gates the pre-fixed-version removable reason on hasFixedPeer — a stale pre-1.22.30 install is only auto-purged by doctor --fix / upgrade when some other install on the box already carries the Touch-ID-storm fix, so a lone stale install is never stranded…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2524/routines-browser-polish-pty-regression-test-fix-bogus-subcommand-error">RUSH-2524</a> · Routines browser polish: PTY regression test + fix bogus-subcommand error leak</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Two non-blocking follow-ups from the 2544 review. (1) Add a PTY-driven regression test of runRoutinesBrowser (grouping, filter, drill-in Definition/Next-fire/Recent-runs/Stats) using the same technique picker.test.ts:487-579 already demonstrates - the browser&#x27;s core behavior currently has zero automated coverage. (2) Making &#x27;browse&#x27; the isDefault hidden subcommand changed the…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2675/notify-owner-planes-table-understates-feed-post-on-this-fleet-an">RUSH-2675</a> · notify-owner Planes table understates feed post: on this fleet an important post IS a phone delivery</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>rules/subrules/notify-owner.md:10 describes &#x27;agents feed post&#x27; as Record - &#x27;Append a milestone to the activity stream (optional forward via config / hooks)&#x27;. On this fleet that forward is not hypothetical: agents.yaml:191-198 wires feed.broadcast.owner to &#x27;agents notify&#x27; at minLevel important, so &#x27;agents feed post --level important&#x27; shells out to agents notify and lands on…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2699/consolidate-the-three-copies-of-stripjsoncomments">RUSH-2699</a> · Consolidate the three copies of stripJsonComments</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>stripJsonComments — the string-literal-aware JSONC parser — now exists twice in apps/cli/src/lib : agents.ts (exported by PR 2685) and permissions-registry.ts (exported by PR 2689, lifted out of permissions.ts ). Both are the same correct implementation. This matters more than usual duplication because the NAIVE variant is a live bug generator: a // -to-end-of-line regex…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2701/share-worker-concurrent-republish-of-the-same-slug-can-silently-drop">RUSH-2701</a> · share worker: concurrent republish of the same slug can silently drop one writer&#x27;s content (revision retention race)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Found during RUSH-2683 code review (PR 2692), confirmed by the reviewer with a reproduction. The bug: apps/cli/src/lib/share/worker-template.ts (PUT handler, revision-on-overwrite): the read-then-write that copies the current object to a revision before overwriting the canonical key has no conditional-put (etag CAS) and no lock: js const noRevision =…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2756/artifacts-share-list-filter-by-arbitrary-meta-keyvalue">RUSH-2756</a> · artifacts share list: filter by arbitrary --meta key=value</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Follow-up from PR 2692 (RUSH-2683). agents artifacts share now stores arbitrary --meta key=value pairs and agents artifacts share list --json RETURNS them (the meta field), but there is no client-side FILTER on them, unlike the shipped --agent/--session/label filters. A user who tags shares with --meta kind=plan --meta ticket=RUSH-2683 can see the values but cannot narrow the…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2866/browser-validate-profile-and-endpoint-names-so-a-runtime-key-stays">RUSH-2866</a> · browser: validate profile and endpoint names so a runtime key stays unambiguous</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>createProfile ( apps/cli/src/lib/browser/profiles.ts ) validates only a duplicate name and a port collision — no charset or shape check. A runtime key is &lt;profile @&lt;endpoint , so an unconstrained name makes the key ambiguous to parse: A profile named me@work at endpoint endpoint-0 yields me@work@endpoint-0 . parseConnectionKey splits on the LAST @ (RUSH-2709), so this resolves…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-2928/eight-more-modules-still-hand-roll-atomic-json-writes-instead-of-fs">RUSH-2928</a> · Eight more modules still hand-roll atomic JSON writes instead of fs-atomic.ts (RUSH-2840 follow-up)</h3>
  <p><span class="artifact-tag">Backlog</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle -</span></p>
  <p>Problem RUSH-2840 consolidated the six copies it named into apps/cli/src/lib/fs-atomic.ts (PR 2814, merged). At least eight further hand-rolled tmp-then-rename JSON writes remain , each bypassing the module that owns the primitive. Verified on origin/main — every one of these has its own inline writeFileSync + renameSync pair rather than calling atomicWriteJsonSync : | File |…</p>
</article>
<article class="artifact-panel">
  <h3><a href="https://linear.app/getrush/issue/RUSH-3069/devices-disk-used-percentage-disagrees-with-df-pick-and-document-one">RUSH-3069</a> · devices: disk-used percentage disagrees with df — pick and document one definition</h3>
  <p><span class="artifact-tag">Todo</span> <span class="artifact-tag-accent">Low</span> <span class="artifact-tag">cycle 26</span></p>
  <p>Observed agents devices list will render a disk-used percentage that does not match what df reports for the same filesystem. Measured on yosemite-s1 against the merged probe ( 2936): probe diskUsedPercent : 36.4% df -Pk / Use% : 34% Why parseDf ( apps/cli/src/lib/devices/health.ts ) derives usage as (totalKb - availableKb) / totalKb . df &#x27;s own Use% is used / (used +…</p>
</article>
</div>

