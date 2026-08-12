---
kind: report
title: QM enterprise adoptability — identity, SSO, and who can actually deploy it
surface: internal
human: redacted
host: redacted
session: redacted
date: 2026-08-12
---

# QM enterprise adoptability — identity, SSO, and who can actually deploy it

## Summary

QM is genuinely multi-user but deliberately single-agent: one org agent with per-person/per-room scoped state, where any scope can pin its own model and harness but there is only one agent identity and one Slack bot. Its identity surface is OIDC sign-in only — the built-in email-link broker is itself a small OIDC server, Google Workspace is the documented IdP default, and the tree contains zero SAML, SCIM, Entra, Okta, or Workday code; the only automated directory sync is the Slack roster. Mapped against 21 real companies from seed to public enterprise, that lands exactly where YC's portfolio lives: seed/Series A Google-Workspace startups can adopt it today, Series B/C works when the IdP speaks OIDC and the suite is Google, growth companies need a fork (SAML/SCIM/M365 are absent but MIT-forkable), and enterprises plus non-tech small businesses are out — the former on identity and hardening grounds, the latter because there is no managed vendor to buy from.

v2 adds the operational half: QM is five Terraform-provisioned services plus Postgres with in-process workers, one-run-per-session serialization, admin-panel-only observability (no Prometheus/Sentry/alerting), no CHANGELOG, pre-1.0 versioning, and a first-12-days issue tracker already carrying four silent-failure deploy bugs. There is deliberately no QM Cloud ("We also wanted something that we could own and host ourselves" — YC), so the n8n-style escape from the ops tax doesn't exist; managed alternatives at $18-30/seat (Copilot, Claude, ChatGPT, Dust, Glean) absorb the companies that lack a platform engineer, and a reseller selling QM-into-your-AWS appeared one day after launch. Self-hosting QM is rational precisely when the platform engineer already exists and the sandbox/multiplayer capabilities are needed — the YC-portfolio profile, again.

## Focus for review

- Whether QM's identity surface (OIDC-only sign-in, no SAML/SCIM, Slack-roster directory sync) matches what companies at each stage actually require.
- The company-by-stage matrix as a visualization of who could adopt QM today vs after a fork vs not at all.
- The multi-agent question: QM is one org agent with scoped state, not a multi-agent platform.
- v2 additions: performance/scale architecture, the real operational overhead (Terraform, migrations, backups, the first 12 days of deploy bugs), observability gaps, developer reception, and the n8n-paradox economics of self-host vs managed.

## Intent

Assess whether YC's QM is multi-user and multi-agent, how it integrates with the identity systems companies already run (Workday, Microsoft Entra, Google Workspace, work SSO), and whether it is adoptable today by startups, small businesses, and enterprises — grounded in a list of credible companies across stages and sectors.

## What QM's identity surface actually is (from the code, commit 3cb5623)

QM has a real but minimal identity model:

- **Principals, not accounts.** `src/types.ts:5-10` defines `Principal { id, type: "internal" | "guest", teamIds, displayName }`. There is no invite flow and no signup form — a person becomes a principal **implicitly on first sign-in** with an allowlisted email or domain (`plugins/auth/README.md:47`, `OIDC_ALLOWED_EMAIL_DOMAIN` in `plugins/portal/README.md:137-138`). The admin Users tab is a roster derived from session metadata plus the admin-grants store, not a user database (`src/admin/users.ts:40-49`).
- **Sign-in is OIDC, and only OIDC.** The portal speaks standard OIDC Authorization Code + PKCE (`plugins/portal/README.md:21-29`). The built-in `auth` broker — the email one-time-link default — is itself a small OIDC authorization server (`plugins/auth/README.md:1-7`), so swapping in Google Workspace, Okta, or Entra ID means pointing five `OIDC_*` env vars at the provider and registering `<publicUrl>/auth/callback` (`cli/templates/deployment/deployment.md:132-149`). Google Workspace is the documented default; Okta/Entra work only insofar as they speak generic OIDC — there is no vendor adapter, guide, or field mapping for either.
- **No SAML. No SCIM. No HRIS or directory provisioning.** `grep -rniE "scim|saml|entra|okta|workday"` across `src`, `plugins`, `docs`, and `adrs` returns zero relevant hits. The only directory sync that exists is the **Slack roster**: `src/api/app-messaging.ts:314-343` snapshots Slack `users.list` into the directory store and deactivates principals who leave the workspace (`src/identity/identity-service.ts:65-77`). Offboarding, in other words, is "remove them from Slack" or manual.
- **One admin role.** `org_admin` is the only role; team-scoped administration was removed (`plugins/admin/README.md:18-19`).

Where Workday and the rest fit against this:

| System a company runs | What it does there | What QM can use it for today |
| --- | --- | --- |
| Workday / HRIS | Source of truth for who is employed; feeds the IdP via provisioning | Nothing — no SCIM/provisioning inlet |
| Microsoft Entra ID (Azure AD) | IdP + directory for Microsoft shops | Sign-in only, via generic OIDC config; no directory sync, no group mapping |
| Google Workspace | Email + IdP for most startups | Sign-in (documented default) + Gmail/Calendar/Drive/Sheets/Tasks connector |
| Okta / Rippling / JumpCloud | Dedicated IdP / IT+HR platform | Sign-in only if configured as a generic OIDC provider; SAML-only setups cannot attach |
| Slack | Chat + de-facto roster | Full: bot surface, sign-in option, and the only automated directory sync |

## Is QM multi-user? Multi-agent?

**Multi-user: yes, genuinely.** Per-person and per-room scoped memory, files, keychain view, permissions, crons, and sandboxes are the core design (`README.md:9-15`); scope kinds are `personal | channel | team | org | group` (`src/types.ts:12-13`).

**Multi-agent: no.** A deployment is **one org agent** with one Slack bot identity (`src/slack/directory.ts:21-28`) and no persona, agent-name, or multi-bot concept anywhere in config or docs. The closest facility: any scope can pin its own harness and model from the org-approved list (`src/api/routes/admin-resources.ts:347-417`) — so the finance channel can run a different model than engineering, but it is still the same single agent identity. Running two differently-named agents means running two QM deployments.

## Connectors: Google-native, Microsoft-absent

Shipped OAuth connectors (`src/connectors/oauth.ts:215-444`): Google Workspace (Gmail, Calendar, Drive, Sheets, Tasks), Slack user-token, Notion, Linear, GitHub, Dropbox, X. Each still requires the operator to create the OAuth app in the provider console and paste client id/secret into write-only admin fields.

**Microsoft 365 — Outlook, Teams, OneDrive, SharePoint — does not exist in the tree** (exhaustive grep; the only "microsoft" hit is a favicon MIME type). For the roughly half of the market that lives in Microsoft tooling, QM today can neither sign them in via their directory conventions (SAML/Entra groups) nor reach their mail, files, or chat.

## How companies actually manage identity, by stage

All percentages below come from vendor-adjacent trackers (Ramp's customer base, ETR panels, comparison-site aggregations), not census-grade surveys — treat them as directional.

| Stage | Typical identity stack | What that implies for a tool like QM |
| --- | --- | --- |
| Seed (1-20) | Google Workspace (or M365) *is* the directory; "Sign in with Google" everywhere; no IdP, no HRIS | QM's OIDC + Google default fits exactly |
| Series A (20-50) | Same, plus Rippling or JumpCloud bundling payroll + device management + basic SSO/SCIM ([Rippling](https://www.techradar.com/pro/rippling-it-iam-solution-review), [JumpCloud](https://businessmodelcanvastemplate.com/blogs/target-market/jumpcloud-target-market)) | Still fits — Google/OIDC sign-in; the Rippling/JumpCloud SCIM layer has nothing to provision into |
| Series B/C (50-250) | First dedicated IdP (Okta or Entra ID), usually triggered by enterprise-customer security reviews; Okta/Auth0 at ~69% mid-market adoption among Ramp customers ([Ramp](https://ramp.com/vendors/categories/identity-providers)) | Works if the IdP is configured as a generic OIDC provider; SAML-standardized shops stall |
| Growth (250-1,000) | Okta/Entra as standing IdP with SCIM provisioning to core apps; **Workday arrives as the HRIS feeding the IdP** — HR is the source of truth, the IdP does the provisioning ([Okta datasheet](https://www.okta.com/resources/datasheets/workday-it-provisioning/), [Microsoft Learn](https://learn.microsoft.com/is-is/entra/identity/app-provisioning/workday-integration-reference)) | QM has no SCIM inlet, so joiners/leavers don't flow; offboarding is manual or Slack-roster-dependent |
| Enterprise (1,000+) | Workday/SuccessFactors → SCIM → Okta/Entra; SAML/SCIM are hard requirements ("manual user management at that scale is unacceptable" — [CIAM Compass](https://guptadeepak.com/ciam-compass/guides/b2b-saas-identity/)) | Blocked on identity grounds alone, before security review even starts |

Note on Workday specifically: it is almost never the SSO provider. The pattern at every size is **HRIS (Workday) → provisioning → IdP (Okta/Entra/Google) → SSO into apps**. So "does QM integrate with Workday" resolves to "does QM accept provisioning from the IdP Workday feeds" — and the answer today is no (no SCIM).

Suite share, with the metric named: Google Workspace leads on raw domain count (59.9% vs 12.3% by one MSP-tracked comparison — [Fusion Computing](https://fusioncomputing.ca/google-workspace-vs-microsoft-365-from-an-mssps-perspective/), which itself notes "domain count favours Google Workspace; the paid-commercial lens favours Microsoft 365"); Microsoft 365 leads on the paid-commercial lens, with nearly 345M paid subscribers across 3.7M companies ([SQ Magazine](https://sqmagazine.co.uk/microsoft-365-statistics/)). QM ships Google connectors and zero Microsoft ones, so it is aligned with the *domain-count* half of the market, not the *paid-seat* half.

The "SSO tax" context cuts the other way, in QM's favor: vendors routinely gate SAML/SCIM behind enterprise-tier pricing (the convention has its own name — [SSOJet](https://ssojet.com/blog/the-enterprise-sso-tax-is-real-heres-how-to-stop-overpaying-it); GitHub's public pricing jumps $4 → $21/user/month for the SAML-bearing Enterprise tier — [github.com/pricing](https://github.com/pricing)), and SCIM coverage is thin across the industry — one analysis puts accessible SCIM endpoints at only 20-40% of SaaS apps ([Iden](https://articles.idenhq.com/scim-tax-enterprise-upgrade-cost-per-app)). QM being MIT-licensed means a company that needs SAML/SCIM can build it without paying anyone — the cost moves from license line-item to platform-engineer time.

<!-- MARKET_SECTION -->

## Company-by-stage matrix

Twenty-one real companies across stages and sectors, with what is known about their identity stack and how QM would land there today. Evidence labels: **E** = evidenced with a URL, **P** = partial (public security/trust page, but internal IdP not named), **I** = inferred from stage/sector norms. The strongest single identity datapoint in the whole set is a job posting, not a trust page — below Series B there is almost no public evidence of a formal IdP at all, which itself is the finding.

QM fit legend: **Works today** (Google-suite OIDC world) · **Conditional** (needs the IdP as generic OIDC + Google suite) · **Fork** (MIT fork adding SAML/SCIM/M365 could get there) · **Blocked** (identity/compliance gates before anything else).

| Company | Sector | Stage · heads | Identity stack (evidence) | QM fit |
| --- | --- | --- | --- | --- |
| [HUD](https://www.ycombinator.com/companies/hud) | Devtools | YC W25 · 15 | Google Workspace, no IdP (I) | Works today |
| [Clicks Health](https://www.goclicks.ai/security) | Healthcare | YC F25 · 8 | Auth0 product login; SOC2/HIPAA claimed (P) | Works today, HIPAA caveat on the sandbox |
| [Theseus](https://www.theseus.us/blog/theseus-seed) | Defense | Seed (First Round) · ~10 | none public (I) | Works today, until the first DoD questionnaire |
| [Lexi](https://www.ycombinator.com/companies/lexi) | Legal | YC F25 · 15 | none public (I) | Works today |
| [Depot](https://depot.dev/blog/depot-raises-series-a) | Devtools | Series A $10M (Felicis) · ~52 | none public (I) | Works today |
| [Highbeam](https://www.fintech.global/2025/09/11/fintech-firm-highbeam-raises-30m-in-series-a-funding/) | Fintech | Series A $30M (Acrew) · 49 | none public (I) | Works today; fintech compliance may pull it to Conditional |
| [AvoMD](https://avomd.com/) | Healthcare | Series A $10M · ~50 | SOC2 Type II badge (P) | Conditional — SOC2 posture meets QM's "conditional egress" honesty problem |
| [Kanvas Biosciences](https://www.businesswire.com/news/home/20260506062784/en/Kanvas-Biosciences-Secures-$48M-Series-A-to-Deliver-Novel-Microbiome-Therapeutics-to-Cancer-Patients) | Biotech | Series A $48M (DCVC) · 42 | none public (I) | Works today |
| [Sandstone](https://www.linkedin.com/company/sandstone-ai) | Legal | Series A $30M (Sequoia) · 11-50 | none public (I) | Works today |
| [Modal Labs](https://modal.com/docs/guide/security) | Devtools | Series C $355M · 120+ | mandates SSO IdP internally, vendor unnamed (P) | Conditional — hinges on whether their IdP hookup is OIDC or SAML |
| [Cradle](https://cloud.google.com/customers/cradlebio) | Biotech | Series B $73M (IVP) · 124 | **Google Workspace + BeyondCorp (E)** | Conditional-best-case — the ideal QM customer profile on paper |
| [Spellbook](https://spellbook.com/security) | Legal | Series B $50M (Khosla) · 115 | product SSO via Microsoft Entra (P) | Fork — Entra/Microsoft gravity, no M365 connectors in QM |
| [Highnote](https://www.forbes.com/sites/stephenpastis/2025/01/21/fintech-payments-startup-highnote-hits-750-million-plus-valuation/) | Fintech | Series B $90M · 124 | none public (I) | Conditional — card-issuing compliance raises the bar |
| [Northbeam](https://www.northbeam.io/data-security) | E-commerce | Series B $15M · 93 | Auth0 product, SOC2, GCP (P) | Conditional |
| [Vercel](https://vercel.com/blog/series-f) | Devtools | Series F $9.3B · ~700 | customer SSO documented; internal unnamed (P) | Fork — at this size SCIM offboarding is expected |
| [Mercury](https://security-profiles.nudgesecurity.com/app/mercury-com) | Fintech | Series D $5.2B · ~1,000 | Google Workspace + Okta reported (P) | Fork — bank-partner compliance + SCIM |
| [Cedar](https://www.vanta.com/customers/cedar) | Healthcare | Series D $3.2B · ~422 | SOC2/HIPAA/HITRUST via Vanta (P) | Fork — HITRUST posture vs QM's "not a hardened boundary" |
| [Ironclad](https://www.builtinsf.com/job/staff-iam-engineer/9652743) | Legal | Series E $3.2B · 863 | **Okta + Entra/Intune + Google Workspace + JAMF (E — IAM job posting)** | Fork — a staffed IAM team is exactly who could fork it, and exactly who will demand SCIM first |
| [Capital One](https://aws.amazon.com/solutions/case-studies/capital-one-all-in-on-aws/) | Bank | Public · ~76,300 | AWS all-in (E); Okta reported (I) | Blocked — bank regulation; yet runs agentic coding for 10,000+ engineers, so appetite exists |
| [HCA Healthcare](https://www.microsoft.com/en/customers/story/1432071140245408877-hca-healthcare) | Healthcare | Public · ~320,000 | Microsoft shop (P) | Blocked — M365/Entra world QM cannot see |
| [ServiceNow](https://www.anthropic.com/news/servicenow-anthropic-claude?lang=us) | Enterprise SaaS | Public · 29,187 | Azure/M365-integrated (P) | Blocked on identity — yet rolled out Claude Code org-wide, proving enterprise agent appetite is real |

<figure>
<svg viewBox="0 0 920 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QM adoption fit across company stages" font-family="ui-monospace,monospace">
  <text x="20" y="26" font-size="14" font-weight="700" fill="currentColor">QM fit across the company spectrum</text>
  <line x1="60" y1="200" x2="880" y2="200" stroke="#888" stroke-width="1.2"/>
  <rect x="60" y="180" width="220" height="40" rx="4" fill="rgba(163,230,53,.18)" stroke="#a3e635"/>
  <text x="80" y="204" font-size="12" font-weight="600" fill="currentColor">Works today</text>
  <rect x="280" y="180" width="220" height="40" rx="4" fill="rgba(250,204,21,.15)" stroke="#facc15"/>
  <text x="300" y="204" font-size="12" font-weight="600" fill="currentColor">Conditional (OIDC IdP + Google)</text>
  <rect x="500" y="180" width="200" height="40" rx="4" fill="rgba(251,146,60,.15)" stroke="#fb923c"/>
  <text x="520" y="204" font-size="12" font-weight="600" fill="currentColor">Fork (add SAML/SCIM/M365)</text>
  <rect x="700" y="180" width="180" height="40" rx="4" fill="rgba(248,113,113,.15)" stroke="#f87171"/>
  <text x="720" y="204" font-size="12" font-weight="600" fill="currentColor">Blocked</text>
  <text x="80" y="250" font-size="11" fill="#888">Seed · Series A</text>
  <text x="300" y="250" font-size="11" fill="#888">Series B/C</text>
  <text x="520" y="250" font-size="11" fill="#888">Growth 250-1500</text>
  <text x="720" y="250" font-size="11" fill="#888">Enterprise / public</text>
  <text x="80" y="70" font-size="11" fill="#888">HUD · Depot · Kanvas · Sandstone</text>
  <text x="80" y="86" font-size="11" fill="#888">Highbeam · Lexi · Theseus</text>
  <line x1="150" y1="94" x2="150" y2="178" stroke="#888" stroke-dasharray="3 4"/>
  <text x="300" y="70" font-size="11" fill="#888">Cradle (ideal) · Modal · Northbeam</text>
  <text x="300" y="86" font-size="11" fill="#888">AvoMD · Highnote</text>
  <line x1="380" y1="94" x2="380" y2="178" stroke="#888" stroke-dasharray="3 4"/>
  <text x="520" y="70" font-size="11" fill="#888">Vercel · Mercury · Cedar</text>
  <text x="520" y="86" font-size="11" fill="#888">Ironclad · Spellbook</text>
  <line x1="590" y1="94" x2="590" y2="178" stroke="#888" stroke-dasharray="3 4"/>
  <text x="720" y="70" font-size="11" fill="#888">Capital One · HCA</text>
  <text x="720" y="86" font-size="11" fill="#888">ServiceNow</text>
  <line x1="770" y1="94" x2="770" y2="178" stroke="#888" stroke-dasharray="3 4"/>
  <text x="60" y="285" font-size="11" fill="#888">The boundary QM cannot cross today sits between Conditional and Fork: SAML, SCIM, Microsoft 365, and more than one admin role.</text>
</svg>
<figcaption>Where the 21 surveyed companies land. The left half is QM's home turf (Google Workspace, no formal IdP); the right half requires code QM does not ship — forkable under MIT, absent today.</figcaption>
</figure>

Caveats carried from the research: Theseus headcount is disputed (3 vs 10-12 by source); Northbeam's round close date conflicts between sources (May vs Aug 2025); Mercury's Google-Workspace+Okta stack comes from a vendor profile that may conflate product SSO with the internal stack; Capital One's Okta use is a consulting case study, unverified.

<!-- COMPANY_MATRIX -->

## Performance and scale, from the code

The scaling design is "Postgres is everything": the run queue is a Postgres table claimed with `SELECT … FOR UPDATE SKIP LOCKED` (`src/runs/postgres-run-store.ts:140-158`), and a unique index enforces **one running run per session** (`postgres-run-store.ts:69`) — a conversation is strictly serialized; parallelism comes from many sessions in flight. Workers are in-process threads of the core service (default `workers: 16`, `src/config.ts:408`), polling the queue every 250ms (`src/wiring.ts:1340`); a standalone worker entrypoint exists (`src/runs/worker-main.ts`) but neither the AWS nor the Fly template deploys a worker tier — the reference deployment is **one core task** (`desiredCount ?? 1`, `cli/src/backends/aws.ts:1288-1289`; a single `shared-cpu-1x / 2GB` VM on Fly, `cli/templates/fly/core.toml:26-30`).

Multiple core replicas are possible — a Postgres advisory-lock leader lease keeps the singleton loops (cron, reaper, monitor poller) from double-firing (`src/persistence/leader-lease.ts:69`), and the instance registry exists for blue/green drain, not load balancing (`src/runs/instance-registry.ts:40-57`). Two real ceilings for a growing org:

- **Connection fan-out.** There is no shared connection pool: 23 stores each call `createPgPool` with no `max` set (node-pg defaults to 10 per pool, `src/persistence/pg-pool.ts:65`), so one core process can hold 20+ pools against the default `db.t4g.small` RDS with 20GB storage (`cli/templates/aws/main.tf:508-518`).
- **Per-principal, not per-org, throughput controls.** Rate limit defaults to 60 requests/min/principal (`src/config.ts:388-389`); spend ceilings (`BUDGET_USD_PER_WINDOW`, `ORG_BUDGET_USD_PER_WINDOW`) default to Infinity.

Sandboxes are persistent per scope, not per run — local Docker names a container per scope with a persistent volume (`src/sandbox/local-sandbox.ts:77-78`), AWS uses Lambda microVMs at 4 vCPU / 8GB / 8GB disk with an 8-hour lifetime and pre-rotation at 7.5h (`src/sandbox/aws-sandbox.ts:121-126`), so cold starts hit the first turn in a scope, not every turn. Latency is observable in-product: the metrics sink records a per-turn phase breakdown (TTFT, queue, provision, exec, stream — `src/admin/metrics-sink.ts:4-39`) with p50/p95/p99 computed in the admin Metrics tab. No stated user or throughput ceiling exists anywhere in the docs; the honest reading is "sized for one org of startup headcount, scale past that unmeasured."

Measured on the local dev instance (this machine, idle): core 334MB + web 107MB + admin 101MB + portal 104MB + dev supervisor 94MB of Node RSS, plus ~91MB Postgres and a 446MB sandbox image — roughly 1GB of memory before the first turn runs.

## What operating QM actually takes

This is real infrastructure, not an npm install. The reference AWS deployment (`cli/templates/aws/main.tf`, 840 lines of Terraform) provisions a VPC, ALB, ECS Fargate cluster, ECR, Cloud Map, IAM roles, a DynamoDB deploy-lock table, RDS Postgres, an S3 artifact bucket, Secrets Manager, CloudFront, and CloudWatch log groups — running **five services** (core, web-ui, admin, portal, auth). Fly is the lighter path (five small apps). The `qm` CLI owns the lifecycle — "The normal gate order is `check`, `doctor`, substrate image build, `plan`, `up --yes`, then `check --live`" (`docs/deploy-directory.md:122`) — and versions are consumed as the pinned `@yc-software/qm` npm package (pinned in-repo at 0.1.6; npm's published latest is 0.1.4), not a git checkout.

The sharp edges an operator inherits:

| Concern | What ships | The gap |
| --- | --- | --- |
| Migrations | Idempotent lazy DDL under an advisory lock (`src/persistence/pg-pool.ts:45`); no migration framework | No down-migrations; `rollback` restores code/config, "never data" (`docs/deploy-directory.md:122`) |
| Backups | Pre-deploy RDS snapshot + RDS automated backups (retention ≥1 day enforced) | Restore is explicitly operator-run; no continuous backup story beyond RDS |
| Storage growth | S3 artifact bucket | "File artifacts have no expiry … can accumulate indefinitely" (`SECURITY.md:147-151`) |
| Upgrades | CI-enforced version bumps, GHCR images pinned by digest | Operator must bump the pin and re-deploy; no auto-update |
| Alerting | Nothing | No PagerDuty/webhook hooks; `/healthz` always returns `{ok:true}` without checking the DB (`src/api/routes/index.ts:29`) |

Twelve days post-launch, the issue tracker is already an operator's-eye view of these edges: [#354](https://github.com/yc-software/qm/issues/354): removing the Slack integration silently renamed the config-derived S3 bucket, so Terraform proposed **destroying the bucket holding all agent files**. [#350](https://github.com/yc-software/qm/issues/350): custom sandbox tools work on Fly but silently fail on AWS while `qm check` passes. [#328](https://github.com/yc-software/qm/issues/328): adding a domain restriction silently dropped the email allow-list and locked users out. [#339](https://github.com/yc-software/qm/issues/339): a race in memory consolidation silently loses concurrent writes. All four are the silent-failure class that costs unattended operators the most.

## Observability: admin-panel-only

QM measures itself well and exports nothing. Per-turn phase metrics (TTFT, queue, provision, exec, stream, cache reads — `src/admin/metrics-sink.ts:4-39`), a Postgres error log, egress and credential-usage audit sinks, captured model requests per session (on by default, `src/config.ts:736`), and live run state over SSE — all surfaced only in the admin UI. No monitoring or APM integration exists anywhere in the tree (a grep for `prometheus|opentelemetry|statsd|datadog|sentry` finds only two design templates mimicking Sentry's visual style); logging is 155 bare `console.log/warn/error` call sites (no structured logger), landing wherever stdout goes (CloudWatch on AWS). For a team that already runs Grafana/Datadog, QM is a black box until someone builds an exporter; for getting paged when it breaks, there is nothing to wire a pager to.

## How developers are receiving it (first 12 days)

Repo signal as of Aug 12: 13.2k stars, 1.5k forks, 89 open issues, 106 open PRs vs 140 closed/merged, last commit Aug 11. The open issues skew toward deploy/infra pain (AWS/Fly/Terraform), Postgres pool reliability, and auth bugs — not feature asks. The contribution model: feature proposals must be human-written prose in `adrs/` ("Please do not have AI artificially expand what you'd like to do into a formal proposal" — `CONTRIBUTING.md`), while bug-fix code PRs are accepted; in practice 7 of the 10 most recent open PRs are ordinary code PRs (the other 3 are `adrs/` prose proposals), and the sampled open issues show no visible maintainer replies yet.

From the [681-point HN launch thread](https://news.ycombinator.com/item?id=49126604), the recurring themes:

- **Criticism:** the human-written-only policy read as ironic for an AI-built project ("an ai project, written by ai, requiring human-written text"); the shipped 22k-token "anti-slop" skill mocked as its own slop; "who is this for" skepticism versus Claude Cowork / Microsoft Copilot / Block's Buzz; and the one substantive security take — "if the agent is acting as me, then security wise it can do anything I can do."
- **Praise:** the per-person-scope + shared-room architecture ("the hardest problem in multiplayer agents … is scoping and QM's per-person scopes plus shared rooms is a sane answer" — a builder in the same space); the contribution policy defended as a spec-quality gate; README quality.
- **Production evidence:** exactly one firm claims production deployments — a consultancy deploying QM into customer AWS accounts and already selling a [DIY-vs-managed cost calculator](https://digitize.llc/qm/calculator/). The most engaged issue reporters are people who deployed this week and hit the silent-failure bugs above. No "we ran it for two weeks" write-ups exist yet, and no abandonment reports either — it is 12 days old.

## The n8n paradox — free license, paid operations

n8n is the instructive precedent: free to self-host, yet worth $5.2B ([SAP investment, May 2026](https://tech.eu/2026/05/12/n8n-s-valuation-doubles-to-5-2bn-following-sap-strategic-investment/)) largely by charging for the hosted version of software anyone can run (Cloud tiers €20-667/mo — [n8n pricing](https://n8n.io/pricing/); a third-party estimate puts ~55% of revenue on cloud subscriptions — [Sacra](https://sacra.com/c/n8n/), not company-disclosed). The pattern repeats wherever it can be measured:

- **GitLab (the only first-party split, 10-K-mandated):** SaaS is $296M (32%) vs self-managed $568M (59%) of FY26 revenue ([10-K](https://www.sec.gov/Archives/edgar/data/1653482/000162828026018731/gtlb-20260131.htm)) — large staffed orgs genuinely self-host cheaper; everyone else pays for "on time upgrades and patches" and compliance-ready hosting.
- **Metabase names the breakeven:** "if they spend ~2 hours a month dealing with your self-hosted Metabase installation, Metabase Cloud will have already paid for itself" ([Why Metabase Cloud](https://www.metabase.com/blog/why-metabase-cloud)) — though it also concedes self-hosting wins for HIPAA/PCI.
- **Supabase kills the compliance-rides-along assumption:** "Supabase's SOC 2 compliance does not transfer to environments outside of the Supabase product or Supabase's control" ([docs](https://supabase.com/docs/guides/security/soc-2-compliance)). Self-hosters bring their own attestations.

What people are really buying in every case is the **operational tax** (upgrades, patching, incidents, uptime) and the **compliance tax** (SOC2/HIPAA attestations procurement demands) moved onto a vendor.

Applied to QM, three things follow:

1. **QM has no one to pay.** There is no QM Cloud, and that is YC's stated choice, not a gap: "We also wanted something that we could own and host ourselves" ([qm.ycombinator.com](https://qm.ycombinator.com/index.html)). Unlike n8n/GitLab/Metabase, the escape hatch from the ops tax does not exist — the §Operating section above *is* the product.
2. **The managed alternative isn't hosted-QM, it's a different product.** The buy-instead set clusters at $18-30/seat/month with SSO, admin controls, and compliance certs bundled: M365 Copilot $18-30, Claude Team $20-25 / Claude Enterprise ($20/seat + metered, with SAML/SCIM/audit logs), ChatGPT Business $20-25, Dust $24-30, Glean (sales-only). A company whose blocker is compliance or headcount skips QM entirely rather than self-hosting it.
3. **The reseller cottage industry has already started.** One day after launch, Digitize LLC began selling managed QM deployments into customers' own AWS accounts — $4,500 setup + $850/mo operate tier ([digitize.llc/qm](https://digitize.llc/qm/)). That is exactly the shape the n8n pattern predicts when a free tool has a real ops tax and no first-party cloud: not multi-tenant SaaS competing with Claude Enterprise, but ops-as-a-service riding QM's infra-in-your-account design. The open question is whether YC eventually reverses and ships a QM Cloud, or leaves that margin to resellers.

The arithmetic for the target buyer: QM at $0/license plus a slice of a platform engineer (five services, Postgres, sandbox pipeline, upgrades — §Operating above) versus ~$20-30/seat/month for a managed assistant with zero ops. At 20 people, the managed alternative costs ~$5-7k/year; a fraction of an engineer costs more. Self-hosting QM is rational when the platform engineer already exists and the sandbox/multiplayer capabilities are actually needed — which is, again, exactly a YC-portfolio-shaped company.

<!-- N8N_PARADOX -->

## Findings

### Who can adopt QM, and when

**Seed and Series A startups (5-50 people): adoptable now.** Their whole identity world is Google Workspace, which is QM's documented sign-in default and its richest connector. No SAML, no SCIM, no Workday exists at this stage to integrate with. The real gates are operational, not identity: someone comfortable with Fly.io/AWS, Postgres, and OAuth-app consoles — QM's own docs say the fit is "a startup or mid-sized company with at least one platform engineer."

**Series B/C (50-250): adoptable with conditions.** Works where the IdP (Okta/Entra) can be pointed at QM as a generic OIDC client and the company is Google-suite. Two common stallers: a SAML-only SSO standard, and a Microsoft 365 shop (no connectors at all for their mail/files/chat). Being MIT, a motivated platform team can fork and add either — that is real but nontrivial engineering, and the private-fork workflow is explicitly documented by QM.

**Small non-tech businesses (the 20-50-person dentist office, agency, clinic): not adoptable.** Not because of identity — because there is no vendor. QM is self-hosted-only with no managed offering; deployment assumes a cloud account and an infrastructure operator. This segment buys SaaS, not repos.

**Enterprises (1,000+): not adoptable today, on identity grounds alone.** Missing before security review even starts: SAML, SCIM provisioning/deprovisioning (the thing that clears the "terminated employee loses access same-day" control), directory/group mapping, more than one admin role (`org_admin` is the only role), and Microsoft 365 anything. QM's own SECURITY.md is candid: not "a hardened public or multi-tenant service boundary," egress enforcement "conditional," token revocation "incomplete." The Slack-roster-as-directory design also inverts the enterprise control model — the chat tool becomes the offboarding authority.

The one-sentence answer to "is it enterprise-adoptable": **QM is adoptable today by exactly the companies YC funds, and that is a design choice, not an accident** — identity lands where a 10-50-person Google-Workspace startup already is, and every layer an enterprise would demand (SAML, SCIM, HRIS flow, Microsoft, roles) is absent but forkable under MIT.

### The operational verdict, added in v2

The identity verdict said *who is allowed in the door*; the operational angles say *who can afford to keep the lights on*. They point at the same buyer with one sharpened caveat:

- **The startup that fits QM's identity profile still pays an ops tax it may not want.** Five services, Terraform-provisioned AWS (or five Fly apps), Postgres, a sandbox image pipeline, version-pin upgrades, no alerting, and a first-12-days issue tracker full of silent-failure deploy bugs. QM's stated requirement of "at least one platform engineer" is real: this is a part-time infrastructure product, not an install-and-forget app. A 10-person seed startup has the identity fit but often not the appetite — which is exactly the gap a managed offering would fill, and one consultancy is already selling QM-into-your-AWS deployments with a DIY-vs-managed calculator.
- **Scale is unproven past one startup-sized org, by design.** One-run-per-session serialization, an in-process worker pool on a single default core task, 20+ unpooled Postgres connection pools against a `db.t4g.small`, and no published ceiling. None of that blocks a 30-person company; all of it is unmeasured territory for a 500-person one.
- **Bugs are handled by one team's bandwidth.** Test culture is strong (the test tree outweighs the source tree; zero TODOs; 7-day dependency quarantine) but there is no CHANGELOG, versions are pre-1.0, and feature contributions are prose-only ADRs the maintainers implement themselves — so fix latency is bounded by YC's attention, not community throughput. The candid SECURITY.md limitation list is the most honest maturity signal in the repo.

<!-- VERDICT -->

## Evidence

- QM identity/SSO/connector audit: file:line citations inline above, against `github.com/yc-software/qm` at commit 3cb5623 (Aug 12), audited in a local worktree.
- Enterprise-readiness signals: audit log (interface `src/audit/audit-log.ts:1-19`; Postgres implementation `src/admin/postgres-audit-log.ts`), org/scope budgets and rate limits (`src/config.ts:740-747`), egress allowlists with enforcement explicitly "conditional" (`SECURITY.md:140-142`), self-hosted Postgres in the operator's own cloud account (`README.md:63,112-113`), MIT license.
- QM's own posture: "It is early, experimental software … QM is not a hardened public or multi-tenant service boundary" (`SECURITY.md:3-5,26-33`).
- v2 performance/ops/observability audit: run queue (`src/runs/postgres-run-store.ts:140-158`), worker pool (`src/config.ts:408`, `src/wiring.ts:1333-1340`), leader lease (`src/persistence/leader-lease.ts:69`), pool fan-out (`src/persistence/pg-pool.ts:65` + 23 `createPgPool` call sites), sandbox lifecycles (`src/sandbox/local-sandbox.ts:77-78`, `aws-sandbox.ts:121-126`), Terraform (`cli/templates/aws/main.tf`), migrations/backup/rollback (`docs/deploy-directory.md:103,118,122`), metrics/error sinks (`src/admin/metrics-sink.ts:4-39`), healthz (`src/api/routes/index.ts:29`), CONTRIBUTING.md, CI (`.github/workflows/cicd.yml`), test-tree size (379 test files, ~89k lines vs ~77k source). Local footprint numbers measured on this report's own dev instance.
- Reception: [HN launch thread](https://news.ycombinator.com/item?id=49126604) (681 points, 164 comments), GitHub issues [#354](https://github.com/yc-software/qm/issues/354), [#350](https://github.com/yc-software/qm/issues/350), [#328](https://github.com/yc-software/qm/issues/328), [#339](https://github.com/yc-software/qm/issues/339), repo counters read from the rendered GitHub pages on Aug 12 (13.2k stars, 89 open issues, 106 open PRs). Reddit threads exist but were unreachable (blocked) — titles only, not cited as content; lobste.rs confirmed zero coverage.
