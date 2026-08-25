---
kind: plan
surface: cli
title: Make the account the unit of load balancing
summary: >-
  `--strategy balanced` load-balances across version homes, not accounts, and
  `agents accounts attach` never seeds the one field that makes an account real
  (`.claude.json` oauthAccount.emailAddress) — so setup-token accounts are
  invisible to balancing. Make add/attach seed identity, then let balancing
  enumerate the account pool directly.
status: draft
tracking: RUSH-3182
links:
  - url: https://linear.app/phnx/issue/RUSH-3182
    label: RUSH-3182
---

## Focus for review

Seven decisions carry this change. Everything else follows from them.

1. **The `(agent, account)` pair — not the version home, not the bare account — is the
   unit of balancing.** The same email signed into Claude and into Codex is **two
   distinct accounts** (different providers, different credentials); `buildIdentityKey`
   already keys identity as `${agent}:…` (`agents.ts:2669`), so balancing Claude never
   touches the Codex login. Today `collectRunCandidates` instead enumerates one candidate
   per installed version home (`rotate.ts:753`) — the reason "8 accounts" needs "8
   versions."
2. **`agents accounts attach` today is a no-op with a success message** — it writes a
   registry record + `.oauth_token` but not the `oauthAccount` identity that balancing
   and headless exec read, so the account stays invisible. Seeding that identity is a
   **Claude-only** bridge (the pivot is Claude's `oauthAccount`); the cross-harness fix
   is Layer 2. See [Harness parity](#harness-parity).
3. **Identity must be captured and stored on the account record** — it has no
   `email`/UUID fields today (`apps/cli/src/lib/account-registry.ts:29-38`). A
   setup-token is opaque, so we capture identity from the `auth` bundle key slug
   plus a `user:profile` fetch when the scope is present.
4. **Workers use setup-tokens, never per-device logins.** You log in once per account
   on your personal box, mint a `claude setup-token` (long-lived, non-rotating), store it
   in the shared `auth` bundle, and sync it to every device — **8 mints total, not 8×11
   logins**. Verified on m1: `muqsit@getrush.ai` already works this way (no credential
   file, setup-token only). The bug is only that a home needs its `oauthAccount` seeded to
   be visible. A **stray** real `.credentials.json` (a rotating refresh token — the
   revocation hazard) was found on m1's `muqsitnawaz@icloud.com` home; the migration
   removes it and re-seeds it as a setup-token account.
5. **The balanceable unit is a (harness, account) binding, not a version home.** An
   account is a credential identity (OAuth / long-lived token / API-key); one account
   can bind to several harnesses (an OpenRouter key runs Codex and Claude); `label`
   names the binding. See [Account model](#account-model).
6. **Bindings are inferred; `attach` is an override.** A native login, or an added
   token/key whose provider can auth the harness, puts an account in the pool with no
   `attach`. `attach` survives only to pin a deliberate 1:1. See
   [The binding is inferred](#the-binding-is-inferred-not-created).
7. **Layer 2 is the harness-parity fix; Layer 1 is an optional Claude bridge.**
   Enumerating the account pool and injecting via `envFor` works for claude, codex, grok,
   cursor, kimi, opencode uniformly. The Claude identity-seed (Layer 1) only helps Claude's
   setup-token special case and does not generalize. For the six-harness goal, build
   Layer 2. See [Harness parity](#harness-parity).

<div class="artifact-callout artifact-callout-danger">
Proven on <code>yosemite-m1</code>, not assumed: seeding only the
<code>oauthAccount</code> identity block (email + accountUuid + organizationUuid;
<strong>no</strong> <code>.credentials.json</code>) flipped a dead version home to
signed-in in <code>agents view</code> and it ran headless via the injected
setup-token (returned <code>PONG</code>). Balanced then rotated across the newly
live accounts.
</div>

## Purpose

Restating the ask: the manual `agents accounts attach` step feels wrong. Installing
a Claude/Codex version and logging in should be enough — the account should just
participate. `label` should only name a login; manual attach should exist only for
API-key style setups. And `--strategy balanced` must actually load-balance across
different accounts by how much usage each has left. This plan makes that true and
grounds every claim in the current implementation.

## Account model

The unit definitions this plan commits to — the vocabulary everything below uses.

An **account is a credential identity**, defined independently of any harness, in
one of three kinds:

- **OAuth flow** — an interactive login (`claude /login`, `codex login`). Carries a
  rotating refresh token and is machine-bound; copying it across machines revokes it.
- **Long-lived token** — a `setup-token` / bearer that does not rotate. Safe to share
  across the fleet; this is the worker-safe credential.
- **API key** — a provider key (OpenRouter, an Anthropic API key). No login, no
  rotation, provider-scoped.

**Identity is `(agent, account)`, not the email.** The same email can be a Claude login
*and* a Codex login — different providers (Anthropic vs OpenAI), different credentials —
so it counts as **two accounts**. The identity key is already agent-scoped
(`buildIdentityKey` → `${agent}:…`, `agents.ts:2669`), so each harness owns a separate
pool and balancing Claude never selects the Codex login, even when the email string is
identical.

A **label is a (harness ⇄ account) binding** — the specific harness tied to an
account is the thing you name. One account can back **several harnesses**: an
OpenRouter API key runs both Codex and Claude, so it holds one binding per harness,
each independently labeled and independently load-balanced *within that harness's
pool*. Balancing for harness H enumerates the accounts bound to H, weighted by each
account's remaining usage.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 900 380" role="img" aria-label="Accounts of three kinds bind to harnesses; one API-key account fans out to multiple harnesses; each binding is a label" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="900" height="380" fill="#0b0f0d"/>
  <text x="40" y="34" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#8a8a8a">ACCOUNTS (credential identity)</text>
  <text x="640" y="34" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#8a8a8a">HARNESSES</text>
  <text x="360" y="34" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#8a8a8a">LABEL = (harness &#8646; account)</text>

  <rect x="40" y="56" width="230" height="60" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="54" y="80" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">dev@getrush.ai</text>
  <text x="54" y="99" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">OAuth flow · rotating · machine-bound</text>

  <rect x="40" y="150" width="230" height="60" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="54" y="174" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">social@swarmify.co</text>
  <text x="54" y="193" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">long-lived token · shareable</text>

  <rect x="40" y="244" width="230" height="60" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="54" y="268" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">openrouter-primary</text>
  <text x="54" y="287" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">API key · provider-scoped · multi-harness</text>

  <rect x="670" y="86" width="190" height="52" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="684" y="116" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">claude</text>

  <rect x="670" y="222" width="190" height="52" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="684" y="252" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">codex</text>

  <line x1="270" y1="86" x2="670" y2="104" stroke="#a3e635" stroke-width="1.5"/>
  <rect x="392" y="70" width="116" height="22" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1"/>
  <text x="404" y="85" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">claude#dev</text>

  <line x1="270" y1="180" x2="670" y2="118" stroke="#38bdf8" stroke-width="1.5"/>
  <rect x="392" y="150" width="132" height="22" rx="6" fill="#0e1418" stroke="#38bdf8" stroke-width="1"/>
  <text x="404" y="165" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">claude#social</text>

  <line x1="270" y1="270" x2="670" y2="130" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 3"/>
  <line x1="270" y1="278" x2="670" y2="248" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 3"/>
  <rect x="392" y="238" width="150" height="22" rx="6" fill="#16120a" stroke="#f59e0b" stroke-width="1"/>
  <text x="404" y="253" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">claude#or · codex#or</text>

  <text x="40" y="344" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">One API-key account (amber) fans out to BOTH harnesses — two labels, two independent balancing pools.</text>
</svg>
<figcaption>Accounts are credential identities; a label is one (harness &#8646; account) binding. Auth injection follows the account kind: OAuth &#8594; native creds, token &#8594; CLAUDE_CODE_OAUTH_TOKEN, API key &#8594; provider env.</figcaption>
</figure>

<div class="artifact-callout">
This sharpens "make the account the unit of balancing": the balanceable unit is a
<strong>(harness, account) binding</strong>. <code>label</code> names it; the account's
<em>kind</em> decides how the credential is injected at exec. An API-key account is
bound to many harnesses; an OAuth/token account is typically one.
</div>

### The binding is inferred, not created

You should not have to run `attach`. A binding is inferred from two facts that already
exist:

1. **A native login present in a version home** → that account is connected to the
   harness. This works today (`getAccountInfo` reads `.claude.json` `oauthAccount`); it
   is why a desktop `claude /login` participates in balancing with no `attach`.
2. **An added token / API-key account whose provider can authenticate the harness** →
   it is in that harness's pool by capability. The predicate already exists —
   `getAccountProvider(provider).envFor(harness, auth)` (`accounts.ts:533`) — so an
   OpenRouter key that can auth both Codex and Claude is automatically in both pools.

Under **Layer 2** the runner enumerates that inferred pool and injects the chosen
account's credential per run (`CLAUDE_CODE_OAUTH_TOKEN` for a token, provider env for a
key), so there is **no persistent binding to create** — install a version, add the
account or log in, and it is in the pool.

<div class="artifact-callout">
<code>attach</code> stops being a required step and becomes a rare <strong>override</strong>:
pin one account to one version home when you deliberately want it isolated (a long-lived
interactive session on a specific account). The common path — install, log in or add a
key, done — infers the binding. Inference cannot pick a <em>deliberate</em> pin, which is
the one job left for <code>attach</code>.
</div>

## Harness parity

Target harnesses: **claude, codex, grok, cursor, kimi, opencode**. Each stores its
identity in its own file — `getAccountInfo` has a per-harness case for all six
(`agents.ts` cases: claude:2211, codex:2285, cursor:2333, grok:2361, kimi:2418,
opencode:2461) — and each account kind is injected by the provider adapter's `envFor`
(`account-provider-registry.ts`). Two facts decide the design:

1. **A native OAuth login already balances for every harness** — `getAccountInfo` reads
   that harness's credential file and reports signed-in, no seed. It is machine-bound, so
   it cannot be shared to a headless worker.
2. **An API-key account is env-injected with no identity file**, so it is invisible to
   balanced for **every** harness today — the same bug class as Claude's setup-token, but
   harness-agnostic.

| Harness | Native OAuth | Long-lived shareable token | API-key | Identity file `getAccountInfo` reads |
| --- | --- | --- | --- | --- |
| claude | ✓ | ✓ setup-token → `CLAUDE_CODE_OAUTH_TOKEN` | ✓ `ANTHROPIC_API_KEY` | `.claude.json` oauthAccount |
| codex | ✓ device-auth | ✗ (no shareable token; Enterprise only) | ✓ `OPENAI_API_KEY` | `.codex/auth.json` (JWT) |
| grok | ✓ | ✗ | ✓ `XAI_API_KEY` | `.grok/auth.json` |
| cursor | ✓ | ✗ | ✓ `CURSOR_API_KEY` | `.config/cursor/auth.json` |
| kimi | ✓ | ✗ | ✗ (no provider adapter) | `.kimi-code/credentials` |
| opencode | ✓ | ✗ | ✓ `OPENCODE`/`OPENAI_API_KEY` | opencode `auth.json` |

<div class="artifact-callout artifact-callout-warn">
<strong>This reprioritizes the layers.</strong> Only Claude has a shareable long-lived
token, so the Layer 1 identity-seed (<code>oauthAccount</code>) is <strong>Claude-only and
does not generalize</strong>. <strong>Layer 2 — enumerate the account pool and inject via
<code>envFor</code> — IS the harness-parity fix</strong>: it makes API-key accounts
balance across all six harnesses uniformly because <code>envFor</code> is already
registry-driven per harness. Native OAuth logins already balance everywhere. So the
six-harness goal is delivered by <strong>Layer 2</strong>; Layer 1 is an optional Claude
bridge, not the target.
</div>

## Current architecture

How an account becomes runnable and balanceable today — and where it silently fails.

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg viewBox="0 0 900 430" role="img" aria-label="Current data flow: balanced enumerates version homes gated on oauthAccount email; attach never seeds it" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="900" height="430" fill="#0b0f0d"/>

  <text x="30" y="30" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">agents run --strategy balanced</text>

  <!-- collectRunCandidates -->
  <rect x="30" y="46" width="250" height="72" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="42" y="70" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">collectRunCandidates()</text>
  <text x="42" y="88" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">rotate.ts:753</text>
  <text x="42" y="105" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">iterates listInstalledVersions()</text>

  <!-- per home -->
  <rect x="30" y="150" width="250" height="60" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="42" y="174" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">one candidate PER version home</text>
  <text x="42" y="192" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">getAccountInfo(home)</text>

  <!-- gate -->
  <rect x="30" y="242" width="250" height="74" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="42" y="266" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">signedIn = !!email</text>
  <text x="42" y="284" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">agents.ts:2280</text>
  <text x="42" y="301" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">email from .claude.json oauthAccount</text>

  <!-- the pivot file -->
  <rect x="340" y="150" width="230" height="166" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="352" y="174" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">.claude.json</text>
  <text x="352" y="196" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">oauthAccount:</text>
  <text x="362" y="214" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">emailAddress  ← THE PIVOT</text>
  <text x="362" y="230" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">accountUuid</text>
  <text x="362" y="246" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">organizationUuid</text>
  <text x="352" y="272" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">drives signedIn AND</text>
  <text x="352" y="288" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">resolveClaudeSetupToken()</text>
  <text x="352" y="304" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">claude-account-token.ts:96</text>

  <!-- attach path -->
  <rect x="630" y="46" width="240" height="72" rx="8" fill="#1a0e0e" stroke="#ff6b6b" stroke-width="1.5"/>
  <text x="642" y="70" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">agents accounts attach</text>
  <text x="642" y="88" font-family="JetBrains Mono, monospace" font-size="10" fill="#ff6b6b">accounts.ts:507</text>
  <text x="642" y="105" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">writes registry record + .oauth_token</text>

  <rect x="630" y="150" width="240" height="90" rx="8" fill="#1a0e0e" stroke="#ff6b6b" stroke-width="1.5"/>
  <text x="642" y="174" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#ff6b6b">NEVER seeds oauthAccount</text>
  <text x="642" y="196" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">account record has no identity</text>
  <text x="642" y="212" font-family="JetBrains Mono, monospace" font-size="10" fill="#ff6b6b">account-registry.ts:29</text>
  <text x="642" y="229" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">→ account invisible to balanced</text>

  <!-- connectors -->
  <line x1="155" y1="118" x2="155" y2="150" stroke="#38bdf8" stroke-width="1.5"/>
  <line x1="155" y1="210" x2="155" y2="242" stroke="#38bdf8" stroke-width="1.5"/>
  <line x1="280" y1="284" x2="340" y2="230" stroke="#a3e635" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.8"/>
  <line x1="750" y1="118" x2="750" y2="150" stroke="#ff6b6b" stroke-width="1.5"/>
  <line x1="630" y1="195" x2="570" y2="210" stroke="#ff6b6b" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.6"/>
  <text x="360" y="360" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">Result: balanced sees only homes whose .claude.json already carries an oauthAccount email.</text>
  <text x="360" y="378" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">On the workers that is 2 of 8. The other 6 accounts exist as bundles but never participate.</text>
</svg>
<figcaption>Current flow. Amber = per-home enumeration; lime = the pivot field; red = the inert attach path.</figcaption>
</figure>

<div class="artifact-legend">
<span class="artifact-tag">amber — per version-home path</span>
<span class="artifact-tag">lime — the load-bearing field</span>
<span class="artifact-tag">red — the broken attach path</span>
</div>

### What exists right now (verified)

| Concern | Current behavior | Evidence (file:line) |
| --- | --- | --- |
| Candidate set | One per installed version home | `rotate.ts:753` `listInstalledVersions` |
| Launchable gate | `signedIn && perVersion credential` | `rotate.ts:172-181` `isLaunchableSignedIn` |
| `signedIn` source | `!!oauthAccount.emailAddress` only | `agents.ts:2216-2280` `getAccountInfo` |
| Setup-token resolution | Keyed by that same email | `claude-account-token.ts:91-127` |
| `attach` effect | Registry record + `.oauth_token`, no identity seed | `accounts.ts:507-538` |
| Account record fields | `id, name, provider, auth, baseUrl` — no identity | `account-registry.ts:29-38` |
| Absent `.credentials.json` | Not treated as signed-out (fail-open) | `agents.ts` `isClaudeCredentialFileBlank` |

## Public Interface

The behavior a user sees before and after — the surface that actually changes.

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="capture">
<figcaption>Current — after <code>agents accounts attach</code> x6 on yosemite-m1</figcaption>
<pre><code>$ agents accounts attach claude-social claude@2.1.222
Attached claude-social to claude@2.1.222.      # success message...

$ agents view claude --device yosemite-m1
  Claude (balanced)
    2.1.207  muqsit@getrush.ai       Max   setup-token (correct)
    2.1.187  muqsitnawaz@icloud.com  Max   stray real login (to migrate)
    2.1.222  (logged out - log in with: claude)   attached, still dead
    2.1.220  (logged out - log in with: claude)   attached, still dead
    2.1.219  (logged out - log in with: claude)   attached, still dead
    2.1.181  (logged out - log in with: claude)   attached, still dead

$ agents run claude --account muqsit@trp.so
Unknown account 'muqsit@trp.so'.   # bundle attached, still unusable

balanced pool = 2 accounts</code></pre>
</section>
<section data-state="proposed" data-evidence="mockup">
<figcaption>Proposed — <code>agents accounts add</code> seeds identity automatically</figcaption>
<pre><code>$ agents accounts add social --auth setup-token
Added social. Identity: social@swarmify.co (Max).
Seeded claude@2.1.222.

$ agents view claude --device yosemite-m1
  Claude (balanced)
    2.1.207  muqsit@getrush.ai   W:##... 46%
    2.1.187  icloud.com          W:#.... 22%
    2.1.222  social@swarmify.co  W:###.. 61%
    2.1.220  muqsit@trp.so       W:#.... 12%
    2.1.219  gmail.com           W:####. 78%
    2.1.181  dev@getrush.ai      W:##... 40%

$ agents run claude --account muqsit@trp.so
Running: claude@2.1.220 (trp.so via setup-token)

balanced pool = 8 accounts, by headroom</code></pre>
</section>
</figure>

### Command surface after this change

| Command | Today | After |
| --- | --- | --- |
| `agents accounts add <n> --auth setup-token` | stores token only | stores token + captures identity + seeds a home |
| `agents accounts attach <acct> <target>` | inert for balancing | **override only** — pin an account to one home; the common binding is inferred |
| `agents accounts label <harness> <name>` | renames a native login only | names any **(harness ⇄ account)** binding — OAuth, token, or API-key |
| `agents run --account <email>` | fails for bundle accounts | resolves any pool account |
| `agents run --strategy balanced` | rotates across homes | load-balances the account pool by usage |

## Specification — expected behavior

Written to extend the existing `EXEC-ACCOUNT-*` block in
`apps/cli/docs/specifications.md` (RFC-2119 MUST/SHOULD, one behavior per line).
Not OpenSpec — plain requirements this feature must satisfy.

<div class="artifact-callout">
<strong>Already specified (verified in the repo).</strong> EXEC-ACCOUNT-1 (account =
id/name/provider/auth-kind/secret-ref; raw creds in the device store, never in
<code>accounts.yaml</code>), EXEC-ACCOUNT-2 (accounts come from API-key / setup-token /
bearer; a native OAuth login MUST NOT be converted to a provider account or copied
between devices), EXEC-ACCOUNT-3 (<code>--account</code> resolves via the provider
adapter and fails before spawn when it cannot auth or the credential is absent). The
requirements below ADD the pool-balancing, binding-inference, and one-command robustness
that are <strong>not</strong> specified anywhere today.
</div>

**What I, the user, expect** (the requirements in plain terms; the table below is the
same set, precise):

- I add an account or sign in → it shows up and is usable for that harness with **no
  extra command**.
- `--strategy balanced` → spreads across **all my accounts for that harness** by remaining
  usage, skipping any that are rate-limited.
- The same email signed into Claude and Codex → **two separate accounts**; balancing one
  never touches the other.
- I pick an account explicitly → **that exact one** runs, never a different login.
- An account that can't run (rate-limited, no credential, provider can't auth the harness)
  → a **clear message**, never a silent wrong result.
- It works the **same for Claude, Codex, Grok, Cursor, Kimi, OpenCode**.
- I **never** run five commands to connect an account.

| # | Level | Requirement |
| --- | --- | --- |
| **AB-0** | MUST | Identity is `(agent, account)`. The same email under two harnesses is two accounts; each harness's pool is separate. Dedup + selection key on the agent-scoped `accountKey` (`buildIdentityKey`, `agents.ts:2669`). |
| **AB-1** | MUST | `--strategy balanced` for harness H considers **every account connected to H** — a native login in any H version home, or a provider account whose adapter can authenticate H — not only accounts written into a version home. |
| **AB-2** | MUST | Selection weights by **remaining usage headroom** and skips any account that is rate-limited (429 / session-window maxed). A cold/absent usage snapshot routes the account as unverified but still eligible, never excluded. |
| **AB-3** | MUST | An account is **connected by inference**: (a) a version home holds its native login, or (b) it is a provider account whose adapter `envFor(H, auth)` succeeds. Neither path requires `attach`. |
| **AB-4** | MUST | **Connecting an account is one command.** After `agents accounts add …` (durable) or a completed native login, the account is signed-in in `agents view` and balance-eligible with **no further command**. Reaching a working, balance-eligible account MUST NOT require more than that one credential-providing command. |
| **AB-5** | MUST | At exec the runner injects the selected account's credential **by kind**: native OAuth → the home's own login; setup/bearer token → `CLAUDE_CODE_OAUTH_TOKEN` (harness-equivalent); API key → provider env. It MUST NOT inject a credential that resolves to a *different* account than the one selected. |
| **AB-6** | MUST | `agents view <harness>` shows every connected account's identity + usage and **never shows a connected, runnable account as "logged out."** |
| **AB-7** | MUST | `agents accounts label` names a **(harness ⇄ account)** binding for any account kind, not only a native login. One account MAY be labeled per harness it is connected to. |
| **AB-8** | SHOULD | `attach`/`detach` remain available to **pin/unpin** a specific account to a specific version home. A pin wins over inference for that home; a pin is never *required* for balancing. |
| **AB-9** | MUST | Every unsupported combination **fails loud**: an `attach`/`add` that cannot make the account usable, or a provider that cannot auth the harness, raises a stated error — never a silent success or a home that reads healthy and dies at spawn. |
| **AB-10** | MUST | The pool-balancing path (AB-1) works for **every target harness — claude, codex, grok, cursor, kimi, opencode** — via the registry-driven `envFor`, not a per-harness `else if`. A harness where an account kind does not exist (e.g. no shareable token for codex, no API-key provider for kimi) reads as unsupported for that kind in the table *before* any code assumes it, per the capability-truthfulness convention. |

**Given / When / Then (the load-bearing scenarios):**

```text
AB-4  Given a worker with claude installed and no accounts
      When  I run: agents accounts add trp --provider anthropic --auth setup-token
      Then  agents view claude shows trp signed-in AND
            agents run claude --strategy balanced can select it — no attach, no seed step.

AB-1  Given 8 anthropic setup-token accounts connected to claude
      When  agents run claude --strategy balanced runs 100 times
      Then  every one of the 8 is eligible, weighted by remaining headroom.

AB-5  Given account A selected for this run
      When  the child spawns
      Then  CLAUDE_CODE_OAUTH_TOKEN resolves to A's token, never B's.
```

## Red lines (hard MUST NOTs)

Non-negotiable. A change that trips one of these is wrong even if every test passes.

<div class="artifact-callout artifact-callout-danger">
<strong>R1 — Never copy a native OAuth / rotating refresh token across machines.</strong>
It revokes the account fleet-wide (EXEC-ACCOUNT-2). Workers use shareable setup-tokens or
per-device native logins only.
<br><strong>R2 — Never write raw credentials into a DotAgents repo or
<code>accounts.yaml</code>.</strong> Secrets live in the device store (EXEC-ACCOUNT-1).
<br><strong>R3 — Never overwrite a different account's live identity in a home.</strong>
An identity seed that would repoint a home already signed into another account MUST refuse
(the <code>skipped-conflict</code> guard), not clobber.
<br><strong>R4 — Never require more than one command to connect an account.</strong> The
current <code>add → attach → (seed) → run</code> dance is the bug. Connecting is one
command; labeling is at most one more. No 5-command ritual.
<br><strong>R5 — Never select a rate-limited or credential-absent account, and never
fail silently.</strong> Skip it in balanced; fail before spawn for an explicit
<code>--account</code> (EXEC-ACCOUNT-3).
<br><strong>R6 — Never mark a (harness, account-kind) combination supported before its
code path exists.</strong> The capability/provider table stays truthful in lockstep with
the code.
<br><strong>R7 — Never ship the pool fix for Claude alone.</strong> The cross-harness
path (AB-10) must cover claude, codex, grok, cursor, kimi, opencode through the
registry-driven <code>envFor</code>, or the PR states which are out of scope and why. A
Claude-only pool is the harness-parity violation the reviewer blocks.
</div>

## Where it's implemented — one clean, testable library

The logic lives in **`apps/cli/src/lib/accounting/account-pool.ts`**, not smeared across
`rotate.ts` + `agents.ts` as it is today. It is a **pure core** (no I/O — inputs are
passed in) plus one thin impure collector, so the decision logic is unit-tested with
fixtures (no real homes, no network), exactly like the seed core already landed.

```ts
export interface PoolAccount {
  agent: AgentId;                 // the harness — half of the identity
  accountKey: string;             // agent-scoped: `${agent}:…` → (claude,gmail) ≠ (codex,gmail)
  email: string | null;
  kind: 'oauth' | 'setup-token' | 'api-key';
  source: 'native-login' | 'registry';
  usageKey: string | null;
  headroomMinutes: number | null;
  rateLimited: boolean;
}

// PURE — given already-collected inputs, produce the harness's pool, deduped by (agent, accountKey)
export function buildAccountPool(agent: AgentId, inputs: PoolInputs): PoolAccount[];

// PURE — pick by strategy: balanced = weighted-random by headroom, skipping rate-limited
export function pickFromPool(pool: PoolAccount[], strategy: RunStrategy, opts?): PoolAccount | null;

// PURE — how to authenticate the chosen account at exec (provider envFor, or a native home)
export function injectionFor(account: PoolAccount): { env?: Record<string,string>; nativeHome?: string };

// the ONLY I/O — reads native logins + the account registry, feeds the pure core
export async function collectPoolInputs(agent: AgentId): Promise<PoolInputs>;
```

`collectRunCandidates` becomes a thin caller of `collectPoolInputs → buildAccountPool`.
Why this is the clean/stable shape:

| Property | How the library delivers it |
| --- | --- |
| Testable | Pure `buildAccountPool` / `pickFromPool` / `injectionFor` take fixtures; a separate real-path test hits the live flow. |
| Stable | One owner for "which `(agent, account)`s can run this harness and which to pick" — no logic duplicated in callers. |
| Correct identity | Dedup + selection key on the agent-scoped `accountKey`, so `(claude, gmail)` and `(codex, gmail)` are distinct rows. |
| Harness-parity | `injectionFor` routes through the provider registry `envFor`, uniform across the six harnesses. |

## "Provisioning correctly" = matched versions + pooled accounts

"Provision a worker" means two things, and only the second is new code here.

**1. Matched harness versions across every device — existing tooling.** You pin one
canonical roster and push it fleet-wide; no per-box hand-install:

```bash
agents fleet capture                          # record this machine's agent versions into agents.yaml fleet:
agents fleet apply -y --provision-secrets     # install those exact versions on every device + push the auth bundle
agents fleet apply --agent claude@all --device yosemite-s0 -y   # clone this box's claude versions onto one box
agents doctor --devices                       # flags any remaining version-skew
```

**2. Accounts that actually balance — this feature (RUSH-3182).** `--provision-secrets`
copies the setup-tokens to every box, but those accounts are **not balance-visible** until
the pool fix lands. That is the missing half.

<div class="artifact-callout">
The two compose into the clean end state. Because the account pool decouples accounts from
version homes, you stop needing 8 mismatched versions per box: pin <strong>one</strong>
version per agent, identical everywhere (<code>fleet capture</code>/<code>apply</code>),
and let the <code>(agent, account)</code> pool ride on top. Uniform versions + one shared
account pool = the "easy to manage" fleet. Version-matching itself is not new code — it is
<code>fleet capture</code>/<code>apply</code>; this feature only makes the synced accounts
balance-eligible.
</div>

## Proposed Changes

Layer 1 is four edits. Layer 2 is the router change that removes the coupling.

```diff
// apps/cli/src/lib/account-registry.ts — carry identity on the record
 export interface CredentialAccount {
   id: string;
   name: string;
   provider: string;
   auth: AccountAuthKind;
   baseUrl?: string;
+  // Captured once at add-time; seeds oauthAccount and drives usage keying.
+  identity?: { email: string; accountUuid?: string; organizationUuid?: string; organizationType?: string };
 }
```

```diff
// apps/cli/src/commands/accounts.ts — attach seeds identity, not just a record
       bindAccount(name, target);
       writeClaudeInteractiveOauthToken(t, targetAgent);
+      // Seed the home's oauthAccount so the account is signed-in for BOTH
+      // balanced enumeration (getAccountInfo) and setup-token resolution.
+      seedClaudeIdentity(t, account);
       console.log(chalk.green(`Attached ${account.name} to ${target}.`));
```

```diff
// apps/cli/src/lib/claude-account-token.ts — reuse the bundle-key ⇄ email map
+// The auth bundle key encodes the email (claudeAccountTokenKey), so we can
+// recover the email for a setup-token even when user:profile scope is absent.
+export function emailFromAuthBundleKey(key: string): string | null { /* reverse the slug */ }
```

```diff
// apps/cli/src/lib/accounting/rotate.ts — LAYER 2: enumerate the account pool
-  const versions = listInstalledVersions(agent);
-  const rows = await Promise.all(versions.map(async (version) => { /* per home */ }));
+  // Union of native logins AND attached provider accounts, deduped by identity.
+  const accounts = listBalanceableAccounts(agent); // homes ∪ pool bundles
+  const rows = await Promise.all(accounts.map(async (acct) => resolveCandidate(agent, acct)));
```

<div class="artifact-callout artifact-callout-warn">
Harness parity: the pivot is Claude-specific (<code>oauthAccount</code>), but the
inert-attach shape is shared. The account record and the pool-enumeration change
must be evaluated for every harness the capability applies to (Codex
<code>auth.json</code>, Gemini, Grok, …) — or the PR states which are out of scope
and why. This is a code-review convention, not optional.
</div>

## Checklist

<div class="artifact-callout">
Layer 1 restores correctness and is safe to ship alone. Layer 2 is the
simplification and depends on Layer 1's identity capture.
</div>

- **L1.1** Add `identity` to `CredentialAccount` + read/write (`account-registry.ts`).
- **L1.2** Capture identity at `add` time: email from the bundle key; UUIDs via a
  `user:profile`/usage fetch when scope allows (`accounts.ts`, `claude-account-token.ts`).
- **L1.3** `seedClaudeIdentity(target, account)` writes `oauthAccount` into the home's
  `.claude.json` (both `$home/.claude.json` and `$home/.claude/.claude.json`).
- **L1.4** Call it from `attach`; clear it from `detach` (mirror the `.oauth_token` logic).
- **L1.5** Real-path test: add → `getAccountInfo` signed-in → `collectRunCandidates`
  includes it → headless run authenticates.
- **L2.1** `listBalanceableAccounts(agent)` = native logins ∪ attached pool accounts.
- **L2.2** `collectRunCandidates` enumerates that union; map each to a runnable home
  (or a shared home + injected token).
- **L2.3** `matchAccountVersion` / `--account` resolves against the pool.
- **L2.4** Docs + CHANGELOG + `apps/cli/docs/` + companion `.agents-system` audit.

## Validation

```bash
# Layer 1 — the real path, on a worker, no credential copied
agents accounts add trp --provider anthropic --auth setup-token   # captures identity
agents view claude --device yosemite-m1 | grep trp.so             # signed-in, not "logged out"
agents run claude --account muqsit@trp.so "Reply: PONG" --mode plan  # runs via setup-token

# Balancing actually rotates the pool
for i in $(seq 1 8); do agents run claude "hi" --strategy balanced --mode plan \
  2>&1 | grep -oE "claude@[0-9.]+"; done | sort | uniq -c   # ≥5 distinct homes
```

| Scenario | Expected | Status |
| --- | --- | --- |
| Seed identity only, no credential file | signed-in + runnable | proven on m1 |
| `--account <email>` for a bundle account | resolves + runs | proven (fails today) |
| balanced across 8 | rotates by headroom | partial (usage cache warming) |

## Risks

| Risk | Mitigation |
| --- | --- |
| Setup-token lacks `user:profile` scope (RUSH-2392) | Email from bundle key still gives signed-in + runnable; UUID backfilled from the usage fetch when available. Usage weighting degrades to fallback, never to "excluded." |
| Overwriting a real native `oauthAccount` on seed | Seed only when the home has no native `oauthAccount`, or the account matches; never clobber a live native login. |
| A stray real `.credentials.json` on a worker (rotating refresh token — verified on m1 icloud) | The migration seeds `oauthAccount` from the shared setup-token and strips the stray credential on worker homes only (never a personal box like zion). Not a manual per-device sweep — the feature does it. |
| Layer 2 changes the hot routing path | Ship Layer 1 first; Layer 2 behind the same `collectRunCandidates` tests, verified on a worker before release. |
| Worktree law / release | Land via `.agents/worktrees/` + PR; release through `apps/cli/scripts/release.sh`, never a hand-rolled build. |

## Corner cases

Realistic cases, each with the expected behavior and which requirement / red line
governs it. These are the acceptance surface, not a wish list.

| # | Corner case | Expected behavior | Governs |
| --- | --- | --- | --- |
| C1 | Same account added on two workers | Each device resolves its **own** device-local setup-token; no rotating refresh token is shared, so nothing is revoked. Verified: this is why m1/s1 coexist. | R1 |
| C2 | Setup-token lacks `user:profile` scope (RUSH-2392) | Email is still recovered from the `auth` bundle-key slug → account is signed-in + runnable. Usage weighting falls back to unverified until the daemon backfills; the account is never excluded. | AB-2 |
| C3 | 8 accounts, 8 version homes (Layer 1) | Balanced rotates across all 8 by headroom. Proven on m1. | AB-1 |
| C4 | 8 accounts, 1 version home (Layer 2) | Runner injects the selected account's token per run; homes scale with **concurrency**, not account count. Under Layer 1 this is a stated limit (needs ≥N homes). | AB-1, AB-5 |
| C5 | An account is rate-limited (429) | Balanced skips it until its `Retry-After`; per-account backoff (RUSH-3036), not a provider-wide park. | AB-2, R5 |
| C6 | API-key account bound to Codex **and** Claude | Appears in both harness pools; selecting it for each injects the same key through that harness's provider adapter. | AB-3, AB-7 |
| C7 | `detach` / `remove` an account | Seeded `oauthAccount` + `.oauth_token` cleared **only** when the seeded email matches; balanced drops it; a re-pointed home keeps its current identity. | AB-8, R3 |
| C8 | Native login **and** setup-token for the same account in one home | Native credential wins for that home; the setup-token is the headless fallback. Not double-counted in the pool (dedup by account identity). | AB-5 |
| C9 | Re-attach account B onto a home already holding live login A | `seedClaudeIdentity` returns `skipped-conflict` and the command says so — it never silently repoints a live login. | R3, AB-9 |
| C10 | Add an OpenRouter key, then run a harness with no OpenRouter adapter | The account is simply **not connected** to that harness (excluded from its pool). Not an error — `envFor` failing is the signal. | AB-3, AB-9 |
| C11 | Version home reinstalled at the same version number | The home's seeded `oauthAccount` persists in its config; no re-derivation, no re-attach. | AB-4 |
| C12 | Fresh seed, usage cache cold | Account is eligible immediately; weighting is ~uniform until the daemon fetches headroom, then shifts to usage-weighted. Observed on m1. | AB-1, AB-2 |
| C13 | `agents accounts add` then straight to `agents run --strategy balanced` | Works with **no** intervening command — the one-command bar. If it needs a second connecting command, that is a bug against AB-4/R4. | AB-4, R4 |

## Tracking

- [RUSH-3182](https://linear.app/phnx/issue/RUSH-3182) — accounts: setup-token accounts
  invisible to `--strategy balanced`; attach is inert (make the account the unit).
