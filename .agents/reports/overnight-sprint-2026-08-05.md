# Overnight Sprint Ledger — 2026-08-05

> **Durable state for the overnight orchestration.** Any successor (watchdog-spawned
> or a resumed session) reads THIS FILE FIRST, then continues as lead orchestrator.
> Live on zion at `/Users/muqsit/.agents/artifacts/2026-08-05/sprint.md`.
> Heartbeat: `/Users/muqsit/.agents/scratch/overnight/heartbeat.txt` (lead touches it every monitor tick).

## Mission (from Muqsit, going to bed)

Close as many engineering + growth tickets as possible overnight across **all** projects
(Prex, Prix, Rush App, Rush CLI, Agents CLI). **Every ticket is actionable — find a way.**

- **Engineering** → worktree + real tests + PR + **merge on green**. Prix auto-reviewer
  (`prix-cloud`) is DOWN (#1767), so the non-author review is a **subagent reviewer**.
  Leave nothing half-done.
- **Cannot fully resolve** → still write as much code, run benchmarks, analyze, and **open a PR**
  so Muqsit can review in the morning.
- **Growth** → do the research, define positioning, include data, build prototypes, then create
  a **daily routine** (`agents routines`) that keeps doing it and **reports to owner + updates the ticket**.
- Update Linear tickets as work lands (move Doing → Review/Done with proof).

## Hard constraints

- **DO NOT kill our infra.** Do not kill/pause running agents/daemons. Coordinate, don't cull.
- **Cost: cheap harnesses first.** Prefer Codex (2 accts), Grok, Kimi, Antigravity, Droid over Claude.
  Reserve Claude for review passes / genuinely hard reasoning. Rotate Claude accounts.
- **Never dispatch onto a ticket that already has an open PR** (list below) or an active session's surface.
- **Old tickets may be stale / lack context** — recent decisions may override. When in doubt, check recent
  sessions/PRs and Muqsit's own messages; prioritize what he explicitly requested.
- Default branch untouchable → worktree + PR always. Never `--admin` merge, never self-approve.
- Browser + computer-use available (this box and remote) for OAuth flows. Agent mailboxes for coordination.

## Harness / account capacity (snapshot 2026-08-05 ~23:10)

| Harness | Account | Headroom | Use |
|---|---|---|---|
| Codex | muqsitnawaz@icloud (Pro) | S 0% — FRESH | primary engineering drain |
| Codex | muqsitnawaz@gmail (Pro) | S 29% | engineering drain #2 |
| Antigravity | Gemini 3.1 Pro | fresh 0% | research / growth |
| Grok | muqsitnawaz@icloud (SuperGrok Heavy) | W 60% | eng/research (GK tabs may share — use lightly) |
| Kimi | k3 | W 86% (low) | sparing |
| Claude | muqsit@getrush.ai | W 36% | reserve: reviews / hard tickets |
| Claude | tech@prix.dev | W 73% | reserve |
| Claude | social@swarmify.co | W 60% | reserve |
| Claude | muqsitnawaz@gmail | RATE-LIMITED | avoid |
| Droid | muqsit@getrush.ai | RATE-LIMITED | avoid |
| Claude | muqsitnawaz@icloud (THIS lead) | S 43% W 42% | orchestrator |

## Fleet boxes (idle → prefer for dispatch)

Idle Linux workers with repos cloned (`agents`, `agents-cli`, `artifacts-cli`): **yosemite-m0..m6**, s0 (light).
mac-mini = release/signing box (loaded, leave). zion = this interactive box (keep light). win-mini = Windows tickets.

## Repos (most tickets land in 2 monorepos)

- **agents-cli** = `git@github.com:phnx-labs/agents-cli.git` → project **Agents CLI**. On zion + all workers.
- **agents** = `git@github.com:muqsitnawaz/agents.git` (monorepo) → **Rush App** (desktop + getrush.ai site),
  **Rush CLI** (rush harness), and much of **Prix** / **Prex** (Factory cloud, prix-api). On zion + all workers.
- prix-api / rush may be sub-trees of `agents` or separate — drain worker resolves per ticket via `repo:` tag.

## OPEN PRs — DO NOT re-dispatch these tickets

agents-cli: #2213 insights, #2212 routine-discovery, #2209 auth-health(RUSH-2111), #2208 lease-renew(RUSH-2217/2226),
#2200 team-session(RUSH-1997), #2199 routines-runner(RUSH-2202), #2198 devices-accounts(RUSH-2003), #2138 resume-owning(RUSH-2022),
#2197 lease-dead-holder(RUSH-2274), #2211 cap-remote(RUSH-2065), #2206 focus, #2204 resources-bench.
→ Skip RUSH-2111, 2217, 2226, 1997, 2202, 2003, 2022, 2274, 2065.

agents monorepo: #1441 factory backend(RUSH-2283), #1294 OAuth scopes(RUSH-448), #1256 static_db(RUSH-425),
#1417 BYOK cloud, #1331 content-studio, + many blog/checkpoint PRs. → Skip RUSH-448, 425, 2283 (verify).

## Other agents running (coordinate, DO NOT overlap or kill)

- Grok tabs (from screenshot): **GK-Refactor, GK-Dispatch, GK-Work, GK-Debug-Routines**; Claude tab **CC-Rules**.
  → Avoid refactor/dispatch/routine-debug/rules lanes; let them run. Message via mailbox if overlap risk.
- Codex `routines-stability-debug` (019fd5a1 on s0) — fleet-config audit, high ask rate. Leave it.
- Runaways flagged earlier (m1/s1) — DO NOT kill (infra). Left alone.

## Dispatch log (append as drains launch)

_(name · box · harness · bucket · status)_

WAVE 1 (launched ~23:35):
- drain-A1-winssh · s0 · codex · A1 agents-cli Windows/SSH (RUSH-2265/2266/2267/2286) · RUNNING
- drain-A2-leases · s0 · codex · A2 agents-cli secrets leases (RUSH-2254/2255/2256) · RUNNING
- drain-P1-prix · s0 · codex · P1 Prix integrations (RUSH-1350/1398/183) · RUNNING
- drain-R1-rushcli · s1 · grok · R1 Rush CLI (RUSH-1929/856/1705) · RUNNING

WAVE 2 (launched ~23:45, codex@s0):
- drain-A3-misc · s0 · codex · A3 agents-cli (RUSH-2001/2129/2287/2213) · RUNNING
- drain-RA1-ui · s0 · codex · RA1 Rush App desktop UI (RUSH-1871/867/1883) · RUNNING
- drain-RA2-undo · s0 · codex · RA2 Rush App undo/security (RUSH-2166/2167/1824) · RUNNING

WAVE 3 (launched ~23:55, idle m-boxes, codex):
- drain-G1-growth · m0 · codex · Growth research + daily routines (RUSH-1936/1941/1939/1940/1948/1949/1937/1938/...) · RUNNING
- drain-X1-prex · m2 · codex · Prex research (RUSH-2173/2175/2177/2179) + model-discount routine · RUNNING
- drain-P2-compliance · m3 · codex · Prix compliance+credits, stage human steps (RUSH-650/655/642/648/644/645/credits) · RUNNING
- drain-RA3-site · m4 · codex · getrush.ai (RUSH-2169 Cloudflare deploy/702/1743) · RUNNING
- drain-X2-cloudinfra · m5 · codex · Prex eng (RUSH-2183/2180/2181/388/402) · RUNNING

NOTE: s0 saturated at load ~53 (6 codex) — do NOT add more to s0; heavy new eng → s1 or wait. m-boxes idle, fine for research.
CODEX is the workhorse (2 accts, gmail S29%/icloud S0%). GROK scarce (1 acct icloud W60%, shared w/ GK tabs). Antigravity/Kimi NOT on workers.
Sibling agents on s1 (claude 2.1.218/219) independently merging agents-cli PRs #2214, #2217 — stay out of their lane.

NOT YET DISPATCHED / backlog for later waves: Rush CLI heavy (R3: RUSH-1926 voice/1927 compliance/1928 isolation/1932 computer-use/2150 browser-bench), R2 (1933 cloud last-mile/447 JWT), Prix P1 extra (1884 OAuth forward), Prex X2 extra (2182/2184/112), Rush App RA1 extra (1565/1862). Launch as boxes free / codex headroom allows.

## Ticket buckets (assign one drain per bucket, cheap harness)

### Agents CLI (repo: agents-cli)
- **A1 Windows/SSH:** RUSH-2265 (explicit SSH identity paths), 2266 (Windows OpenSSH enroll in doctor), 2267 (detached dispatch to Windows), 2286 (windows token burn).
- **A2 Secrets leases:** RUSH-2254 (time-boxed leases), 2255 (broker key subset expiry), 2256 (secrets leases+revoke commands).
- **A3 Misc eng:** RUSH-2001 (run/teams --device auto), 2129 (rule presets in runWithFallback), 2213 (whichagent PR cards v1), 2287 (output token split + --pricing no-cache).

### Rush CLI (repo: agents)
- **R1:** RUSH-1929 (activate dormant RAG knowledge_base), 425 SKIP(PR), 856 (transport user memory to cloud), 1705 (review alpha.46 fail-closed — DECISION, write analysis).
- **R2:** RUSH-1933 (cloud last-mile run --cloud), 447 (per-user JWT), 448 SKIP(PR).
- **R3 (heavy/critical, likely open PR morning):** RUSH-1926 (voice+telephony runtime), 1927 (compliance mode), 1928 (per-tenant isolation), 1932 (reference computer-use agent), 2150 (browser latency 325→56ms bench).

### Rush App (repo: agents)
- **RA1 desktop UI:** RUSH-1871 (toggle top-bar icons), 867 (Library tab views), 1883 (menu-bar finish-setup row), 1565/1862 (Rushroom home, sidebar report vs artifacts).
- **RA2 undo/security:** RUSH-2166 (reversible file actions), 2167 (action ledger + one-click undo), 1824 (keep Supabase JWT out of renderer).
- **RA3 website getrush.ai:** RUSH-771 (homepage v2 brand), 782/783 (/customers real proof), 702 (/skills), 1743 (/status Grafana), 2169 (Cloudflare Pages deploy auth — 3 diffs stuck).

### Prix (repo: agents / prix-api)
- **P1 integrations:** RUSH-1350 (Reddit creds /api/v1/reddit/search), 1398 (Box invalid_client placeholder), 183 (Sendblue webhook), 1884 (forward Google/MS OAuth to cloud).
- **P2 compliance/growth (human-ish → do the doable part):** SOC2/HIPAA tickets → produce the artifacts/docs/config that CAN be automated (risk analysis doc, DPA template, MFA config plan); credits apps (RUSH-950..990) → browser-driven applications + prep packages, escalate only the true human-signature step.

### Prex (repo: agents — cloud infra)
- **X1 Bisma research (agent-doable):** RUSH-2173 (how peers run cloud agents), 2175 (sandbox pricing Box vs CF vs AWS), 2177 (auto model selection + daily discount check), 2179 (cost-reduction plan). → research artifacts + routines.
- **X2 eng:** RUSH-2180 (steering inject into cloud agent), 2181 (agent mailboxes for cloud), 2182 (computer/browser/secrets injection for cloud), 2183 (snooze idle containers), 2184 (live session migration), 388 (shared git-mirror PVC), 402 (git gc PVC), 112 (Supabase rate limiting).

## Growth routines to create (agents routines)

- Daily creator outreach (RUSH-1939), follow-up cadence (RUSH-1940), social drumbeat tied to releases (RUSH-1948),
  metrics snapshot + UTM (RUSH-1936), GitHub community responsiveness (RUSH-1949). Each: runs daily, updates ticket, notifies owner.
- Auto model-selection/discount check (RUSH-2177). Overdue-issues digest (RUSH-2204).

## Resume instructions (for a successor)

1. Read this file top to bottom.
2. `agents sessions --active` + `agents feed` + check the Dispatch log below for what's already running.
3. Do NOT re-dispatch a bucket already listed as launched/running. Re-dispatch only failed/finished ones.
4. Keep touching the heartbeat each tick. Keep drains fed. Report to owner via `agents feed post --level important` at real milestones only.
5. Prefer cheap harnesses. Never kill infra.

- drain-R3-rushheavy · m6 · codex · Rush CLI heavy (RUSH-1926 URGENT voice / 2150 browser-bench / 1933 cloud last-mile) · RUNNING (launched ~23:48)

## Survival / watchdog (installed)

- launchd job `com.muqsit.overnight-watchdog` on zion, runs every 300s. Script: `.agents/scratch/overnight/watchdog.sh`.
- Detects lead death/limit two ways: (a) heartbeat stale >25min, (b) fast-path if lead account muqsitnawaz@icloud claude is rate-limited AND heartbeat >10min.
- On trigger: `agents run claude --resume 8ab26c2d-c1ee-42d2-9d29-6946c007958e --mode auto "<resume brief>"` — recovers THIS conversation; balanced rotation picks a healthy Claude account (a rate-limited origin auto-replays via /continue on a healthy version).
- Cooldown 20min between resumes. Kill switch: `touch .agents/scratch/overnight/watchdog.off` to stop auto-resume.
- Account inventory snapshot (refreshed each tick): `.agents/scratch/overnight/accounts-zion.txt`.
- Healthy Claude accounts for resume (2026-08-05 ~23:40): dev@getrush.ai (S0/W86), tech@prix.dev (S70/W76), social@swarmify.co (S66/W62), muqsit@getrush.ai (S89/W37), muqsit@trp.so (S41/W89). Rate-limited: muqsitnawaz@gmail.
- Cheap drain harnesses on workers: CODEX (2 accts, most runway) + GROK (1 acct, scarce). Antigravity/Kimi NOT installed on workers. Droid rate-limited.
- Monitor loop: lead re-invoked every ~20min via a background sleep+echo; each tick touches the heartbeat, checks feed/PRs, merges green PRs, relaunches backlog.

## Codex model/effort policy (from Muqsit, ~00:00)

- PREFER the FRESH icloud codex account: dispatch `codex@0.145.0` (muqsitnawaz@icloud, 100% weekly left) over the default gmail (0.146.0, ~29% used).
- codex@0.145.0 tiers: cheap=gpt-5.6-luna ($7) · default=gpt-5.6-terra ($18) · best/ultra=gpt-5.6-sol ($35, the smart "Solana" model).
- HARD tickets (voice runtime, debugging, cloud infra, large-scale) → `codex@0.145.0 --model best --effort high` (or xhigh for the hardest). Routine eng → default tier is fine.
- codex is NOT installed on s1 (grok/claude only there). codex IS on s0 + all m-boxes.
