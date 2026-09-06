# PHNX-3940 implementation checklist

Planning deliverable, not a claim these changes exist. The native TaskCreate tool is unavailable in this session; this ticket-bound checklist is the durable substitute. Only planning milestones are marked complete.

## Planning delivery

- [x] Fetch main, re-read canonical execution/storage/auth paths and official vendor constraints.
- [x] Keep the existing PHNX-3940 as owner; move it from Done to Plan.
- [x] Draft proposal, delta contract and all affected CLI states.
- [x] Reconcile independent blind fleet plan; record adopted/rejected findings in verification.md.
- [x] Render and inspect desktop/mobile, light/dark; open and verify the revised document in Arc on the interactive machine.
- [ ] Land a reviewed plan-only PR with evidence and link it from PHNX-3940. Do not mark the broader ticket Done.

## Implementation sequence

### T0 — establish health evidence and the exact recovery target

- [ ] Owner: `cli/src/lib/daemon/harness-update-service.ts`, `daemon/service.ts`, `daemon/supervisor.ts`, `daemon-health.ts`, `commands/daemon.ts`, `cli-entry.ts`, `self-update.ts`, `hosts/remote-cmd.ts`; nearby tests. First read the current daemon process, executable identity, registered service, last pass, child exit/outcome and supervisor entrypoint. Preserve the evidence before recovery. Fix only the evidenced cause; do not assume stale heartbeat proves the updater stopped.
- [ ] Add a durable updater result with started/finished/last-success times, executing CLI build, checked target, outcomes and redacted error. A failed/cancelled child cannot become a successful service pass. Restore the canonical supervisor only with authority for a restart, and prove an automatic pass on the affected worker.

### T1 — canonical account/home/release launch selection

- [ ] Owner: `cli/src/lib/types.ts`, `account-registry.ts`, `account-catalog.ts`, `installations/types.ts`, `installations/store.ts`, `cli/src/lib/exec.ts`, `cli/src/commands/exec.ts`; extend an existing resolver or add `installations/launch-selection.ts` as the single join. Reuse `version` / `configVersion` at adapter boundaries; do not create another executor. Shortened library paths are under `cli/src/lib/`.
- [ ] Resolve `{accountId, homeId, homePath, releaseKey, executablePath, credentialKind, credentialRevision, selectionReason}` once. Remote requests send account identity and release policy, never the sender's absolute home. The target resolves and validates its own home and release. Persist non-secret account/home/release provenance for resume.

### T2 — one immutable release store and transactional updater

- [ ] Prove cross-version native-home compatibility before concurrent new-release launches against a busy home. Where unknown or incompatible, retain/defer that home's selection until idle; do not migrate vendor data or invalidate an existing process. Replace substring activity checks with process/path-boundary attribution, exclude the scanner, and remain fail-closed when ownership is uncertain.

- [ ] Owner: `cli/src/lib/installations/{store,types,strategies,update,update-runtime,update-policy,installation-lock,launch-gate,active-check,shims}.ts`, `daemon/harness-update-service.ts`; nearby tests. Reuse installer staging/probes, file locks, cancellation and launch leases. Add a release-store leaf only if these modules cannot express the immutable record cleanly.
- [ ] Download once per harness/platform/architecture/release; validate the actual entrypoint; atomically publish and advance current under one harness lock. Acquire launch leases before releasing the selection lock. Do not overwrite any published package. New sessions use current immediately; existing processes retain their resolved release and home. Never let vendor auto-updaters mutate manager-owned releases.
- [ ] Preserve `updates.auto` and `updates.<harness>.auto`; global off remains a hard stop. Use the existing 15-minute scheduler with a persisted next-check time, not a new timer. Report unsupported/vendor-managed update strategies explicitly.

### T3 — resumable, metadata-only legacy migration

- [ ] Owner: `cli/src/lib/installations/migrate.ts`, `store.ts`, `account-registry.ts`, `account-catalog.ts`, `accounts/connect.ts`, `codex-home.ts`, `state.ts`; nearby tests and `testdata/`. Register one idempotent migration in the canonical migrator, not consumer fallback probes.
- [ ] Journal discovery → validated inventory → published bindings → completed under a lock with a revision/compare-and-swap check. Snapshot metadata only; never make plaintext secret backups. Adopt existing real home paths; preserve short Codex paths and Claude keychain scope. Do not move, copy, merge or remove native homes.
- [ ] Preserve explicit binding/default first, then choose a sole unambiguous matching local identity. Duplicate identities with different home contents remain separately addressable. If selection is ambiguous, retain existing behavior and show a choice; never choose by numerically newest directory. Unknown/unassigned homes remain preserved and unselected.
- [ ] Import historical `@label` and project/routine/default references as typed aliases with the recorded account/home and update policy. Never reinterpret an existing historical label as a fresh exact-release pin. Gate the new writer with a machine-local schema marker that old launch/update paths reject; stage all relevant CLI entrypoints before activating it.

### T4 — one role-aware credential decision and revisioned delivery

- [ ] Validate effective vendor auth inputs as well as merged env: user/project/managed settings, credential helpers/profiles, provider selectors and launch overrides. Preserve native config and reject conflicting/unknown precedence; do not run arbitrary helpers just to inspect their secrets. Prove a vendor-supported enforcement boundary against config read-after-check races. Add real settings-origin-token and helper/profile regression cases; environment-only tests are insufficient.

- [ ] Owner: `cli/src/lib/account-schema.ts`, `account-provider-registry.ts`, `account-registry.ts`, `accounts/connect.ts`, `auth-mint.ts`, `claude-account-token.ts`, `harness/adapters/{claude,codex}.ts`, `cli/src/lib/exec.ts`, `secrets/{reserved-sync,push,bundles}.ts`, `fleet-shared-state.ts`, `daemon/auth-sync-service.ts`; nearby tests. One stable account owns credential variants; do not create a second provider account with a conflicting name.
- [ ] Reconnect the selected local account home; confirm provider identity. Mint Claude's supported token against that selected identity, save through `agents secrets`, and never print raw values. Add Codex workspace access tokens only with a real capability/entitlement check and their supported non-interactive surface; do not assume a Team display label proves eligibility.
- [ ] Deliver a credential-specific revision from its designated authority to explicitly enrolled, host-key-pinned workers using existing encrypted storage and SSH stdin transport. Reject older revisions; acknowledge only after durable import/read-back and local binding. Same revision retries are idempotent; missing/expired/wrong-identity/revoked remain distinct. Tombstones prevent stale publishers resurrecting revoked credentials; no whole-bundle last-writer-wins replacement.
- [ ] Enforce final credential policy after profiles, account selection, secrets and user env have merged. Personal/desktop native account runs cannot inject or inherit automation-token/API-key overrides; conflicting explicit overrides fail clearly. Worker support is provider-and-surface based. Codex Pro or Codex worker TUI uses its own device login, authorized from the user's browser; no fleet clone of rotating native auth.

### T5 — connect every consumer and render honest UI

- [ ] Owner: `cli/src/commands/{view,accounts,update,config,routines}.ts`, `cli/src/lib/account-catalog.ts`, `config-keys.ts`, `device-config.ts`, `hosts/{dispatch,remote-cmd,ready}.ts`, `teams/agents.ts`, `daemon/runner.ts`, `scheduling/routines.ts`, `session/recovery.ts`, `installations/{shims,resolve}.ts`, config/resource projection call sites discovered by the T1 reference audit. Except explicitly qualified commands, shortened paths are under `cli/src/lib/`. Reuse the canonical selection and state DTO, never duplicate decisions in renderers.
- [ ] Ship the documented normal, pending, paused, unhealthy, missing-login, empty-account, migration-conflict, mixed-CLI and cleanup-preview states. `--versions` separates shared release status from home/legacy aliases; `--json` has additive explicit fields and schema version. Read-only display never performs migration, token refresh or updates. Provide an explicit dated authentication check. Legacy update selectors remain label-first; a release-only fallback must be unique, after auditing callers of the existing multi-match behavior.

### T6 — safe retention, release and installed proof

- [ ] Owner: `cli/src/lib/installations/{store,versions,launch-gate,active-check}.ts`, `cli/src/lib/uninstall.ts`, `cli/src/commands/{uninstall,prune,sync}.ts`; add a small `installations/retention.ts` decision module if no existing owner fits. Preview exact paths, bytes and retaining references. Retain current, pinned, running and rollback releases. No account-home or global CLI deletion through release-cache cleanup.
- [ ] Existing legacy package removal is explicitly approved and lease-checked; preserve launcher aliases, session replay requirements, home paths and logs. New managed-cache GC may expire an unreferenced prior release after 14 days under a disclosed policy. Never delete merely because disk pressure rises or a credential is absent. Detect symlink escapes, unknown ownership and PID reuse; fail closed.
- [ ] Update `cli/README.md`, `cli/AGENTS.md`, `cli/docs/{concepts,execution,credential-management,specifications}.md`, `cli/CHANGELOG.md` and relevant companion `phnx-labs/.agents` guidance. Each capability claim must match implemented harness support. Audit inherited rules that incorrectly promise durable tokens for every harness.
- [ ] Run focused real-process/filesystem tests beside sources, then the canonical remote `cli/scripts/test.sh` and package attestation. Build/install via scripts to `agents-dev` only. Non-author review + green required CI → rebase merge → `cli/scripts/release.sh <version> --apply` on the exact attested artifact. Do not rebuild native helpers.
- [ ] Verify registry package and installed CLI on one interactive device and a light Linux worker, then the originally affected worker. Prove three accounts use one shared release, a running old session survives an update, no re-login follows a release change, retry migration is unchanged, updated token reaches an already-provisioned worker, native laptop auth remains native, and global-off/pins hold. Expand only after these gates; leave offline devices pending, not green.

## Completion rule

The plan PR may finish without runtime changes. Implementation is not delivered until the installed local-to-worker flow passes the above seams with redacted logs and screenshots. PHNX-3940 includes other historical work: inspect all remaining folded acceptance items before closing the whole ticket; this feature's passing gates alone do not close unrelated scope.
