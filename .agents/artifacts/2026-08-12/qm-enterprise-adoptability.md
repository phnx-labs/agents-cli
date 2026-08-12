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

QM is genuinely multi-user but deliberately single-agent: one org agent with per-person/per-room scoped state, where any scope can pin its own model and harness but there is only one agent identity and one Slack bot. Its identity surface is OIDC sign-in only — the built-in email-link broker is itself a small OIDC server, Google Workspace is the documented IdP default, and the tree contains zero SAML, SCIM, Entra, Okta, or Workday code; the only automated directory sync is the Slack roster. Mapped against 20 real companies from seed to public enterprise, that lands exactly where YC's portfolio lives: seed/Series A Google-Workspace startups can adopt it today, Series B/C works when the IdP speaks OIDC and the suite is Google, growth companies need a fork (SAML/SCIM/M365 are absent but MIT-forkable), and enterprises plus non-tech small businesses are out — the former on identity and hardening grounds, the latter because there is no managed vendor to buy from.

## Focus for review

- Whether QM's identity surface (OIDC-only sign-in, no SAML/SCIM, Slack-roster directory sync) matches what companies at each stage actually require.
- The company-by-stage matrix as a visualization of who could adopt QM today vs after a fork vs not at all.
- The multi-agent question: QM is one org agent with scoped state, not a multi-agent platform.

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

Suite share, with the metric named: Google Workspace leads on raw domain count (~50% vs ~45%, dominated by small orgs — [Fusion Computing](https://fusioncomputing.ca/google-workspace-vs-microsoft-365-from-an-mssps-perspective/)); Microsoft 365 leads on paid seats (450M+ commercial seats, ~58% of the enterprise segment, 75% of the Fortune 500 — [SQ Magazine](https://sqmagazine.co.uk/microsoft-365-statistics/)). QM ships Google connectors and zero Microsoft ones, so it is aligned with the *domain-count* half of the market, not the *seat-count* half.

The "SSO tax" context cuts the other way, in QM's favor: vendors routinely gate SAML/SCIM behind 2-4x enterprise pricing (GitHub $4 → $21/user for SAML — [SSOJet](https://ssojet.com/blog/the-enterprise-sso-tax-is-real-heres-how-to-stop-overpaying-it)), and 57% of 721 surveyed apps offer no SCIM at any price ([Iden](https://articles.idenhq.com/scim-tax-enterprise-upgrade-cost-per-app)). QM being MIT-licensed means a company that needs SAML/SCIM can build it without paying anyone — the cost moves from license line-item to platform-engineer time.

<!-- MARKET_SECTION -->

## Company-by-stage matrix

Twenty real companies across stages and sectors, with what is known about their identity stack and how QM would land there today. Evidence labels: **E** = evidenced with a URL, **P** = partial (public security/trust page, but internal IdP not named), **I** = inferred from stage/sector norms. The strongest single identity datapoint in the whole set is a job posting, not a trust page — below Series B there is almost no public evidence of a formal IdP at all, which itself is the finding.

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
<figcaption>Where the 20 surveyed companies land. The left half is QM's home turf (Google Workspace, no formal IdP); the right half requires code QM does not ship — forkable under MIT, absent today.</figcaption>
</figure>

Caveats carried from the research: Theseus headcount is disputed (3 vs 10-12 by source); Northbeam's round close date conflicts between sources (May vs Aug 2025); Mercury's Google-Workspace+Okta stack comes from a vendor profile that may conflate product SSO with the internal stack; Capital One's Okta use is a consulting case study, unverified.

<!-- COMPANY_MATRIX -->

## Findings

### Who can adopt QM, and when

**Seed and Series A startups (5-50 people): adoptable now.** Their whole identity world is Google Workspace, which is QM's documented sign-in default and its richest connector. No SAML, no SCIM, no Workday exists at this stage to integrate with. The real gates are operational, not identity: someone comfortable with Fly.io/AWS, Postgres, and OAuth-app consoles — QM's own docs say the fit is "a startup or mid-sized company with at least one platform engineer."

**Series B/C (50-250): adoptable with conditions.** Works where the IdP (Okta/Entra) can be pointed at QM as a generic OIDC client and the company is Google-suite. Two common stallers: a SAML-only SSO standard, and a Microsoft 365 shop (no connectors at all for their mail/files/chat). Being MIT, a motivated platform team can fork and add either — that is real but nontrivial engineering, and the private-fork workflow is explicitly documented by QM.

**Small non-tech businesses (the 20-50-person dentist office, agency, clinic): not adoptable.** Not because of identity — because there is no vendor. QM is self-hosted-only with no managed offering; deployment assumes a cloud account and an infrastructure operator. This segment buys SaaS, not repos.

**Enterprises (1,000+): not adoptable today, on identity grounds alone.** Missing before security review even starts: SAML, SCIM provisioning/deprovisioning (the thing that clears the "terminated employee loses access same-day" control), directory/group mapping, more than one admin role (`org_admin` is the only role), and Microsoft 365 anything. QM's own SECURITY.md is candid: not "a hardened public or multi-tenant service boundary," egress enforcement "conditional," token revocation "incomplete." The Slack-roster-as-directory design also inverts the enterprise control model — the chat tool becomes the offboarding authority.

The one-sentence answer to "is it enterprise-adoptable": **QM is adoptable today by exactly the companies YC funds, and that is a design choice, not an accident** — identity lands where a 10-50-person Google-Workspace startup already is, and every layer an enterprise would demand (SAML, SCIM, HRIS flow, Microsoft, roles) is absent but forkable under MIT.

<!-- VERDICT -->

## Evidence

- QM identity/SSO/connector audit: file:line citations inline above, against `github.com/yc-software/qm` at commit 3cb5623 (Aug 12), audited in a local worktree.
- Enterprise-readiness signals: Postgres-backed audit log (`src/audit/audit-log.ts:1-19`), org/scope budgets and rate limits (`src/config.ts:740-747`), egress allowlists with enforcement explicitly "conditional" (`SECURITY.md:140-142`), self-hosted Postgres in the operator's own cloud account (`README.md:63,112-113`), MIT license.
- QM's own posture: "It is early, experimental software … QM is not a hardened public or multi-tenant service boundary" (`SECURITY.md:3-5,26-33`).
