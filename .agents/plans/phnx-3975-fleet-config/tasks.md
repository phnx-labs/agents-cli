# PHNX-3975 execution checklist

Tracking: https://linear.app/getrush/issue/PHNX-3975

- [x] Trace latest account, configuration, session and launch ownership.
- [x] Obtain and reconcile a blind Claude plan on yosemite-m3.
- [x] Render and inspect the proposal and interactive explanation; delivery recorded on the linked PR.

Implementation remains proposed:

1. [ ] Inventory writers in `cli/src/lib/state.ts`, `device-config.ts`, `fleet-shared-state.ts`, `session/mirror.ts`, `daemon/account-state-daemon-service.ts`, `accounting/usage-sync.ts` and service-registration writers. Enumerate generated fields, native-home owners and minimum writer protocol; record migration conflict rules. This phase owns the storage field map used by later phases.
2. [ ] Add `cli/src/lib/accounts/db.ts` and adjacent tests; extend `account-registry.ts`, `account-catalog.ts`, `accounts/connect.ts`, `state.ts`. Import UUIDs, aliases, explicit selections and local homes without changing credentials. Use existing SQLite wrapper, transaction/busy handling; preserve source backup and schema version. Only this phase owns the account-store interface.
3. [ ] Add `cli/src/lib/config/store.ts`, adjacent tests and testdata; route config edits through versioned drafts and applied snapshots. Extend `config-keys.ts`, `config-machine-keys.ts` with explicit desired/local/observed ownership; inventory existing device/project overrides.
4. [ ] Add `cli/src/lib/config/sync.ts`; extract reusable authenticated object transport from `session/sync/net-client.ts`, `backend.ts` and `r2.ts` without changing transcript behavior. Extend canonical worker implementation and its tests with enforced conditional head update and device report authorization. Prove managed/BYO concurrency and actual deployment before enabling fleet rollout.
5. [ ] Add `cli/src/lib/config/apply.ts`; extend native sync adapters, `sync-umbrella.ts` and `commands/config.ts`. Implement pure preview, frozen target revision, managed-field projection, apply journal/recovery and read-back. Resolve exact model support via `models.ts`/`model-tiers.ts`; keep entitlement unverified unless checked.
6. [ ] Extend `run-defaults.ts`, `commands/exec.ts`, `lib/exec.ts`, shim generation and new-home/upgrade paths. All managed launches consume applied settings; explicit/project overrides remain visible. Capture effective revision/model in existing session launch metadata. Verify direct native shims and account-selected runs on actual installed binaries.
7. [ ] Move operational writers identified in step 1 to local stores and typed device reports. Extend `fleet-shared-repo-sync.ts`, `fleet-shared-state.ts`, `session/mirror.ts`, daemon consumers and repository ignore/migration handling. Update session-tracker if it owns any migrated writer. Prove normal agent activity leaves the tracked tree unchanged; no legacy dual-writing after cutover.
8. [ ] Add real multi-device tests adjacent to `config/sync.ts` and `config/apply.ts`; check offline queued apply, same-key edit conflict, invalid report owner, interrupted apply, external drift, unsupported release, multiple account homes and binary upgrade. Use actual worker storage services, not mocks.
9. [ ] Update `cli/docs/resource-sync.md`, `cli/docs/credential-management.md`, CLI help and changelog. Land with independent review; release using repo instructions; canary install on two workers, then explicitly apply fleet revision and demonstrate exact target coverage. Do not close ticket before installed end-to-end proof.

Each implementation phase runs in an isolated worktree and lands through reviewed PRs. No primary checkout edits or credential/home directory cleanup.

Review acceptance additions for steps 5, 6 and 8: persist recovery-required launch gating across restarts; test crash after one native write and verify restoration/completion before launch. Pin default-account/binding policy to the applied revision; test A → B download-only remains A, apply becomes B. Downloading resource commits must not change active resource projections.
