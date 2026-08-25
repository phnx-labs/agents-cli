---
kind: plan
template: plan.v1
title: "Leased boxes are just devices"
summary: "Lease capacity when you run out of compute, run on it, and reuse it by name — with no new flags. Today it half-works: the box provisions but the agent dies with 'agents-cli is not set up', portable accounts are wrongly refused, and the lease never appears as a device. This plan makes bootstrap fail loud, recognizes portable accounts before you pay, projects leases into the device surface, and routes --device <slug> through lease-reuse."
status: draft
surface: cli
project: AGI
repository: agents-cli
date: 2026-08-24
links:
  - label: "RUSH-3004 — Hetzner at server_limit (blocks live E2E)"
    url: "https://linear.app/getrush/issue/RUSH-3004"
  - label: "RUSH-3177 — §2-6 follow-up (portable accounts, device projection, routing, mesh)"
    url: "https://linear.app/getrush/issue/RUSH-3177"
metadata:
  harness: claude
  agent: claude
  host: yosemite-m4
  session: e92ac956
---

## Focus for review

Five calls — the rest follows:

1. **No new flags.** Lease with `--lease`, discover with `agents devices list --all`, reuse with `--device <slug>`. `--box` stays for compat but leaves the help; `--bare` is neither added nor expanded.
2. **Mesh default** — the one genuine product decision, and it's yours to pick. Today a *fresh* lease defaults to public (tailnet opt-in), while a *reuse* already defaults to tailnet. Should a fresh lease also default to your tailnet when a key is configured?
3. **Accounts resolve before you pay.** The false "native OAuth" refusal on a portable setup-token account is fixed, and true-native refusals still fire before any box is created.
4. **Bootstrap fails loud.** A box that can't finish `agents setup` is stopped and the real error printed — never a billed box that silently can't run.
5. **Leases stay ephemeral.** They project into `devices list --all` at read time; never written to the persistent registry, never in `--device auto`.

## Purpose

When you run out of compute, `agents run <agent> "…" --lease` should hand you a *working* box: agents-cli set up, your portable account loaded, your repo + config synced, and the box addressable afterward as `--device <slug>`. Right now it doesn't — three bugs, all reproduced live in the prior session against a real Hetzner box `jade-lobster` (`49.13.31.13`):

<div class="artifact-behavior">
  <div class="artifact-behavior-panel" data-state="current" data-evidence="capture">

**Today — provisions, then fails**

```
$ agents run deepseek "summarize this repo" --lease
✓ jade-lobster provisioned (49.13.31.13)
✖ agents-cli is not set up. Run: agents setup
  (agent never runs — bootstrap failure was swallowed)

# portable account, still refused before it can help:
Refusing to copy native OAuth / session credentials … claude

$ agents devices list          # jade-lobster is absent
  yosemite-m3   linux   ready
$ agents devices lease list    # …only here
  jade-lobster  running  49.13.31.13
$ agents run deepseek "…" --device jade-lobster
✖ Unknown device 'jade-lobster'. See 'agents devices list'.
```

  </div>
  <div class="artifact-behavior-panel" data-state="proposed" data-evidence="mockup">

**Proposed — a lease is just a device**

```
$ agents run deepseek "summarize this repo" --lease
Leasing a Hetzner box on your tailnet…
✓ swift-krill ready
✓ agents-cli installed and set up
✓ Project and user setup synchronized
✓ DeepSeek account loaded for this run
<agent output>
Box swift-krill kept warm.
  Reuse: agents run deepseek "…" --device swift-krill

$ agents devices list --all
Registered devices
  yosemite-m3   linux   ready
Leased devices
  swift-krill   linux   ready   tailnet   ephemeral   expires in 29m

$ agents run deepseek "run the tests" --device swift-krill
Reusing leased device swift-krill…
<agent output>
```

  </div>
</div>

<p class="artifact-callout">The load-bearing shift: one read-time <code>ExecutionDevice</code> projection makes a lease addressable everywhere a registered device is — <code>devices list --all</code>, <code>agents ssh</code>, and <code>run --device</code> — without ever writing it to the persistent registry.</p>

The three confirmed bugs and their causes:

| # | Symptom (observed live) | Cause |
|---|---|---|
| 1 | Box provisioned, agent died: `agents-cli is not set up` | `lease.ts:190` runs `agents setup >/dev/null 2>&1 \|\| true` — output and exit both discarded, no downstream check (unlike the `npm install` step at `lease.ts:184-187`, which `exit 96`s) |
| 2 | Portable `claude-tech-prix` account refused as native OAuth | the lease path's `detectSignedInRuntimes()` (`runtimes.ts:105`) sees the *native* claude runtime and `assertNoNativeOAuthTransfer` (`runtimes.ts:350`) refuses; the selected portable account never suppresses it, and `CLAUDE_CODE_OAUTH_TOKEN` is unrecognized in the copy path (`claudeCredentialsJson` hardcoded `null` at `exec.ts:1539`) |
| 3 | Lease in `lease list` but not `devices list`; unaddressable as `--device` | `--all` (`ssh.ts:2153`) affects only text output; the `--json` branch returns at `ssh.ts:2112` before the leased section. `--device <slug>` hits `mustGetDevice`'s `Unknown device` error (`ssh.ts:500`) — only bare `agents ssh <slug>` has a lease fallback (`trySshLeasedBox`, `ssh.ts:477`) |

## Proposed Changes

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 900 430" role="img" aria-label="Before: lease pipeline swallows setup failures and the device surface is split. After: accounts resolve first, setup is gated on a real postcondition, and one ExecutionDevice projection feeds both devices list --all and run --device.">
  <defs>
    <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#666"/></marker>
    <marker id="ab" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#f0616d"/></marker>
  </defs>

  <text x="24" y="26" fill="#a3e635" font-family="Inter, sans-serif" font-size="14" font-weight="700">BEFORE — failures swallowed, surfaces split</text>
  <rect x="24" y="42" width="164" height="32" rx="6" fill="#0f0f12" stroke="#333" stroke-width="1.2"/>
  <text x="34" y="62" fill="#e5e5e5" font-family="JetBrains Mono, monospace" font-size="11">agents run --lease</text>
  <rect x="24" y="96" width="164" height="32" rx="6" fill="#0f0f12" stroke="#333" stroke-width="1.2"/>
  <text x="34" y="116" fill="#e5e5e5" font-family="JetBrains Mono, monospace" font-size="11">provision box</text>
  <rect x="24" y="150" width="164" height="44" rx="6" fill="#160a0c" stroke="#f0616d" stroke-width="1.2"/>
  <text x="34" y="168" fill="#f0616d" font-family="JetBrains Mono, monospace" font-size="11">agents setup</text>
  <text x="34" y="185" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">||true (swallowed)</text>
  <rect x="24" y="216" width="164" height="32" rx="6" fill="#160a0c" stroke="#f0616d" stroke-width="1.2"/>
  <text x="34" y="236" fill="#f0616d" font-family="JetBrains Mono, monospace" font-size="11">run agent → fails</text>
  <path d="M106,74 L106,96" stroke="#666" stroke-width="1.4" fill="none" marker-end="url(#a)"/>
  <path d="M106,128 L106,150" stroke="#666" stroke-width="1.4" fill="none" marker-end="url(#a)"/>
  <path d="M106,194 L106,216" stroke="#f0616d" stroke-width="1.4" stroke-dasharray="4 3" fill="none" marker-end="url(#ab)"/>
  <text x="24" y="278" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">"agents-cli is not set up"</text>

  <rect x="232" y="96" width="176" height="32" rx="6" fill="#0f0f12" stroke="#333" stroke-width="1.2"/>
  <text x="242" y="116" fill="#e5e5e5" font-family="JetBrains Mono, monospace" font-size="10.5">devices list → registry</text>
  <rect x="232" y="150" width="176" height="32" rx="6" fill="#0f0f12" stroke="#333" stroke-width="1.2"/>
  <text x="242" y="170" fill="#e5e5e5" font-family="JetBrains Mono, monospace" font-size="10.5">lease list → provider</text>
  <text x="232" y="212" fill="#f0616d" font-family="Inter, sans-serif" font-size="11">no bridge — a lease is</text>
  <text x="232" y="228" fill="#f0616d" font-family="Inter, sans-serif" font-size="11">never a --device</text>

  <line x1="450" y1="38" x2="450" y2="410" stroke="#2a2a2a" stroke-width="1"/>

  <text x="470" y="26" fill="#a3e635" font-family="Inter, sans-serif" font-size="14" font-weight="700">AFTER — fail loud, one projection</text>
  <rect x="470" y="42" width="168" height="32" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.4"/>
  <text x="480" y="62" fill="#c8c8c8" font-family="JetBrains Mono, monospace" font-size="11">resolve account</text>
  <text x="648" y="62" fill="#7c9a4e" font-family="JetBrains Mono, monospace" font-size="10">before pay</text>
  <rect x="470" y="96" width="168" height="32" rx="6" fill="#0f0f12" stroke="#333" stroke-width="1.2"/>
  <text x="480" y="116" fill="#e5e5e5" font-family="JetBrains Mono, monospace" font-size="11">provision box</text>
  <rect x="470" y="150" width="168" height="44" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.4"/>
  <text x="480" y="168" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">agents setup</text>
  <text x="480" y="185" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="10">postcondition: .git?</text>
  <rect x="470" y="216" width="168" height="32" rx="6" fill="#0f160a" stroke="#a3e635" stroke-width="1.4"/>
  <text x="480" y="236" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="11">run agent</text>
  <rect x="470" y="266" width="168" height="32" rx="6" fill="#160a0c" stroke="#f0616d" stroke-width="1.2"/>
  <text x="480" y="286" fill="#f0616d" font-family="JetBrains Mono, monospace" font-size="10.5">no .git → stop box</text>
  <path d="M554,74 L554,96" stroke="#666" stroke-width="1.4" fill="none" marker-end="url(#a)"/>
  <path d="M554,128 L554,150" stroke="#666" stroke-width="1.4" fill="none" marker-end="url(#a)"/>
  <path d="M554,194 L554,216" stroke="#666" stroke-width="1.4" fill="none" marker-end="url(#a)"/>
  <path d="M638,172 C690,172 690,282 638,282" stroke="#f0616d" stroke-width="1.4" stroke-dasharray="4 3" fill="none" marker-end="url(#ab)"/>

  <rect x="686" y="96" width="196" height="58" rx="8" fill="#0f160a" stroke="#a3e635" stroke-width="1.4"/>
  <text x="696" y="118" fill="#fff" font-family="Inter, sans-serif" font-size="12" font-weight="700">ExecutionDevice</text>
  <text x="696" y="136" fill="#a3e635" font-family="JetBrains Mono, monospace" font-size="10.5">registered ∪ lease</text>
  <text x="696" y="150" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9.5">read-time union</text>
  <path d="M686,124 L640,124" stroke="#666" stroke-width="1.4" fill="none" marker-end="url(#a)"/>
  <rect x="686" y="176" width="196" height="30" rx="6" fill="#0f0f12" stroke="#333" stroke-width="1.2"/>
  <text x="696" y="196" fill="#e5e5e5" font-family="JetBrains Mono, monospace" font-size="10.5">devices list --all</text>
  <rect x="686" y="228" width="196" height="30" rx="6" fill="#0f0f12" stroke="#333" stroke-width="1.2"/>
  <text x="696" y="248" fill="#e5e5e5" font-family="JetBrains Mono, monospace" font-size="10.5">run --device &lt;slug&gt;</text>
  <path d="M784,154 L784,176" stroke="#666" stroke-width="1.4" fill="none" marker-end="url(#a)"/>
  <path d="M784,206 L784,228" stroke="#666" stroke-width="1.4" fill="none" marker-end="url(#a)"/>
  <text x="686" y="286" fill="#8a8a8a" font-family="JetBrains Mono, monospace" font-size="9.5">never in registry / --device auto</text>
</svg>
<figcaption>Before: the lease pipeline swallows setup failures and the device surface is split, so a lease can never be addressed as a device. After: accounts resolve before provisioning, setup is gated on a real postcondition (a failed box is stopped), and one read-time <code>ExecutionDevice</code> projection feeds both <code>devices list --all</code> and <code>--device &lt;slug&gt;</code> without touching the persistent registry.</figcaption>
</figure>

### 1. Deterministic lease bootstrap (fixes bug 1)

- Replace the swallowed `agents setup >/dev/null 2>&1 || true` at `lease.ts:190` (inside `ENSURE_AGENTS_CLI`, `lease.ts:172-191`) with a postcondition-driven bootstrap: run non-interactive `agents setup` when `.agents/.system` is not a git repo, capture its output, accept a nonzero exit only if `.agents/.system/.git` exists afterward, else print the captured cause and `exit` before running the agent — mirroring the `exit 96` diagnostic the `npm install` step already uses at `lease.ts:184-187`.
- Treat tracked setup sync as required, not best-effort: check the host-side rsync push (`copySetupToBox`, `lease.ts:421-433`) and the box-side `agents sync --local -y` (`copy-setup` step, `lease.ts:266`); surface failures.
- Copy tracked DotAgents resources + portable account material only — never ambient shell vars, native OAuth/session files, or host auth files.
- Track whether *this* invocation created the box and whether the `LEASE_AGENT_MARKER` (`lease.ts:269`) appeared. Stop a newly created unusable box on copy/bootstrap/transport failure; never auto-stop an explicitly reused box. Preserve the teardown logic exactly (`lease.ts:447-455`: teardown only when `!keep && fresh && !reused`).

### 2. Recognize portable accounts on the lease path (fixes bug 2)

The lease branch (`exec.ts:1320`) is a separate track from the normal `resolveSpawnAccount` engine (`account-registry.ts:432`, reached only at `exec.ts:2497` — unreachable once the lease branch has fired). So "move resolveSpawnAccount earlier" isn't the fix. The real gap: a user-selected **portable setup-token** account (`auth === 'setup-token'` → `CLAUDE_CODE_OAUTH_TOKEN`, per `account-registry.ts:395`) is not consulted by the file-copy detection, so `detectSignedInRuntimes()` sees the native claude runtime and refuses.

- When a portable setup-token account is selected/available for the run's agent, route it through the existing dispatch-profile env path (`exec.ts:1469-1494`, `buildProfileScript` `lease.ts:141`) — which already carries a `CLAUDE_CODE_OAUTH_TOKEN` correctly — and suppress the native-runtime refusal for that agent. Do not hardcode `claudeCredentialsJson = null` (`exec.ts:1539`) when a portable token is present.
- Keep rejecting *true* native Claude/Codex OAuth transfers (`assertNoNativeOAuthTransfer`, `lease.ts:367`), and keep it firing **before** a box is created.
- Shred temporary profile/account files after every run, including kept boxes (verify the shred covers the profile env path).

### 3. Project leases into the device surface (fixes bug 3)

Read-time union — no ephemeral lease ever enters the persistent registry:

```ts
type ExecutionDevice =
  | { kind: "registered"; profile: DeviceProfile }
  | { kind: "lease"; name: string; provider: "crabbox"; ephemeral: true;
      lifecycle: "starting" | "ready" | "unreachable" | "expired" | "stopped";
      network: "tailscale" | "public"; address?: string; leaseId: string;
      expiresAt: number | null };
```

- One projection/resolver for `devices list --all` (text **and** `--json` — today `--json` returns at `ssh.ts:2112` before the leased section at `ssh.ts:2138`; fix that), `agents ssh <slug>` (already has `trySshLeasedBox`, `ssh.ts:477`), and exact `run … --device <slug>`.
- `--all` performs live discovery via `crabboxList` (`ssh.ts:454`); provider/auth errors become visible and nonzero, not silently `catch`-omitted (`ssh.ts:456-458`). Keep discovery behind explicit `--all` to preserve the Touch-ID-after-print concern (`ssh.ts:462-467`).
- Leases stay out of `--device auto`. If a registered device and a lease share a name, fail as ambiguous and point at `--box <slug>` as the explicit disambiguator.

### 4. Route `--device <lease>` through lease-reuse

- Intercept an exact live lease slug in the host-target resolution (`hostTargetGiven`, `exec.ts:157-164` → `runInteractiveOnHost`, `exec.ts:1673`) — today `hosts/dispatch.ts`, `hosts/remote-cmd.ts`, `hosts/run-target.ts` have zero crabbox references.
- Normalize the slug to the existing `leaseAndRun({ reuseBox: slug })` path (`exec.ts:1589`) — not raw SSH, which would skip workspace sync, isolated HOME, runtime install, portable-account materialization, and cleanup.
- Retain `--box <slug>` (`exec.ts:796`) for compat but drop it from primary help/examples. Do not add/require/expand `--bare` (`exec.ts:808`).
- Add one bounded SSH readiness probe before named dispatch and when computing live lease status.

### 5. Truthful mesh (the decision above)

Current behavior (`computeNetMode`, `exec.ts:277-281`): a fresh lease defaults to public (tailnet opt-in via `--tailscale`); a reuse context already defaults to tailscale. The decision is whether a fresh lease also defaults to tailnet-when-configured — aligning fresh with reuse.

- **If Auto-private (recommended):** default new leases to Tailscale when the tailnet key is configured (the `TAILSCALE_BUNDLE` key from `agents devices lease setup`, `commands/lease.ts:212`), else public, stated in output — one change at `exec.ts:280`.
- An explicit `--tailscale` without valid credentials fails before provisioning, never silently downgrades (today the join is best-effort, `cli.ts:296-306`).
- Existing named boxes keep their actual network (`poolReusableBoxes` filters by `boxNet`, `cli.ts:419-423`); a run flag can't retrofit it.
- Keep the one-time `agents devices lease setup` flow (`commands/lease.ts:157-217`); document the `tag:crabbox` ephemeral auth-key requirement (minted manually, `lease.ts:102-108`) and a direct renewal error on expiry.

### 6. Docs + delivery

- Update run/device help, README, concepts, profiles, hosts architecture, specifications, generated command reference, CHANGELOG. Remove text claiming leases can't be addressed as devices.
- Audit + update the companion `.agents-system` run/devices guidance in a linked PR so fleet instructions teach `--device <leased-slug>`.
- Open an AGI ticket (none covers this); link it both ways to this committed plan.

## Public Interface

- `agents run <agent> "…" --lease` — unchanged flag; now yields a working box or a loud failure.
- `agents devices list --all` — text **and** `--json` now include a `Leased devices` section / `kind: "lease"` rows.
- `agents run <agent> "…" --device <slug>` — a live lease slug now routes through lease-reuse instead of erroring `Unknown device`.
- `--box <slug>` — retained for compat, removed from primary help. `--bare` — unchanged, not expanded. No new flags added.
- `ExecutionDevice` — new internal read-time projection type; not persisted.

## Validation

- **Unit** (fake Crabbox transport, `crabbox/*.test.ts`, `withFakeTransport` `setup-copy.test.ts:149`): portable-token vs native-OAuth classification; setup git-repo postcondition + visible failure; required copy/sync failure + credential shred; net-mode selection + explicit-private failure + inherited named-box network; registered/lease/ambiguous/unknown resolution; lease JSON/text projection per lifecycle; new-box pre-agent cleanup vs retained reuse.
- **Integration** (fake transport): `--device <slug>` reuses the same box, never warms a replacement; registered devices stay on ordinary dispatch; stale "ready" + refused SSH → `unreachable`; leases never enter auto placement.
- **Real Hetzner acceptance** (gated on quota — RUSH-3004: account at `server_limit`): real `--lease` deepseek run; verify remote `.agents/.system` is a git repo, tracked setup present, native OAuth absent; slug in text + JSON `devices list --all`; second run via `--device <slug>` on the same hostname; tailnet addressing when configured; stop + prove it's gone.
- Run affected tests; `test:remote` is down fleet-wide (RUSH-3004) so run locally / on an idle fleet box.
- Non-author review via a review subagent (repo reviewer paused #1767); merge on green.
- Release via `release.sh` next patch, respecting the release lease; verify publish + pushed tag + fleet upgrade + installed version + repeat the leased-device flow with the installed CLI.

## Risks

- **Live E2E blocked by Hetzner `server_limit` (RUSH-3004).** Unit + integration fully cover the logic against the fake transport, but the real-box acceptance run can't happen until quota frees. Mitigation: reap stray boxes (as the prior session did) to open a slot, or ship code-verified + fake-transport-verified and run real acceptance when quota returns — named explicitly, never rounded up to "verified live".
- **Credential handling.** The portable-token fix must not widen the door to copying *true* native OAuth. The pre-provision `assertNoNativeOAuthTransfer` gate stays; tests pin both directions.
- **Device-surface ambiguity.** A lease slug colliding with a registered device name must fail loud (ambiguous), not silently pick one — tested.
- **Mesh default change.** Flipping the fresh-lease default to tailnet-when-configured changes observable behavior for users with a key set; documented in CHANGELOG, and an explicit `--no-tailscale` still wins.

## Tracking

Delivered in slices — §1 first (it makes the reproduced `agents run deepseek --lease` flow work and is releasable now), the rest tracked for follow-up where they can get live Hetzner E2E once quota frees:

| Slice | What | Where |
|---|---|---|
| §1 Deterministic lease bootstrap | Box sets up or is stopped with a real error, not a swallowed "agents-cli is not set up" | **this PR** (`lease.ts`, tested against the fake crabbox transport) |
| §2 Portable accounts on the lease path | Fixes the false native-OAuth refusal | RUSH-3177 |
| §3 Project leases into the device surface | `devices list --all` (text + JSON) shows leases | RUSH-3177 |
| §4 Route `--device <lease>` through reuse | Reuse a lease by name | RUSH-3177 |
| §5 Truthful mesh default | Fresh lease joins the tailnet when a key is configured | RUSH-3177 |
| §6 Docs + companion `.agents-system` | run/device help, README, concepts, fleet guidance | RUSH-3177 |
