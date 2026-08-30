---
kind: plan
surface: cli
title: "Nest org under auth as space; retire leftover alias doors"
summary: >
  agents org is a Prix spaces client misnamed as org, invisible in root help,
  and colliding with accounts (harness keys) just as monetization lands.
  Nest it under auth as space. Retire trends (already insights mix), audit,
  unshare, and humans. Keep notify and logs.
status: awaiting-go
facts:
  - "75 top-level groups after inbox removal"
  - "org maps to /api/v1/spaces, not /api/v1/orgs (prix-account.ts header)"
  - "trends is already a deprecated alias of insights mix"
  - "Root help Credentials lists harness / secrets / accounts — not auth or org"
links:
  - url: https://github.com/phnx-labs/agi-cli/pull/2853
    label: "PR #2853 setup alias"
  - url: https://github.com/phnx-labs/agi-cli/pull/2858
    label: "PR #2858 retire inbox"
---

## Focus for review

- **Org noun (the real pick).** Nest under `auth` as `agents auth space …` (recommended), keep a top-level `agents space`, or keep the `org` label. This is the only product call; everything else is cleanup of leftover aliases.
- **Alias retirements in the same PR?** `trends`, `audit`, `unshare`, `humans` are the same class as `inbox`. I recommend yes — four fewer top-level doors, same retirement pattern.
- **Keep `notify`.** It is a verb (`send --to owner`), not a second noun. Fleet briefs already teach it.

## Intent

Go through the rest of the command reference after inbox/alias nesting. Does `agents org` make sense now that users can get Prix accounts, or should it be refined? Also show what else can still be simplified.

Restated: one identity door for the monetization account layer, and delete leftover aliases that already have a home.

<div class="artifact-callout">
<p><strong>Proposal:</strong> nest <code>org</code> under <code>auth</code> as <code>agents auth space</code>. Retire <code>trends</code> (already <code>insights mix</code>), <code>audit</code>, <code>unshare</code>, and <code>humans</code>. Keep <code>notify</code> and <code>logs</code>. Do not fold Prix login into <code>accounts</code>.</p>
</div>

## Current architecture

Three different “account” nouns sit next to each other, and `org` does not match the API it calls.

`agents org` is a client over Prix `/api/v1/spaces` (free: 1 owned space / 3 members). `/api/v1/orgs` is the heavier enterprise tenancy (domain, SSO) and is unused. The file header already admits the mismatch (`apps/cli/src/lib/prix-account.ts`).

`agents insights` already owns the mix recipes. `agents trends` is a deprecated alias of `agents insights mix` — same recipes, same implementation, one deprecation line.

```
agents insights mix          # canonical
agents insights harness-mix  # recipe
agents trends                # deprecated alias of insights mix
agents trends harness-mix    # same recipe, second door
```

Root `agents --help` does not list `auth` or `org`. Credentials only shows `harness` / `secrets` / `accounts`.

<div class="artifact-figure-diagram">
<svg viewBox="0 0 960 420" role="img" aria-label="Today: four identity-shaped top-level commands plus leftover aliases. Prix login and Prix spaces are split; harness keys reuse the word accounts." xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#38bdf8"/></marker>
  </defs>
  <text x="24" y="28" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#a3e635">TODAY — four “who are you” doors, two leftover aliases</text>

  <rect x="24" y="48" width="210" height="86" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="36" y="72" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">agents auth</text>
  <text x="36" y="90" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Prix / Rush login</text>
  <text x="36" y="108" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">login · whoami · logout</text>
  <text x="36" y="122" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">not in root help</text>

  <rect x="258" y="48" width="210" height="86" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="270" y="72" font-family="JetBrains Mono, monospace" font-size="12" fill="#f59e0b">agents org</text>
  <text x="270" y="90" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Prix spaces, named org</text>
  <text x="270" y="108" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">maps to /api/v1/spaces</text>
  <text x="270" y="122" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">not /api/v1/orgs</text>

  <rect x="492" y="48" width="210" height="86" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="504" y="72" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">agents accounts</text>
  <text x="504" y="90" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Harness API keys</text>
  <text x="504" y="108" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">claude / codex / grok</text>
  <text x="504" y="122" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">not a Prix user</text>

  <rect x="726" y="48" width="210" height="86" rx="8" fill="#141018" stroke="#c084fc" stroke-width="1.5"/>
  <text x="738" y="72" font-family="JetBrains Mono, monospace" font-size="12" fill="#c084fc">agents humans</text>
  <text x="738" y="90" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Local owner for notify</text>
  <text x="738" y="108" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">humans.yaml inspect-only</text>
  <text x="738" y="122" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">show owner</text>

  <line x1="129" y1="134" x2="129" y2="178" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" marker-end="url(#ar)"/>
  <line x1="363" y1="134" x2="363" y2="178" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" marker-end="url(#ar)"/>
  <rect x="24" y="186" width="444" height="70" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="36" y="210" font-family="JetBrains Mono, monospace" font-size="12" fill="#38bdf8">api.prix.dev</text>
  <text x="36" y="228" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">/api/v1/auth/device/*  ·  /api/v1/spaces  ·  /api/v1/orgs unused</text>
  <text x="36" y="244" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">shared backend with rush login; separate session file</text>

  <rect x="24" y="280" width="210" height="70" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="36" y="304" font-family="JetBrains Mono, monospace" font-size="12" fill="#f87171">agents trends</text>
  <text x="36" y="322" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">deprecated alias</text>
  <text x="36" y="338" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">= insights mix</text>

  <rect x="258" y="280" width="210" height="70" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="270" y="304" font-family="JetBrains Mono, monospace" font-size="12" fill="#f87171">agents audit</text>
  <text x="270" y="322" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">pure alias</text>
  <text x="270" y="338" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">= events --include runs</text>

  <rect x="492" y="280" width="210" height="70" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="504" y="304" font-family="JetBrains Mono, monospace" font-size="12" fill="#f87171">agents unshare</text>
  <text x="504" y="322" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">pure alias</text>
  <text x="504" y="338" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">= artifacts share delete</text>

  <rect x="726" y="280" width="210" height="70" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="738" y="304" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">agents insights</text>
  <text x="738" y="322" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">canonical mix home</text>
  <text x="738" y="338" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">mix · recipes · cost · output</text>

  <text x="24" y="390" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">Keep: notify (verb), logs (real viewer), accounts (harness keys), insights (already the mix home).</text>
</svg>
</div>

Caption: Prix identity is split across `auth` and `org`. Harness keys reuse the word `accounts`. `trends` duplicates `insights mix`.

## Purpose

When a user “gets an account” for monetization they will type `agents accounts` and land on Claude/Codex API keys. `agents org` teaches the wrong noun for a space, and later `/api/v1/orgs` (SSO, domain) has nowhere to go. Root help hides both `auth` and `org`.

Leftover aliases from earlier nesting still occupy top-level slots the same way `inbox` did.

## Proposed Changes

**A (recommended).** One Prix door. Spaces live under auth. Retire the leftover aliases.

```
agents auth login | logout | whoami
agents auth space create|list|view|invite|members|role|remove|leave
```

`agents org …` becomes a retired top-level (same pattern as `inbox` / `alias`): unknown command, no distance-1 autocorrect, hint names the new path.

Do **not** fold into `accounts`. Do **not** rename to `team` (collides with `agents teams`). Do **not** keep `org` unless you are willing to never ship a distinct `/orgs` CLI.

Same PR, same retirement pattern:

| Today | After | Why |
|---|---|---|
| `agents org …` | `agents auth space …` | noun matches `/spaces`; one Prix door |
| `agents trends …` | gone; use `agents insights mix` | already deprecated alias |
| `agents audit` | gone; use `agents events --include runs` | pure alias; `audit verify` moves under `events` if still needed |
| `agents unshare` | gone; use `agents artifacts share delete` | leftover from share nesting |
| `agents humans show owner` | `agents notify show` (or drop) | inspect-only stub |
| `agents notify` | **keep** | verb, taught in fleet briefs |
| `agents logs` | **keep** | real host-dispatch + session viewer |
| `agents accounts` | **keep** | harness credentials, different noun |

Root help gains an Identity block so login is discoverable:

```
Identity (Prix account — shared with paid tiers):
  auth login                      Sign in via device-code flow
  auth whoami                     Show the signed-in Prix user
  auth space                      Create and manage a space (invite collaborators)

Credentials (harness keys, not your Prix user):
  accounts                        Provider credentials + native OAuth logout
  secrets                         Keychain-backed env bundles
  harness                         Custom (host CLI + model + auth) harnesses
```

### Current vs proposed CLI behavior

<figure class="artifact-behavior">
  <div data-state="current" data-evidence="mockup">
    <svg viewBox="0 0 720 360" role="img" aria-label="Current: agents --help Credentials section plus four extra top-level groups org, trends, audit, unshare" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="360" rx="8" fill="#0a0a0a"/>
      <text x="20" y="28" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">$ agents --help</text>
      <text x="20" y="56" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">Credentials:</text>
      <text x="20" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  harness     Custom (host CLI + model + auth)</text>
      <text x="20" y="94" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  secrets     Keychain-backed env bundles</text>
      <text x="20" y="112" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  accounts    Provider credentials + native OAuth logout</text>
      <text x="20" y="140" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">  (auth and org are missing from this list)</text>
      <text x="20" y="172" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">Also top-level, not grouped:</text>
      <text x="20" y="192" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">  org         “a Rush space” via /api/v1/spaces</text>
      <text x="20" y="210" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">  trends      deprecated alias of insights mix</text>
      <text x="20" y="228" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">  audit       alias of events --include runs</text>
      <text x="20" y="246" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">  unshare     alias of artifacts share delete</text>
      <text x="20" y="264" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">  humans      inspect humans.yaml</text>
      <text x="20" y="300" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">$ agents org create acme</text>
      <text x="20" y="318" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">Created space 'acme' (acme).</text>
      <text x="20" y="342" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">mockup of current help + org output — labeled because this is a command-tree change, not a screenshot</text>
    </svg>
  </div>
  <div data-state="proposed" data-evidence="mockup">
    <svg viewBox="0 0 720 360" role="img" aria-label="Proposed: Identity block with auth login and auth space; leftover aliases gone; accounts stays under Credentials" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="360" rx="8" fill="#0a0a0a"/>
      <text x="20" y="28" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">$ agents --help</text>
      <text x="20" y="56" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">Identity (Prix account — shared with paid tiers):</text>
      <text x="20" y="76" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  auth login     Sign in via device-code flow</text>
      <text x="20" y="94" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  auth whoami    Show the signed-in Prix user</text>
      <text x="20" y="112" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  auth space     Create and manage a space (invite collaborators)</text>
      <text x="20" y="140" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">Credentials (harness keys, not your Prix user):</text>
      <text x="20" y="160" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  accounts       Provider credentials + native OAuth logout</text>
      <text x="20" y="178" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  secrets        Keychain-backed env bundles</text>
      <text x="20" y="196" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">  harness        Custom (host CLI + model + auth) harnesses</text>
      <text x="20" y="228" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">$ agents org create acme</text>
      <text x="20" y="248" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">unknown command 'org'</text>
      <text x="20" y="266" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">Moved under `agents auth space`. Try:</text>
      <text x="20" y="284" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">  agents auth space create acme</text>
      <text x="20" y="318" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">$ agents auth space create acme</text>
      <text x="20" y="336" font-family="JetBrains Mono, monospace" font-size="11" fill="#c8c8c8">Created space 'acme' (acme).</text>
    </svg>
  </div>
</figure>

After: Prix identity is one group. Harness keys stay `accounts`. Mix recipes stay `insights`.

<div class="artifact-figure-diagram">
<svg viewBox="0 0 960 280" role="img" aria-label="Proposed: auth owns login and spaces; accounts stays harness keys; insights owns mix; leftover aliases retired" xmlns="http://www.w3.org/2000/svg">
  <text x="24" y="28" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#a3e635">PROPOSED — one Prix door, leftover aliases gone</text>
  <rect x="24" y="48" width="360" height="140" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="36" y="72" font-family="JetBrains Mono, monospace" font-size="13" fill="#a3e635">agents auth</text>
  <text x="36" y="94" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">login · logout · whoami</text>
  <text x="36" y="114" font-family="JetBrains Mono, monospace" font-size="12" fill="#a3e635">auth space</text>
  <text x="36" y="132" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">create list view invite members role remove leave</text>
  <text x="36" y="154" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">still /api/v1/spaces — noun now matches the route</text>
  <rect x="408" y="48" width="250" height="140" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="420" y="72" font-family="JetBrains Mono, monospace" font-size="13" fill="#38bdf8">agents accounts</text>
  <text x="420" y="94" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">unchanged</text>
  <text x="420" y="114" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Claude / Codex / Grok keys</text>
  <text x="420" y="154" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">not your Prix user</text>
  <rect x="682" y="48" width="254" height="140" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="694" y="72" font-family="JetBrains Mono, monospace" font-size="13" fill="#a3e635">agents insights</text>
  <text x="694" y="94" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">mix · recipes · cost · output</text>
  <text x="694" y="114" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">trends retired</text>
  <text x="694" y="154" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">already the canonical home</text>
  <text x="24" y="220" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">Retired: org, trends, audit, unshare, humans. Kept: notify, logs, accounts, insights.</text>
  <text x="24" y="244" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">Rejected: agents team (collides with agents teams). Rejected: fold into accounts (harness keys).</text>
</svg>
</div>

### Load-bearing diffs

Move space registration onto the existing `auth` command. Retire `org` as a top-level name.

```diff
# apps/cli/src/commands/org.ts  →  register on auth, rename group to space
- const org = program.command('org').description('Create and manage a team (a Rush "space") …');
+ export function registerSpaceCommand(auth: Command): void {
+   const space = auth.command('space').description('Create and manage a Prix space (invite collaborators)');
```

```diff
# apps/cli/src/lib/startup/command-registry.ts
  const LOADED_COMMAND_NAMES = [
-   'accounts', 'auth', 'org', …
+   'accounts', 'auth', …
  RETIRED_TOP_LEVEL_COMMANDS: new Set([
    … 'alias', 'inbox',
+   'org', 'trends', 'audit', 'unshare', 'humans',
  ]),
```

Help examples become `agents auth space create acme-team` instead of `agents org create acme-team`. `prix-account.ts` stays; only the CLI noun moves.

`trends.ts` is deleted (implementation already lives in `lib/analytics/mix-commands.ts` under insights). `audit.ts` default path is deleted; `verifyAuditChain` parks under `events` if the legacy hash-chain file still exists.

Companion `.agents-system` audit in the same delivery: any hook/skill/rule that still says `agents org`, `agents trends`, `agents audit`, `agents unshare`, or `agents humans`.

## Public Interface

```
agents auth login
agents auth logout
agents auth whoami [--json]
agents auth space create <name> [--slug] [--description] [--json]
agents auth space list [--json]
agents auth space view [space] [--json]
agents auth space invite <email> [--role admin|member] [--space]
agents auth space members [space]
agents auth space role <email> <role> [--space]
agents auth space remove <email> [--space]
agents auth space leave [space]
```

Retired (fail loud, hint the new path):

```
agents org …
agents trends …
agents audit …
agents unshare …
agents humans …
```

Unchanged:

```
agents insights mix
agents accounts …
agents notify [text]
agents logs [id]
agents events --include runs
agents artifacts share delete <targets...>
```

## Plan

- [ ] File/claim Linear ticket for the identity nest + alias retirements
- [ ] Worktree off freshly fetched `origin/main`
- [ ] Register space under `auth`; retire top-level `org`
- [ ] Retire `trends`, `audit`, `unshare`, `humans` (move `audit verify` under `events` if still needed)
- [ ] Root help Identity block; `auth`/`space` help examples
- [ ] Tests: nested tree, real spawn of retired names, no distance-1 autocorrect
- [ ] Docs + command-index regen + CHANGELOG fragment
- [ ] Companion `.agents-system` audit, linked PR
- [ ] Republish command-reference share (RUSH-2396 slug)
- [ ] PR, non-author review, merge on green

## Validation

```
agents auth space --help
agents org create acme          # unknown command, hints auth space
agents trends                   # unknown command, hints insights mix
agents insights mix --help      # unchanged
agents accounts list            # unchanged — still harness keys
agents notify --help            # unchanged
```

Pin the retired-name spawn tests the same way `inbox` and `alias` were pinned.

## Risks

| Risk | Mitigation |
|---|---|
| `space` is a vague English word next to sessions/projects | Nesting under `auth` scopes it: “Prix space”, not a new top-level noun |
| Scripts still call `agents org` | Retired set fails loud with the new path; no silent alias |
| `audit verify` still needed for old hash-chain files | Keep as `events verify-chain`, don’t keep a top-level `audit` for one legacy walker |
| Companion fleet briefs still say `agents notify` and `agents insights` | Those stay; only org/trends/audit/unshare/humans change |
| Folding into `accounts` later | Out of scope. `accounts` is harness credentials; mixing it with Prix login is the collision this plan prevents |

## Tracking

No ticket yet — file one under AGI after this pick lands (identity nest + alias retirements, one delivery). Previous surface work: RUSH-2965 (`setup alias`), RUSH-2984 (`inbox` retired).
