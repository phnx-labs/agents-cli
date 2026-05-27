---
name: audit
description: "Multi-perspective security audit. Default mode: review codebase **source** via parallel agent teams — picks 3–7 threat perspectives tailored to THIS product, spawns one read-only reviewer per perspective, synthesizes a ranked report with file:line evidence. Pentest mode: when the user gives a **deployed target** (URL, host, API) or asks to attack/red-team a live service, load the companion playbook [`pentest.md`](pentest.md) in this directory and follow it instead — recon, attack-tree plan, multi-team exploitation with reproducible PoCs against the running system. Triggers on 'audit', 'security audit', 'threat model', 'pre-launch review', 'supply-chain audit', 'secrets sweep', 'pentest', 'penetration test', 'attack the staging URL', 'red-team the API'."
argument-hint: "[scope or target — e.g. 'pre-launch', 'supply-chain before v1.0', 'pentest https://staging.getrush.ai']"
allowed-tools: Read(*), Write(*), Grep(*), Glob(*), Bash(*), WebSearch, WebFetch
user-invocable: true
---

# audit

Multi-perspective security work. Two modes — pick before you start:

| Mode | Input | What you do | Playbook |
| --- | --- | --- | --- |
| **Source audit** (default) | Codebase, scope phrase ("pre-launch", "supply-chain") | Read source, fan out reviewers by threat perspective, synthesize ranked report with file:line evidence. | This file (steps below). |
| **Pentest** | Deployed target — URL, host, CIDR, or "attack/red-team/pentest <url>" | Recon → attack-tree plan → multi-team live exploitation → reproducible-PoC report against the running system. Requires explicit user authorization. | **Load [`pentest.md`](pentest.md)** in this directory and follow it. Do NOT continue with the source-audit steps below.|

If the user's request mentions a URL, host, "deployed", "staging", "production endpoint", "pentest", "penetration test", "red-team", or "attack <thing>" — that's the pentest mode. Read `pentest.md` first thing, then proceed from its Step 0.

Everything below this line is the **source-audit** playbook.

## Arguments

`$ARGUMENTS` — Optional. Free-form scope ("pre-launch security review", "supply-chain audit before v1.0", "secrets sweep before going public"). If omitted, infer scope from project state and the milestone in front of the team.

## Your Job

You are the lead security reviewer. You decide which threat models matter, which agents play which roles, and how their findings combine. Do not hard-code roles — pick the threat perspectives that actually matter for THIS product, THIS audience, and THIS milestone.

### Step 1 — Ground yourself in the product (NOT optional)

Before spawning anyone, you must answer three questions in your own words. If you cannot, you have not explored enough:

1. **What is this product and what is its attack surface?** Read the top-level README, AGENTS.md / CLAUDE.md, package metadata, and the entry-point file. Identify: does it have a network listener? A web UI? A CLI? Does it touch the filesystem, secrets, the user's keychain, external APIs, child processes? What runs with elevated privileges? The attack surface determines which threat models matter.
2. **Who is it aimed at, and what is the trust model?** Internal team tool? Indie devs running locally? Multi-tenant SaaS? OSS package others will install? Each audience implies a different threat model — a CLI on the user's own machine has a very different threat surface from a hosted service holding other users' data.
3. **What milestone is in front of us?** Look for signals: open issues tagged "launch", "P0", or "security", a `CHANGELOG.md` with an unreleased section, a website or signup flow, recent dependency bumps, a Show HN draft, version bumps. State the target milestone (Show HN, public beta, v1.0, OSS release, paid tier, SOC2) and the implicit deadline if any. If you cannot find one, ask the user before spawning. The milestone sets the bar — pre-Show-HN is "no embarrassments"; SOC2 is much stricter.

State your answers back to the user in 4–6 lines before going further. The user will redirect if you've misread the threat model — that's cheaper than spawning the wrong team.

### Step 2 — Research the right methodology

Use web search to find current best practice for the kind of security audit the product and milestone demand. Anchor every query with the current year (see Hard Line #5). Examples:
- "OWASP top 10 2026"
- "supply chain attack vectors npm 2026"
- "CLI tool security audit checklist 2026"
- "pre-launch SaaS security review 2026"
- "secrets scanning best practices 2026"

Do not skip this step. New CVE classes, new attack patterns, and new tooling emerge constantly; your training data is months stale. Pull 1–3 sources, extract the threat classes that recur for this product type, and use them to inform which perspectives you assign.

### Step 3 — Pick the threat perspectives

**First, derive your own list.** Using the attack surface from Step 1 and the threat classes from Step 2's web search, write down the perspectives that matter for THIS specific product — in your own words, before looking at any menu. Aim for 3–7 viewpoints, each surfacing findings the others would miss. Many of the most valuable perspectives are product-specific and won't appear in any generic security checklist (e.g. for an AI-agent CLI: prompt injection, untrusted-LLM-output handling, agent permission-escalation; for a video-rendering pipeline: untrusted media parsing; for a developer tool: arbitrary-code-execution paths via project config).

**Then, cross-check the starter menu below** to catch obvious blind spots. Add anything from the menu you missed. Drop anything that doesn't fit (don't run a "tenant isolation" reviewer on a single-user CLI). Treat the menu as a primer, not a pick-list.

**Common starter perspectives — primer only, not a checklist:**

- **External attacker / red team** — what can an unauthenticated outsider do? Exposed endpoints, SSRF, RCE, auth bypass.
- **Authenticated abuser** — once a user signs up, what can they do to other users' data? IDOR, broken access control, tenant isolation.
- **Supply-chain attacker** — package lockfile health, postinstall scripts, typosquats, unpinned deps, vendored binaries, build-time injection.
- **Secrets hunter** — committed `.env`s, hard-coded keys, leaked tokens in fixtures, secrets in logs, keys in client bundles.
- **Crypto / auth reviewer** — weak hashes, broken token signing, missing CSRF, session fixation, insecure cookie flags, JWT pitfalls.
- **Input validation / injection** — SQLi, command injection, path traversal, prototype pollution, deserialization, SSRF in URL fetchers.
- **Privacy / data handling** — PII storage, logging of sensitive data, third-party SDK exfil, GDPR / CCPA gaps, telemetry leaks.
- **Local-machine threat** — for CLIs / desktop apps: shell escapes, world-writable paths in `/tmp`, symlink races, keychain misuse, IPC trust boundaries.
- **Dependency CVE scanner** — known vulnerable versions in the lockfile, EOL runtimes, abandoned packages.
- **Operational / deploy** — secrets in CI logs, public S3 buckets, exposed metadata endpoints, misconfigured IAM, debug endpoints in production.
- **Insider threat / abuse path** — what does a compromised employee account or stolen API key do? Blast radius, audit logging.

For each perspective in your final list — whether you derived it yourself or pulled it from the menu — write one sentence explaining why it matters for this specific product. If you can't justify it, drop it. The goal is a list that fits THIS codebase, not coverage of any external framework.

### Step 4 — Spawn the team

Use the `agents teams` CLI. Recommended flow (adapt as needed — run `agents teams --help` and `agents teams add --help` to confirm current flags):

```bash
agents teams create <short-team-name>
agents teams add <team> <agent> "<task>" --name <role> --mode plan
# repeat for each perspective
agents teams start <team> --watch   # or omit --watch and poll with status
```

Recommendations (not rules):
- **Always use `--mode plan`** — security audits are read-only by definition. Never let a security reviewer modify the code it's reviewing.
- **Mix agents** if available — different agents have different blind spots and different vulnerability priors. Run `agents teams doctor` to see what's installed.
- **Give each teammate the FULL context the lead has** (product summary, attack surface, trust model, milestone) plus their specific threat model and a concrete deliverable shape: `Return a markdown report with: CRITICAL (exploitable now), HIGH (exploitable with effort), MEDIUM (defense-in-depth gaps), LOW (hygiene). Each finding must have: file:line, attack scenario, blast radius, suggested fix.`
- **Demand evidence** — end every teammate's prompt with: `Return file:line quotes for every claim. Do NOT paraphrase. If you can't quote it, don't claim it. No theoretical vulnerabilities — only ones you can demonstrate against the actual code in this repo.`
- **Recommend tool use** — point teammates at the relevant per-surface tool file in this directory. **Minimum set applied if the surface fits**, not exhaustive and not mandatory — a project with no Dockerfile skips `hadolint`, a project with no LLM endpoint skips `promptfoo redteam`. Better tools land monthly, so Step 2's web search should turn up additions. The teammate decides what to run; you don't dictate.
  - Always-applicable starter: [`pentest-baseline.md`](pentest-baseline.md) — gitleaks, semgrep, osv-scanner, Socket CLI, scorecard.
  - Per-language: [`pentest-go.md`](pentest-go.md), [`pentest-js-ts.md`](pentest-js-ts.md).
  - Per-runtime: [`pentest-electron.md`](pentest-electron.md) (Electron + macOS-signed apps).
  - Per-concern: [`pentest-llm.md`](pentest-llm.md) (any LLM endpoint, MCP server, or agent surface), [`pentest-infra.md`](pentest-infra.md) (CI / IaC / Cloudflare / Supabase / Hetzner / systemd).
- **Run in parallel** — security perspectives almost never depend on each other. Skip `--after` unless you have a real reason.

### Step 5 — Monitor and collect

```bash
agents teams status <team>          # who's working, what they touched
agents teams logs <team> <name>     # raw output of one teammate
```

Don't poll obsessively. Check in at sensible intervals. When everyone is done, read each teammate's final report.

### Step 6 — Synthesize the verdict

The team produces raw findings. You produce the security report.

- **Deduplicate** — multiple teammates often surface the same CVE or pattern from different angles. Merge them; cite which perspectives agreed (independent confirmation strengthens severity).
- **Re-rank** — teammates rank findings against their own threat model. You rank against the milestone. A "CRITICAL" from the local-machine threat reviewer may be irrelevant for a public SaaS, and vice versa.
- **Verdict** — one line: ship / no-ship / ship-with-mitigations. Then the punch list, ordered by exploit severity × likelihood.
- **Cite** — every finding in your synthesis must trace back to a teammate's file:line evidence. No vibes, no theoretical concerns. If a teammate flagged something but couldn't show the vulnerable code, drop it or downgrade to "review needed."
- **Highlight what was NOT covered** — list threat models you considered but didn't assign, so the user knows the audit's blind spots.

### Step 7 — Wind down

```bash
agents teams disband <team>
```

Or leave the team intact if the user wants to follow up on specific findings (`agents teams logs`, `agents teams add ... --after` for a focused deep-dive on one finding).

## Companion files (in this directory)

Playbook:
- **[`pentest.md`](pentest.md)** — Live-service pentest playbook. Load this instead of running the source-audit steps when the user's target is a deployed URL/host/API. Covers the authorization gate, recon, attack-tree planning, posture tiers (recon-only / read-only / aggressive), team spawning for live exploitation, and the reproducible-PoC report format.

Tool files (per surface — **minimum set applied if the surface fits**, not exhaustive):
- **[`pentest-baseline.md`](pentest-baseline.md)** — Codebase-agnostic source-side scanners (gitleaks, trufflehog, semgrep, osv-scanner, Socket CLI, OpenSSF Scorecard). Run on every repo.
- **[`pentest-go.md`](pentest-go.md)** — Go (govulncheck, gosec, staticcheck). For rush/cli.
- **[`pentest-js-ts.md`](pentest-js-ts.md)** — JS / TS / Node / Bun (bun audit, Socket CLI, eslint-plugin-security, retire.js). For prix/api, rush/app JS, rush/web, prix/web.
- **[`pentest-electron.md`](pentest-electron.md)** — Electron + macOS-signed app (`@electron/fuses`, codesign/spctl/stapler, otool, entitlements diff, preload audit). For rush/app.
- **[`pentest-llm.md`](pentest-llm.md)** — LLM red-team (promptfoo, garak, mcp-scan). For prix/api LLM proxy, rush/cli agent runtime, any MCP server, any rendered LLM output.
- **[`pentest-infra.md`](pentest-infra.md)** — CI / IaC / cloud / systemd (zizmor, actionlint, hadolint, trivy, checkov, Steampipe plugins, systemd-analyze, supabase db lint).
- **[`pentest-web.md`](pentest-web.md)** — Live web pentest tooling (recon, DAST, injection, auth/authz, API, frontend). Loaded by `pentest.md`.

## When NOT to Use This

- The user wants a security review of one PR or one diff — use the built-in review skill instead.
- The user wants to fix vulnerabilities, not just find them — run `/audit` first to surface them, then create a team with `agents teams` to remediate.
- The codebase is tiny (one file, a few hundred lines) — a single subagent will do, no team needed.

## Reminders

- Hard Line #1: "done" means a real synthesized security report the user can act on, not "team spawned."
- Hard Line #2: every finding must be backed by a teammate's file:line citation against actual code in this repo.
- Hard Line #11: parallelize — security perspectives are independent by nature; this is exactly the fan-out workload teams are built for.
- Hard Line #4: do not let teammates surface "fallback" or "just-in-case" defensive-code suggestions as findings. A finding is a real exploit path, not a wishlist.
