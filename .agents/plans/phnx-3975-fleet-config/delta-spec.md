# Proposed fleet configuration contract

Status: proposed, PHNX-3975. The proposal is the rationale; this file defines acceptance.

1. Shared account IDs are stable UUIDs. Display names, binary releases and local installation labels are not account identity.
2. Connect/discovery writes local account-to-home records automatically. A local home mapping never causes another device to adopt its path. Explicit account-selection bindings remain optional CLI-managed rules.
3. `accounts/accounts.db` and `config/config.db` are durable local SQLite stores excluded from Git, including WAL/SHM companions. The sync protocol carries validated records, never an active database file.
4. A desired revision is immutable and content-addressed. Publication validates its base against the shared head atomically. Concurrent conflicting edits remain explicit drafts; wall-clock timestamps never silently pick a desired configuration winner.
5. Sync stores desired state locally and reports its revision. It must not modify native managed fields, the applied snapshot or active-session launch parameters.
6. An apply request identifies an immutable revision, a frozen set of devices and an ordered request ID. Reconnecting targets can fulfill that exact request; new revisions require new apply requests.
7. Apply preview performs no writes. Actual apply validates every managed target home before mutation, journals previous managed values, writes through native adapters and verifies read-back before recording completion. Partial filesystem work is recoverable and is never acknowledged as applied.
8. A device's parity record contains desired revision, applied revision, managed projection digest, applicable home set, resolved model IDs, schema/projector version and checked time. Resource hashes must match the desired manifest. A fleet result succeeds only when every targeted device meets the contract; stale reports cannot prove present parity.
9. Config parity and login readiness are distinct. A known account with no local credential is shown as unavailable, never connected merely because its metadata synced. Authentication material does not enter this new transport.
10. Unsupported exact models block apply. Inconclusive catalog evidence is shown as unverified; no silent fallback. Tier policies disclose differing resolved model IDs. Later provider denial fails the affected launch visibly.
11. Managed launch paths use the last applied local snapshot without requiring network access. New homes and upgraded binaries must project/revalidate that snapshot before managed launch. Existing sessions keep their launch revision. Intentional per-run/project overrides are reported.
12. Device reports are scoped to the authenticated owner and enrolled device, sequence-ordered and freshness-limited. Tombstones prevent removed identities/settings from reappearing when an offline device returns.
13. Migration preserves original files and credentials, detects conflicting YAML/native inputs and has one write authority after cutover. Legacy writers are gated by minimum protocol version. Generated account/session/heartbeat/service updates must not change tracked Git files.
14. Authored skills/rules/hooks remain in reviewed resource repositories. Their revision hashes can participate in fleet parity; local paths, secrets and transcripts are outside equality comparisons.
15. Account identity/availability discovery can sync immediately, but default-account and managed-binding selection must read applied policy and its pinned catalog revision. Download-only never changes the default selected identity. Explicit per-run selection remains an override.
16. Failed or interrupted apply persists a recovery-required gate across restarts. Managed launches cannot proceed until rollback restores and verifies the prior managed values, or completion verifies the requested revision. Resource activation shares this boundary; downloading resource commits alone never activates them.
