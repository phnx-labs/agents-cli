---
kind: plan
surface: cli
title: One fleet configuration, explicitly applied
summary: Share desired settings and account identities; keep device homes and running state out of Git.
status: proposed — not implemented
project: agents-cli
repository: phnx-labs/agents-cli
harness: codex
agent: codex
session: 01a07528-c1e5-7290-96cd-527a06ab3303
host: zion
date: "2026-09-06"
tracking: PHNX-3975
links:
  - https://linear.app/getrush/issue/PHNX-3975
  - https://linear.app/getrush/issue/PHNX-3923
  - https://linear.app/getrush/issue/PHNX-3940
---

## Focus for review

**Yes to a local `~/.agents/accounts/accounts.db`. The daemon exchanges records, never copies the live database.** One fleet revision expresses the settings you want. Each device separately records the revision it downloaded and the revision it applied and checked.

1. Normal launches, account discovery, heartbeats and session updates must not write tracked configuration files.
2. Downloading a revision does not change native settings. Explicit apply targets one revision across the fleet.
3. Account identity survives binary upgrades. Homes and credentials remain device-owned.
4. “In sync” means every targeted device has verified the requested settings; offline or incompatible devices remain visible.

## Purpose

Change a default once for all Claude or Codex accounts on the laptop and workers. Nobody maintains account-to-home mappings by hand. Existing sessions keep their launch settings. Newly launched sessions use the last applied configuration, even offline.

<div class="artifact-callout">Same configuration means the same managed settings and resource revisions. It does not mean identical absolute paths, credentials, transcripts, installed binaries, or database bytes.</div>

### What the user sees

Commands below marked proposed are a design, not commands available today. Revision numbers and fleet rows are illustrative.

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="capture">
<h3>Today: desired settings and device details share YAML</h3>
<p>Captured CLI text, September 6, 2026; rendered here as text rather than a terminal screenshot.</p>
<pre>agents config list --json
browser.device       zion          central agents.yaml
browser.profile      comet-local   devices/&lt;self&gt;/agents.yaml
interactive.host     zion          central agents.yaml

No shared run model default was listed.</pre>
</section>
<section data-state="proposed" data-evidence="mockup">
<h3>Proposed: publish → download → apply → verify</h3>
<pre>agents config set 'run.codex@*.model' &lt;model-id&gt;
Published revision r42. Native settings unchanged.

agents config sync --fleet
Desired r42 downloaded. Applied r41.

agents config apply --fleet --revision r42 --dry-run
zion          ready          3 Codex account homes
worker-a      blocked        model unsupported by installed release
worker-b      offline        last applied r41

agents config apply --fleet --revision r42
zion          applied r42    managed settings verified
worker-a      blocked        still on r41
worker-b      pending        apply r42 when it reconnects

Fleet incomplete: 1 of 3 targeted devices verified.</pre>
</section>
</figure>

| State | Visible result | Next action |
| --- | --- | --- |
| New device | Desired r42 downloaded; no applied revision | Preview and apply r42 |
| Download only | Desired r42 / applied r41 | Existing launches keep r41 |
| Success | Applied r42; projection hash and check time | New launches use r42 |
| Unsupported model | Blocked; requested ID, harness release and reason | Upgrade compatible release or publish another model |
| Catalog inconclusive | Model availability unverified | Refresh catalog or explicitly authorize a provider probe |
| Native setting edited outside CLI | Drift: model differs from applied r42 | Reapply or explicitly adopt the edit into a new revision |
| Concurrent desired edit | Conflict on the changed key; both values preserved | Choose one value and publish a new revision |
| Disk/write failure | Apply incomplete; old revision remains recorded | Recover journal and retry; never claim success |
| Account absent | Config applied; account login missing | Connect that named account locally through existing flow |

## Current architecture

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 720 230" role="img" aria-label="Current flow: CLI and daemon write YAML, Git distributes it, run resolves settings and native account homes">
<rect x="20" y="30" width="150" height="60" rx="8" fill="#16120a" stroke="#f59e0b"/><text x="35" y="56" fill="#c8c8c8" font-size="14">CLI + daemon</text><text x="35" y="77" fill="#c8c8c8" font-size="12">settings / observations</text>
<path d="M170 60 H220 M212 54 L220 60 L212 66" fill="none" stroke="#38bdf8"/>
<rect x="220" y="30" width="240" height="60" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="235" y="56" fill="#c8c8c8" font-size="14">agents.yaml + device YAML/JSON</text><text x="235" y="77" fill="#c8c8c8" font-size="12">desired and generated state</text>
<path d="M460 60 H510 M502 54 L510 60 L502 66" fill="none" stroke="#38bdf8"/>
<rect x="510" y="30" width="180" height="60" rx="8" fill="#16120a" stroke="#f59e0b"/><text x="525" y="56" fill="#c8c8c8" font-size="14">Git commit / rebase</text><text x="525" y="77" fill="#c8c8c8" font-size="12">peer working directories</text>
<path d="M340 90 V140 M334 132 L340 140 L346 132" fill="none" stroke="#38bdf8"/>
<rect x="180" y="140" width="360" height="60" rx="8" fill="#0f160a" stroke="#a3e635"/><text x="195" y="166" fill="#c8c8c8" font-size="14">Run defaults → account home → binary launch</text><text x="195" y="187" fill="#c8c8c8" font-size="12">direct native shim has a separate settings path</text>
</svg>
</figure>

Source baseline: agents-cli `83dc2a8133e41241938a81155bb368a8dcd04f5a`, fetched September 6, 2026. File links below pin that baseline.

| Evidence | What it establishes |
| --- | --- |
| [account-registry.ts:358](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/account-registry.ts#L358) `setNativeAccountHome` | Connect already records a device-owned home keyed by stable account ID. Preserve this behavior. |
| [account-registry.ts:497](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/account-registry.ts#L497) `resolveAccountSelection` | A binding is a saved selection rule: target → account. It is distinct from the home map. CLI attach/detach owns these records; manual editing is unnecessary. |
| [run-defaults.ts:202](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/run-defaults.ts#L202) | Current run defaults read `readMeta().run` plus project layers. Merely adding a pending document would still activate it early unless this reader changes. |
| [state.ts:1334](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/state.ts#L1334) `writeMetaUnlocked` | Central and device metadata share a YAML serialization path. Storage ownership must change at this source. |
| [fleet-shared-repo-sync.ts:315](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/fleet-shared-repo-sync.ts#L315) | Daemon publication commits central metadata alongside device state, then fetches and rebases. |
| [session/mirror.ts:66](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/session/mirror.ts#L66) | Session summaries also enter the shared device-state writer. Moving accounts alone cannot remove runtime Git churn. |
| [session/sync/agents.ts:1](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/session/sync/agents.ts#L1) | Transcript backup has a separate object-store/mirror flow; it does not replicate `sessions.db`. |
| [session/sync/net-client.ts:61](https://github.com/phnx-labs/agents-cli/blob/83dc2a813/cli/src/lib/session/sync/net-client.ts#L61) | Ordinary `put` overwrites unconditionally. Authenticated transport is reusable; safe concurrent configuration publication still needs a conditional revision contract. |

### Proposed architecture

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 720 340" role="img" aria-label="Proposed configuration flow with shared revisions and separate download and apply on each device">
<rect x="20" y="20" width="190" height="65" rx="8" fill="#16120a" stroke="#f59e0b"/><text x="35" y="47" fill="#c8c8c8" font-size="14">Explicit settings edit</text><text x="35" y="68" fill="#c8c8c8" font-size="12">base revision + intended change</text>
<path d="M210 52 H260 M252 46 L260 52 L252 58" fill="none" stroke="#38bdf8"/>
<rect x="260" y="20" width="430" height="65" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="275" y="47" fill="#c8c8c8" font-size="14">Authenticated fleet store</text><text x="275" y="68" fill="#c8c8c8" font-size="12">immutable desired revisions + device observations + apply requests</text>
<path d="M470 85 V125 M464 117 L470 125 L476 117" fill="none" stroke="#38bdf8"/><text x="485" y="110" fill="#38bdf8" font-size="12">daemon download</text>
<rect x="20" y="125" width="670" height="70" rx="8" fill="#0e1418" stroke="#38bdf8"/><text x="35" y="153" fill="#c8c8c8" font-size="14">Each device: local SQLite stores</text><text x="35" y="177" fill="#c8c8c8" font-size="12">accounts.db: identities + local homes • config.db: desired / applied • state: observations</text>
<path d="M260 195 V235 M254 227 L260 235 L266 227" fill="none" stroke="#a3e635"/><text x="275" y="219" fill="#a3e635" font-size="12">explicit apply; validate / journal / write / read back</text>
<rect x="20" y="235" width="390" height="75" rx="8" fill="#0f160a" stroke="#a3e635"/><text x="35" y="263" fill="#c8c8c8" font-size="14">Managed settings in every local account home</text><text x="35" y="287" fill="#c8c8c8" font-size="12">native launch and agents run use applied revision</text>
<rect x="450" y="235" width="240" height="75" rx="8" fill="#16120a" stroke="#f59e0b"/><text x="465" y="263" fill="#c8c8c8" font-size="14">Device-only state</text><text x="465" y="287" fill="#c8c8c8" font-size="12">credentials / paths / active sessions</text>
</svg>
</figure>

### Storage and ownership

| Data | Owner / storage | Shared behavior |
| --- | --- | --- |
| Account ID, name, provider | `accounts/accounts.db` replicated catalog | Same logical identity on every enrolled device; name is not the key |
| Default account and managed account-selection bindings | Desired/applied configuration revisions | Downloaded selection changes remain inactive until applied |
| Local account home, discovered installation, login observation | Device-owned rows in `accounts/accounts.db` | Share availability metadata keyed by device ID; do not apply another device's path |
| Desired settings, resource revision manifest, revision history | Shared service; durable replica in `config/config.db` | Publish explicit edits with base-revision comparison |
| Applied settings, managed-field hashes, recovery journal | Local `config/config.db` | Publish acknowledgements only after read-back succeeds |
| Heartbeat, usage and session summaries | Dedicated local operational store; session content stays in existing session store | Device-owned records outside Git; no changes to transcript semantics |
| Skills/rules/hooks authored by people or agents | Existing resource repositories | Git remains the authoring/review transport; pin resource commits in desired revision |
| OAuth material and provider secrets | Existing native homes / secrets mechanisms | No new credential transport in this feature |

All local database files, WAL/SHM files and generated metadata are ignored by Git. Use the existing SQLite wrapper, migrations and locking conventions. Do not repurpose the transcript database into an unrelated catch-all account store.

### Publish and conflict handling

The daemon syncs typed, schema-versioned records. A revision contains a canonical settings document, resource commit hashes, account catalog revision, parent revision, author/device ID and content hash. One conditional update of the shared head is the publication point. A failed comparison preserves the local draft and returns the conflicting keys; no wall-clock last-writer-wins for desired settings. Disjoint edits can be rebased after validation; conflicting edits require an explicit selection. Offline edits remain drafts until publication succeeds.

Reuse managed/BYO storage selection, authenticated networking and object storage from sessions. Extend a shared transport interface with conditional head reads/writes and test its server enforcement on both backends. Immutable revision upload precedes head advancement; failed head advancement leaves a harmless unreferenced object. Do not assume today's session endpoint is deployed or implements the required conditionals: a real authenticated concurrency probe is a release prerequisite.

Device reports have device ID, monotonic sequence, observed time and expiry. Only that enrolled device may submit its report. Display stale reports as stale; never let a peer's reported home mutate local mappings. Account removal uses tombstones so offline peers cannot resurrect removed records. Retain history until all active peers acknowledge, or explicitly retire a peer.

### Apply and launch contract

`apply` freezes a target-device list and revision. Preview is read-only, including bootstrap paths. Execution checks schema compatibility, resource availability, managed-field overrides and model support for each target home. It acquires a local apply lock, captures previous managed values, records a recovery journal, writes through existing native adapters, then reads back managed fields. Only a fully verified local application advances the applied revision. Cross-file updates use a recoverable journal, not a false promise of filesystem-wide atomicity.

A durable fleet apply request authorizes that exact revision for its targets, including devices that reconnect later. It does not authorize future revisions. Repeated requests are idempotent. Partial fleet completion remains partial. A later explicit request supersedes an earlier pending request by ordered request ID; cancellation leaves already-applied devices visible.

On failure or interruption, the journal leaves a persistent recovery-required launch gate. Managed launches remain blocked across CLI/daemon restarts until either all old managed values are restored and verified or the requested revision finishes and is verified. Releasing a process lock alone must never expose partially written native settings. Resource projection must use the same apply boundary; downloading new resource commits cannot activate them.

Both `agents run` and managed native shims read the last applied snapshot. Downloads never change launch behavior. A new local home receives the already-applied revision before its first launch; an unprojectable home cannot silently run a different fleet default. Binary upgrades recheck/project the same applied revision. Existing sessions retain their launch revision. Launches do not depend on network access; while an apply is active, new managed launches briefly wait or get an explicit retry message.

Project settings and command-line overrides remain intentional higher-precedence inputs and are shown as overrides. Device/version settings that conflict with fleet model parity must be reported at preview and removed or explicitly excluded; they cannot be hidden behind a green fleet badge. Identical native files across platforms are neither necessary nor desirable.

### Models and account identity

Set a concrete model ID when exact fleet model equality matters. A tier such as `best` can resolve differently on different releases; display every resolved ID and call that policy parity, not model parity. Unsupported exact models block apply, preserving the previous active revision. An unknown catalog result is “unverified,” not proof of rejection or entitlement. An explicit provider probe may establish access; later provider revocation is reported at launch and never silently changes the model.

Preserve existing UUID account IDs and `setNativeAccountHome` behavior. Connect/discovery associates a native identity with a local home automatically. Never infer equality from a display name alone: use provider identity plus organization/tenant where available; ambiguous matches remain unresolved. A binding is just an optional saved account choice for a target. Ordinary users choose a per-harness default or `--account`; they do not write mapping rows. Existing explicit bindings are imported without changing their meaning, while new defaults do not contain binary version numbers.

Identity discovery and availability observations may sync immediately. Default-account and managed-binding policies are pinned to the applied configuration revision, including the referenced account catalog revision. Replace account selection's current `readMeta()` input in `commands/exec.ts:2559` with applied policy; downloading a change from account A to B must keep choosing A until apply. Explicit per-run account selection remains an intentional override. A revoked or deleted account fails visibly rather than silently selecting another identity.

### Alternatives and research

Verified against primary documentation on September 6, 2026:

| Approach | Decision |
| --- | --- |
| Continue Git transport for generated runtime state | Reject: improving rebase locking does not remove concurrent runtime writers from the checkout. Keep Git for authored resources. |
| Copy or synchronize a live SQLite database | Reject: SQLite WAL requires same-host coordination; a backup API creates snapshots, not a multi-writer fleet merge protocol. |
| SQLite session-extension changesets | Viable building block, but table changesets still need application conflict rules, transport and rollout semantics. Do not add a second opaque replication protocol. |
| Local SQLite + typed record transport + explicit apply | Choose: fits existing adapters/storage and makes account ownership, conflicts and rollout state explicit. |

SQLite says “All processes using a database must be on the same host computer” in its [WAL documentation](https://sqlite.org/wal.html). The [backup API](https://sqlite.org/backup.html) is appropriate for local migration snapshots. The [session extension](https://sqlite.org/sessionintro.html) records changesets; it does not supply this application's desired/applied contract.

### Independent verification

Claude planner `independent-plan`, team `fleet-config-plan-20260906`, completed on yosemite-m3. It received the requirements and source paths without this proposal.

- **Adopted:** desired/applied split, local database with record sync, offline launch path, stable identity/home/binary separation and verified parity.
- **Corrected:** its claim that bindings inherently require hand editing. `account-registry.ts:358` and attach/detach already automate writes. The design preserves useful explicit rules and removes manual upkeep from the default path.
- **Corrected:** its description of sessions as a universally conflict-free transport. `session/mirror.ts:66` still publishes summaries through shared Git state; that writer must move too.
- **Expanded:** its suggested owner-only edits into multi-device conditional publication, and its apply digest into a recoverable journal plus separate per-device projection hashes. The current network client's unconditional PUT is insufficient.
- **Adopted from non-author review:** persist the failed-apply launch gate across restarts, and pin default-account/binding selection to the applied revision. Both close paths where a download or failed apply could otherwise change launch behavior early.

## Proposed Changes

Illustrative changes, not implemented code:

```diff
cli/src/lib/run-defaults.ts
- resolveRunDefaultsFromConfigs([readMeta().run, ...projectRunConfigs], agent, version)
+ resolveRunDefaultsFromConfigs([readAppliedConfig().run, ...projectRunConfigs], agent, version)

cli/src/lib/account-registry.ts
- updateMeta(...deviceAccounts.homes...)
+ accountStore.recordLocalHome(accountId, installationLabel)

cli/src/lib/fleet-shared-repo-sync.ts
- publish generated account / session / heartbeat state through Git
+ retain authored-resource synchronization only
```

Introduce focused `accounts/db.ts`, `config/store.ts`, `config/sync.ts`, `config/apply.ts` modules under `cli/src/lib/`; extend existing adapters and storage abstractions. Keep command handlers thin. Inventory every generated writer before retiring YAML writes, including service discovery and session-tracker integrations. Do not declare the conflict issue solved after moving only account rows.

## Public Interface

Proposed command additions, reusing the existing config namespace:

```text
agents config set 'run.codex@*.model' <model-id>
agents config sync --fleet
agents config status --fleet --json
agents config apply --fleet --revision <revision> --dry-run
agents config apply --fleet --revision <revision>
```

`set` publishes desired state when online; offline it reports a queued draft. `sync` exchanges configuration records without applying. `status` includes desired/downloaded/applied revision, requested and resolved model, projection digest, drift, freshness, blocked reason and account readiness. JSON separates configuration parity from authentication readiness. A partially applied target set returns a non-success result with individual states.

## Plan

- [ ] Inventory existing writers and migration inputs; preserve dirty user data and scoped overrides.
- [ ] Add local account/config stores, stable IDs, schema migrations and one-time imports with checksummed backups.
- [ ] Add authenticated revision transport, concurrent publication and per-device acknowledgements.
- [ ] Build read-only preview and journaled apply through existing native adapters.
- [ ] Route all managed launch paths to applied settings; initialize new homes and check upgrades.
- [ ] Move remaining generated account/session/heartbeat/service metadata off tracked files; enforce Git cleanliness in the real flow.
- [ ] Roll out on isolated fixtures, two workers, then the fleet; prove partial/offline states before declaring parity.

Detailed file ownership and execution order are in `tasks.md`; the normative behavior contract is in `delta-spec.md`.

## Validation

Use real temporary SQLite databases, native configuration fixtures and the actual installed CLI; no mocks. Full suites run on a worker. Run three-process concurrent discovery/update tests, kill only owned test processes at each apply-journal boundary, restart and prove consistent recovery. Test incompatible schemas, stale account aliases, missing credentials, local native edits, changed catalogs, two-device publish races, replayed device reports and cross-owner authorization failures.

End-to-end proof: change one concrete model → publish → download on two devices → prove native files and launches still use old revision → dry-run and prove zero writes → apply → inspect all managed fields across multiple account homes → launch one session per harness and record effective model/revision → retry idempotently. Add an offline third device; show pending, reconnect, then verify its queued exact revision. Repeat after a binary upgrade and creation of a new account home. Existing sessions retain their original revision.

Also change the default account from A to B: download-only must still launch A; apply switches to B. Interrupt apply after one native file write, restart the launcher, and prove it refuses mixed settings until rollback or completion is verified. Download updated resource commits and prove active resource projection stays unchanged until apply.

Git proof compares tracked-file hashes and `git status --porcelain` before and after repeated discovery, launches, usage refresh and session mirrors. Baseline dirty user files must remain byte-identical. No worker runtime commits may be produced. Explicit authored resource changes remain ordinary reviewable Git changes.

## Risks

| Source / edge | Handling |
| --- | --- |
| `run-defaults.ts:202` reads desired YAML now | Change the canonical reader before introducing download-only behavior. |
| `account-registry.ts:720` builds a versioned selection target | Preserve imported explicit bindings; default account and identity must survive release changes. |
| `session/sync/net-client.ts:61` unconditional put | Conditional publish must be enforced by the service, not just client-side comparison. |
| `session/mirror.ts:66` produces generated shared rows | Move its transport with other runtime writers or Git churn persists. |
| `state.ts:1334` broad serialization | Dual-read only during migration; single new write owner. Unknown fields preserved. |
| Older fleet binaries still write YAML | Minimum writer protocol gate; upgraded devices stop importing legacy writes after cutover. Older devices remain “upgrade required.” |
| Filesystem interruption and external native writers | Journal and read-back; lock managed launches; detect out-of-band drift without overwriting unrelated native fields. |
| Storage unreachable | Keep last applied configuration usable; preserve drafts and report stale sync honestly. |

Migration is additive: backup and import without renaming native homes or deleting user data. Review conflicting inputs explicitly. Disable old generated writers only after reader migration and device version checks. Tracked generated files are retired through a reviewed repository change; no blanket cleanup of `~/.agents`. Rollback uses retained previous applied snapshots and a coordinated writer policy, not resuming two authorities.

## Tracking

[PHNX-3975](https://linear.app/getrush/issue/PHNX-3975): primary configuration proposal. [PHNX-3923](https://linear.app/getrush/issue/PHNX-3923): runtime Git drift. [PHNX-3940](https://linear.app/getrush/issue/PHNX-3940): existing account identity/home work to preserve.

Delivery stage: researched and independently checked proposal. No model was selected or applied by this plan. Implementation and fleet rollout remain unchecked above. Separate prior dry-run repair is [PR #3481](https://github.com/phnx-labs/agents-cli/pull/3481); it is not proof that this configuration design exists.
