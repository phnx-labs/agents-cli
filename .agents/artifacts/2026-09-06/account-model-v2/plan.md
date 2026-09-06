---
kind: plan
surface: cli
title: Account model v2 — install a harness once, add accounts, sync them to workers
summary: One managed installation per harness plus N credential slots; one verb (`agents accounts add <harness>`) logs in, mints the worker credential, and syncs both to the fleet; every listing shows a real auth verdict and the fix.
header: Phoenix Labs / agents-cli
footer: Change proposal · nothing lands from this document
project: agents-cli
repository: phnx-labs/agi-cli
branch: main
harness: claude
agent: claude-fable-5-1
host: laptop
session: session-redacted
tracking: PHNX-3940
status: draft
date: "2026-09-06"
links:
  - url: https://linear.app/getrush/issue/PHNX-3940
    label: PHNX-3940 fleet account state inconsistent across machines
  - url: https://linear.app/getrush/issue/PHNX-3988
    label: PHNX-3988 per-harness rename/remove (PR #3491, in flight)
  - url: https://linear.app/getrush/issue/PHNX-3887
    label: PHNX-3887 labels unique per harness
  - url: https://linear.app/getrush/issue/PHNX-3728
    label: PHNX-3728 automatic mint → sync → inject
  - url: https://linear.app/getrush/issue/PHNX-3975
    label: PHNX-3975 declare config once, project to all installs
  - url: https://github.com/phnx-labs/agi-cli/pull/3493
    label: PR #3493 accounts UX + provisioning audit
  - url: https://code.claude.com/docs/en/authentication
    label: Claude Code authentication (setup-token, CLAUDE_CONFIG_DIR)
  - url: https://learn.chatgpt.com/docs/auth/ci-cd-auth
    label: Codex CLI headless auth (API key, auth.json per runner)
  - url: https://docs.x.ai/build/cli/headless-scripting
    label: Grok CLI headless auth
  - url: https://antigravity.google/docs/cli/headless/
    label: Antigravity CLI headless auth
---

## Focus for review

1. **An account is a credential slot, not an installation.** One managed installation per harness (`main`, release moves on update); every account gets a HOME-shaped slot with no binary in it. The binary/config split already exists at `commands/exec.ts:2580-2596` (`version` vs `accountConfigVersion`); the plan stops `connect` from installing a second copy per account and stops listing slots as installations.
2. **`agents accounts add <harness> [name]` is the only onboarding verb.** On a headed device it runs the native login in the new slot, registers the account fleet-wide, mints the worker credential (Claude: `setup-token`; API-key harnesses: prompt or `--api-key`), and hands both to the daemon sync. On a worker it refuses. `connect`, `name`, `label`, `mint`, `attach` become hidden aliases or fold away.
3. **Workers are provisioned from the account row, never from a home.** The daemon `auth-sync` tick already pushes the reserved `auth` bundle to a peer whose verdict is `missing` (`secrets/reserved-sync.ts:36-60`); the plan generalizes that to every account's `workerCredential` and materializes a worker slot per account. Native OAuth files stay banned from transport (`fleet/auth-sync.ts:53-66`).
4. **`connected` becomes a verdict.** The daemon already computes `live | expired | revoked | rate_limited | unverified` per identity; the listing renders it with a `FIX` column and the daemon notifies on `live → expired|revoked`. Today the word `connected` means "a credential file exists".
5. **Bundles are not a user concept, and the store may only hold credentials that are safe to share.** The listing never shows a bundle; the worker credential is a hidden field of the account. Each harness owns one reserved, hard-coded store name (`__claude__`, `__codex__`, …) that a user-named bundle can never collide with, and the store refuses any rotating OAuth/session credential at write time — only a setup-token or an API key may enter it, because a refresh-bearing session reused on two devices logs the owner out (RUSH-1958).
6. **Migration folds N homes into 1 install + N slots without touching credentials.** Homes are moved, not copied; empty logged-out homes and duplicates go to trash (`agents trash restore` reverses); session paths are re-indexed. The risky steps are named in Risks.

## Purpose

The owner's words, 2026-09-06: "we have completely moved on from having different variants and connecting accounts … a user installs Claude once and then connects multiple accounts. He does `agents add claude@latest`, then `agents accounts add claude`, and he's basically just signing into a Claude account and it should be taken care of." Plus: `agents view claude --versions` is legacy and should be hidden or removed; syncing that information to workers is part of the same problem; identify all the gaps and cover them in one plan with system diagrams and user journeys.

Three earlier documents from today feed this one and are cited rather than repeated: the accounts UX + provisioning audit (PR #3493, `accounts-ux-audit.md`), the worker-identity diagnosis (`fleet-worker-account-identity/plan.md`, session session-redacted), and the per-harness name fix (PHNX-3988, PR #3491). The per-harness sign-in research and the file:line code map are in `evidence-harness-auth.md` and `evidence-code-map.md` beside this file.

## What the owner sees today

Captures from the owner's terminal, 2026-09-06, redacted for a public repo (emails to `m***@…`, devices to `laptop` / `worker-n`).

```text
$ agents view codex --device worker-1 --versions
Installed Agent CLIs
  Codex (available)
    0.146.0 (default)  default  (logged out — log in with: codex login)
    0.153.4            default  cxpersonal · m***@gmail.com   Pro   W: █▉░░░ 38% (6d)   3h ago
    0.153.3 → 0.153.4  default  cxicloud · m***@icloud.com    Pro   W: ▉░░░░ 18% (17h)  5h ago
    0.147.0 → 0.153.4  default  cxsmores · t***@…             Team  W: ███▋░ 72% (2d)   19h ago
    0.153.2 → 0.153.4  default  (logged out — log in with: codex login)
    0.145.0 → 0.153.4  default  (logged out — log in with: codex login)

$ agents view codex          # on the laptop, same three identities
    * gmail · m***@gmail.com    connected  default  Pro  W: ███░░ 59% (6d)
      cxicloud · m***@icloud.com connected  default  Pro  W: █▉░░░ 37% (17h)
      cxsmores · t***@…          connected  default  Team W: █▎░░░ 26% (2d)
```

<div class="artifact-callout">
Six codex installations on one worker for three accounts: three homes carry a login, three are empty, and the <em>default</em> one is logged out (its JSON reads <code>signedIn:false, launchable:false</code>), so a bare <code>agents run codex</code> there picks an unlaunchable home. The same identity is <code>gmail</code> on the laptop and <code>cxpersonal</code> on the worker. Every row says <code>connected</code> or <code>logged out</code>; nothing says expired, revoked, or "fix with …".
</div>

| Symptom | Root cause | Evidence |
|---|---|---|
| Extra installations per account | `accounts connect` mints an opaque `acct-<hex>` label and installs a full release into it | `lib/accounts/connect.ts:8-25, 109-111, 389-396` |
| `0.147.0 → 0.153.4` arrows | The installation label is frozen at creation; only the release moves | `lib/installations/types.ts:47-53` |
| Empty logged-out homes never leave | Migration keeps every home; there is no per-installation remove | `docs/version-management.md:33-36`, `agents uninstall --help` |
| Label drift across devices | Device-scoped rows and connect homes deliberately never sync | `lib/account-registry.ts:293-315, 352-357`, `lib/types.ts:933-956` |
| Worker rows read "not connected here" | The setup-token seed writes only the email; the registry keys on account+org uuid | sibling plan E1–E11, `claude-account-token.ts:274` |
| Expiry is silent | `authVerdict` exists (`lib/auth-health.ts:50-57`) but no listing renders it and no notify fires on transition | audit §3.2, findings 1–3 |
| `connect` wired for two harnesses | `LOGIN_INVOCATIONS` = claude, codex | `lib/accounts/connect.ts:59-62` |
| A rename on the laptop never reaches a worker | The worker's `~/.agents` clone was 639 commits behind origin with 61 unpushed daemon "publish state" commits and a dirty tree of CLI-owned files, so `agents repo pull` refuses ("needs a clean tree") and the daemon's own push loop never recovers. The row ids are byte-identical on both devices, so the data is right and only the transport is stuck | live capture 2026-09-06 after PHNX-3988 landed; PHNX-3968 |

## User journeys

Each journey names the person, the machines, and the exact commands. The stick figure is the owner; the laptop is the headed device where every interactive login is minted (invariant 7); the racks are workers; the cloud is the fleet-shared `~/.agents` Git repo; the key is a durable credential carried over the existing encrypted SSH transfer.

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 1100 560" role="img" aria-label="Journey 1: install once, add an account, the fleet provisions itself">
  <text x="30" y="30" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Journey 1 — new user: install once, add the first account, fleet provisions itself</text>
  <!-- person -->
  <circle cx="80" cy="120" r="16" fill="none" stroke="#c8c8c8" stroke-width="2"/>
  <line x1="80" y1="136" x2="80" y2="190" stroke="#c8c8c8" stroke-width="2"/>
  <line x1="80" y1="150" x2="52" y2="175" stroke="#c8c8c8" stroke-width="2"/>
  <line x1="80" y1="150" x2="108" y2="175" stroke="#c8c8c8" stroke-width="2"/>
  <line x1="80" y1="190" x2="58" y2="230" stroke="#c8c8c8" stroke-width="2"/>
  <line x1="80" y1="190" x2="102" y2="230" stroke="#c8c8c8" stroke-width="2"/>
  <text x="80" y="256" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#8a8a8a">owner</text>
  <!-- laptop -->
  <rect x="200" y="110" width="150" height="95" rx="6" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <rect x="185" y="205" width="180" height="12" rx="3" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="275" y="145" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">laptop (personal)</text>
  <text x="275" y="165" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">native OAuth minted here</text>
  <text x="275" y="182" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">setup-token minted here</text>
  <!-- cloud (git) -->
  <ellipse cx="600" cy="150" rx="110" ry="46" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="600" y="145" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">~/.agents git (central)</text>
  <text x="600" y="163" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">accounts.native rows · defaults</text>
  <!-- key (ssh) -->
  <circle cx="600" cy="268" r="12" fill="none" stroke="#a3e635" stroke-width="2"/>
  <line x1="612" y1="268" x2="660" y2="268" stroke="#a3e635" stroke-width="2"/>
  <line x1="645" y1="268" x2="645" y2="280" stroke="#a3e635" stroke-width="2"/>
  <line x1="658" y1="268" x2="658" y2="278" stroke="#a3e635" stroke-width="2"/>
  <text x="600" y="305" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">durable credential · encrypted SSH · never Git</text>
  <!-- workers -->
  <g>
    <rect x="850" y="100" width="190" height="34" rx="5" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <rect x="850" y="140" width="190" height="34" rx="5" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <rect x="850" y="180" width="190" height="34" rx="5" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
    <circle cx="866" cy="117" r="4" fill="#a3e635"/><circle cx="866" cy="157" r="4" fill="#a3e635"/><circle cx="866" cy="197" r="4" fill="#a3e635"/>
    <text x="945" y="122" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">worker-1</text>
    <text x="945" y="162" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">worker-2</text>
    <text x="945" y="202" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">worker-3</text>
    <text x="945" y="240" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">slot per account · token injected at spawn</text>
  </g>
  <!-- arrows -->
  <line x1="120" y1="160" x2="185" y2="160" stroke="#c8c8c8" stroke-width="1.5"/>
  <line x1="365" y1="150" x2="490" y2="150" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="365" y1="200" x2="588" y2="262" stroke="#a3e635" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="710" y1="150" x2="850" y2="150" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="660" y1="268" x2="850" y2="200" stroke="#a3e635" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <!-- steps -->
  <text x="30" y="360" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">1  agents add claude                     installs ONE managed Claude (label main), no login yet</text>
  <text x="30" y="382" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">2  agents accounts add claude work       opens the browser login inside the new slot → identity captured → row "work" registered</text>
  <text x="30" y="404" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">3  (same command)                        runs claude setup-token → 1-year worker token stored in the __claude__ store for "work"</text>
  <text x="30" y="426" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">4  daemon tick (laptop)                  commits accounts.native + defaults to the central repo; pushes</text>
  <text x="30" y="448" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">5  daemon tick (each worker)             pulls the row; verdict says "missing" → asks the laptop for the bundle over SSH</text>
  <text x="30" y="470" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">6  worker materializes slot              accounts/claude/&lt;id&gt;/ with the token; identity joined from the registry row</text>
  <text x="30" y="492" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">7  agents run claude#work --device worker-1   binary from main, HOME = the work slot, token injected — no login prompt</text>
  <text x="30" y="530" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Nothing in steps 4–6 is new transport: the same shared-state tick and reserved-bundle SSH push exist today for the single `auth` bundle. The delta is that they key on the account row.</text>
</svg>
<figcaption>Journey 1. Install once, add an account, the fleet provisions itself. Amber = headed laptop actions; blue = Git-synced metadata; lime = the durable credential and the worker slot.</figcaption>
</figure>

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 1100 420" role="img" aria-label="Journeys 2 to 5: second account, run by label, expiry and re-auth, rename">
  <text x="30" y="30" font-family="Inter, system-ui, sans-serif" font-size="13" fill="#c8c8c8">Journeys 2–5 — everyday operations, every one a single verb</text>
  <rect x="30" y="52" width="500" height="150" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="46" y="76" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">J2 · second account on the same install</text>
  <text x="46" y="100" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">agents accounts add claude personal</text>
  <text x="46" y="120" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">no second installation · new slot · new row · worker token minted</text>
  <text x="46" y="150" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">agents accounts default claude personal</text>
  <text x="46" y="170" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">the * moves; synced fleet-wide with the row (today's set-default and switch fold into this)</text>
  <rect x="570" y="52" width="500" height="150" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="586" y="76" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">J3 · run a specific account, anywhere</text>
  <text x="586" y="100" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">agents run claude#work "…"</text>
  <text x="586" y="120" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">agents run codex#gmail --device worker-2 "…"</text>
  <text x="586" y="150" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">#label selects the account (exec.ts:2168-2188 today); @version is gone from the happy path.</text>
  <text x="586" y="168" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Headed: slot's native login. Worker: slot + injected durable credential. Same selector.</text>
  <rect x="30" y="222" width="500" height="170" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="46" y="246" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">J4 · a login expires</text>
  <text x="46" y="270" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">daemon probe flips work: live → expired · owner feed post (important) · list shows the row in red with the fix</text>
  <text x="46" y="296" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">$ agents accounts list claude</text>
  <text x="46" y="314" font-family="JetBrains Mono, monospace" font-size="11" fill="#f87171">  work   m***@getrush.ai  EXPIRED 2h  laptop+3 workers  fix: agents accounts login claude#work</text>
  <text x="46" y="344" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">$ agents accounts login claude#work     (on the laptop: browser login into the same slot, re-mint, re-sync)</text>
  <text x="46" y="372" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Never a token fallback on the laptop (invariant 7). Workers refresh from the re-minted bundle on the next tick.</text>
  <rect x="570" y="222" width="500" height="170" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="586" y="246" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">J5 · rename and clean up</text>
  <text x="586" y="270" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">agents accounts rename codex#cxicloud icloud</text>
  <text x="586" y="290" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">per-harness names (PHNX-3887 + PHNX-3988) · the row syncs, so every device shows icloud</text>
  <text x="586" y="318" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">agents accounts remove codex#smores</text>
  <text x="586" y="338" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">row + bundle + every device's slot go to trash; agents trash restore reverses it</text>
  <text x="586" y="366" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">agents accounts logout kimi     (this box only — kimi is per-device)</text>
</svg>
<figcaption>Journeys 2–5. One verb each: add, default, run by label, login (re-auth), rename, remove, logout.</figcaption>
</figure>

## Current architecture

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 1100 520" role="img" aria-label="Current architecture: each account is a full installation; the device-local home map and connect homes never sync">
  <text x="30" y="28" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">laptop (headed) — per-account INSTALLATIONS</text>
  <text x="620" y="28" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">worker — what actually arrives</text>
  <rect x="30" y="44" width="500" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="46" y="66" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">versions/claude/main/ · installation.json{label:main, release}</text>
  <text x="46" y="84" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">node_modules + home/.claude (login A)   ← agents add claude</text>
  <text x="46" y="102" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">installations/store.ts:167-192 · versions.ts:94-106</text>
  <rect x="30" y="126" width="500" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="46" y="148" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">versions/claude/acct-3f9a…/ · installation.json{label:acct-3f9a}</text>
  <text x="46" y="166" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">node_modules (2nd copy) + home/.claude (login B) ← accounts connect</text>
  <text x="46" y="184" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">accounts/connect.ts:109-111, 389-396</text>
  <rect x="30" y="208" width="500" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="46" y="230" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">versions/claude/2.1.187/ … (empty, logged-out homes from old adds)</text>
  <text x="46" y="248" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">listed by --versions · counted by balanced rotation as candidates</text>
  <text x="46" y="266" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">accounting/rotate.ts:904-946 · view.ts:2157</text>
  <rect x="30" y="300" width="500" height="60" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="46" y="322" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">central agents.yaml · accounts.native[id]{name, identityKey, label} · defaults · bindings</text>
  <text x="46" y="342" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">SYNCS (repo push/pull, staged by the daemon tick)  state.ts:1055-1077</text>
  <rect x="30" y="372" width="500" height="60" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="46" y="394" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">device doc · deviceAccounts.homes[id] = "acct-3f9a" · pendingConnects</text>
  <text x="46" y="414" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">NEVER SYNCS (by design)  types.ts:933-956 · state.ts:1140-1152</text>
  <rect x="30" y="444" width="500" height="60" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="46" y="466" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">reserved `auth` bundle · CLAUDE_CODE_OAUTH_TOKEN_&lt;EMAIL&gt; (claude only) · 9 named claude-* bundles</text>
  <text x="46" y="486" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">daemon auth-sync pushes to a `missing` peer over SSH  reserved-sync.ts:36-60</text>
  <!-- connectors -->
  <line x1="530" y1="330" x2="620" y2="330" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="530" y1="474" x2="620" y2="474" stroke="#a3e635" stroke-dasharray="3 3" opacity="0.7"/>
  <rect x="620" y="300" width="450" height="60" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="636" y="322" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">identical account rows arrive</text>
  <text x="636" y="342" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">but no home is bound to them here (homes map is device-local)</text>
  <rect x="620" y="444" width="450" height="60" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="636" y="466" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">token arrives → seeded into SOME version home with email only</text>
  <text x="636" y="486" font-family="JetBrains Mono, monospace" font-size="11" fill="#8a8a8a">uuids dropped → row never folds → "not connected here"  (sibling plan E1)</text>
  <rect x="620" y="44" width="450" height="234" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="636" y="66" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">versions/codex/{0.145.0, 0.146.0, 0.147.0, 0.153.2, 0.153.3, 0.153.4}</text>
  <text x="636" y="88" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">6 installations · 3 logins · 3 empty · default = logged out</text>
  <text x="636" y="110" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">labels applied per box → cxpersonal here, gmail on the laptop</text>
  <text x="636" y="140" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Run-time selection today (account-registry.ts:710-757 → exec.ts:2580-2596):</text>
  <text x="636" y="160" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">--account → exact agent@version binding → device binding → default</text>
  <text x="636" y="178" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">native account ⇒ resolveAccountVersion ⇒ that home's installation</text>
  <text x="636" y="196" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">binary = `version`, config = `accountConfigVersion` (already split)</text>
  <text x="636" y="226" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Health today: `connected` = credential file present (account-catalog.ts:220,255).</text>
  <text x="636" y="246" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">authVerdict computed by the daemon, rendered nowhere but `devices ping`.</text>
</svg>
<figcaption>Current: the account IS an installation; the binding from account to home is device-local by design; the worker receives rows and a token but no way to join them.</figcaption>
</figure>

## Proposed architecture

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 1100 560" role="img" aria-label="Proposed architecture: one installation per harness, account slots, fleet-synced rows, daemon-provisioned worker slots">
  <text x="30" y="28" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">laptop (headed) — ONE installation, N slots</text>
  <text x="620" y="28" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">worker — slots materialized by the daemon</text>
  <rect x="30" y="44" width="500" height="64" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="46" y="66" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">HarnessInstallation  versions/claude/main/ · binary + shared settings/resources</text>
  <text x="46" y="86" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">no credential lives here · `agents update claude` moves its release</text>
  <rect x="30" y="122" width="240" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="46" y="144" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Slot accounts/claude/&lt;id-work&gt;/</text>
  <text x="46" y="162" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">HOME-shaped · native OAuth (work)</text>
  <text x="46" y="180" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">projected settings/skills/hooks</text>
  <rect x="290" y="122" width="240" height="70" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="306" y="144" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Slot accounts/claude/&lt;id-personal&gt;/</text>
  <text x="306" y="162" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">HOME-shaped · native OAuth (personal)</text>
  <text x="306" y="180" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">same binary, different HOME</text>
  <rect x="30" y="206" width="500" height="64" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="46" y="228" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Account row (central, SYNCS)  {id, harness, name, identityKey,</text>
  <text x="46" y="248" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">identityLabel, workerCredential:{bundle,key}, provisioning}</text>
  <rect x="30" y="284" width="500" height="64" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="46" y="306" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">DeviceAccountSlot (device doc, local)  {accountId → slotDir, authMode, verdict, checkedAt}</text>
  <text x="46" y="326" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">replaces deviceAccounts.homes; still never syncs — paths are per box</text>
  <rect x="30" y="362" width="500" height="64" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="46" y="384" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Worker credentials · one bundle key per account</text>
  <text x="46" y="404" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">__claude__ / __codex__ stores · keys by account id · non-rotating only</text>
  <rect x="30" y="440" width="500" height="64" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="46" y="462" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Daemon services (the ONLY scheduler): account-state + auth-sync</text>
  <text x="46" y="482" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">verdicts + notify · commits agents.yaml · per-account bundle sync</text>
  <!-- connectors -->
  <line x1="530" y1="238" x2="620" y2="238" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="530" y1="394" x2="620" y2="394" stroke="#a3e635" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="530" y1="472" x2="620" y2="472" stroke="#38bdf8" stroke-dasharray="3 3" opacity="0.7"/>
  <rect x="620" y="44" width="450" height="64" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="636" y="66" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">HarnessInstallation  versions/claude/main/ (auto-updated, same as today)</text>
  <text x="636" y="86" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">one binary · no credential</text>
  <rect x="620" y="122" width="450" height="70" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="636" y="144" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Slots accounts/claude/&lt;id-work&gt;/, …/&lt;id-personal&gt;/</text>
  <text x="636" y="162" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">token injected at spawn (worker role) · identity joined from the row</text>
  <text x="636" y="180" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">kimi / antigravity: slot exists, login per box (agents fleet login)</text>
  <rect x="620" y="206" width="450" height="64" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="636" y="228" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">same Account rows (pulled by the daemon tick)</text>
  <text x="636" y="248" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">name, default, workerCredential ref — identical on every device</text>
  <rect x="620" y="284" width="450" height="64" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="636" y="306" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">DeviceAccountSlot (this worker's) · verdict per account</text>
  <text x="636" y="326" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">live | expired | revoked | missing → daemon-state.json → --fleet</text>
  <rect x="620" y="362" width="450" height="64" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="636" y="384" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">bundle received only when verdict = missing (existing rule)</text>
  <text x="636" y="404" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">native OAuth files never transported (auth-sync.ts:53-66 unchanged)</text>
  <rect x="620" y="440" width="450" height="64" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="636" y="462" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">agents run claude#work → binary main + HOME = slot + injected token</text>
  <text x="636" y="482" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">balanced rotation iterates SLOTS with live verdicts, not version dirs</text>
  <text x="30" y="540" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Coupling points that change: installations/store · accounts/connect → slot · exec (HOME = slot) · rotate (slots) · reserved-sync (per account) · account-catalog (verdict) · view/accounts.</text>
</svg>
<figcaption>Proposed: the account row is the fleet-wide fact; the slot is the per-device materialization; the daemon keeps them equal. The binary is shared.</figcaption>
</figure>

### Data model

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 1100 400" role="img" aria-label="Class diagram of the proposed account model">
  <rect x="30" y="40" width="300" height="130" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="46" y="62" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">HarnessInstallation  (per harness, per device)</text>
  <line x1="30" y1="70" x2="330" y2="70" stroke="#a3e635" stroke-width="1"/>
  <text x="46" y="90" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">harness: AgentId</text>
  <text x="46" y="108" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">label: 'main'  (pins stay expert-only)</text>
  <text x="46" y="126" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">releaseVersion: string  (moves on update)</text>
  <text x="46" y="144" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">dir: versions/&lt;harness&gt;/main/</text>
  <text x="46" y="162" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">installation.json unchanged (types.ts:26-53)</text>
  <rect x="400" y="40" width="330" height="170" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="416" y="62" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">Account  (central agents.yaml, fleet-synced)</text>
  <line x1="400" y1="70" x2="730" y2="70" stroke="#38bdf8" stroke-width="1"/>
  <text x="416" y="90" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">id: uuid · harness · name (unique per harness)</text>
  <text x="416" y="108" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">identityKey · identityLabel (email)</text>
  <text x="416" y="126" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">provisioning: 'portable' | 'per-device'</text>
  <text x="416" y="144" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">workerCredential?: {bundle, key, kind, mintedAt}</text>
  <text x="416" y="162" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">createdOn: deviceName · createdAt</text>
  <text x="416" y="180" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">extends NativeAccount (types.ts) · never a secret value</text>
  <text x="416" y="198" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">defaults[harness] = id · bindings unchanged</text>
  <rect x="800" y="40" width="270" height="150" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="816" y="62" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">DeviceAccountSlot  (device doc)</text>
  <line x1="800" y1="70" x2="1070" y2="70" stroke="#f59e0b" stroke-width="1"/>
  <text x="816" y="90" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">accountId → slotDir</text>
  <text x="816" y="108" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">authMode: native | durable | per-device</text>
  <text x="816" y="126" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">verdict: AuthVerdict · checkedAt</text>
  <text x="816" y="144" font-family="JetBrains Mono, monospace" font-size="11" fill="#f59e0b">pending?: onboarding in flight</text>
  <text x="816" y="162" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">replaces deviceAccounts.homes/pendingConnects</text>
  <rect x="400" y="250" width="330" height="110" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="416" y="272" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">ReservedStore  (`__&lt;harness&gt;__`, hidden from users)</text>
  <line x1="400" y1="280" x2="730" y2="280" stroke="#a3e635" stroke-width="1"/>
  <text x="416" y="300" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">__claude__: CLAUDE_CODE_OAUTH_TOKEN_&lt;id&gt; = sk-ant-oat01-…</text>
  <text x="416" y="318" font-family="JetBrains Mono, monospace" font-size="11" fill="#a3e635">__codex__: OPENAI_API_KEY_&lt;id&gt; · __grok__: XAI_API_KEY_&lt;id&gt;</text>
  <text x="416" y="336" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">SSH transfer to `missing` peers only (reserved-sync.ts)</text>
  <rect x="800" y="250" width="270" height="110" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="816" y="272" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">HarnessAuthCapability  (registry table)</text>
  <line x1="800" y1="280" x2="1070" y2="280" stroke="#38bdf8" stroke-width="1"/>
  <text x="816" y="300" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">login: argv | null · identity: strong|email|opaque</text>
  <text x="816" y="318" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">worker: setup-token | api-key(env) | none</text>
  <text x="816" y="336" font-family="JetBrains Mono, monospace" font-size="11" fill="#38bdf8">status: argv | null · slotEnv: HOME | CONFIG_DIR</text>
  <!-- relationships -->
  <line x1="330" y1="100" x2="400" y2="100" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="340" y="94" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">1 ─ N</text>
  <line x1="730" y1="100" x2="800" y2="100" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="742" y="94" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">1 ─ 0..1 per device</text>
  <line x1="565" y1="210" x2="565" y2="250" stroke="#a3e635" stroke-width="1.5"/>
  <text x="572" y="235" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">workerCredential ref</text>
  <line x1="935" y1="190" x2="935" y2="250" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="942" y="225" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">governs</text>
  <text x="30" y="390" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Account keeps NativeAccount's id/name/identityKey so every existing row migrates in place; the two new fields are additive. Slot dirs are HOME-shaped so the existing HOME swap in exec.ts is the isolation mechanism for every harness (CLAUDE_CONFIG_DIR keying stays as the claude adapter does it today).</text>
</svg>
<figcaption>Data model. One installation per harness per device; N accounts fleet-wide; one slot per (account, device); one durable credential per portable account.</figcaption>
</figure>

### `agents accounts add claude work` on the laptop, step by step

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 1100 470" role="img" aria-label="Sequence of agents accounts add on a headed device">
  <text x="90" y="30" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">owner</text>
  <text x="300" y="30" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">agents accounts add</text>
  <text x="520" y="30" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">claude (in slot)</text>
  <text x="740" y="30" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">registry + secrets</text>
  <text x="960" y="30" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">daemon</text>
  <line x1="90" y1="40" x2="90" y2="440" stroke="#8a8a8a" stroke-dasharray="3 3"/>
  <line x1="300" y1="40" x2="300" y2="440" stroke="#8a8a8a" stroke-dasharray="3 3"/>
  <line x1="520" y1="40" x2="520" y2="440" stroke="#8a8a8a" stroke-dasharray="3 3"/>
  <line x1="740" y1="40" x2="740" y2="440" stroke="#8a8a8a" stroke-dasharray="3 3"/>
  <line x1="960" y1="40" x2="960" y2="440" stroke="#8a8a8a" stroke-dasharray="3 3"/>
  <line x1="90" y1="70" x2="300" y2="70" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="195" y="64" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">1 add claude work</text>
  <line x1="300" y1="100" x2="740" y2="100" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="520" y="94" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">2 role=headed? name free for claude? install main if absent; create slot dir; project settings</text>
  <line x1="300" y1="130" x2="520" y2="130" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="410" y="124" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">3 HOME=slot claude auth login (browser)</text>
  <line x1="520" y1="160" x2="300" y2="160" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="410" y="154" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">4 .claude.json oauthAccount {email, accountUuid, orgUuid}</text>
  <line x1="300" y1="190" x2="740" y2="190" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="520" y="184" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">5 identity unique for claude? → Account row (central) + Slot (device) + default if first</text>
  <line x1="300" y1="220" x2="520" y2="220" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="410" y="214" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">6 HOME=slot claude setup-token (2nd browser grant)</text>
  <line x1="520" y1="250" x2="740" y2="250" stroke="#a3e635" stroke-width="1.5"/>
  <text x="630" y="244" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">7 sk-ant-oat01-… → __claude__ store, key CLAUDE_CODE_OAUTH_TOKEN_&lt;id&gt;; row.workerCredential set</text>
  <line x1="300" y1="280" x2="960" y2="280" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="630" y="274" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">8 request reconcile now (no second scheduler; the daemon owns the tick)</text>
  <line x1="960" y1="310" x2="740" y2="310" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="850" y="304" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">9 commit agents.yaml, push; publish verdict</text>
  <line x1="300" y1="340" x2="90" y2="340" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="195" y="334" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">10 "work · m***@… · live · run: agents run claude#work"</text>
  <rect x="30" y="370" width="1040" height="60" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="46" y="392" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Failure paths: step 3 cancelled → slot removed, nothing registered (connect.ts:275-306 already does this). Step 4 identity already registered → "already added as &lt;name&gt;; use accounts login" (connect.ts:349). Step 6 declined (`--no-worker-token`) → row provisioning stays per-device with a doctor warning.</text>
  <text x="46" y="412" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#c8c8c8">Codex/Grok/OpenCode/Cursor: step 6 is `--api-key` or an interactive prompt (no derivable token). Kimi/Antigravity: step 6 is skipped, provisioning = per-device, printed as such.</text>
</svg>
<figcaption>Two browser grants on the laptop: the native login (identity + usage, headed use) and the setup-token (identity-blind, workers only). That answers "setup-token OAuth or something else": both, in one command.</figcaption>
</figure>

### Account lifecycle

<figure class="artifact-figure artifact-figure-wide artifact-figure-diagram">
<svg viewBox="0 0 1100 260" role="img" aria-label="Account lifecycle states and the command on each edge">
  <rect x="30" y="90" width="150" height="56" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="105" y="114" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">absent</text>
  <text x="105" y="132" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">no row anywhere</text>
  <rect x="260" y="90" width="150" height="56" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.5"/>
  <text x="335" y="114" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">live</text>
  <text x="335" y="132" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">row + slot + verdict live</text>
  <rect x="490" y="20" width="150" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="565" y="44" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">rate_limited</text>
  <text x="565" y="62" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">rotation skips it</text>
  <rect x="490" y="160" width="150" height="56" rx="8" fill="#16120a" stroke="#f87171" stroke-width="1.5"/>
  <text x="565" y="184" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">expired / revoked</text>
  <text x="565" y="202" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">notify owner · FIX column</text>
  <rect x="720" y="90" width="150" height="56" rx="8" fill="#0e1418" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="795" y="114" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">missing (device)</text>
  <text x="795" y="132" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">row known, no slot here</text>
  <rect x="950" y="90" width="120" height="56" rx="8" fill="#16120a" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="1010" y="114" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#c8c8c8">trashed</text>
  <text x="1010" y="132" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#8a8a8a">restore reverses</text>
  <line x1="180" y1="118" x2="260" y2="118" stroke="#a3e635" stroke-width="1.5"/>
  <text x="220" y="110" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">accounts add</text>
  <line x1="410" y1="105" x2="490" y2="55" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="440" y="70" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">usage probe</text>
  <line x1="490" y1="60" x2="410" y2="100" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <line x1="410" y1="130" x2="490" y2="180" stroke="#f87171" stroke-width="1.5"/>
  <text x="440" y="168" font-family="JetBrains Mono, monospace" font-size="10" fill="#f87171">daemon probe 401/403</text>
  <line x1="490" y1="200" x2="330" y2="146" stroke="#a3e635" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <text x="330" y="180" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">accounts login &lt;h&gt;#&lt;name&gt; (laptop)</text>
  <line x1="640" y1="118" x2="720" y2="118" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.7"/>
  <text x="680" y="110" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#38bdf8">row synced</text>
  <line x1="720" y1="130" x2="640" y2="140" stroke="#a3e635" stroke-width="1.5"/>
  <text x="690" y="150" font-family="JetBrains Mono, monospace" font-size="10" fill="#a3e635">daemon provisions slot</text>
  <line x1="870" y1="118" x2="950" y2="118" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="910" y="110" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="#f59e0b">accounts remove</text>
  <text x="30" y="245" font-family="Inter, system-ui, sans-serif" font-size="10" fill="#8a8a8a">Verdict vocabulary is the existing AuthVerdict (auth-health.ts:50-57). `logout` on a per-device harness moves only this device's slot to missing; it never edits the row.</text>
</svg>
<figcaption>Every edge is one command or one daemon tick. There is no state a user has to reason about that the listing does not show.</figcaption>
</figure>

## Credential store rules and the scenarios they must survive

<div class="artifact-callout artifact-callout-warn">
The owner's rule, 2026-09-06: users never see or name bundles; the per-harness store is a reserved word; and a rotating token must never be stored, because reusing it across devices logs the user out. The table below is the contract the code enforces at write time, not advice.
</div>

| Credential kind | Example | Rotates? | May enter the reserved store? | Concurrent use on N devices | Decision |
|---|---|---|---|---|---|
| Long-lived bearer minted for automation | Claude `setup-token` (1 yr, `user:inference` only) | no | **yes** | safe: bearer, no refresh, no server-side session | worker credential for claude |
| Provider API key | `OPENAI_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY`, `FACTORY_API_KEY`, `GEMINI_API_KEY` | no (until revoked) | **yes** | safe | worker credential for api-key harnesses |
| Native OAuth session with refresh token | claude `.credentials.json`, codex `auth.json` (~8-day refresh), grok `auth.json` (30-day), kimi `credentials/*.json`, droid, antigravity keyring | **yes** | **never** (write refused) | unsafe: the first device to refresh invalidates the copy on every other device — droid collapsed 10 boxes to 1 overnight (`fleet/auth-sync.ts:41-51`, RUSH-1958); codex docs say "do not share the same file across multiple machines" | stays in its slot on the device that minted it |
| Device-bound keyring entry | antigravity, claude on macOS Keychain | n/a | never | not portable | per-device login (`agents fleet login`) |
| ChatGPT-plan Codex login (Pro/Team seat, no API billing) | codex `auth.json` from `codex login --device-auth` | yes | never | unsafe (same as any refresh session) | **per-device device-code login** via `agents devices login --agents codex --devices …`; the capability table records codex as `worker: api-key OR per-device`, chosen per account by whether the account carries a key. An API key would bill the API, not the plan, so it is not a substitute for a plan account (owner, 2026-09-06) |

**Reserved store names.** One store per harness, named `__<harness>__` from a hard-coded table derived from `ALL_AGENT_IDS` (`__claude__`, `__codex__`, `__grok__`, …). The secrets layer rejects any user-created bundle whose name starts with `__`, and the table is the only place a reserved name can be added, so a user can neither shadow one nor mint a new one. Keys inside are `<ENV>_<accountId>` (`CLAUDE_CODE_OAUTH_TOKEN_9f2c…`), never `_<EMAIL>`, so a rename or an email change never breaks the key. The existing single `auth` bundle is migrated into `__claude__` and kept readable as an alias for one release. `agents secrets` still lists reserved stores (they are real bundles) but `agents accounts` never mentions them.

**Scenarios the store must survive** (each is a test in T6):

| Scenario | What happens | Why it is safe |
|---|---|---|
| Two workers run `claude#work` at the same second | both inject the same setup-token | bearer token, no refresh, no session cookie |
| The laptop re-mints `work` (expired) while workers still hold the old token | new key value written under the same `<ENV>_<id>`; verdict on workers flips to `expired` on their next probe; daemon pushes the new value | keys are per account id, so the rotation is a value update, not a new key |
| The owner renames `work` → `getrush` | row name changes; key `<ENV>_<id>` unchanged; every device's slot dir is by id | nothing keyed on the name |
| The owner removes `work` | row → trash, key deleted from `__claude__` on the laptop, daemon deletes it on workers and trashes their slots | removal is the only path that deletes a key |
| Someone tries to store a codex `auth.json` refresh session into `__codex__` | write refused: `codex: auth.json is a rotating session; add an API key instead` | kind check at the write boundary |
| The same email is a Team seat AND a personal Max | two accounts, two ids, two keys | identity is account+org uuid, not email |
| A worker is offline during the push | its verdict stays `missing`; next tick retries | verdict-gated, idempotent push |
| A headed peer (`desktop`) syncs the row | receives the row, never the key (role filter) | invariant 7 |
| An ambient `CLAUDE_CODE_OAUTH_TOKEN` is set in the owner's shell | `accounts add` refuses to mint until it is unset | prevents collapsing every slot to one account (`signin-badge.ts:69-74`) |
| A user names a bundle `__claude__` by hand | rejected: reserved | hard-coded table |

## Options considered

| Choice | Option | Implication | Verdict |
|---|---|---|---|
| Unit of an account | A. HOME-shaped slot with no binary; selected per spawn through the harness's config-dir pin (`CONFIG_ENV_ISOLATED_AGENTS`: claude, codex, copilot, kimi, grok, cursor, muse; opencode once its exec pin lands) | Reuses `exec.ts` config/binary split and the adapters' existing pins; symlink-adopted harnesses (gemini, antigravity, droid, openclaw, amp, goose, hermes, warp — `shims.ts:1153-1167`) get ONE active slot per box, switched by `accounts default` under the auth-op lock | **winner** |
| | B. Per-spawn env redirect for every harness | Not possible: eight harnesses expose no config-dir env (research + `shims.ts:1153-1167`) | rejected: partial coverage |
| | C. Keep per-account installations, only hide `--versions` | Cosmetic; six codex dirs and the update-per-home problem remain | rejected |
| Onboarding verb | A. `accounts add <harness> [name]` = login + register + mint + sync | One verb, matches the owner's words; `add <name> --provider` moves to `accounts add <harness> --api-key` | **winner** |
| | B. Keep `connect` and add `mint` to it | Two verbs for one act; "connect" reads as a second install | rejected |
| Worker credential for Claude | setup-token minted in the same `add` run, second browser grant | Identity-blind by design; the row supplies identity (sibling plan) | **winner** |
| Worker credential for API-key harnesses | Prompt / `--api-key` in `add`; never derived from OAuth | No CLI exposes a derivable durable token | **winner** |
| Where identity for a worker slot comes from | Registry row at read time (sibling plan option A) | Fixes every existing email-only home on upgrade | **adopted from sibling plan** |
| Health | Render daemon `authVerdict` + notify on transition | Already computed; zero request-path cost | **winner** |
| Legacy surfaces | Hide (`--versions`, `@label`, `connect`, `name`, `label`, `attach`) behind `--advanced`/hidden commands for one release, then delete | Existing project pins and routines that name `agent@label` keep resolving to `main` | **winner**; deletion tracked as a follow-up release |
| Migration of homes | Move, never copy; trash empties/duplicates; re-index sessions | Reversible via `agents trash restore` | **winner** |
| What the store may hold | A. Only non-rotating kinds (setup-token, API key), enforced at write | A rotating session can never be shared by accident | **winner** (owner rule) |
| | B. Store native OAuth files too and rely on the transport ban | The ban is one predicate; a copied `auth.json` still logs the owner out the day someone widens it | rejected |
| Store naming | A. Reserved `__<harness>__` per harness from a hard-coded table; keys by account id | No collision with user bundles; rename-proof | **winner** (owner rule) |
| | B. Keep the single `auth` bundle with `_<EMAIL>` keys | Rename and `+`/`_` emails break the key (`emailFromTokenKey`) | rejected, kept as a read alias for one release |

## Independent panel

Two planners on other harnesses (Droid, Kimi) were given the problem, the constraints, and the file list, but not this proposal. Both are archived beside this file (`blind-plan-droid.md`, `blind-plan-kimi.md`). Both independently arrived at the same target shape (one installation per harness, config-only account homes selected at spawn, `accounts add` replacing `connect`, daemon-generalized bundle sync, verdicts rendered + notified), which is the high-confidence core. Divergences are the decisions below.

| Finding | From | Decision |
|---|---|---|
| Same target model: one `HarnessInstallation` per harness, `Account` fleet-shared, `DeviceAccountSlot` device-scoped with `authMode` + `health` | droid §2 | **ADOPTED** (high confidence: independently reached) |
| Slot isolation via a registry-driven per-harness env table (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `KIMI_CODE_HOME`, `OPENCODE_CONFIG_DIR`, `COPILOT_HOME`, HOME swap for cursor) | droid §2 | **ADOPTED as the capability table**, but the mechanism is the existing HOME swap for every harness (option A above); the table records which harnesses additionally need a `CONFIG_DIR` keyed for keychain entries. Antigravity and droid document no redirect (research), so a slot for them is the HOME swap only. |
| `accounts add <harness> [name]` replaces `connect`; `connect` hidden alias; `name`/`label` hidden; `attach`/`detach` out of public help; new `accounts rotate` | droid §3 | **ADOPTED**, except `rotate` folds into `accounts login <harness>#<name>` (re-auth re-mints). One verb for "make this account work again". |
| Worker `accounts add` refuses with "Add this account on a personal/desktop device" | droid §3 | **ADOPTED** verbatim |
| Generalize reserved-auth sync to every account's `workerCredentialRef`; keep `auth` as the compatibility alias | droid §4 | **ADOPTED**; the key naming `<VAR>_<accountId>` replaces `_<EMAIL>` so a rename never breaks the key (sibling plan noted `emailFromTokenKey` rejects `_`, `+`, `-`). Migration keeps reading the email-keyed entries. |
| Health verdicts persisted by the daemon only; CLI may request a reconcile but never schedule | droid §4 | **ADOPTED** (matches the one-scheduler rule) |
| Migration: inventory → choose canonical install → slots reuse account ids → separate executable → migrate settings → rebuild workers → quarantine, never delete | droid §5 | **ADOPTED**; "quarantine" = `agents trash` (already reversible) |
| Gaps: only Claude has automated minting; provider registry covers anthropic/openai/google/xai only; droid/opencode worker contracts unverified | droid §6 | **ADOPTED into Risks/Gaps** |
| Keep `agents add claude@latest` but allow one managed installation per harness | droid §3 | **ADOPTED**: bare `agents add claude` is the taught form; `@<release>` becomes the expert pin of the single install (same as `update --to`) |
| Per-spawn account switching exists only for `CONFIG_ENV_ISOLATED_AGENTS`; gemini/antigravity/droid/openclaw/amp/goose/hermes/warp isolate by symlink-adopting `~/.<config>` (`shims.ts:1153-1167`) | kimi §2, §6 | **ADOPTED, corrects this plan's first draft.** Those harnesses hold one active slot per box; `accounts default <h> <name>` repoints the adopted symlink under the existing auth-op mutex (`connect.ts:304-314`); N concurrent accounts there means provider API keys where the vendor offers one |
| The reserved-bundle verdict is bundle-coarse (`ready|missing|invalid`): a `ready` peer missing one new account's key gets no push | kimi §4 | **ADOPTED** — T6 makes the verdict per key so a newly added account propagates within one tick |
| Neither `accounts sync` nor `mint --fleet` filters by device role today (`auth-mint.ts:499-518` targets every non-self device) | kimi §4 | **ADOPTED** — bundle pushes target `role=worker` only; a headed peer receives the row, never the token |
| OpenCode has a shim pin but no `applyExecConfigEnv`; grok gets `GROK_HOME` only with `configVersion`; strip list `adapter.ts:176-181` omits `GROK_HOME`/`OPENCODE_CONFIG_DIR`/XDG so cross-account leaks are unverified | kimi §6 | **ADOPTED** into T5 with a leak test per pinned harness |
| Ship order: read-side identity completion + worker provisioning first (zero data movement, fixes "not connected here"), the install-collapse migration behind `doctor --fix`, hiding `--versions`/`connect` last | kimi §5 | **ADOPTED** as the rollout order of T1–T8 (T6 and the sibling plan's reader fix land before T7) |
| Doc says "no reserved bundle name" (`credential-management.md:60`) while code defines `AUTH_BUNDLE_NAME='auth'` (`bundles.ts:214`) | kimi §6, sibling plan focus 3 | **ADOPTED** — T8 resolves it in favor of the code: `auth` is the claude token store, named bundles hold API keys |
| Daemon may transport a bundle without retaining it (invariant 1 vs the `auth`-bundle precedent) needs stating | kimi §6 | **ADOPTED** — stated in Risks and in the credential-management doc under T8 |
| `accounts add` on a worker provisions from the bundle (kimi) vs refuses (droid) | both | **Droid's refusal wins** for `add`; provisioning is the daemon's job (and `accounts sync` as the manual form), so a worker never has two paths to the same slot |

## Proposed Changes

Load-bearing hunks, sketched against origin/main `1bc8ae2d2`. Full task list under Plan.

**`cli/src/lib/accounts/slots.ts` (new)** — the slot, replacing `deviceAccounts.homes`:

```diff
+export interface DeviceAccountSlot {
+  accountId: string;
+  slotDir: string;                 // ~/.agents/.history/accounts/<harness>/<accountId>/
+  authMode: 'native' | 'durable' | 'per-device';
+  verdict: AuthVerdict;            // lib/auth-health.ts
+  checkedAt?: string;
+}
+export function slotDir(harness: AgentId, accountId: string): string
+export function ensureSlot(harness: AgentId, accountId: string): DeviceAccountSlot  // mkdir + project settings/resources (reuses syncResourcesToVersion's writers)
+export function readSlots(meta: Pick<Meta,'deviceAccounts'>): Record<string, DeviceAccountSlot>
```

**`cli/src/lib/accounts/connect.ts` → `add.ts`** — stop installing per account:

```diff
-  // installs the current release into that label's isolated home
-  await run.install(agent, plan.label, { installationLabel: plan.label, ... });
+  const install = await ensureHarnessInstallation(agent);       // ONE per harness, label 'main'
+  const slot = ensureSlot(agent, pendingAccountId);
+  await run.login(agent, { home: slot.slotDir, binary: install.binaryPath });  // HOME = slot
   const identity = await inspectIdentity(agent, slot.slotDir);
   assertUniqueUnifiedName(name, meta, undefined, undefined, agent);
   const account = addNativeAccount(name, agent, identity.key, identity.email, 'version');
-  setNativeAccountHome(account.id, plan.label);
+  recordSlot(account.id, slot);
+  if (isHeadedDeviceRole(role) && cap.worker !== 'none' && !opts.noWorkerToken)
+    await mintWorkerCredential(agent, account, slot);            // claude: setup-token; api-key: prompt/--api-key
+  else if (!isHeadedDeviceRole(role)) throw new Error(`Add this account on a personal/desktop device; workers are provisioned automatically.`);
+  requestAuthSyncReconcile();                                     // daemon owns the tick
```

**`cli/src/lib/harness-auth-capabilities.ts` (new registry table, replaces `LOGIN_INVOCATIONS`)**:

```diff
+export const HARNESS_AUTH: Record<AgentId, HarnessAuthCapability> = {
+  claude:      { login: ['auth','login'], status: ['auth','status'], identity: 'strong', worker: 'setup-token', slotEnv: 'CLAUDE_CONFIG_DIR' },
+  codex:       { login: ['login'],        status: ['login','status'], identity: 'strong', worker: ['api-key:OPENAI_API_KEY', 'per-device:device-auth'], slotEnv: 'CODEX_HOME' },
+  grok:        { login: ['login'],        status: null, identity: 'strong', worker: 'api-key:XAI_API_KEY', slotEnv: 'GROK_HOME' },
+  opencode:    { login: ['auth','login'], status: ['auth','list'], identity: 'email', worker: 'api-key:provider', slotEnv: 'XDG_DATA_HOME' },
+  cursor:      { login: ['login'],        status: ['status'], identity: 'strong', worker: 'api-key:CURSOR_API_KEY', slotEnv: null },
+  kimi:        { login: ['login'],        status: null, identity: 'opaque', worker: 'none', slotEnv: 'KIMI_CODE_HOME' },
+  antigravity: { login: null /* first launch */, status: null, identity: 'opaque', worker: 'none', slotEnv: null },
+  droid:       { login: null /* /login */,        status: null, identity: 'opaque', worker: 'api-key:FACTORY_API_KEY', slotEnv: null },
+  // every other harness: { login: null, worker: 'none' } — accounts add refuses with the reason
+};
```

**`cli/src/commands/exec.ts`** — the spawn reads the slot, not a version home:

```diff
-  accountConfigVersion = await resolveAccountVersion(agent, spawnAccount.identityKey, nativeAccountHome(spawnAccount.id, readMeta()));
-  if (!version && !fromProfile) version = accountConfigVersion;
+  const slot = readSlots(readMeta())[spawnAccount.id] ?? (await materializeSlotIfProvisionable(agent, spawnAccount));
+  if (!slot) throw new Error(`${agent}#${spawnAccount.name} has no slot on this device — ${provisionHint(agent, spawnAccount)}`);
+  execHome = slot.slotDir;                                       // binary always from the harness installation
```

**`cli/src/lib/secrets/reserved-sync.ts`** — reconcile every portable account, not one bundle:

```diff
-const BUNDLES = [AUTH_BUNDLE_NAME];
+const targets = listNativeAccounts(meta).filter(a => a.workerCredential).map(a => a.workerCredential.bundle);
 for (const peer of peers) for (const bundle of new Set(targets))
   if (verdictFor(peer, bundle) === 'missing') plan.push({ peer, bundle });
```

**`cli/src/commands/accounts.ts`** — the listing renders the verdict and the fix:

```diff
-  out.push(`${name} · ${email}  ${signedIn ? 'connected' : 'not connected here'}`);
+  out.push(renderAccountRow({ name, email, verdict, devices: slotDevices(id), fix: fixFor(verdict, agent, name) }));
```

**`cli/src/commands/view.ts`, `versions.ts`, `update.ts`** — hide the version-variant surface:

```diff
-  .option('--versions', 'Show every installation')
+  .option('--versions', 'Show every installation (legacy)', { hidden: true })
-  "Connect: agents accounts connect <agent> [name] · Details: agents view <agent> --versions"
+  "Add an account: agents accounts add <agent> [name]"
```

## Public Interface

<figure class="artifact-figure artifact-behavior">
  <section data-state="current" data-evidence="capture">
    <h4>Current — <code>agents accounts list</code> (owner capture, redacted)</h4>
    <pre><code>Native logins  run &lt;harness&gt;#&lt;label&gt;
 claude   personal * m***@gmail.com  connected
          dev        d***@getrush.ai connected
          work       m***@getrush.ai connected
          icloud     m***@icloud.com connected
 codex    gmail    * m***@gmail.com  connected
          codex-icloud m***@icloud… connected
          codex-smores t***@…       connected
 grok     personal   z***@gmail.com  connected
          —        * m***@icloud.com connected
 opencode —        * opencode:… not connected

Provider bundles  --account &lt;name&gt;
 claude-dev-getrush     setup-token ready
 claude-dev-getrush  setup-token ready
 …</code></pre>
    <p>"connected" = a credential file exists. No expiry, no device coverage, no fix. Provider bundles are a second list the user has to join by eye.</p>
  </section>
  <section data-state="proposed" data-evidence="mockup">
    <h4>Proposed — <code>agents accounts list</code></h4>
    <pre><code>Accounts  run: agents run &lt;h&gt;#&lt;name&gt;

claude 2.1.263 · auto-update
* personal m***@gmail.com  LIVE     +9  20%
  work     m***@getrush.ai EXPIRED  +9
           fix: accounts login claude#work
  dev      d***@getrush.ai LIVE     +9  26%
  icloud   m***@icloud.com LIVE     +6  3 sync

codex  0.153.4 · auto-update
* gmail    m***@gmail.com  LIVE     +9  59%
  icloud   m***@icloud.com LIMITED  17h
  smores   t***@…          LIVE     +9  26%

kimi   0.41.0 · per-device login
* this box kimi:user=d483… LIVE  laptop, w1
           elsewhere: agents fleet login kimi

1 needs you · add: agents accounts add &lt;h&gt;</code></pre>
    <p>One row per account per harness. STATE is the daemon verdict; WHERE counts devices with a live slot; FIX is the exact command. Provider bundles disappear as a separate list because the worker credential is a field of the account.</p>
  </section>
</figure>

### Commands after the change

| Verb | Behavior | Today's equivalent |
|---|---|---|
| `agents add <harness>` | Install the one managed installation (`main`) if absent; no login. `@<release>` pins it (expert). | `add` bare-reuse rule `versions.ts:94-106`; `@version` creates a second home |
| `agents accounts add <harness> [name] [--api-key <k>] [--no-worker-token]` | Headed only. Login in a new slot → register row → mint/collect worker credential → daemon sync. Idempotent on an already-registered identity (points at `login`). | `accounts connect` + `accounts mint` + `accounts add --provider` + `accounts sync` |
| `agents accounts login <harness>#<name>` | Re-auth into the same slot on a headed device; re-mints and re-syncs. On a per-device harness, logs this box in. | `connect` reconnect path + `mint` |
| `agents accounts list [<harness>] [--fleet] [--json]` | Verdict + devices + fix per account. `--fleet` is the matrix from the audit's Design C. | `accounts list`, `agents view`, `devices accounts` |
| `agents accounts default <harness> [name]` | Set the fleet-wide default (picker with no name). | `set-default`, `switch` |
| `agents accounts rename <harness>#<old> <new>` | PHNX-3988 semantics. | same |
| `agents accounts remove <harness>#<name>` | Row + bundle + every device's slot → trash. | `remove` (record only) |
| `agents accounts logout <harness>[#<name>]` | This device's slot only. | `logout` |
| `agents accounts sync [<harness>#<name>] [--device <d>]` | Manual reconcile (the daemon does it anyway). | `accounts sync <bundle> <device>` |
| hidden: `connect`, `name`, `label`, `mint`, `attach`, `detach`, `view --versions`, `add <h>@<v>` as a second install, `update <h>@<label>` | Print a one-line pointer to the replacement; removed in the following release. | — |

Nothing under `agents accounts` prints the word bundle: the credential is a field of the account, the reserved stores are visible only under `agents secrets`, and `--account <name>` selects an account, not a bundle.

`agents run <harness>#<name>` is unchanged and becomes the taught selector everywhere (help, README, fleet skills). `--account <name>` stays as the flag form.

### JSON

`agents accounts list --json` emits `{ version: 2, accounts: [{ id, harness, name, identityLabel, isDefault, provisioning, verdict, checkedAt, devices: [{ device, authMode, verdict }], usage, fix }] }`. `agents view --json` keeps `versions[]` (hidden surface) and gains the same `accounts[]` projection; consumers (AGI EXT) read `accounts[]`.

## Plan

Ordered; each task names its files. Drainable by `/code:loop` or fanned out as tracks. Tracks 1–3 are independent of each other; 4 depends on 1+2; 5 on 1–4; 6 last.

- [ ] **T1 Slot store + capability table.** `lib/accounts/slots.ts` (new), `lib/harness-auth-capabilities.ts` (new, replaces `LOGIN_INVOCATIONS` in `lib/accounts/connect.ts:59-62`), `lib/types.ts` (Account fields `workerCredential`, `provisioning`, `createdOn`; `deviceAccounts.slots`), `lib/state.ts` (device-doc write/read for `slots`), `lib/account-registry.ts` (`recordSlot`, `readSlots`; `setNativeAccountHome` becomes a thin shim over it). Completeness test pins `HARNESS_AUTH` to `ALL_AGENT_IDS`.
- [ ] **T2 One installation per harness.** `lib/installations/store.ts` (`ensureHarnessInstallation`, `listInstalledVersions` excludes slots), `lib/installations/versions.ts` (install into `main`), `commands/versions.ts:94-106,409-560` (bare add; `@<release>` = pin of `main`), `commands/update.ts` (single target). Tests: `installations/store.test.ts:105` ("duplicate installations … separate identities") is rewritten to the new rule.
- [ ] **T3 Verdict rendering + notify.** `lib/account-catalog.ts:195-260` (row carries `verdict`, `devices`, `fix`), `commands/accounts.ts` (`list` rewrite per mockup, `--fleet` matrix reusing `devices/harness-inventory.ts:362-382`), `commands/view.ts:700-730` (account-first render, hidden `--versions`), `lib/daemon/account-state-daemon-service.ts` (notify on `live → expired|revoked` via `agents feed post --level important`), `lib/signin-badge.ts:16-38` (`fixFor`).
- [ ] **T4 `accounts add` / `login`.** `lib/accounts/connect.ts` → `lib/accounts/add.ts` (slot instead of install; mint step; worker refusal), `lib/auth-mint.ts` (mint per account id; key `CLAUDE_CODE_OAUTH_TOKEN_<id>`; `MINT_FLOWS` gains `api-key` flows for codex/grok/opencode/cursor/droid reading `--api-key`/prompt), `commands/accounts.ts` (register `add`, `login`, `default`; hide `connect/name/label/mint/attach/detach`), `lib/harness/adapters/*.ts` (slot HOME + `slotEnv`). Tests: `accounts/connect.test.ts` renamed `add.test.ts`, every "installs into slot label" assertion becomes "creates slot, no install".
- [ ] **T5 Spawn + rotation read slots.** `commands/exec.ts:2568-2600` (slot resolution; provisionable-on-demand for workers), `lib/exec.ts` (`execHome` = slot), `lib/harness/adapters/opencode.ts` (add the missing `applyExecConfigEnv`), `lib/harness/adapter.ts:176-181` (strip `GROK_HOME`, `OPENCODE_CONFIG_DIR`, XDG vars), `lib/installations/shims.ts:1153-1167` (symlink-adopted harnesses: `accounts default` repoints the adopted `~/.<config>` under the auth-op lock), `lib/accounting/rotate.ts:904-946` (candidates = slots with verdicts), `commands/run-account-picker.ts` (drop version column), `lib/agent-spec/agents.ts:1537-1546` (`resolveAccountCredentialPath` checks slot first). Remote `--device` path: `lib/hosts/dispatch.ts` forwards `#name` unchanged (already does) and the peer resolves its own slot. Test: for every pinned harness, two slots in one install never read each other's credential.
- [ ] **T6 Worker provisioning generalized.** `lib/secrets/reserved-stores.ts` (new: `RESERVED_STORES` table `__<harness>__` from `ALL_AGENT_IDS`, `isReservedStoreName`, `assertStorableCredentialKind` refusing anything but `setup-token` | `api-key`), `lib/secrets/bundles.ts` (reject user bundle names starting with `__`; `auth` read alias), `lib/secrets/reserved-sync.ts:36-60` (plan over every `workerCredential.bundle`, verdict per KEY not per bundle, targets `role=worker` only), `lib/daemon/auth-sync-service.ts` (materialize a slot per portable account after a bundle lands: `provisionWorkerSlot` generalizing `provisionClaudeWorkerHome` in `lib/claude-account-token.ts`), `lib/fleet/auth-sync.ts` unchanged (native files stay banned; add a test that asserts no slot credential file ever appears in a transfer plan). Identity for a worker slot resolved from the row at read time (sibling plan T1).
- [ ] **T7 Migration.** `lib/accounts/migrate.ts` (new; `agents accounts migrate --dry-run|--apply`, also run once by `runMigration()` on upgrade): inventory → canonical install per harness (default if launchable, else newest launchable) → each credential-bearing home becomes a slot (move `home/`, trash `node_modules`) → empties and duplicates to trash (reuse `planDuplicatePrune` from `commands/view.ts`) → `agent@label` bindings → account bindings → `sessions.db` re-index of moved transcript paths (`lib/session/db.ts`) → report. Reversible through `agents trash restore`.
- [ ] **T8 Docs + fleet guidance.** `cli/docs/credential-management.md` (§Provisioning model: `accounts add` is the flow; naming table fixed for cursor/kimi), `cli/docs/version-management.md` (rewrite around one install + slots), `cli/README.md:580,1159-1164`, `cli/AGENTS.md` (§Configuration surface, §Supported harnesses, remediation strings `:725,769,779`), `.changelog/next/PHNX-3940.md`, companion `phnx-labs/.agents` skills that teach `connect`/`--versions` (audit in the PR body).

## Validation

```bash
# unit + integration (real files, no mocks)
cd cli && bun run test src/lib/accounts src/lib/account-registry.test.ts src/lib/installations src/commands/accounts.test.ts src/commands/view.account.test.ts src/lib/secrets/reserved-sync.test.ts

# end to end on the fleet (owner-run, headed laptop + one worker)
agents-dev accounts add codex e2e --api-key "$(agents secrets get openai.com OPENAI_API_KEY)"   # login in browser, key stored
agents-dev accounts list codex                      # e2e · LIVE · laptop + 0 workers → syncing
agents-dev ssh worker-1 'agents-dev accounts list codex'   # after one daemon tick: e2e · LIVE · durable
agents-dev run codex#e2e --device worker-1 "echo ok"       # no login prompt, exit 0, quote output
agents-dev view codex --device worker-1                    # exactly ONE installation row; no arrows
agents-dev accounts migrate --dry-run --device worker-1    # 6 codex homes → 1 install + 3 slots + 3 trashed
```

Proof of done is the quoted output of the last four commands on a real worker, plus a screenshot of `accounts list` on the laptop showing an `EXPIRED` row after revoking a test login, and the owner feed post that fired for it.

## Risks

| Risk | Where | Handling |
|---|---|---|
| Moving a home moves transcripts; `sessions.db` rows point at old paths | `lib/session/db.ts` filePath column; claude `projects/<cwd-key>` under the home | T7 re-indexes moved paths in the same transaction; resume falls back to `/continue` on a miss (`session/recovery.ts` already does) |
| A running agent holds the home being migrated | `installations/active-check.ts` (process-table scan + launch leases) | Migration reuses the same active check per home and defers, exactly like update; stale codex sessions from Aug 17 on worker-3 must be killed first (found today) |
| Balanced rotation counts empty homes as candidates today; after T5 a slot with `missing` verdict must not be a candidate | `accounting/rotate.ts:904-946` | Candidate filter on verdict ∈ {live, unverified}; test with a `missing` slot |
| Keychain-bound harnesses on macOS (claude, antigravity) key the entry by config dir | `fleet/auth-sync.ts:39`, `harness/adapters/claude.ts:96-105` | Slot dir is stable per account id; `CLAUDE_CONFIG_DIR` set to the slot as the adapter does now |
| Ambient `CLAUDE_CODE_OAUTH_TOKEN` in the owner's shell collapses every slot to one account | `signin-badge.ts:69-74` | `accounts add` warns and refuses to mint while an ambient token is set |
| Two headed devices mint different tokens for the same account | `reserved-sync.ts` has no custodian election (droid gap) | `createdOn` on the row; only the creating device mints; a second headed device gets a `missing` slot that `login` fills. Documented as the rule |
| `accounts add` on an unmarked device | `device-config.ts:849-875` treats unmarked as worker | Refuses with the role hint; `agents devices role <name> personal` is the fix |
| Setup-token cannot read profile/usage (403) | sibling plan E6–E7 | Worker slot identity and usage come from the row and the synced usage snapshot; never a probe with the token |
| Codex `auth.json` copied per runner is documented as unsafe to share across machines | research, learn.chatgpt.com ci-cd-auth | Never transported; codex workers use the API key only |
| Droid refresh tokens are single-use and collapse the fleet when copied | `fleet/auth-sync.ts:41-51` (RUSH-1958) | Unchanged ban; droid worker path is `FACTORY_API_KEY` only |
| Hidden legacy verbs still referenced by fleet skills/routines | companion repo | T8 audit; the hidden verbs keep working for one release and print the replacement |
| A worker's `~/.agents` clone wedges behind origin and the daemon keeps committing locally | observed today: 61 local / 639 behind on one worker; `agents repo pull` refuses on a dirty tree (PHNX-3968) | T6's reconcile must not depend on a clean pull: the daemon commits only its owned files, rebases with origin winning conflicts on shared files, and reports `sync-stuck` as a verdict the `--fleet` matrix shows; the account row transport is otherwise silent |
| The daemon transports a worker bundle it must not retain (invariant 1) | `secrets/reserved-sync.ts`, `secrets/push.ts:64,163-168` | Same contract as today's `auth` push: stdin transfer, host-pin verified, nothing written on the sender beyond the existing store; stated explicitly in the doc (T8) |
| A symlink-adopted harness (antigravity, droid, gemini, …) can only hold one active account per box | `shims.ts:1153-1167` | `accounts add` on those prints "one active account per device on <harness>; `accounts default` switches it"; rotation never rotates across them |

### Gaps this plan does not close

- No harness other than Claude exposes a derivable durable token; API keys are collected, not minted (`auth-mint.ts:71-81`).
- Antigravity and Droid document no config-dir redirect and no status command; their slot is the HOME swap and their verdict stays `unverified` until a safe probe exists.
- Copilot, OpenClaw, Hermes, Goose, Warp have no credential knowledge in the codebase; `accounts add` refuses them with the reason until the capability table gets a real row.
- PHNX-3975's revisioned config sync is the eventual carrier for the row; this plan rides today's `repo push/pull` and is compatible with moving later.

## Tracking

- PHNX-3940 — this plan (primary)
- PHNX-3988 / PR #3491 — per-harness rename/remove/view, landing first
- PR #3502 (merged d507886) — `accounts connect` refuses on a worker before any side effect, with the per-harness provisioning hint; the first half of T4's worker rule, landed early after the owner hit it live on a worker
- PR #3493 — accounts UX + provisioning audit (evidence)
- PHNX-3887, PHNX-3728, PHNX-3975 — related, linked above
- Build status (2026-09-06, same day): T1 merged 67a18cf (PR #3505) · T2 merged cf2111d (PR #3511) · T6 merged b26e071 (PR #3516) · T3 merged (PR #3513) · T4 merged (PR #3518) · T5 merged (PR #3521) · T7 and T8 building
- Tasks T1–T8 above are the build checklist

<!-- agents-plan -->
