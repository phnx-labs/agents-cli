# Delta spec — usage read credential selection (the contract after this change)

The source-of-truth contract a future change diffs against. RFC-2119. Cited to
`file:line` in `cli/src/lib/accounting/usage.ts` and `cli/src/commands/view.ts`.

## USAGE-READ-1 — Credential selection is capability-gated, default-closed

A Claude usage read (`getClaudeUsageInfo` → `loadClaudeOauth` with
`accessTokenCache: true`) selects its credential by an explicit `allowInteractiveLogin`
capability threaded from the caller:

- **Given** `allowInteractiveLogin` is unset or `false`
  **When** `loadClaudeOauth` resolves a credential
  **Then** it resolves the file-based setup-token via `resolveClaudeSetupToken(home)`
  and, if none exists, **MUST** `return null` — it **MUST NOT** read the interactive
  OAuth login (keychain / `.credentials.json`). This is the RUSH-1822 guarantee and is
  the behavior for every background caller.

- **Given** `allowInteractiveLogin` is `true`
  **When** the setup-token lookup returns null
  **Then** `loadClaudeOauth` **MUST** fall through to the interactive OAuth login read
  (the keychain / `.credentials.json` path already present at `usage.ts:2023-2044`) and
  return that credential when present.

- A usage read **MUST NOT** refresh an access token
  (`claudeUsageAccessTokenNoRefresh`). An expired interactive token reports
  `expired-credential`, never a silent refresh.

## USAGE-READ-2 — Only a foreground human `agents view` on a personal device may set the flag

- **Given** the process is `agents view`
  **And** `selfConfiguredDeviceRole() === 'personal'`
  **And** output is **not** `--json`
  **And** `process.stdout.isTTY` is true (a human is watching)
  **Then** the call sites in `cli/src/commands/view.ts` (:545, :1116, :1453)
  **MUST** set `allowInteractiveLogin: true`.

- **Given** a `--json` or non-TTY `agents view` (scripted/machine reader), even on a
  personal device — **Then** `allowInteractiveLogin` **MUST** remain unset. Role alone
  is insufficient; a scripted refresh **MUST NOT** silently acquire the interactive
  credential.

- **Given** any other caller — daemon usage warm (`usage-refresh.ts`), auth-health probe
  (`auth-health.ts`), watchdog, `collectRunCandidates`, or a `worker`/`unknown`-role
  device — **Then** `allowInteractiveLogin` **MUST** remain unset (default-closed).

- This mirrors the exec-credential role gate (EXEC-2a, `specifications.md`): a
  `personal` device uses the interactive login because it is the only credential
  carrying `user:profile`; unattended loops never touch it.

## USAGE-READ-3 — Live read is opt-in via `--refresh`, cache serve is unchanged

- **Given** plain `agents view` (no `--refresh`)
  **Then** the read serves the event-fed cache
  (`~/.agents/.cache/claude-usage.json`) and **MUST NOT** perform a network read —
  behavior identical to today.

- **Given** `agents view --refresh` (or `--live`) on a `personal` device
  **Then** `forceRefresh` reaches `getUsageInfoForIdentity`'s live fetch
  (`usage.ts:647-686`), which — with `allowInteractiveLogin: true` — reads the
  interactive login and repopulates the session (5h) + week (7d) windows for every
  signed-in account.

## USAGE-READ-4 — Window freshness is unchanged

- `isCachedUsageWindowFresh()` (`usage.ts:2483`) still expires a window
  `windowMinutes` after capture: session = 300, week = 10080. This change does not
  alter freshness; it only restores the credential that lets `--refresh` recapture an
  expired session window on a personal device.

## Invariants preserved

- No background loop reads the interactive login (fleet-logout root cause untouched).
- The setup-token scope wall (RUSH-2392) is unchanged; the fix routes around it by
  using the interactive login on personal devices, not by re-scoping the setup-token.
- `view --json` credential-selection is identical for machine callers unless they run
  on a personal device as a foreground `agents view`.
