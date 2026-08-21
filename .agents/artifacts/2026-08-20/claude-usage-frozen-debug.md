# Debug: Claude usage bars frozen at "0% (now)" fleet-wide

Date: 2026-08-20 · Repo: agents-cli · Surface: `agents view` usage bars, rotation eligibility

## Intent vs observed

- **Intended:** `agents view claude` shows each account's real session (S) and weekly (W) utilization.
- **Observed:** every Claude account renders `S: ░░░░░ 0% (now)  W: ░░░░░ 0% (now)` and `usageStatus: "available"`, on every fleet box, for ~2 weeks.
- **Delta:** the bars are drawn from a cache frozen since Aug 5-7 and presented as fresh, zero-utilization, available accounts.

## Root cause — two stacked failures

### 1. Anthropic rate-limits the usage endpoint per account, and the bucket never drains

Live probes from a fleet worker box (2026-08-20):

| Probe | Result |
|---|---|
| Valid setup-token (account A) → `GET /api/oauth/usage` | **HTTP 429**, `retry-after: 3600` |
| Valid setup-token (account B) | **HTTP 429**, `retry-after: 3600` |
| Garbage bearer token, same box | **HTTP 401** `authentication_error` |
| Garbage bearer token, a fleet box that never ran usage probes | **HTTP 401** |
| No auth header (any box, incl. the never-probing box) | HTTP 429 (endpoint default for unauthenticated) |

The 401s prove the machines/IPs are **not** throttled — the auth layer is reached and evaluated. The 429 keys on the **account/token**. Every Claude account's bucket is exhausted and stays exhausted: the aggregate fleet traffic against the same 8 accounts — per-box auth-health probes (`probeClaudeStatus`, ~3 min cadence per version home, 8 homes), the usage refresh tick (5 min per account on the resolved primary), hourly backoff retries from 6 desynchronized boxes, plus every live Claude Code session's own statusline polling — keeps each per-account window pinned.

`usage-backoff.ts` works as designed (cross-process penalty files honored; live penalty file `claude.<deadline>` present) — but its `MAX_BACKOFF_MS` cap of 1 hour guarantees each box retries hourly forever, and nothing escalates on repeated 429s.

Evidence: `~/.agents/.cache/claude-usage.json` — all seven `claude:org=*` entries carry `capturedAt` of **Aug 5-7**, while `codex`/`grok`/`antigravity` entries in the same file carry Aug 20 timestamps. The Claude fetch has not succeeded once in ~2 weeks; a failed fetch never overwrites the cache.

### 2. The deserializer turns "expired cache" into "0% used, fresh, available"

`apps/cli/src/lib/accounting/usage.ts`, `deserializeClaudeUsageSnapshot`: a cached window whose `resetsAt` has passed gets `usedPercent = 0` but **stays in the snapshot**. Downstream:

- `formatResetHint` renders the past `resetsAt` as `(now)` — implying freshness.
- `deriveUsageStatusFromSnapshot` sees maxUsed 0 < 100 → returns **`'available'`**.
- `rotate.ts` `hasUsageAvailable` mirrors that status → a genuinely session-limited account reads as a 0%-used ideal dispatch candidate (RUSH-2858's observed damage: "runs die instantly").

The codebase already has the honest precedent: the Grok collector **filters** expired windows ("so a stale 100% does not paint 'rate-limited' after reset") instead of zeroing them. Claude's deserializer diverges from it.

## Spec & gap

`formatUsageSummary` carries the design intent in its own comment — "Drawing them unmarked is what let a 26h-old '48% used' read as fact" — and has an honest `usage unavailable` branch for a null snapshot. No test pins the expired-window path: `usage.test.ts` covers *unexpired* stale windows ("deserialization keeps the number rather than zeroing it") but nothing asserts what an **expired** window becomes. That coverage hole is where this slipped.

## Fix

1. **This PR:** `deserializeClaudeUsageSnapshot` filters expired windows (Grok precedent) instead of zeroing them; an all-expired snapshot deserializes to null. Existing plumbing then does the right thing for free: `readClaudeUsageCache` deletes the dead entry, `agents view` renders `usage unavailable` plus the recorded throttle reason ("Claude rate-limited this machine — not retrying for Xm"), and rotation stops trusting fake 0%. Regression test added.
2. **Follow-up (ticketed):** escalate the backoff on repeated 429s (hourly-forever retries from every box are part of what keeps the per-account bucket pinned), and reconsider auth-health probing the usage endpoint per version home on every box when a usage primary is configured.

## Attribution

Not a CLI regression in the frozen-cache sense: the zeroing behavior predates the freeze, and the freeze began when Anthropic's per-account limiting on `/api/oauth/usage` tightened (~Aug 3-5; the 2026-08-03 `usage-backoff.ts` incident on a fleet worker was the first symptom). The CLI's contribution is the display lie (failure 2) and the non-escalating retry cadence.
