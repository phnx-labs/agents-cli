---
kind: plan
template: plan.v1
title: 'Phoenix login: own backend now, consolidate under Phoenix ID later'
summary: 'Decision + implementation plan: detach agents-cli identity from the Rush/Prix backend, stand up its own account backend built for later Phoenix-ID consolidation via Google sub matching.'
project: agents-cli
context: 'RUSH-2581 principal model, superseding the Prix-coupled auth shipped in PRs #2821/#2822'
repository: phnx-labs/agents-cli
branch: phoenix-detach-prix
tracking: 'RUSH-2581'
status: approved
surface: api
date: '2026-08-22'
facts:
  - 'prix/api identity audit verdict: deeply Rush-entangled (product columns on users, rush_user_id FK, 15-table GDPR transaction, RLS across ~12 tables, rush:// SSO scheme)'
  - 'agents-cli shipped surface = 13 endpoints (3 auth device-code, 9 spaces, 1 billing) — the exact contract an own backend must implement'
  - 'client coupling is scattered: the user.yaml token-read implemented 7x, api.prix.dev hardcoded 5x; no identity seam exists'
  - 'agents-cli has ~zero users; its only Prix-backend footprint is a conference-signup form'
links:
  - 'https://linear.app/getrush/issue/RUSH-2581/no-human-identity-substrate-ssosaml-cannot-attach-because-there-is-no'
assets: []
---

## Focus for review

- **The sequencing call**: own agents-cli backend now + Phoenix-ID consolidation later — approved by Muqsit 2026-08-22; this document is the execution shape.
- **The seven linkability rules** are the load-bearing bet: they keep "consolidate later" cheap. Veto or add there.
- **Phase A soft-vs-hard removal**: `agents auth`/`org` are removed as retired names (fail loudly). A "Phoenix sign-in coming" stub was considered and skipped — a stub teaches a surface that doesn't exist yet.
- **The new backend's home**: suggested repo `agents-id` with its own Supabase project — name and hosting are Muqsit's pick before Phase C dispatch.

## Purpose

Muqsit, 2026-08-22: agents-cli must not ride Rush/Prix's login ("that's a separate product") — but the family should eventually share a top-level **Phoenix login**, Apple-ID style: *"if users have similar emails we can later also consolidate them, right? Evaluate the workload of doing it now versus after."* Answer: consolidation later is cheap **if** matched on the Google `sub` (not email) and **if** the own backend is built linkable from day one.

## Current architecture

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
  <svg class="artifact-diagram" viewBox="0 0 980 310" role="img" aria-label="Sequencing: today's Prix coupling, the own-backend phase, and later Phoenix-ID consolidation">
    <text x="160" y="28" text-anchor="middle" fill="#dc2626" font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="700">TODAY (shipped 1.22.42+)</text>
    <rect x="30" y="45" width="260" height="72" rx="8" fill="#1a0e0e" stroke="#dc2626" stroke-width="1.5" />
    <text x="160" y="72" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="12">agents auth / org / entitlement</text>
    <text x="160" y="90" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="10">5x api.prix.dev · 7x user.yaml reads</text>
    <line x1="160" y1="117" x2="160" y2="157" stroke="#dc2626" stroke-width="2" marker-end="url(#aR)" />
    <rect x="30" y="160" width="260" height="72" rx="8" fill="#1a0e0e" stroke="#dc2626" stroke-width="1.5" />
    <text x="160" y="187" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="12">prix/api — Rush's one DB</text>
    <text x="160" y="205" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="10">users carries Rush product columns; rush:// SSO</text>
    <text x="160" y="262" text-anchor="middle" fill="#f87171" font-family="Inter, system-ui, sans-serif" font-size="11">identity entangled with the revenue product</text>

    <text x="490" y="28" text-anchor="middle" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="700">NOW (Phases A-D)</text>
    <rect x="360" y="45" width="260" height="72" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="490" y="72" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="12">agents-cli identity seam (one client)</text>
    <text x="490" y="90" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="10">lib/identity: 1 base URL · 1 token read</text>
    <line x1="490" y1="117" x2="490" y2="157" stroke="#a3e635" stroke-width="2" marker-end="url(#aG)" />
    <rect x="360" y="160" width="260" height="72" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5" />
    <text x="490" y="187" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="12">agents-id — own Bun/Hono + Supabase</text>
    <text x="490" y="205" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="10">13 endpoints · Google OAuth · stores sub</text>
    <text x="490" y="262" text-anchor="middle" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="11">Phoenix-branded sign-in; zero Rush risk</text>

    <text x="820" y="28" text-anchor="middle" fill="#38bdf8" font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="700">LATER (when users overlap)</text>
    <rect x="690" y="45" width="260" height="72" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5" />
    <text x="820" y="72" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="12">Phoenix ID service (one login)</text>
    <text x="820" y="90" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="10">both products re-auth once via Google</text>
    <line x1="820" y1="117" x2="820" y2="157" stroke="#38bdf8" stroke-width="2" marker-end="url(#aB)" />
    <rect x="690" y="160" width="260" height="72" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5" />
    <text x="820" y="187" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="12">sub-match + scripted re-key</text>
    <text x="820" y="205" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="10">same Google sub → same human</text>
    <text x="820" y="262" text-anchor="middle" fill="#38bdf8" font-family="Inter, system-ui, sans-serif" font-size="11">cheap only if the seven rules held</text>

    <line x1="300" y1="196" x2="352" y2="196" stroke="#666" stroke-width="2" stroke-dasharray="4 4" marker-end="url(#aN)" />
    <line x1="630" y1="196" x2="682" y2="196" stroke="#666" stroke-width="2" stroke-dasharray="4 4" marker-end="url(#aN)" />
    <defs>
      <marker id="aR" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#dc2626" /></marker>
      <marker id="aG" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#a3e635" /></marker>
      <marker id="aB" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#38bdf8" /></marker>
      <marker id="aN" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#666" /></marker>
    </defs>
  </svg>
  <figcaption><b>Figure 1.</b> Detach from the entangled Rush DB now, build the own backend linkable, and make Phoenix ID a deliberate later consolidation instead of a forced merge.</figcaption>
</figure>

## What changes for whom

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">
    <p><strong>Today (shipped 1.22.42/43):</strong> <code>agents auth login</code> device-codes against <code>api.prix.dev</code> — Rush's backend — and silently falls back to the <code>rush login</code> session. <code>agents org</code> manages <em>Rush's</em> spaces; account caps are gated by <em>Rush's</em> billing tier. The sign-in page says "A Rush CLI is trying to sign in."</p>
  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">
    <p><strong>After Phases A-D:</strong> <code>agents auth login</code> device-codes against agents-cli's <em>own</em> backend; the browser page reads <strong>"Sign in with Phoenix · agents-cli"</strong> with Google as the only provider. No <code>rush</code> fallback, no Prix URLs in the identity path. Teams/spaces live in agents-cli's own database. Later, one click re-links the account under the family-wide Phoenix ID.</p>
  </div>
</div>

## Proposed Changes

### Phase A — Detach the shipped Prix coupling (this PR, release 1.22.44)

```text
DELETED  src/lib/prix-account.ts (+test)   src/commands/auth.ts   src/commands/org.ts
DELETED  src/lib/entitlement.ts (+test)
EDITED   src/commands/accounts.ts   (cap/dormant gates removed; registration uncapped)
EDITED   src/commands/insights.ts   (paid gate removed; full report always)
EDITED   src/bootstrap.ts, src/cli/command-registry.ts, src/lib/startup/command-registry.ts
         ('auth'/'org' retired: fail loudly, no auto-correct)
```

Untouched (deliberate Rush *feature* integrations, not identity): `lib/cloud/rush.ts`, `lib/secrets/drivers/rush.ts`, `lib/session/cloud.ts`, `commands/factory.ts`, `lib/channels/owner-sink.ts`.

### Phase B — One identity seam

New `apps/cli/src/lib/identity/` client modeled on the proven seams (`SyncBackend`, `CloudProvider`): one base-URL constant, one token reader, one HTTP funnel, own session file, no `~/.rush/user.yaml` fallback.

### Phase C — The own backend (`agents-id`)

Own Bun/Hono service + own Supabase project implementing the audited contract:

```text
POST /api/v1/auth/device/authorization      # RFC 8628 start
POST /api/v1/auth/device/token              # poll; errors: authorization_pending | slow_down | expired_token | access_denied
GET  /api/v1/auth/me                        # {userId, email, valid}
GET/POST/PATCH/DELETE /api/v1/spaces[...]   # 9 spaces/members/invites routes, audited shapes
GET  /api/v1/billing/subscription?agent=... # {tierName} — "free" for everyone initially
```

**Seven linkability rules (hard requirements):** Google-only IdP; persist the Google `sub` on our user row; opaque internal ids; no passwords, ever; verified-email-only writes; product fields in a separate 1:1 profile table; callback scheme as config, not a literal.

### Phase D — Re-land the CLI surface

`agents auth login/whoami/logout` + `agents auth space` through the Phase-B seam at the Phase-C service; docs + CHANGELOG; release; fleet verify.

### Deferred — Phoenix ID consolidation (ticketed, not built)

When product-user overlap is real: users re-auth once via Google against the unified project (no cross-project auth-row copying — unsupported in Supabase; the `sub` match is the join), then a scripted re-key of `spaces.owner_user_id` / `space_members.user_id`. Rush migrates on its own schedule.

## Public Interface

| Surface | Before (1.22.42/43) | After |
|---|---|---|
| `agents auth login/whoami/logout` | Device-code against `api.prix.dev`, `rush login` fallback | Removed in 1.22.44; returns in Phase D against `agents-id` |
| `agents org` / `agents auth space` | Rush spaces CRUD | Removed; returns as own-backend spaces in Phase D |
| `agents accounts add/name/attach` | Capped 3-per-harness on free (Rush billing tier) | Uncapped; no tier reads |
| `agents insights` | Friction sections + `--by account` paid-gated | Full report, no `plan`/`notice` JSON fields |

## Validation

```text
Phase A: fleet runs 1.22.44; `agents auth` fails loudly as a retired name;
         grep gate: no api.prix.dev in the identity path; suites green (34/34 affected tests)
Phase C: live device-code round-trip from a clean box; Phoenix-branded page screenshotted
Phase D: end-to-end on an installed release, not a dev build
```

## Risks

| Risk | Mitigation |
| --- | --- |
| Linkability rules skipped in Phase C | They are hard requirements in the brief; reviewed against the checklist before merge |
| Dogfooders lose the rush-session freebie | Named cost; one extra login, internal users only |
| Consolidation grows with real user data | Consolidate before general-audience launch; re-key is per-user scripted |
| Second device-code flow drifts from RFC 8628 semantics | Fails loudly; contract pinned by the audited client shapes |

## Workload comparison (stress-tested)

| | Phoenix ID now | Own backend now | Consolidation later (rules held) |
|---|---|---|---|
| Effort | Multi-week; RLS across ~12 tables + 15-table GDPR transaction re-verified | Single-digit agent sessions; contract already specified | A few sessions + scripted re-key |
| Riskiest step | Live identity surgery on the revenue product (silent RLS/GDPR failure modes) | Device-code flow + verification page — fails loudly, self-revealing | Cutover window: stale tokens/invites, slug uniqueness |
| Agent-dispatchable | No — human sign-off per diff | Largely yes | Mostly scripted |

<aside class="artifact-callout"><strong>The real bet is the rules, not the sequencing.</strong> Consolidate-later stays cheap only while both products share one IdP (Google), the <code>sub</code> is persisted, and no passwords exist. Skip those and "later" balloons toward the extraction project's risk profile. Honest cost: dogfooders lose today's shared-session freebie (the <code>rush login</code> fallback) — one extra login, internal users only.</aside>

## Checklist

- [x] Phase A: detach the Prix surface (this PR) → release 1.22.44 → fleet verify
- [ ] Phase B: `lib/identity/` seam
- [ ] Phase C: `agents-id` backend (awaits repo-name/hosting pick)
- [ ] Phase D: re-land `agents auth` against it
- [ ] Re-scope RUSH-2581; file the Phoenix-ID consolidation successor ticket

## Tracking

- [RUSH-2581](https://linear.app/getrush/issue/RUSH-2581/no-human-identity-substrate-ssosaml-cannot-attach-because-there-is-no) — re-scoped: the principal model is the own backend (Phase C)
- Successor ticket (to file): Phoenix ID consolidation — link-by-`sub`, per-product re-key
- Supersedes: PRs #2821/#2822's Prix coupling
