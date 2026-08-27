# Restore live Claude usage bars on a personal machine (`agents view claude`)

## Why — the problem and the user value

On **zion** (an interactive `personal` device) `agents view claude` shows
`S: █████ unavailable` for most signed-in Claude accounts — the 5-hour **session**
window is missing — and one account (`muqsit@getrush.ai`) shows a bare
`usage unavailable` with no bars at all. The operator was certain this information
**used to be present for every signed-in account**. They are right: it regressed.

This matters because `agents view` is the operator's at-a-glance answer to *"which
of my accounts has session headroom right now?"* — the exact question you ask before
launching a burst of agents. A dark S column across eight accounts makes the command
useless for its primary job on the one machine where a human actually reads it.

## Root cause (grounded, `file:line`)

Two self-inflicted constraints closed on each other:

1. **The regression — `3f3554c51` (RUSH-1822, 2026-08-07).** Before it, a usage read
   fell through to Claude Code's **interactive OAuth login** (keychain /
   `.credentials.json`) when no setup-token was provisioned — that fallback is what
   populated the bars for every signed-in account. The commit made the
   `accessTokenCache` branch of `loadClaudeOauth` **`return null`** instead — for
   **every** caller (`cli/src/lib/accounting/usage.ts:1994-2013`).
   - The stated problem was real: the daemon's **~60s usage warm** and **~3min
     auth-health probe** fired the interactive token programmatically from a
     background loop, which Anthropic flags and revokes (fleet-wide logout).
   - **But it over-applied.** It also silenced the **foreground, human-invoked**
     `agents view` on a personal machine — a completely different risk profile from
     an unattended 60s loop. `getClaudeUsageInfo` is hardwired to
     `accessTokenCache: true` for *all* callers (`usage.ts:1209-1212`).

2. **The scope wall — RUSH-2392.** The sanctioned replacement credential,
   `claude setup-token`, is `user:inference` scoped; the usage endpoint requires
   `user:profile` → **403** (`usage.ts:1257-1270`, `isClaudeUsageScopeDenied` at
   `usage.ts:150-157`). So "just seed a setup-token" — the previous session's remedy —
   *structurally cannot* light a usage bar.

**Why S dies but W survives.** Both windows come from the same event-fed cache
(`~/.agents/.cache/claude-usage.json`); the difference is lifetime.
`isCachedUsageWindowFresh()` (`usage.ts:2483`) expires a window `windowMinutes` after
capture — **session = 300 min (5h)**, **week = 10080 min (7d)**. An account idle >5h
drops its cached session window and keeps its week window. Refreshing S needs a live
read, and the live read is setup-token-only → dead. So idle S never comes back.

**Why `muqsit@getrush.ai` shows nothing at all.** Under the event-fed design, a login
provisions **nothing** for usage — a snapshot exists only after a recent completed
Claude Code inference response (native `rate_limits` statusline ingest, RUSH-3194) or
a live read. That account has no recent inference and no readable usage credential, so
its cache key never existed → the bare `usage unavailable` bucket. This is the same
regression at its extreme, not a separate bug.

## What changes — the delta

Give the **usage read** the same role gate the **exec** path already has (EXEC-2a,
`cli/docs/specifications.md`): on a `personal` device a foreground `agents view` reads
the interactive OAuth login (the only credential carrying `user:profile`); every
unattended background caller (daemon usage warm, auth-health probe, watchdog) stays
**setup-token-only**, exactly as RUSH-1822 made it.

Concretely:

1. **`usage.ts` — thread an explicit `allowInteractiveLogin` capability into the read.**
   - Add `allowInteractiveLogin?: boolean` to `UsageOptions` (`usage.ts:387`) and
     `UsageLookupOptions` (`usage.ts:409`).
   - `getClaudeUsageInfo` (`usage.ts:1202`) forwards it into `loadClaudeOauth`
     (`usage.ts:1209`).
   - `loadClaudeOauth` (`usage.ts:1984`): when `accessTokenCache === true` **and**
     `allowInteractiveLogin === true`, after the setup-token lookup returns null,
     **fall through to the existing keychain / `.credentials.json` read** below
     (`usage.ts:2023-2044`) instead of `return null`. When the flag is falsy,
     behaviour is byte-identical to today — the RUSH-1822 guarantee is untouched for
     every background caller.
   - Keep `claudeUsageAccessTokenNoRefresh` (`usage.ts:1230`): never refresh a token
     just to read usage. The interactive access token is read as-is; if expired,
     report `expired-credential` as today.

2. **Gate the capability at the `agents view` call site only**
   (`cli/src/commands/view.ts`), and gate on **foreground human TTY**, not device role
   alone:
   ```ts
   const allowInteractiveLogin =
     selfConfiguredDeviceRole() === 'personal'  // EXEC-2a's helper
     && !options.json                           // not a machine reader
     && process.stdout.isTTY;                   // a human is watching
   ```
   Pass it at the three call sites (`view.ts:545`, `view.ts:1116`, `view.ts:1453`).
   The TTY/`--json` clause matters: a scripted `agents view --json --refresh` on a
   personal box must **not** silently acquire the interactive credential — role alone
   would let it. Every other caller (`usage-refresh.ts`, `auth-health.ts`, watchdog,
   `collectRunCandidates`) leaves it unset → **default-closed**. A new caller that
   forgets the flag simply gets today's setup-token-only behaviour — fail-safe.
   *(Reconciled from the blind verifier — see Verification.)*

3. **Exercise the network on `--refresh`.** `agents view --refresh` already maps to
   `forceRefresh` (`view.ts:1816`, `1944`), and `getUsageInfoForIdentity` only hits
   the live fetch on `forceRefresh` (`usage.ts:647-686`). The `personal` +
   `forceRefresh` path is the one that must reach the interactive read. Confirm plain
   `agents view` (cache serve) is unchanged — it renders whatever the cache holds — so
   the live read is opt-in via `--refresh`, not on every foreground print.

4. **Test the real read path.** The renderer test at `usage.test.ts:806`
   ("renders a red missing session slot") is a **renderer unit** given only a week
   window — leave it. The test that actually **blesses the bug** is
   `usage.test.ts:681` — *"reports unprovisioned even when an interactive login is
   present — the probe never reads it"* — which asserts the login stays unread for
   **all** callers. **Split it:**
   - `usage.test.ts:157` (RUSH-1822: no setup-token → `null`, never reads login) —
     keep, now scoped to **background** mode.
   - `usage.test.ts:681` — background mode still expects `unavailable`; add an
     **interactive-personal** case where the present interactive login **is** read and
     returns live windows (injected keychain backend, `isKeychainBackendOverridden` —
     real path, no mocked fetch).
   - Add a **worker/undefined-role rejection**: even a foreground request cannot read
     the login off a non-personal device.
   - Add an **expired-OAuth** case: a usage read returns `expired-credential` and never
     refreshes.
   - `usage.test.ts:433` (cache freshness, week survives / session expires) — keep as a
     cache-correctness test; just stop treating week-only as the final personal-view
     outcome.
   *(The `:681`/`:157`/`:433` split is the blind verifier's find — see Verification.)*

5. **Cache pollution.** `claude:org=sess-vs-cred` is written into the developer's
   **real** `~/.agents/.cache/claude-usage.json` by `usage.test.ts:1724` — the exact
   hazard `setUsageBackoffDirForTest` (`usage-backoff.ts:60-70`) documents. Point that
   test at a temp cache dir. Independent, folds into the same PR.

6. **Docs + CHANGELOG.** Correct `cli/docs/secrets.md:35-46` (the "no credential
   populates a live Claude usage bar / a state nothing changes" claim is no longer true
   on a personal device) and the usage-credential note near EXEC-2a in
   `specifications.md`. Add a CHANGELOG entry (user-visible behaviour change).

## Impact — what this touches

- `cli/src/lib/accounting/usage.ts` — new opt, one gated fall-through branch.
- `cli/src/commands/view.ts` — set the flag from device role at 3 call sites.
- `cli/src/lib/accounting/usage.test.ts` — new read-path test + temp-dir the polluting test.
- `cli/docs/secrets.md`, `cli/docs/specifications.md`, `CHANGELOG` — docs in lockstep.

**Explicitly NOT touched:** the daemon usage warm, the auth-health probe, and the
watchdog rotate all keep the setup-token-only guarantee — that RUSH-1822 fix was
correct *for those callers*, and the fleet-logout revocation came from unattended
programmatic loops, which this change does not go near.

## Verification — the swarm planned it blind

One independent verifier (**codex-planner**, on codex — a different provider than mine)
was given only the problem, the key files, and the system mechanics, and asked to
produce its own plan with no sight of mine. A second (droid) stalled at 0 tools and was
stood down; opencode failed at launch. One clean independent plan is sufficient here.

**Where we agreed (high confidence — independently reproduced):**
- Same culprit commit `3f3554c51` (RUSH-1822) and the same over-broad application to
  foreground `agents view` (`usage.ts:1202`, `usage.ts:1984`).
- Same S-vs-W mechanism: `windowMinutes` 300 vs 10080 via `isCachedUsageWindowFresh`
  (`usage.ts:2483`), fed by `claude-statusline.ts:67`.
- Same scope wall (RUSH-2392, `usage.ts:91`/`:1253`) — setup-token `user:inference` vs
  required `user:profile` → the "seed a setup-token" remedy structurally can't work.
- Same fix shape: a role gate on the *read*, mirroring EXEC-2a, with every background
  caller (daemon `usage-refresh.ts`, `auth-health.ts`, watchdog) pinned setup-token-only.
- Same 2.1.220 explanation: no native sample + setup-token 403 → row drops
  (`usage.ts:2323`).

**Where it sharpened the plan (folded in above — the real decisions):**
1. **Gate on foreground TTY + non-`--json`, not device role alone.** A scripted
   `agents view --json --refresh` on a personal box should not silently acquire the
   interactive credential. Added `!options.json && process.stdout.isTTY` to the gate.
2. **The blessing test is `:681`, not `:806`.** I had flagged the renderer unit; codex
   found the deeper `:681` ("the probe never reads it") that asserts the login stays
   unread for all callers. Verified by reading both — `:806` is genuinely just a
   renderer test. Plan now splits `:681` and keeps `:157`/`:433`/`:806`.
3. **Two extra test contracts:** worker/undefined-role rejection of a foreground read,
   and an expired-OAuth case that reports `expired-credential` without refreshing.
4. **Name the option a mode, not a boolean.** codex proposed
   `credentialMode: 'background' | 'interactive-personal'` over a bare
   `allowInteractiveLogin`. Kept the boolean in the delta for the smallest diff, but
   the mode framing is noted as the cleaner long-term shape if a third mode ever appears.

No divergence on scope or safety — the two plans are the same plan, and the verifier's
deltas only tightened the gate and the tests.

## Design & mock-ups

`agents view` is a text surface (no GUI), so the mock-ups are the rendered terminal
table — current (regressed) vs proposed (restored), plus the personal/worker credential
flow. They live in the HTML review artifact under
`.agents/artifacts/2026-08-27/` with `data-state="current|proposed"` markup and are
summarized here:

- **Current:** four idle accounts render `S: █████ unavailable`; `muqsit@getrush.ai`
  renders a bare `usage unavailable`.
- **Proposed:** `agents view claude --refresh` on zion reads each account's interactive
  login and renders a live `S: …%` + `W: …%` for every signed-in account.
- **Worker (unchanged):** `agents view claude --device mark-1` still resolves from the
  setup-token/cache path only; no interactive read happens in any background loop.
