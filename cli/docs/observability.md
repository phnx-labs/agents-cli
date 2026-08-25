# Observability

Observability is a set of projections over owned stores, not a second source of truth.

- Events are the unified operational and activity timeline.
- Sessions are conversations and live process identity.
- Feed is the operator attention ledger plus deliberate progress posts.
- Performance is a disposable latency warehouse.
- Insights derive behavioral and usage aggregates.
- Cost/output join token burn to durable delivery evidence.
- Doctor compares declared, installed, authenticated, and synchronized state.

Every event is stamped with machine, transport, caller, session, and resolved actor when
known. Provenance travels across child processes and SSH so a remote execution is not
misattributed to the shared machine account.

Attention is an explicit lifecycle. Resolution tombstones are recorded before an open
block clears, preventing stale session reads from resurrecting answered asks. The CLI
publishes one versioned stream; thin clients replace state on reset and apply monotonic
increments.

## Account and usage projections

Authentication health and quota are separate signals with separate freshness. Provider
collectors normalize quota into stable window slots; unavailable evidence renders as
unavailable rather than as zero usage.

Claude quota is event-fed rather than polled. Claude Code sends native five-hour and
seven-day rate-limit fields to the managed status-line command after an inference
response. Ingestion merges whichever windows arrived into the previous per-account
snapshot, so one omitted window does not erase the other. No interactive OAuth or
Keychain credential is copied or read to populate usage.

Grok quota is also event-fed: Grok writes its current weekly billing meter to the
version home's `unified.jsonl`, and the daemon or an explicit `view --refresh` publishes
that derived snapshot. Agents-cli never invokes an upstream Grok usage API. When the
latest billing period has expired, the row names the exact `grok@version` to run once so
Grok can emit a current event.

Managed Cursor versions select Cursor's file credential store under their isolated
`XDG_CONFIG_HOME`. Cursor's machine-global macOS Keychain login is not imported or
deleted; a managed version without `auth.json` is signed out until Cursor's native login
flow authenticates that version. Usage uses the same version-local access token as the
run, so account identity and quota cannot silently refer to different logins.

Identity and plan come from version-home state. The human-facing account row exposes one
last-active timestamp; probe age remains machine-readable health metadata rather than a
second activity timestamp.

Health findings use one severity registry and one remediation vocabulary. A finding must
name a command that fixes the full scope represented by its row. Unavailable evidence is
reported as unknown or degraded, never healthy by default.

**Severity rubric** — `FINDING_SEVERITY` in `src/lib/devices/doctor-findings.ts` is the
single source of truth; this prose copy is pinned to it by a test, so the two cannot
drift.

**CRITICAL** — needs you now: `logged-out`, `missing-hook`, `missing-plugin`,
`unwired-hook`, `hook-runtime-broken`, `cli-missing`, `owner-sink-unreachable`,
`ssh-key-enrollment`.

**WARNING** — worth fixing, not urgent: `logout-unprovable`,
`hook-runtime-visibility-unavailable`, `missing-resource`, `content-drift`,
`never-synced`, `stale`, `repo-behind`, `repo-drift`, `fleet-resource-gap`,
`version-skew`, `orphan`, `duplicate-hook`, `duplicate-hook-drift`, `host-cli-missing`,
`host-cli-invalid`, `rc-secret-export`, `env-secret-export`, `exec-policy`, `stale-cli`,
`binary-shadow`.

The split is provability and blast radius: a critical is something the operator can act
on right now with a known fix, while a warning is drift that one sweep resolves.
