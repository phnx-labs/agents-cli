---
kind: plan
surface: cli
title: Restore Cursor and Grok usage truth
summary: Make managed Cursor authentication match its isolated credential store and publish current Grok billing events without claiming agents-cli owns Grok's upstream refresh.
status: validating
tracking: RUSH-3196 / RUSH-3197
links:
  - https://linear.app/phnx/issue/RUSH-3196
  - https://linear.app/phnx/issue/RUSH-3197
---

## Focus for review

- Cursor swaps HOME and uses its version-local file credential store at every launch boundary; stale metadata is not authentication.
- Existing Cursor Keychain credentials are neither exported nor deleted. The selected managed version receives one fresh OAuth login.
- Grok remains event-fed. A forced or daemon collection publishes the newest local billing event, while expired data names the exact run needed to refresh it.

## Purpose

Restore truthful account identity and quota output for the installed Cursor and Grok harnesses, then prove the dev build against their real Zion installations.

## Current architecture

<figure class="artifact-figure artifact-behavior">
  <section data-state="current" data-evidence="capture">
    <h3>Current</h3>
    <pre>Cursor  2026.08.04  muqsitnawaz@gmail.com  usage unavailable
binary about:       team@agentsmores.com    Pro+

Grok    SuperGrok Heavy
Grok    X Premium+
        current billing logs exist, but daemon rejects last_seen</pre>
  </section>
  <section data-state="proposed" data-evidence="mockup">
    <h3>Proposed</h3>
    <pre>Cursor  2026.08.04  &lt;OAuth account&gt;  Pro+  &lt;current meters&gt;

Grok    SuperGrok Heavy  W: █░░░░ 21% (5d)
Grok    X Premium+       W: █████ 100% (2d)

Expired Grok log: run grok@&lt;version&gt; once to refresh usage</pre>
  </section>
</figure>

The forced collector is the shared seam: network providers return `live`; local event providers return `last_seen`. Both are successful fresh collections when invoked against the source now.

## Proposed Changes

```diff
- Cursor: XDG_CONFIG_HOME assumption; signedIn = token || stale email
+ Cursor: version HOME + AGENT_CLI_CREDENTIAL_STORE=file; signedIn = readable ~/.cursor/auth.json token

- daemon: publish only snapshot.source === "live"
+ daemon: publish any snapshot returned by an explicit source collection

- Grok expired billing: plan with an empty usage column
+ Grok expired billing: run grok@<version> once to refresh usage
```

## Public Interface

| Surface | Behavior |
| --- | --- |
| `agents run cursor@<version>` | Authenticates only from that version's file store. |
| `agents view cursor --refresh` | Uses the same version credential and reports its real identity and quota. |
| `agents view grok --refresh` | Rereads and publishes the newest Grok billing event. |
| Plain Grok view without a current event | Names the exact version to run once. |

<aside class="artifact-callout">`source: last_seen` describes provenance, not failure. A just-read local event is a successful collection and belongs in the shared cache.</aside>

## Plan

- [x] Wire Cursor file-store isolation and truthful signed-in state.
- [x] Publish forced local-event collections and render actionable Grok freshness.
- [x] Add focused regressions and update durable docs/changelog fragments.
- [x] Run focused tests, the canonical build, and side-by-side dev install. After clearing the disposable stale remote tree, the full suite ran this diff cleanly but retained 54 unrelated repository-baseline failures; all affected Cursor/Grok files passed.
- [x] Complete Cursor OAuth in Arc and verify Cursor plus both Grok identities on Zion.
- [ ] Open, review, rebase-merge, and close both tickets with proof.

## Validation

```bash
cd cli && bunx vitest run <affected test files>
cli/scripts/test.sh --device yosemite-m1  # affected tests pass; 54 unrelated baseline failures remain
cli/scripts/build.sh --skip-tests
cli/scripts/install.sh --skip-tests
agents-dev view cursor --refresh
agents-dev view grok --refresh
```

The PR includes quoted installed-binary output and a rendered terminal capture. Production `agents` remains untouched.

## Risks

| Risk | Mitigation |
| --- | --- |
| Cursor's Keychain login masks an empty isolated store | Force file mode and require one explicit OAuth login; retain Keychain entries. |
| An expired Grok 100% meter remains red after reset | Drop expired windows and request a new harness event. |
| A cached local event is mistaken for a newly collected event | Publish only from the explicit collector path; ordinary views remain cache-only. |

## Tracking

- [RUSH-3196](https://linear.app/phnx/issue/RUSH-3196)
- [RUSH-3197](https://linear.app/phnx/issue/RUSH-3197)
