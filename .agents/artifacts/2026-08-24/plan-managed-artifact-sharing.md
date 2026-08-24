---
kind: plan
surface: cli
title: 'Managed artifact sharing — the first payoff of a Phoenix account'
summary: 'Signed-in users share artifacts with zero Cloudflare setup, on the already-live share.agents-cli.sh, with server-enforced visibility. Ships in three honest phases: public+unlisted now, org-by-domain and view-analytics as fast-follows.'
status: draft
tracking: 'AGI / Distribution → first converts'
links:
  - 'https://phoenix-id.muqsitnawaz.workers.dev'
---

> **Status: NOT landed. This is the plan — nothing has been built or dispatched yet.**
> Reshaped 2026-08-24 after grounding research: the platform endpoint already exists,
> the org tier is a cross-service fast-follow, and view-analytics is greenfield.

## Focus for review

- **Phasing (the main call).** Ship **Phase 1 — managed public + unlisted** now (delivers the whole "sign in → share, no Cloudflare" payoff). Treat **org-by-domain** and **view-analytics** as fast-follows, because each has a real dependency Phase 1 does not. Confirm, or ask for a different cut.
- **Org tier's real cost.** A *browser viewer* of `share.agents-cli.sh/<user>/<slug>` sends no Phoenix bearer, so the org gate needs a **browser session/redirect-callback flow** added to the Phoenix ID worker (`phnx-labs/phoenix-id` — a Cloudflare Worker with Google OAuth already, reachable, not local) plus a callback + GET gate in the share worker. Cross-repo and auth-sensitive, but buildable — so org is a phased **fast-follow**, not a hard blocker. The only genuine your-call item: is touching the identity backend in the same push acceptable, or should P2 be sequenced after P1 ships?
- **No new infra needed for Phase 1.** The worker `agents-share` + R2 bucket already run on CF account `cba808…`, live at `share.agents-cli.sh`. Managed = a Phoenix-auth multi-tenant layer *on the worker already deployed*, redeployed from the box that holds the `cloudflare` bundle + `share` token (**zion**, not this box).
- **Domain resolved.** `share.agi-cli.sh` does **not** resolve / is unregistered; `share.agents-cli.sh` is live and wired through the code. Build on the live domain, hostname stays a swappable config; the `agi-cli.sh` rebrand is a later DNS + one-line flip.

## Purpose

A Phoenix account today unlocks spaces CRUD and nothing a user can feel. Give it a concrete
first payoff: **sign in → share an artifact instantly, no Cloudflare account, no bucket, no
worker, no token** — permissions controlled server-side. It is the free lure that makes an
account worth having, and the on-ramp to the paid agent-cloud (Prix) later.

## Current architecture

Sharing today is **bring-your-own-Cloudflare**: each user provisions their own R2 bucket +
Worker + static write-token (`lib/share/config.ts:41-47`, `worker-template.ts:55-58`). The
worker already stamps `customMetadata.visibility` and hides `unlisted` from listings
(`worker-template.ts:97,214-215,280`) — but **the GET path enforces nothing**
(`worker-template.ts:166-178` serves any found object unconditionally). Managed reuses the
same worker/R2 shape and swaps static-token auth for Phoenix-token auth, keyed per user.

<figure class="artifact-figure artifact-figure-wide">
<svg viewBox="0 0 940 440" role="img" aria-label="Managed artifact sharing data path" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif">
  <defs>
    <marker id="ag" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#a3e635"/></marker>
    <marker id="ab" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#38bdf8"/></marker>
  </defs>
  <text x="30" y="30" fill="#a3e635" font-size="12" font-weight="700">PUBLISH (writer, signed in) — Phase 1</text>
  <rect x="30" y="45" width="200" height="70" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="45" y="72" fill="#f2f2f2" font-size="13">agents artifacts share</text>
  <text x="45" y="92" fill="#9ca3af" font-family="monospace" font-size="10.5">managed driver reads</text>
  <text x="45" y="106" fill="#9ca3af" font-family="monospace" font-size="10.5">phoenix-session.json</text>
  <path d="M230 80 L330 80" stroke="#a3e635" stroke-width="2" fill="none" marker-end="url(#ag)"/>
  <text x="243" y="72" fill="#9ca3af" font-family="monospace" font-size="10.5">PUT +bearer</text>
  <rect x="330" y="45" width="220" height="70" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="345" y="70" fill="#f2f2f2" font-size="13">agents-share Worker</text>
  <text x="345" y="88" fill="#9ca3af" font-family="monospace" font-size="10.5">verify bearer to userId</text>
  <text x="345" y="102" fill="#9ca3af" font-family="monospace" font-size="10.5">key: &lt;user&gt;/&lt;slug&gt;-&lt;uuid&gt;</text>
  <path d="M550 80 L650 80" stroke="#a3e635" stroke-width="2" fill="none" marker-end="url(#ag)"/>
  <rect x="650" y="45" width="200" height="70" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="665" y="70" fill="#f2f2f2" font-size="13">R2 (already live)</text>
  <text x="665" y="90" fill="#9ca3af" font-family="monospace" font-size="10.5">object + customMetadata:</text>
  <text x="665" y="104" fill="#9ca3af" font-family="monospace" font-size="10.5">visibility, owner, org_domain</text>
  <rect x="330" y="150" width="220" height="56" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="345" y="174" fill="#f2f2f2" font-size="13">Phoenix ID (workers.dev)</text>
  <text x="345" y="192" fill="#9ca3af" font-family="monospace" font-size="10.5">GET /api/v1/auth/me to userId,email</text>
  <path d="M440 150 L440 116" stroke="#38bdf8" stroke-width="2" fill="none" marker-end="url(#ab)"/>
  <text x="30" y="262" fill="#38bdf8" font-size="12" font-weight="700">FETCH (viewer) — enforced at the edge, never the client</text>
  <rect x="30" y="285" width="170" height="60" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="45" y="312" fill="#f2f2f2" font-size="13">Anyone</text>
  <text x="45" y="330" fill="#9ca3af" font-family="monospace" font-size="10.5">GET /&lt;user&gt;/&lt;slug&gt;</text>
  <path d="M200 315 L300 315" stroke="#38bdf8" stroke-width="2" fill="none" marker-end="url(#ab)"/>
  <rect x="300" y="270" width="250" height="150" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="315" y="295" fill="#f2f2f2" font-size="13">Worker: enforce by visibility</text>
  <text x="315" y="320" fill="#a3e635" font-family="monospace" font-size="10.5">public   to serve, listed  [P1]</text>
  <text x="315" y="340" fill="#a3e635" font-family="monospace" font-size="10.5">unlisted to serve, noindex [P1]</text>
  <text x="315" y="360" fill="#f59e0b" font-family="monospace" font-size="10.5">org      to browser session  [P2]</text>
  <text x="333" y="374" fill="#f59e0b" font-family="monospace" font-size="10.5">302 phoenix login to cookie</text>
  <text x="315" y="398" fill="#f59e0b" font-family="monospace" font-size="10.5">domain(viewer)==org_domain</text>
  <path d="M550 320 L650 320" stroke="#38bdf8" stroke-width="2" fill="none" marker-end="url(#ab)"/>
  <rect x="650" y="290" width="200" height="60" rx="8" fill="#0a1420" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="665" y="316" fill="#f2f2f2" font-size="13">Rendered artifact</text>
  <text x="665" y="334" fill="#9ca3af" font-family="monospace" font-size="10.5">share.agents-cli.sh/&lt;user&gt;/…</text>
  <path d="M420 270 L440 210" stroke="#38bdf8" stroke-width="2" fill="none" marker-end="url(#ab)"/>
</svg>
<figcaption><b>Figure 1.</b> Phase 1 (lime) ships now: upload authorized by the Phoenix token the CLI already stores at <code>phoenix-session.json</code>; the worker verifies via <code>/api/v1/auth/me</code>, stamps <code>visibility</code> into R2, and enforces public/unlisted on GET. The org tier (amber, Phase 2) needs a browser session handshake with the Phoenix ID worker — external source, cross-service.</figcaption>
</figure>

<figure class="artifact-figure artifact-behavior">
  <section data-state="current" data-evidence="mockup">
    <h4>Today — bring your own Cloudflare</h4>
    <pre><code>$ agents artifacts share plan.html
✗ No share endpoint configured.
  Run 'agents artifacts setup' first:
    - create a Cloudflare R2 bucket
    - deploy the share Worker
    - mint a write token
  (needs your own Cloudflare account)</code></pre>
  </section>
  <section data-state="proposed" data-evidence="mockup">
    <h4>After — managed, account-gated (Phase 1)</h4>
    <pre><code>$ agents auth login          # once
$ agents artifacts share plan.html --visibility unlisted
  https://share.agents-cli.sh/muqsit/managed-sharing-plan-a1b2c3d4
    "Managed sharing plan"
    visibility: unlisted (noindex, hidden from gallery)
    expires never</code></pre>
  </section>
</figure>

## The three phases

| Phase | Scope | Buildable now? | Dependency |
|---|---|---|---|
| **P1 — public + unlisted** | Phoenix-bearer PUT auth on the worker; managed CLI driver + `--visibility public\|unlisted`; signed-in default; keep BYO | **Yes, fully.** Code + tests land now; deploy from zion (holds `cloudflare` + `share`) | none for code; deploy creds on zion |
| **P2 — org by domain** | Worker GET requires a Phoenix **browser session**, resolves viewer's verified-email domain, compares to owner's | **Cross-repo.** Add a browser session/redirect-callback flow to `phnx-labs/phoenix-id`, plus the org GET gate here | identity backend edit (`phnx-labs/phoenix-id`, reachable) |
| **P3 — analytics + search** | Per-artifact view counter + `/view` beacon + "N views"; `artifacts list` `--since` / text / `--meta` filters (subsumes RUSH-2756) | **Yes** (parallel to P1). Analytics is greenfield; prix/api is the reference pattern | Cloudflare-native counter (D1/KV/DO) |

Server-side enforcement is the whole point: the CLI only *declares* visibility; the worker
*enforces* it on every GET, and for org it reads the viewer's domain from Phoenix's *verified*
(Google-only) email — never a client claim. A gmail/outlook owner gets public + unlisted only.

<div class="artifact-callout"><strong>The platform endpoint already exists.</strong> Worker <code>agents-share</code> + its R2 bucket are live on <code>share.agents-cli.sh</code> today. Managed sharing is a Phoenix-auth multi-tenant layer <em>on the worker already deployed</em> — so <strong>Phase 1 ships the entire "sign in → share, no Cloudflare" payoff with no new infrastructure</strong>, redeployed from the box that holds the credentials. The org tier is the only piece that reaches outside this repo.</div>

## Proposed changes

### Phase 1 — worker PUT auth (the load-bearing diff)

The worker already stamps `visibility` and hides `unlisted` from listings; Phase 1 swaps the
static-token check for a Phoenix bearer and stamps the owner.

```diff
# apps/cli/src/lib/share/worker-template.ts  (managed variant, PUT path ~55-97)
- const presented = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
- if (!env.WRITE_TOKEN || !safeEqual(presented, env.WRITE_TOKEN)) return json({ error: 'unauthorized' }, 401);
+ const claims = await verifyPhoenixToken(request, env);   // GET {PHOENIX_ID_BASE}/api/v1/auth/me → {userId,email}; 401 if absent/invalid
+ // key namespace is the verified userId, so a user cannot write into another's prefix
+ const owner = claims.userId;
  const visibility = normalizeVisibility(request.headers.get('x-share-visibility')); // public|unlisted (org → 400 in P1)
  customMetadata['visibility'] = visibility;
+ customMetadata['owner'] = owner;
```

```diff
# GET path — add the noindex header unlisted already implies (worker-template.ts ~166-178)
+ if (o.customMetadata?.visibility === 'unlisted') headers['X-Robots-Tag'] = 'noindex';
  return new Response(body, { headers });
```

### Phase 1 — CLI provider seam + managed driver

```diff
# apps/cli/src/lib/share/  — a ShareBackend seam beside today's BYO worker calls
+ export interface ShareBackend { publish(...): Promise<PublishResult>; list(...): Promise<ShareListItem[]>; }
+ // managed-backend.ts: reads ~/.agents/.cache/state/phoenix-session.json (identity/client.ts:readSession)
+ //                     sends Authorization: Bearer <access_token> to the managed endpoint
+ // byo-backend.ts:     today's static WRITE_TOKEN path, untouched
+ // pick(): signed-in (readSession() != null) => managed; else BYO
```

```diff
# apps/cli/src/commands/share.ts  — visibility flag replaces the boolean
- .option('--unlisted', 'hide from the public gallery ...')
- .option('--private', 'alias of --unlisted')
+ .option('--visibility <level>', 'public | unlisted (managed adds org later); default public', 'public')
+ // keep --unlisted/--private as hidden aliases mapping to --visibility unlisted (no breakage)
```

### Phase 2 — org GET gate (deferred, shown for completeness)

```diff
# GET path — org gate, BLOCKED on the Phoenix ID worker exposing a browser session
+ if (o.customMetadata?.visibility === 'org') {
+   const viewer = await sessionFromRequest(request, env);   // Phoenix cookie/bearer — NEEDS a browser session flow in phnx-labs/phoenix-id
+   if (!viewer) return Response.redirect(loginUrl(env, request.url), 302);
+   if (orgDomainOf(viewer.email) !== o.customMetadata.org_domain) return new Response('Not found', { status: 404 });
+ }
```

## Public interface

| Surface | Before | After (Phase 1) |
|---|---|---|
| First share | `agents artifacts setup` → provision own Cloudflare | `agents auth login` once → `agents artifacts share <file>` just works |
| Auth | static per-endpoint write token | Phoenix bearer from `phoenix-session.json` (already stored by `agents auth`) |
| Visibility | `--unlisted` (2 states, listing-only) | `--visibility public\|unlisted` (GET-enforced; `org` in P2) |
| Hosting | user's own Cloudflare account | the already-live managed `agents-share` on `share.agents-cli.sh` |
| BYO-Cloudflare | the only option | **kept** for power users / custom domains / self-host |

URL model: `share.agents-cli.sh/<userId-or-username>/<readable-slug>-<uuid>` — the `-<uuid>`
suffix is the unguessable-link entropy for **unlisted** and slug-collision protection for public.

## Validation

```text
P1 public   → curl the URL unauthenticated → 200 + present in /<user> gallery JSON
P1 unlisted → curl the URL → 200 + X-Robots-Tag: noindex + ABSENT from gallery JSON
P1 auth     → PUT with no/invalid bearer → 401; PUT with a valid Phoenix bearer → 200, owner stamped
P1 BYO      → an existing BYO config still publishes unchanged (no regression)
P2 org      → (fast-follow) matching-domain browser session → 200; stranger/none → 302 login / 404
P3 views    → GET then read listing JSON → view_count incremented; "N views" rendered
```

Seam verification runs from **zion** (signed in to Phoenix; holds `cloudflare` + `share`), against
the redeployed worker — quote every HTTP response.

## Risks

| Risk | Mitigation |
|---|---|
| Org tier leaks across domains | Server-side only; domain from *verified* (Google) email; P2 seam test includes a stranger fetch |
| Org tier touches auth-critical identity backend | Phase it: P1 ships the payoff without it; P2 is a separate, reviewed cross-repo push to `phnx-labs/phoenix-id` + the share worker |
| Abuse of free managed hosting | Per-user quota + object TTL on the worker; account-gated uploads give a revocation handle |
| Worker redeploy needs creds not on the build box | Deploy + verify from zion (`cloudflare` + `share` bundles); build tracks produce code only |
| BYO users regress | BYO driver untouched; managed added alongside; existing configs keep working |

## Tracking

- File under **AGI**, linked to the Phoenix-ID line and the "Distribution → first converts" milestone.
- P1 dispatched as a 2-track team (worker auth + CLI driver/flag), worktree-isolated, on worker boxes.
- P2 (org) and P3 (analytics + search) are follow-on tickets; RUSH-2756 (`--meta` filter) folds into P3.
