---
kind: plan
title: Make account routing refuse stale usage decisions
summary: Factory correctly requests balanced routing, but agents-cli can select from days-old usage snapshots when every candidate is stale. This plan makes freshness a hard admission rule for an initial launch, preserves stale candidates only for bounded failover, and records enough decision evidence to reconstruct every pick.
status: awaiting-go
tracking: "RUSH-2392 / RUSH-2395"
facts:
  - Claude 2.1.219 was picked from an 86% weekly snapshot captured roughly 59 hours earlier.
  - preferVerified falls back to the entire stale pool when no candidate is fresh.
  - rotation.resolved omits usageUnverified, candidate ages, weights, and the random roll.
---

# Make account routing refuse stale usage decisions

## Purpose

When the user runs **Agents: New Claude**, Factory emits a balanced launch. On workstation, every cached Claude usage row was older than the five-minute routing limit, yet agents-cli selected `claude@2.1.219` from a roughly 59-hour-old snapshot reporting 86% weekly usage. Claude then rejected the first prompt because the weekly limit had already been reached.

<div class="artifact-callout"><strong>Behavioral contract:</strong> an initial launch must never choose an account from an unverified usage snapshot. If no fresh candidate exists, agents-cli performs one bounded refresh; if freshness still cannot be established, it exits with the account list and refresh failure instead of guessing.</div>

<figure>
<svg viewBox="0 0 980 330" role="img" aria-labelledby="routing-title routing-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="routing-title">Current and proposed routing decision</title>
  <desc id="routing-desc">The current flow falls from an empty fresh pool into stale weighted selection. The proposed flow refreshes once and either selects from verified accounts or fails with evidence.</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a3e635"/></marker>
    <style>
      .box{fill:#111827;stroke:#475569;stroke-width:2;rx:12}.bad{stroke:#ef4444}.good{stroke:#a3e635}.t{fill:#f8fafc;font:15px Inter,system-ui}.s{fill:#cbd5e1;font:12px Inter,system-ui}.h{fill:#a3e635;font:700 15px Inter,system-ui}.line{stroke:#a3e635;stroke-width:3;fill:none;marker-end:url(#arrow)}
    </style>
  </defs>
  <text x="25" y="30" class="h">CURRENT</text>
  <rect x="25" y="50" width="210" height="76" class="box"/><text x="42" y="80" class="t">All snapshots stale</text><text x="42" y="104" class="s">verified.length === 0</text>
  <path d="M235 88 H300" class="line"/>
  <rect x="300" y="50" width="245" height="76" class="box bad"/><text x="317" y="80" class="t">Fallback to stale pool</text><text x="317" y="104" class="s">weighted random still runs</text>
  <path d="M545 88 H610" class="line"/>
  <rect x="610" y="50" width="340" height="76" class="box bad"/><text x="627" y="80" class="t">Launch exhausted account</text><text x="627" y="104" class="s">provider rejects the first prompt</text>
  <text x="25" y="185" class="h">PROPOSED</text>
  <rect x="25" y="205" width="210" height="76" class="box"/><text x="42" y="235" class="t">No verified candidate</text><text x="42" y="259" class="s">initial admission stops</text>
  <path d="M235 243 H300" class="line"/>
  <rect x="300" y="205" width="245" height="76" class="box good"/><text x="317" y="235" class="t">One bounded refresh</text><text x="317" y="259" class="s">deduped provider reads</text>
  <path d="M545 243 H610" class="line"/>
  <rect x="610" y="185" width="340" height="58" class="box good"/><text x="627" y="218" class="t">Fresh pool → balanced pick</text>
  <rect x="610" y="258" width="340" height="58" class="box good"/><text x="627" y="291" class="t">Still unverified → fail with evidence</text>
</svg>
<figcaption>The stale pool remains available only after a provider-reported limit, as a bounded failover choice where the alternative is no launch.</figcaption>
</figure>

## Proposed Changes

### 1. Separate initial admission from emergency failover

`pickBalancedCandidate` currently calls `preferVerified`, which chooses the entire pool when no verified row exists. Introduce an explicit initial-decision result that can represent `no_verified_usage` without inventing a winner. Keep `rotation.healthy` intact so `rotationFailoverChain` can still use stale alternatives after the primary provider has already rejected a request.

### 2. Refresh once at the decision boundary

When `resolveRunVersion` receives `no_verified_usage`, perform one deduplicated, bounded usage refresh for the installed identities, then rebuild candidates and rerun selection. Do not add a second cache or background scheduler. The existing daemon remains the sole periodic refresher; this is an on-demand correctness check at the launch boundary.

If the refresh cannot establish a fresh account, exit nonzero with:

```text
agents: cannot choose a Claude account — all 7 usage snapshots are stale and refresh failed
oldest snapshot: user@example.com, captured 59 hours ago
run `agents view claude --refresh` for provider details
```

### 3. Record the complete decision

Extend `rotation.resolved` and add `rotation.unresolved` for a refused decision. Use stable identity keys in persisted events; human-readable email may remain in the terminal banner but is not required in the audit payload.

| Field | Purpose |
| --- | --- |
| `decisionId` | Correlates Factory launch, rotation decision, provider rejection, and failover |
| `pickedVersion`, `pickedUsageKey` | Identifies the chosen installed account without relying on display text |
| `pickedUsedPercent`, `pickedCapturedAt`, `pickedAgeMs` | Shows the exact usage evidence used |
| `pickedWeight`, `totalWeight`, `roll` | Reconstructs a weighted-random choice |
| `usageVerified` | Makes a stale decision impossible to mistake for a healthy one |
| `candidates[]` | Version, stable identity key, status, blocking percentage, age, weight, exclusion reason |
| `outcome` | `selected`, `refresh_failed`, `no_healthy_account`, or `provider_rejected` |

### 4. Feed provider rejection back into routing

When the existing same-agent failover detector recognizes Claude's weekly/session-limit response, emit `rotation.provider_rejected` with the same `decisionId` and temporarily exclude that account until its known reset or a successful live refresh. Store this in the existing auth/health cache rather than adding a parallel state file.

### Files

| Tag | File | Change |
| --- | --- | --- |
| core | `apps/cli/src/lib/rotate.ts` | Separate verified initial admission from stale failover; expose decision evidence |
| usage | `apps/cli/src/lib/usage.ts` | Add a bounded forced-refresh entry point using existing deduplication |
| daemon | `apps/cli/src/lib/usage-refresh.ts` | Reuse refresh result types; no new scheduler |
| run | `apps/cli/src/commands/exec.ts` | Retry selection once after refresh; emit refusal/provider-rejection outcomes |
| events | `apps/cli/src/lib/events.ts` | Register resolved, unresolved, and provider-rejected event contracts |
| Factory | `apps/factory/src/vscode/extension.ts` | Thread the terminal/session correlation ID; keep balanced launch behavior unchanged |
| tests | matching `*.test.ts` files | Reproduce all-stale selection and assert event payloads |
| docs | `apps/cli/docs/`, `apps/cli/CHANGELOG.md` | Document the fail-closed routing contract and new diagnostics |

## Public Interface

No new command or flag. `agents run <agent> --strategy balanced` changes behavior only when it cannot establish fresh usage for any candidate: it refreshes once, then refuses to guess.

The structured events become the supported debugging interface:

```json
{
  "event": "rotation.resolved",
  "decisionId": "...",
  "agent": "claude",
  "strategy": "balanced",
  "usageVerified": true,
  "pickedVersion": "2.1.218",
  "pickedUsedPercent": 8,
  "pickedAgeMs": 42000,
  "pickedWeight": 92,
  "totalWeight": 406,
  "outcome": "selected"
}
```

## Validation

1. Unit-test an all-stale pool containing a tempting 0% row and prove no initial pick is returned.
2. Unit-test mixed fresh/stale rows and prove only fresh rows participate in the initial roll.
3. Unit-test a successful one-time refresh followed by a verified balanced pick.
4. Unit-test refresh failure and prove no harness starts.
5. Unit-test provider rejection quarantine and bounded failover.
6. Run the real Factory command on a machine with deliberately aged cache rows; verify the terminal either launches a freshly measured account or prints the refusal.
7. Query `agents events --event rotation.resolved --json` and reconstruct the chosen candidate from the recorded weights and roll.

```bash
cd apps/cli
bun test src/lib/rotate.test.ts src/lib/usage.test.ts src/commands/exec.test.ts src/lib/events.test.ts
cd ../factory
bun test src/core/agents.test.ts
```

## Risks

| Risk | Handling |
| --- | --- |
| Provider refresh adds launch latency | Only pay it when zero candidates have a snapshot newer than five minutes; dedupe concurrent reads |
| Usage provider is unavailable | Fail with concrete snapshot ages and provider error instead of launching into unknown capacity |
| Worker setup-tokens cannot read usage | Treat those identities as unverified; device-role work in RUSH-2392/RUSH-2395 must supply an auth strategy that can measure usage or explicitly disallow usage-balanced routing |
| Event payload becomes large | Record one compact candidate row per installed version and rely on existing event truncation limits |
| Stale candidate might be the only working fallback | Preserve it only in the bounded post-rejection failover chain, clearly logged as unverified |

## Tracking

- RUSH-2392 — setup-token lacks `user:profile`; usage cannot be measured
- RUSH-2395 — device roles must choose authentication appropriate to personal versus worker devices
- Open one focused routing ticket for the all-stale admission bug before implementation; link this plan from it and add the ticket URL here.

## Delta Spec

- An initial balanced or available account decision MUST use a usage snapshot captured within `USAGE_DECISION_MAX_AGE_MS`.
- When no verified candidate exists, agents-cli MUST attempt at most one bounded live refresh before deciding.
- If the refresh produces no verified candidate, agents-cli MUST exit nonzero and MUST NOT launch a pinned or stale account implicitly.
- Stale candidates MAY participate only in an already-triggered, bounded provider-rejection failover chain and MUST be logged as unverified.
- Every routing decision MUST emit enough structured evidence to reproduce candidate admission, weighting, selection, and outcome without reading a session transcript.
