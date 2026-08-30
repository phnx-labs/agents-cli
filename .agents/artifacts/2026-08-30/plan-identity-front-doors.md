---
kind: plan
template: plan.v1
surface: cli
title: 'Phoenix ID as the family identity: one login for agents CLI, prix.dev, and Rush'
summary: >
  agents CLI, rush CLI, and prix.dev present three front doors resolving to two
  unlinked accounts. Decision (Muqsit, 2026-08-30): Phoenix ID becomes the single
  identity for all three. Rush stays a separate product but stops being the identity
  substrate, and neither agents CLI nor prix.dev may require a Rush account.
project: agents-cli
context: 'Supersedes plan-phoenix-identity-sequencing (2026-08-22), whose Phase B/C/D checkboxes are stale — all three shipped. This document reopens its deferred consolidation as a decision.'
repository: phnx-labs/agents-cli
branch: docs/phoenix-identity-current-state
status: approved
date: '2026-08-30'
facts:
  - 'agents CLI identity = Phoenix ID; API https://phoenix-id.muqsitnawaz.workers.dev, browser https://id.byphoenix.com/device (probed live, 200)'
  - 'rush CLI AND prix.dev share one identity: Supabase project lyzihnugrpnfwiubeyko behind api.prix.dev (probed live via /api/v1/auth/config)'
  - 'The shared users table carries 8 product columns; 19 tables are under RLS in prix/api migration 026'
  - 'An agents-cli user needs ONE account and ONE install — rush CLI and prix.dev are not prerequisites'
  - 'The managed share Worker has no quota, no rate limit, and no upload size cap'
  - 'Handle claims are bound to a Phoenix userId: signing in as the same person on a different domain collides with 409 handle taken'
links:
  - 'https://linear.app/getrush/issue/RUSH-2581/no-human-identity-substrate-ssosaml-cannot-attach-because-there-is-no'
---

## Focus for review

- **Decided (Muqsit, 2026-08-30):** Phoenix ID is the family identity. Rush authenticates against it too. Neither agents CLI nor prix.dev may require a Rush account. What follows is the execution shape, not a re-litigation.
- **Open: does prix.dev migrate before or after Rush?** They currently share one `users` table, so the order determines whether we run one cutover or two.
- **Open: what happens to the 8 product columns on `users`?** Recommendation below is a per-product 1:1 profile table, which is also what makes "no Rush account required" true rather than cosmetic.
- **Sequencing constraint, not a preference: the share Worker has no quota.** It is an open write path against our R2 bill and it gates inviting anyone, independent of identity work.

## Purpose

Muqsit, 2026-08-30: *"We want to unify it using the Phoenix ID. Even in Rush, it should use the Phoenix ID. And using agents CLI and the prix.dev platform should not require the user to have a Rush account. Rush is its own separate product."*

Restated as the target: **one human, one Phoenix ID, three products that each decide what that human may do — and no product's account is the price of admission to another.**

<aside class="artifact-callout">
<p><strong>The confusing part and the broken part are different problems.</strong> Today an agents-cli user already needs only one install and one login; the rush CLI and prix.dev are simply undocumented as <em>not</em> being prerequisites, which is a signage bug. The genuinely broken part is on the other side: prix.dev's identity <em>is</em> the Rush account, so using the platform means holding a Rush row. That is the part that needs migration, not wording.</p>
</aside>

## Current architecture

Three surfaces, two identity backends, both Google-only, no join between them.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 980 460" role="img" aria-label="Three product front doors resolving to two separate identity backends: agents CLI to Phoenix ID; rush CLI and prix.dev both to the Prix Supabase project, whose users table carries Rush product columns." xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="fdG" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#a3e635"/></marker>
    <marker id="fdB" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#38bdf8"/></marker>
  </defs>

  <text x="490" y="26" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">WHAT A USER SEES — three doors, no signage</text>

  <rect x="40" y="46" width="260" height="86" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="170" y="72" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600">agents CLI</text>
  <text x="170" y="93" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="10">npm i -g @phnx-labs/agents-cli</text>
  <text x="170" y="112" text-anchor="middle" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="10">fleet control plane</text>

  <rect x="360" y="46" width="260" height="86" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="490" y="72" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600">rush CLI</text>
  <text x="490" y="93" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="10">rush run · rush install</text>
  <text x="490" y="112" text-anchor="middle" fill="#38bdf8" font-family="Inter, system-ui, sans-serif" font-size="10">engine behind the Rush desktop app</text>

  <rect x="680" y="46" width="260" height="86" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="810" y="72" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600">prix.dev</text>
  <text x="810" y="93" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="10">web console · /settings</text>
  <text x="810" y="112" text-anchor="middle" fill="#38bdf8" font-family="Inter, system-ui, sans-serif" font-size="10">platform surface</text>

  <line x1="170" y1="132" x2="170" y2="228" stroke="#a3e635" stroke-width="2" marker-end="url(#fdG)"/>
  <line x1="490" y1="132" x2="700" y2="228" stroke="#38bdf8" stroke-width="2" marker-end="url(#fdB)"/>
  <line x1="810" y1="132" x2="810" y2="228" stroke="#38bdf8" stroke-width="2" marker-end="url(#fdB)"/>

  <text x="490" y="205" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="12">WHAT THEY RESOLVE TO — two accounts</text>

  <rect x="40" y="232" width="260" height="104" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="170" y="258" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600">Phoenix ID</text>
  <text x="170" y="278" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="9">phoenix-id.muqsitnawaz.workers.dev</text>
  <text x="170" y="296" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="9">browser: id.byphoenix.com/device</text>
  <text x="170" y="318" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="10">Google device-code · clean schema</text>

  <rect x="680" y="232" width="260" height="104" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="810" y="258" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600">Prix account (Supabase)</text>
  <text x="810" y="278" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="9">api.prix.dev · lyzihnugrpnfwiubeyko</text>
  <text x="810" y="296" text-anchor="middle" fill="#f87171" font-family="Inter, system-ui, sans-serif" font-size="10">users carries 8 product columns</text>
  <text x="810" y="318" text-anchor="middle" fill="#f87171" font-family="Inter, system-ui, sans-serif" font-size="10">19 tables under RLS · rush_user_id FK</text>

  <line x1="300" y1="284" x2="676" y2="284" stroke="#dc2626" stroke-width="2" stroke-dasharray="6 5"/>
  <text x="488" y="277" text-anchor="middle" fill="#f87171" font-family="Inter, system-ui, sans-serif" font-size="11" font-weight="600">no link — same Google human, two rows</text>

  <rect x="40" y="368" width="900" height="62" rx="8" fill="#111" stroke="#333" stroke-width="1"/>
  <text x="490" y="392" text-anchor="middle" fill="#f87171" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="600">Using the platform means holding a Rush row.</text>
  <text x="490" y="414" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="11">prix.dev and rush CLI are one account, so "no Rush account required" is not true today.</text>
</svg>
<figcaption>Probed live on 2026-08-30. The dashed red edge is the split; the bottom bar is the coupling the decision removes.</figcaption>
</figure>

### Why the split exists

It was deliberate. The 2026-08-22 sequencing plan (RUSH-2581) detached agents-cli identity from `prix/api` because that backend is Rush-entangled. Standing up a separate service was judged single-digit agent sessions against multi-week live surgery on the revenue product. Consolidation was deferred with the join key specified up front: match on the Google `sub`, never on email.

The entanglement is measurable, not rhetorical:

```console
$ grep -hn "ALTER TABLE users ADD COLUMN" prix/api/migrations/*.sql
seed_quota_multiplier   developer_name   developer_enabled_at   cloud_access
workos_user_id          org_id           auth_method            late_profile_id

$ grep -c "ENABLE ROW LEVEL SECURITY" prix/api/migrations/026_enable_rls_all_tables.sql
19

$ grep -n "rush_user_id" prix/api/migrations/066_channel_installations.sql
17:  rush_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
```

Eight product columns sit directly on the identity row. That is what makes `users` a Rush table wearing an identity table's name.

### What has shipped since that plan

The superseded document's checklist still shows Phases B, C, and D unchecked. All three landed:

| Phase | Old status | Reality on 2026-08-30 |
|---|---|---|
| A — detach Prix coupling | done | done (1.22.44) |
| B — one identity seam | unchecked | shipped: `cli/src/lib/identity/client.ts` |
| C — own backend | unchecked | shipped and live; device-code round-trip verified |
| D — re-land CLI surface | unchecked | shipped: `agents auth login/whoami/logout`, `agents auth space` |
| Phoenix ID consolidation | deferred | **this document** — now decided |

## Proposed architecture

Phoenix ID becomes the root identity. Each product keeps its own database and its own authorization, and holds a 1:1 profile row keyed by the Phoenix user id. No product's row is a prerequisite for another's.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 980 420" role="img" aria-label="Target architecture: Phoenix ID as the single identity root, with agents CLI, prix.dev, and Rush each holding an independent per-product profile table keyed by the Phoenix user id." xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="tgG" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#a3e635"/></marker>
  </defs>

  <rect x="330" y="34" width="320" height="84" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="2"/>
  <text x="490" y="62" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="15" font-weight="700">Phoenix ID</text>
  <text x="490" y="83" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="10">id.byphoenix.com · Google sub is the join key</text>
  <text x="490" y="102" text-anchor="middle" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="10">identity only — no product columns, ever</text>

  <line x1="420" y1="118" x2="170" y2="196" stroke="#a3e635" stroke-width="2" marker-end="url(#tgG)"/>
  <line x1="490" y1="118" x2="490" y2="196" stroke="#a3e635" stroke-width="2" marker-end="url(#tgG)"/>
  <line x1="560" y1="118" x2="810" y2="196" stroke="#a3e635" stroke-width="2" marker-end="url(#tgG)"/>

  <rect x="40" y="200" width="260" height="104" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="170" y="226" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600">agents CLI</text>
  <text x="170" y="248" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="9">spaces · share handles</text>
  <text x="170" y="272" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="10">already here — no migration</text>
  <text x="170" y="292" text-anchor="middle" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="10">✓ done</text>

  <rect x="360" y="200" width="260" height="104" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="490" y="226" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600">prix.dev</text>
  <text x="490" y="248" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="9">prix_profiles(phoenix_user_id)</text>
  <text x="490" y="272" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="10">cloud_access, quotas, org_id</text>
  <text x="490" y="292" text-anchor="middle" fill="#fbbf24" font-family="Inter, system-ui, sans-serif" font-size="10">migrate — no Rush row required</text>

  <rect x="680" y="200" width="260" height="104" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="810" y="226" text-anchor="middle" fill="#f2f2f2" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600">Rush</text>
  <text x="810" y="248" text-anchor="middle" fill="#9ca3af" font-family="JetBrains Mono, monospace" font-size="9">rush_profiles(phoenix_user_id)</text>
  <text x="810" y="272" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="10">seed quota, developer mode, late_profile</text>
  <text x="810" y="292" text-anchor="middle" fill="#fbbf24" font-family="Inter, system-ui, sans-serif" font-size="10">migrate — own product, own schedule</text>

  <rect x="40" y="336" width="900" height="62" rx="8" fill="#111" stroke="#333" stroke-width="1"/>
  <text x="490" y="360" text-anchor="middle" fill="#a3e635" font-family="Inter, system-ui, sans-serif" font-size="12" font-weight="600">One login. Three independent authorization stores.</text>
  <text x="490" y="382" text-anchor="middle" fill="#9ca3af" font-family="Inter, system-ui, sans-serif" font-size="11">A missing profile row means "not entitled to that product", never "cannot sign in".</text>
</svg>
<figcaption>Target state. The load-bearing rule is the caption: absence of a product profile is an authorization answer, not an authentication failure.</figcaption>
</figure>

## What a user actually has to do

<figure class="artifact-figure artifact-behavior">
  <section data-state="current" data-evidence="capture">
    <p><strong>Today.</strong> The agents-cli path is already one install and one login — but nothing says so, and prix.dev genuinely does hand you a Rush account.</p>
<pre><code>$ npm i -g @phnx-labs/agents-cli
$ agents auth login
  Your code:  2VQZ-RZ44
  Open:       https://id.byphoenix.com/device?code=2VQZ-RZ44
$ agents artifacts share plan.html
  https://share.agents-cli.sh/&lt;handle&gt;/&lt;slug&gt;

# rush CLI:  not needed — but nothing tells you that
# prix.dev:  signing in creates a row in Rush's users table
</code></pre>
  </section>
  <section data-state="proposed" data-evidence="mockup">
    <p><strong>After.</strong> Same commands. One Phoenix ID works across all three surfaces, and each product answers separately for what you may do there.</p>
<pre><code>$ agents auth login

  Sign in to Phoenix ID — one account across agents CLI,
  prix.dev, and Rush. Google only; no password reaches the CLI.

  Signed in as ada (at your workspace domain)
  Your pages: share.agents-cli.sh/ada

$ open https://prix.dev        # same login, no Rush account created
$ rush login                   # same login, Rush entitlements resolved separately
</code></pre>
  </section>
</figure>

| Surface | Needed by an agents-cli user? | Account after this change |
|---|---|---|
| `agents` CLI | **yes** — the product | Phoenix ID |
| prix.dev | no | Phoenix ID; `prix_profiles` row created on first use |
| `rush` CLI | no | Phoenix ID; `rush_profiles` row, separate entitlements |

Signing in stays optional for agents-cli. Every local feature — running agents, sessions, teams, devices, secrets — works with no account. Phoenix ID buys publishing to `share.agents-cli.sh` and team spaces.

## Proposed Changes

**1. Give Phoenix ID a real hostname.** Every installed binary currently authenticates against a personal `workers.dev` URL. `id.byphoenix.com` already serves the browser half.

```diff
--- a/cli/src/lib/identity/client.ts
+++ b/cli/src/lib/identity/client.ts
@@
 export const PHOENIX_ID_BASE =
-  process.env.PHOENIX_ID_BASE ?? 'https://phoenix-id.muqsitnawaz.workers.dev';
+  process.env.PHOENIX_ID_BASE ?? 'https://id.byphoenix.com';
```

The share Worker's `PHOENIX_ID_BASE` binding moves in the same release — it calls `/api/v1/auth/me` against that base to verify every publish, so a split leaves clients presenting tokens the Worker cannot verify.

**2. Split product state off the identity row.** This is what makes "no Rush account required" structurally true rather than a docs claim.

```diff
--- /dev/null
+++ b/prix/api/migrations/0NN_phoenix_identity_split.sql
+-- Identity becomes a foreign key, not a home for product state.
+ALTER TABLE users ADD COLUMN IF NOT EXISTS phoenix_user_id UUID UNIQUE;
+ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE;
+
+CREATE TABLE IF NOT EXISTS rush_profiles (
+  phoenix_user_id       UUID PRIMARY KEY,
+  seed_quota_multiplier INTEGER NOT NULL DEFAULT 1,
+  developer_name        TEXT,
+  developer_enabled_at  TIMESTAMPTZ,
+  late_profile_id       TEXT
+);
+
+CREATE TABLE IF NOT EXISTS prix_profiles (
+  phoenix_user_id UUID PRIMARY KEY,
+  cloud_access    BOOLEAN NOT NULL DEFAULT FALSE,
+  org_id          UUID REFERENCES organizations(id)
+);
```

Backfill joins on `google_sub`, never on email — the rule the superseded plan made load-bearing and the reason this stays cheap.

**3. Point Rush's login at Phoenix ID.** `rush login` currently fetches Supabase config from `api.prix.dev/api/v1/auth/config` and runs its own Google OAuth and device flow (`rush/cli/internal/cli/login.go`). Both flows collapse onto the Phoenix ID device-code endpoints the agents CLI already uses.

**4. Say it in the CLI.** Until the migration lands, the signage bug is fixable on its own:

```diff
--- a/cli/src/commands/auth.ts
+++ b/cli/src/commands/auth.ts
@@ async function login(): Promise<void> {
   const grant = await startDeviceAuthorization();
+  console.log('');
+  console.log('  Sign in to Phoenix ID — one account for agents-cli.');
+  console.log(chalk.gray('  Google only; the CLI never sees a password.'));
```

## Public Interface

| Surface | Before | After |
|---|---|---|
| `PHOENIX_ID_BASE` default | `phoenix-id.muqsitnawaz.workers.dev` | `id.byphoenix.com`; env override unchanged |
| Share Worker binding | workers.dev | `id.byphoenix.com`, redeployed with the release |
| `rush login` | Supabase OAuth via `api.prix.dev` | Phoenix ID device code |
| prix.dev sign-in | creates a Rush `users` row | creates a `prix_profiles` row only |
| `agents auth login` | prints code and URL | also names the account and its scope |

## Plan

- [ ] Attach `id.byphoenix.com` to the Phoenix ID Worker; flip the shipped default; move the share Worker binding in the same release
- [ ] Add per-user quota and an upload size cap to the share Worker — **blocks any third-party invitation**
- [ ] Add an explicit handle choice so a domain change does not dead-end on `409 handle taken`
- [ ] `prix/api`: add `phoenix_user_id` + `google_sub`, create `rush_profiles` / `prix_profiles`, backfill by `sub`
- [ ] Move prix.dev sign-in to Phoenix ID; verify no Rush row is created
- [ ] Move `rush login` to Phoenix ID device code
- [ ] Land the `agents auth login` copy change and a README section naming the one account

## Validation

```bash
# 1. The shipped default no longer names a personal hostname
grep -n 'PHOENIX_ID_BASE =' cli/src/lib/identity/client.ts

# 2. Device-code round trip against the new base, from a clean box
PHOENIX_ID_BASE=https://id.byphoenix.com agents auth login && agents auth whoami --json

# 3. A publish still verifies — proves the Worker binding moved too
agents artifacts share /tmp/probe.html && curl -sI <returned-url> | head -1

# 4. A fresh prix.dev sign-in creates NO Rush row
psql -c "select count(*) from users where phoenix_user_id = '<new-id>';"   # expect 0
psql -c "select count(*) from prix_profiles where phoenix_user_id = '<new-id>';" # expect 1

# 5. Quota actually rejects
for i in $(seq 1 200); do agents artifacts share /tmp/probe.html --slug "q$i"; done
```

Proof is the installed release doing the round trip, not a dev build.

## Risks

| Risk | Concrete failure | Mitigation |
|---|---|---|
| Handle is bound to a userId, not a human | Handles derive from the email local-part and are then claimed for one Phoenix userId. Two accounts of the *same human* on different domains share a handle only when the local-parts match — and then the second gets `409 handle taken` (`cli/src/lib/share/worker-template.ts:1304`) with no way to pick another. Not currently biting the owner, whose two local-parts differ, so the workspace handle is free | Link identities by `google_sub`; add an explicit handle choice so this is recoverable rather than a dead end |
| `org` visibility is unreachable from a personal-inbox account | **Reproduced live:** publishing with `--visibility org` from a `gmail.com` session returns `400 {"error":"org visibility cannot use a public email domain"}`. Company-internal sharing therefore requires signing in with the workspace-domain Google account | No code change needed today — sign in with the workspace account. The CLI should say this instead of surfacing a generic 400 |
| Worker binding not moved with the client default | Clients present tokens minted by the new base while the Worker verifies against the old host — every publish 401s. `phoenixIdBaseForDeploy` (`cli/src/lib/share/backend.ts:118`) throws on an empty base, which catches only the blank case | Move both in one release; the release already redeploys the share Worker (`--deploy-worker auto`) |
| Opening the door before quota lands | No rate limit, per-user byte cap, or throttle exists anywhere in `cli/src/lib/share/worker-template.ts`. Any Google account can PUT unbounded objects into our R2 bucket | Quota is sequenced ahead of invitations |
| Migrating identity on the revenue product | 19 tables under RLS and 8 product columns on `users`; a wrong policy silently returns empty result sets rather than erroring | Additive columns first, backfill, dual-read, then cut over; never a destructive single step |
| Backfill joined on email | Two humans share an email local-part across domains, or one person changes address, and rows merge wrongly | Join on `google_sub` only — the rule holds while both stay Google-only with no passwords |
| Users hit the 30-day expiry unaware | `DEFAULT_SHARE_EXPIRE = '30d'` (`cli/src/lib/share/publish.ts:388`); the Worker 410s afterward | State it at publish time, or lengthen it for signed-in users |

## Tracking

- [RUSH-2581](https://linear.app/getrush/issue/RUSH-2581/no-human-identity-substrate-ssosaml-cannot-attach-because-there-is-no) — the principal model; Phases A-D delivered
- Supersedes `.agents/artifacts/2026-08-22/plan-phoenix-identity-sequencing.md`
- Tickets to file: Phoenix ID hostname cutover · share Worker quota + upload cap · explicit share handle · prix/api identity split · prix.dev onto Phoenix ID · rush login onto Phoenix ID
