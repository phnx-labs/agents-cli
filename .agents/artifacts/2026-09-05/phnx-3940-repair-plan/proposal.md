# PHNX-3940 repair proposal

Status: proposed, not implemented. Source baseline: `83dc2a8133e41241938a81155bb368a8dcd04f5a`, fetched 2026-09-05. This supersedes the remaining-work recommendations in the earlier diagnosis; it does not replace its dated evidence or claim the first release never worked.

## Why

Users should choose a harness and account. Six Codex installation rows for three accounts are a storage/identity coupling, not six useful choices. An enabled update policy says nothing about successful checks. A shared account name says nothing about usable credentials on a particular worker.

## What changes

1. Separate a device's account homes from its executable releases. Reuse stable account IDs and the existing `ExecOptions.version` / `configVersion` separation (`cli/src/lib/exec.ts:282–284`), then resolve one immutable launch selection before any spawn.
2. For transactionally managed npm harnesses, store each `(harness, platform, architecture, release)` package once per device. New default launches use one verified current release. An explicit pin or already-running session can retain another release. Do not share mutable credential homes across accounts or devices.
3. Migrate metadata in place. Preserve native-home paths, their inodes, keychain lookup paths, pending connect slots, histories, account IDs, labels and explicit pins. Existing account-home paths may retain old numbers internally; their meaning is no longer a release selection.
4. Extend the existing daemon updater with durable per-pass outcomes and one per-harness lock. An update stages and probes an immutable release, then atomically advances the current pointer. Do not mutate an executable underneath a running session. Preserve the existing cooperative cancellation discipline.
5. Unify native and automation credentials under the same account identity. Enforce device-role and provider-surface policy after all environment overlays and against effective vendor settings/helpers/profiles and CLI overrides. Preserve native files and reject conflicting/unknown auth precedence; prove post-load enforcement, not just an environment preflight. Revisioned secret delivery must acknowledge the exact credential revision and establish a local home binding before the worker is marked ready.
6. Show account identity, dated authentication result, update policy and update health as separate facts. Version details list actual shared releases and retention reasons; legacy aliases/home paths become explicitly labeled diagnostics.
7. Classify redundant packages with an exact-target cleanup preview. Never infer safe deletion from being logged out. Legacy package removal requires explicit approval; automatic retention cleanup applies only to new manager-owned immutable release-cache entries under a disclosed policy.

## Impact and boundaries

Canonical owners are installation storage/updater, account registry/catalog, `buildExecEnv`/`execAgent`, daemon service health, secret transport, and thin command renderers. Bare shims, local run, remote dispatch, teams, routines, native resume, config sync and account/usage enumeration must consume the same separation. No second scheduler or credential-selection implementation in a consumer.

First implementation covers Claude/Codex and other npm-package harnesses only when their adapters prove isolated account-home support. Global/vendor-managed harnesses keep their real single-binary path; the capability registry must say which guarantees apply. No claim that unsupported vendors acquire managed transactions or durable tokens.

Out of scope: unrelated items consolidated into PHNX-3940 (for example fleet trace-shard merging), changing billing providers, making personal Pro tokens last a year, automatic removal of native homes, fleet-wide resets, re-enabling the paused cloud PR reviewer, and any customer-cloud credential redistribution. This plan concerns the user's trusted device fleet.

## Mock-ups and flows

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="capture">
<h3>Current: dated, redacted real output</h3>
<img src="current-accounts.png" alt="Real account view shows three accounts and update policy without updater health" />
</section>
<section data-state="proposed" data-evidence="mockup">
<h3>Proposed: account-first, shared executable</h3>
<pre><code>Codex · up to date
  Automatic updates on · last successful check: 2m ago
  * personal   native login · checked 2m ago
    secondary  native login · checked 4m ago
    team       native login · checked 5m ago
  Default account: personal
  3 accounts · 1 shared executable</code></pre>
</section>
</figure>

Happy path: connect harness/account → reuse shared package → native authorization in a separate home → verify identity → bind → enroll supported worker credential → acknowledge revision and verify on the worker. An update changes only executable selection, not that home.

Failure paths: cancelled login remains pending; wrong identity never replaces an existing binding; an offline worker remains pending; unsupported worker tokens require independent device login; an incompatible busy native home defers only its next release selection. All relative times above are illustrative.

The rendered [repair plan](plan.html) contains the current capture, proposed normal/pending/paused/unhealthy/empty/reconnect states, connection and worker-enrollment flow, release details, migration conflict and cleanup preview, and current/proposed system diagrams. These are labeled proposals, not screenshots of implemented behavior.

## Execution and contract

- [Ordered file-owned tasks](tasks.md)
- [Delta specification](delta-spec.md)
- [Ticket](https://linear.app/getrush/issue/PHNX-3940)

No runtime changes or removal are authorized by merely rendering this plan. The task list carries the release and installed-proof gates for the subsequent implementation. Before activating a new layout, prove old entrypoints are upgraded or reliably blocked; a new marker alone cannot fence an unaware old executable. Where cross-version native-home compatibility is unproven, defer the busy home's next selection rather than mutate vendor data.
