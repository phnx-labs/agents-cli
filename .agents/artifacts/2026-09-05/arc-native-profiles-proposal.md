---
kind: plan
surface: cli
title: "Use existing Arc profiles from agents browser"
summary: "Discover the user's Arc profiles, select a Space, and reuse its signed-in session without a debugging port."
header: "agents-cli / Engineering"
status: "Proposal — not implemented"
project: agents-cli
repository: phnx-labs/agents-cli
branch: plan/arc-native-profiles
harness: Codex
agent: Codex
human: ""
host: ""
session: ""
date: "2026-09-05"
tracking: PHNX-2399
links:
  - https://linear.app/getrush/issue/PHNX-2399
  - https://github.com/phnx-labs/agents-cli/pull/3299
assets:
  - arc-spaces-capture.png
---

## Focus for review

**Arc profile selection does not work properly in the shipped CLI.** A native scripting experiment proved selected-profile tab creation and page JavaScript, not a completed feature. This proposal closes that gap.

<figure class="artifact-figure artifact-behavior">
<section data-state="current" data-evidence="mockup">
<h3>Today: configured connections</h3>
<pre>$ agents browser profiles list

NAME                BROWSER
configured-browser  comet

ENDPOINT
cdp://127.0.0.1:9333

Arc native profiles and Spaces
are not discovered.</pre>
<p>Faithful, anonymized mockup of the installed listing and source behavior, checked September 5, 2026. A configured Arc connection without CDP asks for a restart.</p>
</section>
<section data-state="proposed" data-evidence="mockup">
<h3>Proposed: choose a real profile</h3>
<pre>$ agents browser profiles list

arc-work      Arc / Work
  Space: Work       Ready
arc-personal  Arc / Personal
  Spaces: Home, Reading
  Choose Space

$ agents browser start \
    --profile arc-work \
    --url https://example.com

Arc / Work · Space Work
No debug port required.</pre>
<p>Proposed output, not an implemented command flow. “Ready” requires the capability and selection-preservation checks below to pass. Saved logins stay in Arc.</p>
</section>
</figure>

The decisions: automatically discover existing native profiles; bind each task to a profile and Space by stable identity; use native Arc automation when no debugging port exists; make selection preservation a release requirement. No password or cookie migration.

## Purpose

The requested outcome is a familiar command flow: list profiles, choose an existing signed-in Arc profile, browse in the intended Space, and finish without damaging the user's session. The user also requested an evidence-backed plan opened locally. This deliverable is the plan and findings; implementation and release remain outstanding.

<div class="artifact-callout"><strong>Passwords stay in Arc.</strong> The CLI controls a tab inside the original profile. It must not copy the profile, create a replacement data directory, reset cookies, export passwords, or quietly switch to Comet. Ordinary website session expiry still exists; this is preservation of storage, not a promise that sites never log out.</div>

## What the experiment actually proved

<figure class="artifact-figure">
<img class="artifact-image" src="arc-spaces-capture.png" alt="User-provided cropped Arc sidebar showing Space selectors and the add button"/>
<figcaption>Actual user-supplied capture, September 5, 2026. These are Arc Space selectors, not independently debuggable browser processes. Profile names and account details are outside this crop.</figcaption>
</figure>

| Observation | Evidence from September 5 | What it establishes |
| --- | --- | --- |
| Running Arc exposed named Spaces and stable IDs | Native AppleScript enumeration returned the Space list | Discovery is feasible |
| A tab was created in the requested Work Space | The probe enumerated its newly created tab ID in that Space | Native Space-targeted creation is feasible |
| The tab used the expected native profile | `arc://version` returned a path ending in `Arc/User Data/Profile 1` | Selection reached the intended profile in this single trial |
| Page JavaScript ran | `{"ready":"complete","clicked":"yes","value":"arc-native-probe"}` | DOM evaluation, synthetic click, and direct field assignment worked |
| Creation changed selection | `selectionUnchanged: false` | The previous background-safe claim is disproven |
| Cleanup required explicit restoration | Closing the owned tab left “Can't get active tab of window 1”; the original selection was then restored | Cleanup needs a defined restoration protocol |
| Arc was not restarted | Same process before/after; one window; final probe-tab count zero | This experiment used the real running app without a debug port |

The test did **not** establish trusted keyboard/mouse events, framework-controlled form reliability, native password autofill, file uploads, background screenshot fidelity, cross-profile login isolation, or full CDP feature parity. Only one non-default profile completed the fresh mutation test; the planned second profile was not tested after the selection failure. “Prototype works” must never substitute for these missing checks.

The original PHNX-2399 requested native Space support. PR #3299 landed attachment and URL/title filtering. An older unmerged worktree contains native-driver experiments, but its claims are not acceptance evidence for current main. Its protocol emulation and selection behavior must be reviewed before any reuse.

## Current architecture

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 1040 340" role="img" aria-label="Current architecture: CLI profile registry routes CDP endpoints to BrowserService and URL-title tab selection">
<defs><marker id="current-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#38bdf8"/></marker></defs>
<g font-family="Inter,system-ui,sans-serif" font-size="17" fill="#e8e8e8">
<rect x="25" y="25" width="270" height="85" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="44" y="58">browser profiles / start</text><text x="44" y="88" fill="#999999" font-size="14">commands/browser.ts</text>
<rect x="385" y="25" width="270" height="85" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="404" y="58">registry → resolve-target</text><text x="404" y="88" fill="#999999" font-size="14">Configured names + device + port</text>
<rect x="745" y="25" width="270" height="85" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="764" y="58">BrowserService</text><text x="764" y="88" fill="#999999" font-size="14">One connection per profile alias</text>
<rect x="745" y="195" width="270" height="105" rx="8" fill="#16120a" stroke="#f59e0b"/>
<text x="764" y="226">drivers/local.ts → CDP</text><text x="764" y="256" fill="#f59e0b" font-size="14">Arc without a port: connection fails</text><text x="764" y="280" fill="#999999" font-size="14">No native Arc transport</text>
<rect x="385" y="195" width="270" height="105" rx="8" fill="#16120a" stroke="#f59e0b"/>
<text x="404" y="226">Existing page target</text><text x="404" y="256" fill="#f59e0b" font-size="14">Chosen by URL / title</text><text x="404" y="280" fill="#999999" font-size="14">No Space or account identity</text>
<path d="M295 68H378M655 68H738M880 110V188M745 246H662" stroke="#38bdf8" fill="none" stroke-width="2" marker-end="url(#current-arrow)"/>
</g></svg>
<figcaption>Source snapshot 60855164c, September 5, 2026. The implementation gap is between browser connection identity and the native profile containing a tab.</figcaption>
</figure>

| Gap | Canonical source | Consequence |
| --- | --- | --- |
| Listing reads configured declarations only | [profiles.ts:199](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/profiles.ts#L199) | Existing Arc profiles remain invisible |
| Profile type has no native profile or Space identity | [types.ts:117](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/types.ts#L117) | A CLI “profile” is a connection configuration |
| Local ports must be unique per configured profile | [profiles.ts:527](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/profiles.ts#L527) | Two native profiles cannot be modeled as aliases of one Arc port |
| Arc without CDP gets a quit/relaunch hint | [local.ts:56](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/drivers/local.ts#L56) | The normal running Arc cannot use the current transport |
| Tab choice compares URL/title, then first match | [service.ts:776](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/service.ts#L776) | Identical sites under different accounts are ambiguous |
| Arc new-tab creation is blocked | [service.ts:2877](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/service.ts#L2877) | The service borrows existing tabs instead of owning new ones |

The gap is not solved by removing the new-tab guard or permitting duplicate ports. Tab claims currently live within each connection's task map ([service.ts:747](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/service.ts#L747)); multiple aliases would also need shared ownership.

## Proposed architecture

<figure class="artifact-figure artifact-figure-diagram">
<svg viewBox="0 0 1040 600" role="img" aria-label="Proposed architecture: unified discovery and selection, shared browser service, native Arc adapter and existing CDP adapter, with user data owned by Arc">
<defs><marker id="proposed-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#38bdf8"/></marker></defs>
<g font-family="Inter,system-ui,sans-serif" font-size="17" fill="#e8e8e8">
<rect x="25" y="25" width="290" height="100" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="45" y="57">profiles list / show / use</text><text x="45" y="84" fill="#999999" font-size="14">Configured + discovered descriptors</text><text x="45" y="108" fill="#999999" font-size="14">Profile → eligible Spaces → readiness</text>
<rect x="395" y="25" width="290" height="100" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="415" y="57">start --profile --space</text><text x="415" y="84" fill="#999999" font-size="14">Resolve stable native IDs on owner host</text><text x="415" y="108" fill="#999999" font-size="14">Validate selection before opening a URL</text>
<rect x="395" y="190" width="290" height="105" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="415" y="223">Existing BrowserService + IPC</text><text x="415" y="252" fill="#999999" font-size="14">Tasks · ownership · capabilities</text><text x="415" y="276" fill="#999999" font-size="14">One Arc coordinator per host/app</text>
<rect x="25" y="370" width="440" height="105" rx="8" fill="#0f160a" stroke="#a3e635"/>
<text x="45" y="402">Native Arc adapter</text><text x="45" y="430" fill="#a3e635" font-size="14">Apple Events → exact Space ID → owned tab ID</text><text x="45" y="454" fill="#999999" font-size="14">Bounded operations · verified selection preservation</text>
<rect x="575" y="370" width="440" height="105" rx="8" fill="#0e1418" stroke="#38bdf8"/>
<text x="595" y="402">Existing CDP adapter</text><text x="595" y="430" fill="#999999" font-size="14">Existing Chrome / Comet tasks and features</text><text x="595" y="454" fill="#999999" font-size="14">No silent switch to another logged-in identity</text>
<rect x="25" y="530" width="990" height="50" rx="8" fill="#141414" stroke="#777777"/>
<text x="45" y="562">Arc owns passwords, cookies, history and extensions. The CLI stores references and task state only.</text>
<path d="M315 76H388M540 125V183M460 295L280 363M620 295L790 363M245 475V523" stroke="#38bdf8" fill="none" stroke-width="2" marker-end="url(#proposed-arrow)"/>
</g></svg>
<figcaption>Proposed. Native discovery and control join the existing browser service; they do not create another daemon or a copy of the user's browser profile.</figcaption>
</figure>

**Reuse:** the existing command verbs, registry ownership, shared browser daemon, task index, actor/session attribution, capture storage, and remote-control consent. Add a bounded native Arc adapter and a discovered-profile projection. Do not build another service, copy the old experimental driver wholesale, or pretend Apple Events implements all of CDP.

Discovery reads Arc's local profile-name/directory metadata and Space-to-profile assignments as hints, then uses Arc's scripting interface for live Space/tab identity. Those files have a private schema: unsupported or inconsistent data produces an explicit unknown/error state. Profile metadata is not a credential source. Before opening the requested URL, validate the selected Space and profile association on the actual owner host; use a task-owned bootstrap tab to verify the effective profile path if required. The single `arc://version` trial is evidence this check is possible, not proof it is stable across versions.

## Alternatives and research

| Approach | Evidence and implication | Decision |
| --- | --- | --- |
| Native Apple Events | Installed Arc scripting dictionary exposes windows, Spaces, tabs, and JavaScript; our live trial exercised them | First delivery, gated by selection preservation and core-action tests |
| Relaunch with remote debugging | Current CLI suggests it. Chrome restricts default-data-directory debugging from version 136; applicability to current Arc was not freshly tested | Do not require a restart or a new data directory to use existing Arc logins |
| Extension transport | Chrome documents `chrome.debugger` as an alternative tab-scoped CDP transport with restricted domains and a permission requirement | Possible later route for advanced capabilities; Arc compatibility, installation per profile, and background tab behavior need a separate prototype |

Primary references checked September 5, 2026:

- [Arc Profiles](https://resources.arc.net/hc/en-us/articles/19227964556183-Profiles-Separate-Work-Personal-Browsing): “one or multiple Spaces” can use a profile. Profiles contain authentication, cookies, history and extensions.
- [Arc multiple windows](https://resources.arc.net/hc/en-us/articles/25590417429783-Why-Are-the-Same-Tabs-Appearing-Across-Multiple-Arc-Windows): windows can share Space tabs; another window is not an independent account or debugging boundary.
- [Chrome remote debugging change, March 2025](https://developer.chrome.com/blog/remote-debugging-port): default Chrome data directories are excluded. This is Chrome evidence, not a reproduced Arc restriction.
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger): extension transport requires `debugger` permission and supports only selected CDP domains.
- [CDP Target API](https://chromedevtools.github.io/devtools-protocol/tot/Target/): `getBrowserContexts` returns contexts created through its API; it is not documented as enumeration of persistent signed-in browser profiles.
- [Independent Arc MCP implementation](https://github.com/Mukbeast4/arc-browser-mcp): its own documentation separates native live operations from CDP-only features and admits frontmost-tab race limitations. It is an implementation precedent, not validation of our integration.

## Proposed Changes

Illustrative deltas below describe the contract to build, not patches already implemented.

`cli/src/lib/browser/types.ts` and `cli/src/lib/types.ts`:

```diff
- browser profile = name + CDP endpoints + launch options
+ resolved browser profile = configured CDP connection | discovered Arc reference
+ Arc reference = owner device + stable native profile ID + selected Space ID
+ task = backend kind + exact owned tab IDs + capability result + identity
```

`cli/src/lib/browser/profiles.ts`, `registry.ts`, `resolve-target.ts`, plus adjacent `arc-discovery.ts`:

```diff
- listProfiles() returns configured declarations only
+ listProfiles() merges configured declarations with bounded native discovery
+ getProfile()/use/start resolve the same descriptor, never list-only aliases
+ listing is read-only: no launch, permissions prompt, profile mint, or default change
+ native descriptors bypass CDP-port allocation and managed-data-dir ownership
```

`cli/src/lib/browser/service.ts`, new `drivers/arc.ts`, and the existing driver boundary:

```diff
- Arc navigate borrows the first matching URL/title target
+ Arc start validates native profile + Space and creates a task-owned tab
+ native adapter implements only declared, verified core operations
+ common service owns claims, recovery, task routing and capability errors
+ all aliases of the same Arc app share one mutation coordinator
```

`cli/src/commands/browser.ts`:

```diff
+ profiles list/show expose native profile, Spaces, origin and readiness
+ start --profile <selector> [--space <name-or-id>] selects existing Arc state
+ use persists stable native identity; rename changes an alias, not Arc storage
+ native remove/prune remove CLI references only; never delete native data
+ doctor explains missing permissions and unsupported capabilities
```

Both conversion paths (`configToProfile` and `profileFromDeclaration`) must carry the discriminant and native identity. Endpoint rewriting must never turn a native reference into an `ssh://...:9222` tunnel. These are shared-source changes, not patches in downstream consumers.

## Public Interface

All new behavior below is proposed. Existing task verbs remain the user-facing workflow.

```bash
agents browser profiles list
agents browser profiles list --json
agents browser profiles show arc-work

agents browser start --profile arc-work --url https://example.com
# Only when the profile has multiple Spaces:
agents browser start --profile arc-personal --space Reading --url https://example.com

agents browser refs --task <returned-task>
agents browser click <ref> --task <returned-task>
agents browser done --task <returned-task>

# Optional default; stores a native reference, not a copy of its data.
agents browser use arc-work
```

### Discovery and identity

A native row has a stable machine-scoped ID, a display name, exact eligible Space IDs/titles, source `discovered`, owner device, freshness, and readiness. Human names such as `arc-work` are convenient selectors; duplicates or a collision with a configured name fail with the matching stable IDs. JSON always returns the canonical ID. A running task pins identity at start, so a rename cannot redirect it.

One Space: select automatically. Multiple Spaces: require `--space` in headless use; a TTY can offer a picker. No assigned Space: display the profile with “Assign a Space in Arc”; do not invent a Space. Native internal/system profiles are excluded. If metadata cannot establish a profile association, show “Profile unknown” and refuse account-sensitive selection.

### Readiness and failure states

<section class="artifact-grid artifact-grid-2">
<article class="artifact-panel"><h3>Arc open, no debugging port</h3><pre>arc-work  Discovered
Control: Native automation
Debug port: Not required

start → permission check → own tab</pre><p>Use the real signed-in profile. No restart prompt.</p></article>
<article class="artifact-panel"><h3>Permission missing</h3><pre>Arc was found, but control is not allowed.
Allow Automation access to Arc.
Enable JavaScript from Apple Events in Arc.
Next: agents browser profiles doctor arc-work</pre><p>No tab opens until the required permissions are satisfied. Discovery is not reported as “Ready.”</p></article>
<article class="artifact-panel"><h3>Arc closed</h3><pre>arc-work  Arc closed
Existing profile detected.

start → open Arc normally → verify identity</pre><p>Open the installed app with its ordinary data. If no usable window/Space appears or startup times out, report it; never mint a new profile.</p></article>
<article class="artifact-panel"><h3>More than one Space</h3><pre>Profile Personal has multiple Spaces:
  Home
  Reading
Choose one:
  start --profile arc-personal --space Reading</pre><p>Do not guess from the user's current tab or whichever Space happens to be first.</p></article>
<article class="artifact-panel"><h3>Profile identity changed</h3><pre>Space Work no longer uses the selected profile.
No page action was performed.
Refresh: agents browser profiles list</pre><p>Reassignment or deletion cannot silently move an existing task to another account.</p></article>
<article class="artifact-panel"><h3>Capability unavailable</h3><pre>Network capture is unavailable for native Arc.
This task still belongs to Arc / Work.</pre><p>Return a structured capability error. Never report an empty capture as success or silently open another browser.</p></article>
</section>

### Core capability contract

| Capability | First-delivery requirement |
| --- | --- |
| List/show profiles and Spaces; select existing native identity | Required |
| Own a new tab; navigate; read DOM; synchronous evaluate; refs | Required after real-flow tests |
| DOM click/fill, framework-controlled forms and bounded waits | Required with honest semantics; synthetic DOM input must not masquerade as trusted hardware input |
| Scroll and task cleanup | Required with selection checks |
| Screenshot | Conditional: capture the verified task window only when the intended tab is actually visible; otherwise return a capability/readiness error. No foreground switch just to get a picture |
| Async evaluation, cross-origin frames, dialogs, upload/download control, PDF, network/console recording, headless | Unsupported unless separately implemented and proven; never return fabricated successful results |
| Password autofill | Existing Arc storage remains intact; autofill automation is not yet verified or promised |

### User selection and concurrency

A host-wide Arc coordinator serializes native tab creation, identity validation, selection-sensitive operations and cleanup across all profiles. Snapshot exact window/Space/tab selection and the relevant existing tab set. Obtain a native tab reference from the create operation, or an unambiguous per-attempt marker with durable creation intent; “first new tab in a before/after diff” is unsafe if a human opens a tab concurrently.

Restoration is conditional: restore only when the current selection is still the one the operation induced. Do not override a newer human selection. If the original tab/window disappeared, leave the user's newer state alone. In-process locks do not coordinate the human; a real concurrency test is mandatory.

**Release gate:** if the current Arc API cannot create/control task tabs without visible selection disruption while the user is active, do not advertise background readiness. Native discovery may ship independently, but the browsing feature remains unfinished until a nondisruptive path is proven. An extension route is a separately tested alternative, not an automatic fallback or a presumed solution.

### Fleet and cleanup

Discovery runs on the browser's owner host through existing dispatch/consent boundaries. A worker does not read its own Arc metadata and pretend it describes the desktop. Native page verbs route to the owner through the existing task binding and execute in its shared browser service; they do not tunnel a nonexistent CDP port or start another native-control daemon.

A remote owner that is unreachable yields “owner unavailable.” Arc profiles and cookies never become fleet replicas. Listing remote readiness is bounded; stale cached metadata is labeled stale and is revalidated before use.

`done`, `stop`, pruning and crash recovery can close only positively owned tabs, never kill Arc. If a human moves an owned tab to another Space/profile, stop acting and release it for manual ownership rather than following it into another account. A lost or ambiguous tab reference must not cause cleanup of a same-URL user tab.

## Plan

The executable checklist is [arc-native-profiles-tasks.md](arc-native-profiles-tasks.md), bound to PHNX-2399. No runtime implementation is marked done by this planning document.

1. Validate the no-disruption creation/control path on real Arc before expanding the driver.
2. Add native discovery and stable profile/Space descriptors to the canonical resolver.
3. Add the bounded native adapter and declared capability boundary.
4. Integrate tab ownership, selection checks, daemon recovery and cleanup.
5. Expose the proposed CLI listing/selection/readiness flow.
6. Preserve remote dispatch and owner-host execution.
7. Exercise the real two-profile flow, review, merge, release, then run the installed CLI.

## Validation

| Scenario | Acceptance evidence |
| --- | --- |
| Actual discovery | `profiles list --json` matches real Arc profile/Space metadata; no files changed by listing; unknown schemas are explicit |
| Two profiles, same website | Two controlled accounts in two existing Arc profiles remain distinct through creation, navigation, read, action and cleanup; a third Space sharing a profile intentionally shares its login |
| No CDP listener | Installed CLI performs the complete native core flow without quitting Arc or opening a debugging port |
| Login preservation | Existing signed-in pages still authenticate before/after; original native storage paths remain unchanged; no copying, reset, deletion or extra user-data-dir |
| Forms | Real input/change behavior on native and controlled framework forms; synthetic-only behavior reported honestly |
| Selection and race | Record before/during/after state and a screen recording while the human changes tabs; no wrong-tab operation or unwanted restoration |
| Failure recovery | Timeout/crash after creation, duplicate names, missing Space, reassignment, moved tab, permission denial and malformed metadata all fail without borrowing a user's tab |
| Remote start | Worker → browser owner → returned task → refs/action → done; no local duplicate or token/profile transfer |
| Existing browsers | Affected CDP/remote-task regression suites remain green |
| Shipped proof | `cli/scripts/install.sh --skip-tests` for side-by-side `agents-dev`; reviewed PR; canonical CLI release; then repeat the native flow with registry-installed `agents` |

Tests live beside their source and use real Arc on a provisioned test Mac, with adjacent non-sensitive `testdata/`. Broader suites run through `cli/scripts/test.sh` on fleet workers; the interactive laptop is not the broad-test runner. Use the canonical build/install/release scripts. Slow real-Arc coverage belongs outside the required PR fast lane. Existing R1–R5 CI/release requirements remain unchanged.

## Risks

| Source or observation | Failure | Handling |
| --- | --- | --- |
| [service.ts:747](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/service.ts#L747) | Claims isolated by alias permit two tasks to own one native tab | Host/app coordinator and exact native IDs |
| [resolve-target.ts:67](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/resolve-target.ts#L67) | A conversion omits new native fields | One complete conversion contract exercised through public commands |
| [resolve-target.ts:199](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/resolve-target.ts#L199) | Native selection becomes an SSH CDP tunnel | Discriminated routing before endpoint rewriting |
| [commands/browser.ts:1135](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/commands/browser.ts#L1135) | Removing an alias reaches native profile data | Explicit external-data ownership; no native directory deletion |
| Installed Arc.sdef / live probe | Native script coercion fails or creation changes selected tab | Exact-ID scripts, bounded calls, recorded intent, tested restoration |
| Private metadata format | Profile rename/reassignment or format change misroutes account | Validate schema, stable identity and actual profile before actions |
| Real DOM trial | Synthetic events pass a toy test but fail on an application | Real forms and explicit unsupported capabilities |

## Independent verification

An independent Claude teammate produced a blinded plan after reading the current browser sources. It received the requirements and empirical observations, not this proposal. The following reconciliation distinguishes agreement from recommendations we rejected; independent planning is not a claim that runtime code passed review.

| Independent finding | Decision and reason |
| --- | --- |
| Extend the existing service with a native backend, not a second daemon | **Adopted.** Keep task routing, consent, captures and cleanup in their current owners; native operations must not emulate successful CDP responses |
| Native declarations would be rewritten into a fabricated SSH port | **Adopted.** The source at [resolve-target.ts:199](https://github.com/phnx-labs/agents-cli/blob/60855164c70bf086ca9e22ee45c3313ec9597191/cli/src/lib/browser/resolve-target.ts#L199) confirms this risk. Add a discriminated owner-host route before endpoint rewriting |
| Capability completeness must cover every browser verb | **Adopted.** Every verb must be implemented and tested or explicitly unsupported; no silent empty-result success |
| Add a separate discover → create → migrate command sequence | **Not adopted.** The user asked for automatic listing and direct selection. Discovery belongs in the existing profiles listing; legacy configured connections remain explicit |
| Encode Space titles in an endpoint and recover tabs through title/URL/index | **Rejected.** The fresh native enumeration returned Space and tab IDs. Mutable names and shared URLs cannot establish ownership; validate stable native references on every action |
| Treat Arc as one globally selected profile | **Rejected.** The tested Space reached native Profile 1; Arc documents profile assignment per Space. Model the relation explicitly, then verify two different profiles end to end |
| Restore selection after every action; serialize per connection | **Strengthened.** Aliases share the same app, so coordinate per host/app and restore only if the operation still owns the induced selection. A before/after match alone cannot prove absence of visible disruption |
| Never launch Arc, even when closed | **Not adopted as a blanket rule.** Listing remains read-only. An explicit start may open the normal app with existing data, but never restart a running app to enable debugging or create a replacement profile |

The key remaining uncertainty is native automation's ability to meet the no-disruption requirement. That is P1, ahead of implementation expansion, not a hidden assumption.

## Tracking

- [PHNX-2399 — native Arc Space support](https://linear.app/getrush/issue/PHNX-2399): implementation remains outstanding; the previously closed ticket did not establish native acceptance.
- [PR #3299 — earlier attachment change](https://github.com/phnx-labs/agents-cli/pull/3299): historical context, not full delivery proof.
- Planning branch: `plan/arc-native-profiles`. [Rendered overview](arc-native-profiles-visual.html) and [implementation checklist](arc-native-profiles-tasks.md) accompany this proposal; the planning PR is linked from PHNX-2399.
- The related Comet work remains separate; no change to the configured default browser is part of this proposal.

## Evidence record

Both HTML artifacts passed `artifacts check` and were inspected at 1440px desktop and 390px mobile widths in light and dark themes. Checks returned zero page JavaScript errors, no document overflow, no missing internal anchors and no broken content captures. Theme switching and collapse/expand controls were exercised. Optional external favicons are decorative and are not required to read the page. Renderer warnings accepted: personal host/session metadata intentionally omitted; the repository's existing legacy dark palette was reused with the renderer's light palette.

Code snapshot: `60855164c70bf086ca9e22ee45c3313ec9597191`. Arc version: `1.162.0`. Observation date: September 5, 2026, Pacific time. Profile names in command mockups are illustrative. Local account names, session IDs, device addresses and absolute home paths are omitted from the public artifact.

The quoted native results above come from actual tool output in the requesting session. Sanitized sequence: enumerate → create one Work tab → verify DOM → navigate owned tab to Arc version page → verify `Profile 1` → close owned tab → restore original selection → verify no probe tabs. Failed initial AppleScript/JXA coercion attempts are not counted as successful operations. No assertion is based solely on a command's exit status.
