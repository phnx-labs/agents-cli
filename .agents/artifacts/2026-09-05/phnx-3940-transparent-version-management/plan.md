---
kind: plan
surface: cli
title: Accounts stay. Releases move.
summary: Connect each account once; let Agents maintain the executable without replacing its login home.
project: agents-cli
repository: phnx-labs/agi-cli
branch: fix/phnx-3940-transparent-version-management
tracking: PHNX-3940
status: verifying
header: Agents / Engineering
footer: Technical proposal · examples use fictional identities
human: Project owner
host: local
session: ""
harness: codex
agent: Codex
date: "2026-09-05"
links:
  - url: https://linear.app/getrush/issue/PHNX-3940/fleet-account-state-is-inconsistent-across-machines
    label: PHNX-3940
assets: []
---

## Focus for review

The everyday choices become **which agent** and **which account**. Updates happen behind those choices. Version numbers remain available for debugging and deliberate release pins, but are no longer account names.

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="mockup">
<h3>Current · a release looks like an account</h3>
<pre><code>$ agents view codex
Installed Agent CLIs
  0.146.0  default  personal  person@example.com
  0.153.4           work      work@example.com
  0.145.0           work      work@example.com

$ agents add codex
Installing a new release-named home…
Sign in again in the new home.</code></pre>
<p>Faithful simplified mockup of current grouping and the new-home upgrade path; fictional identities.</p>
</section>
<section data-state="proposed" data-evidence="mockup">
<h3>Proposed · one row per account</h3>
<pre><code>$ agents view codex
Codex · automatic updates on
  * personal  person@example.com  connected
    work      work@example.com    connected

$ agents accounts connect codex work
Opening Codex sign-in for work…

$ agents run codex#work
[agents] account work · Codex

$ agents view codex --versions
Installation and release diagnostics</code></pre>
<p>Account homes remain separate. Duplicate homes for the same identity are retained, not erased.</p>
</section>
</figure>

<aside class="artifact-callout">An executable update must not become an account migration. Keep the same home, credential location, account identity, and session paths; replace only the managed executable.</aside>

## Purpose

Support many accounts on the same current release without repeated installation or sign-in work. Make automatic updates configurable, preserve old account labels and references, and make account selection consistent across view, connect, switch, and launch.

This is an agents-cli change, not a new cloud credential-transfer mechanism. Native login credentials remain on the device where their harness owns them. Provider-key and durable worker-token accounts retain their separate existing flow.

## Current architecture

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 900 255" role="img" aria-label="Current add creates a separate home per release; manual update already preserves a stable installation">
<rect x="20" y="25" width="190" height="68" rx="8" fill="#16120a" stroke="#f59e0b"/>
<text x="38" y="51" fill="#f59e0b" font-size="14" font-family="monospace">agents add codex</text>
<text x="38" y="74" fill="#c8c8c8" font-size="12">resolves latest release</text>
<path d="M210 60 H275" stroke="#38bdf8" stroke-width="2"/>
<path d="M265 54 L275 60 L265 66" fill="none" stroke="#38bdf8" stroke-width="2"/>
<rect x="280" y="25" width="245" height="68" rx="8" fill="#16120a" stroke="#f59e0b"/>
<text x="298" y="51" fill="#f59e0b" font-size="14" font-family="monospace">versions/codex/NEW</text>
<text x="298" y="74" fill="#c8c8c8" font-size="12">new executable + empty home</text>
<path d="M525 60 H590" stroke="#38bdf8" stroke-width="2"/>
<path d="M580 54 L590 60 L580 66" fill="none" stroke="#38bdf8" stroke-width="2"/>
<rect x="595" y="25" width="285" height="68" rx="8" fill="#16120a" stroke="#f59e0b"/>
<text x="613" y="51" fill="#f59e0b" font-size="14" font-family="monospace">Another sign-in</text>
<text x="613" y="74" fill="#c8c8c8" font-size="12">old account still lives in old home</text>
<rect x="20" y="150" width="190" height="68" rx="8" fill="#0f160a" stroke="#a3e635"/>
<text x="38" y="177" fill="#a3e635" font-size="14" font-family="monospace">agents update</text>
<text x="38" y="199" fill="#c8c8c8" font-size="12">manual only today</text>
<path d="M210 184 H275" stroke="#38bdf8" stroke-width="2"/>
<path d="M265 178 L275 184 L265 190" fill="none" stroke="#38bdf8" stroke-width="2"/>
<rect x="280" y="150" width="245" height="68" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="298" y="177" fill="#38bdf8" font-size="14" font-family="monospace">updateInstallation</text>
<text x="298" y="199" fill="#c8c8c8" font-size="12">stage → verify → swap</text>
<path d="M525 184 H590" stroke="#38bdf8" stroke-width="2"/>
<path d="M580 178 L590 184 L580 190" fill="none" stroke="#38bdf8" stroke-width="2"/>
<rect x="595" y="150" width="285" height="68" rx="8" fill="#0f160a" stroke="#a3e635"/>
<text x="613" y="177" fill="#a3e635" font-size="14" font-family="monospace">Same installation/home</text>
<text x="613" y="199" fill="#c8c8c8" font-size="12">stable label + changed releaseVersion</text>
</svg>
<figcaption>Reuse the lower path. Do not build another credential store or updater.</figcaption>
</figure>

Evidence was checked against freshly fetched `origin/main` at `ed99e4a2f31ec5ce80876a588b2bb66bae8c6a52`:

| Existing seam | Evidence | Consequence |
| --- | --- | --- |
| Stable installation vs release | `cli/src/lib/installations/types.ts:41` separates `label` and `releaseVersion` | Extend the record; do not rename directories. |
| Binary-only update | `installations/strategies.ts:112` lists only `node_modules`, `package.json`, `package-lock.json` | Existing `home/` can survive upgrades unchanged. |
| Reauth-producing add path | `installations/versions.ts:1235` derives a new installation label from the new release | Reuse existing installation on bare add; only connect creates another account slot. |
| Native identity lookup | `commands/exec.ts:2583` resolves an account's home by its identity | Keep identity selection canonical; do not select credentials by display label alone. |
| Version-first presentation | `commands/view.ts:452` begins the installed-version renderer | Normal view becomes account-first; retain detailed diagnostics. |
| No harness update timer | `daemon/self-update-service.ts:1` describes agents-cli self-update | Add a separate supervised harness-update service. |

Codex stores sign-in state under its configured home or keyring. Claude supports disabling vendor background updates. Those facts support keeping the credential path stable and letting Agents own updates for its managed installations. See [Codex authentication](https://learn.chatgpt.com/docs/auth) and [Claude update controls](https://code.claude.com/docs/en/setup#automatic-updates).

## Proposed Changes

<figure class="artifact-figure artifact-figure-diagram artifact-figure-wide">
<svg class="artifact-diagram" viewBox="0 0 900 440" role="img" aria-label="Proposed separation of account selection, stable credential homes, and guarded executable updates">
<rect x="20" y="20" width="260" height="75" rx="8" fill="#0f160a" stroke="#a3e635"/>
<text x="38" y="48" fill="#a3e635" font-size="15" font-family="monospace">view / accounts / run</text>
<text x="38" y="73" fill="#c8c8c8" font-size="13">harness + named account</text>
<path d="M280 58 H345" stroke="#38bdf8" stroke-width="2"/>
<path d="M335 52 L345 58 L335 64" fill="none" stroke="#38bdf8" stroke-width="2"/>
<rect x="350" y="20" width="245" height="75" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="368" y="48" fill="#38bdf8" font-size="15" font-family="monospace">Account catalog</text>
<text x="368" y="73" fill="#c8c8c8" font-size="13">native identity → existing home</text>
<path d="M595 58 H650" stroke="#38bdf8" stroke-width="2"/>
<path d="M640 52 L650 58 L640 64" fill="none" stroke="#38bdf8" stroke-width="2"/>
<rect x="655" y="20" width="225" height="75" rx="8" fill="#0f160a" stroke="#a3e635"/>
<text x="673" y="48" fill="#a3e635" font-size="15" font-family="monospace">Stable home</text>
<text x="673" y="73" fill="#c8c8c8" font-size="13">login · config · sessions</text>
<path d="M472 95 V153" stroke="#38bdf8" stroke-width="2"/>
<path d="M466 143 L472 153 L478 143" fill="none" stroke="#38bdf8" stroke-width="2"/>
<rect x="350" y="158" width="245" height="75" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="368" y="186" fill="#38bdf8" font-size="15" font-family="monospace">Stable installation</text>
<text x="368" y="211" fill="#c8c8c8" font-size="13">label fixed · release replaceable</text>
<path d="M280 335 H340" stroke="#38bdf8" stroke-width="2"/>
<path d="M330 329 L340 335 L330 341" fill="none" stroke="#38bdf8" stroke-width="2"/>
<rect x="20" y="292" width="260" height="86" rx="8" fill="#16120a" stroke="#f59e0b"/>
<text x="38" y="320" fill="#f59e0b" font-size="15" font-family="monospace">Update policy</text>
<text x="38" y="345" fill="#c8c8c8" font-size="13">auto on/off · release pin</text>
<text x="38" y="365" fill="#8a8a8a" font-size="12">daemon tick or explicit update</text>
<rect x="350" y="292" width="245" height="86" rx="8" fill="#16120a" stroke="#f59e0b"/>
<text x="368" y="320" fill="#f59e0b" font-size="15" font-family="monospace">Shared update engine</text>
<text x="368" y="345" fill="#c8c8c8" font-size="13">lock · stage · verify · commit</text>
<text x="368" y="365" fill="#8a8a8a" font-size="12">defer busy · roll back failure</text>
<path d="M472 292 V240" stroke="#38bdf8" stroke-width="2"/>
<path d="M466 250 L472 240 L478 250" fill="none" stroke="#38bdf8" stroke-width="2"/>
<rect x="655" y="292" width="225" height="86" rx="8" fill="#0f160a" stroke="#a3e635"/>
<text x="673" y="320" fill="#a3e635" font-size="15" font-family="monospace">No credential writes</text>
<text x="673" y="345" fill="#c8c8c8" font-size="13">no copy · no refresh</text>
<text x="673" y="365" fill="#8a8a8a" font-size="12">no home merge or cleanup</text>
<text x="350" y="418" fill="#8a8a8a" font-size="13">Only executable files are in the update transaction.</text>
</svg>
</figure>

### Account connection and migration

Existing directories are adopted in place with idempotent metadata backfill. Preserve every label, default, binding, configuration file, and session path. Multiple installations with the same harness-native identity produce one account row; distinct organizations or identity keys are not merged merely because their email matches. Old homes are never deleted or moved automatically.

`accounts connect` creates a new stable slot only for a new account. Reconnecting an existing named identity reuses its existing home and validates the identity afterward. Failed or cancelled sign-in must not silently select another account. A CLI update cannot revive a revoked login; show that it needs reconnection.

### Updates and compatibility

Default to latest for managed installations unless globally disabled, disabled for that harness, or explicitly pinned. Check periodically in the existing daemon, without blocking its event loop. No claim of instantaneous upstream notification: the intended cadence is 15 minutes, plus explicit `agents update`.

Serialize competing updates, guard launch/update races, and defer a busy harness rather than replacing executable files beneath it. Verify the staged binary and keep rollback material until the new release metadata is durable. Failed downloads, offline checks, and unsupported strategies leave the working installation intact.

Keep vendor updaters disabled inside Agents-managed npm homes: uncoordinated vendor updates would bypass these guarantees. Nontransactional/global vendor installers must report their capability honestly; do not call them safely auto-updatable until their strategy meets the same checks.

Existing `harness@label` selectors continue addressing stable installations. They have not been immutable release guarantees in the existing record model. An explicit concrete update target pins that installation; `--to latest` resumes following latest. JSON keeps existing fields, adds truthful release/account projections, and avoids a breaking shape change.

| Ownership | Canonical files / changes |
| --- | --- |
| Account implementation track | `commands/accounts.ts`, `account-catalog.ts`, `account-registry.ts`, installation/add flow; connect, discover, reconnect, safe logout targeting |
| Update implementation track | installation record/strategy/transaction, update policy/config, `commands/update.ts`, supervised harness-update service |
| Integration track | `commands/view.ts`, normal account launch selection, launch safety integration, docs, composed E2E, release |

## Public Interface

```sh
agents accounts connect codex work
agents accounts connect claude personal
agents accounts switch codex work
agents run codex#work
agents view codex
agents accounts

agents config set updates.auto false
agents config set updates.auto true
agents config set updates.codex.auto false
agents update codex --check
agents update codex

# Advanced diagnostics and reproducibility:
agents view codex --versions
agents update codex@INSTALLATION --to RELEASE
agents update codex@INSTALLATION --to latest
```

## Plan

- [x] Fetch current source and claim PHNX-3940; inspect recent overlapping changes.
- [x] Trace installation → account → launch → update; independent read-only architecture verification.
- [x] Render this plan and companion technical visual; inspect and open them for the user.
- [x] Implement stable connect/reconnect, non-destructive legacy adoption, and account catalog.
- [x] Implement configurable guarded updates, pinning, rollback, and daemon scheduling.
- [x] Integrate account-first view, default selection, launch, diagnostics, and documentation.
- [x] Run real-filesystem/process tests, remote suite, and safe native-harness E2E; attach evidence.
- [ ] Open one PR; obtain posted non-author review; fix findings and merge on green CI.
- [ ] Release through the canonical script; verify installed binary, account identities, and update policy.
- [ ] Link delivery proof to the ticket; close the delivered scope and send one owner summary.

This ticket-bound checklist is the execution record. The current tool surface does not expose TaskCreate.

## Validation

| Case | Required observation |
| --- | --- |
| Ten accounts, same release | Separate homes and identity keys; no release-number trick to add accounts. |
| Legacy migration, repeated | Byte-identical credential files and unchanged paths/defaults; repeated adoption creates no duplicates. |
| Automatic update off / pin | No automatic binary replacement; explicit update remains usable. |
| Active process / simultaneous launch | No swap beneath a live harness; bounded deferral, no process termination. |
| Partial commit / record failure | Previous binary and installation metadata restored together; rollback not discarded early. |
| Duplicate identity homes | One normal account row; all original installations visible with diagnostics. |
| Wrong identity / stale registry | Fail closed or show reconnect needed; never borrow a different login. |
| Installed release | Real `agents view`, `accounts`, config and update-check behavior; native identity observed before/after without logging secrets. |

## Risks

### Verification progress · implementation, not released

Real registry-backed tests installed and executed Codex `0.147.0 → 0.153.4` in two isolated account homes. Both retained the same installation ID, label, home inode, and synthetic account-owned data. No human OAuth login is claimed by that test.

Native-command cancellation and authentication exclusion passed on Linux and on a real Windows worker (7 Windows tests). Loss of authentication-lock ownership aborts the native command and prevents account binding writes. Windows cancellation waits for the owned process tree and wrapper to close before releasing the installation lease.

Fresh installation, migration, launch, update, and pin changes share one lock outside the installation directory. This prevents a reader from adopting an incomplete new home as a legacy release. Existing directories and credentials are not moved.

Cooperative updater cancellation is implemented over Node IPC, including Ctrl+C protection and an already-disconnected parent. Independent reviewers cleared the account/auth/preview scope and updater/install/launch scope; their attributed verdicts are posted on PR #3473. The canonical full suite passed all four remote shards at `fef2e93ed277`, followed by a successful build and package attestation. Native Windows checks passed 24 tests, with two POSIX-only signal tests skipped. The remaining delivery gates are exact-tree revalidation after incorporating newer main-branch changes, green CI, merge, and the published/installed release check.

Active-process detection alone has a check-to-launch race; the implementation must coordinate launch with update or retain immutable executable paths. This is a release gate, not a claim that process polling solves concurrency.

Third-party login formats and keyring ownership differ. Preserve their current locations and use their native flows; never invent portability. Existing native credentials may already be expired, and should not be described as healthy without evidence.

An independent Claude review verified the current architecture and suggested automatic cleanup of unsigned homes. That cleanup is deliberately rejected: this task requires no data deletion. A second OpenCode verifier could not obtain a tool-capable endpoint and supplied no evidence; it is not counted as verification.

## Tracking

- [PHNX-3940 — implementation and delivery evidence](https://linear.app/getrush/issue/PHNX-3940/fleet-account-state-is-inconsistent-across-machines)
- Related context, not extra scope: [PHNX-3975 — declarative config](https://linear.app/getrush/issue/PHNX-3975).
- [Companion technical visual](visual.html)
- [Implementation PR #3473 · draft while release gates are being verified](https://github.com/phnx-labs/agi-cli/pull/3473)
- Installed-release proof is still pending. Nothing is marked shipped by this proposal.
