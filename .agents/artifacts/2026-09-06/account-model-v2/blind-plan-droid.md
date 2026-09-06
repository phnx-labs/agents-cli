# Proposal: one harness installation, many account slots

## 1. Current architecture

Today, an installation is both a binary release and a configuration/authentication home. Its stable label and mutable `releaseVersion` live in `installation.json`; updates replace the release while retaining the label and home (`cli/src/lib/installations/store.ts:39-52`, `cli/src/lib/installations/update.ts:261-287`). A bare first install receives a release-independent label and later bare adds reuse an existing non-isolated installation (`cli/src/commands/versions.ts:229-252`, `cli/src/commands/versions.ts:500-539`). `accounts connect` breaks that reuse rule by allocating an opaque `acct-*` installation for each account, installing another copy, launching native login there, then recording account→installation in the device document (`cli/src/lib/accounts/connect.ts:64-97`, `:207-264`, `:292-372`). Native account identity metadata is fleet-shared, but the local account→home mapping remains device-local (`cli/src/lib/types.ts:893-956`, `cli/src/lib/account-registry.ts:328-381`). Runtime can execute one installation’s binary while selecting another installation as `configVersion`, preserving the coupling between accounts and version homes (`cli/src/commands/exec.ts:2538-2604`, `cli/src/lib/exec.ts:545-594`).

```text
Current

agents add claude
        │
        ▼
Installation "claude" ── installation.json(label, releaseVersion)
        │                       │
        │                       └── binary/package
        └── home/ ── settings + resources + native OAuth + sessions

accounts connect claude work
        │
        ├── creates another Installation "acct-xxxxxxxx"
        ├── creates another home/
        ├── runs native /login in that home
        ├── central accounts.native[account-id] = identity metadata
        └── deviceAccounts.homes[account-id] = "acct-xxxxxxxx"

agents run claude#work
        ├── resolves account/default/binding
        ├── resolves "acct-xxxxxxxx" as configVersion
        └── runs selected binary with that version home's config environment

Fleet:
  central agents.yaml ── account rows/defaults/bindings ── Git sync
  device document     ── local account→home/pending slot ── not shared
  secrets bundle      ── durable worker token ── SSH transfer
  native OAuth        ── never transferred
```

The current account selection order is explicit account, exact target binding, harness binding, then harness default (`cli/src/lib/account-registry.ts:582-648`, `cli/src/commands/exec.ts:2547-2563`). Native account selection is restricted to harnesses whose config can be redirected independently (`cli/src/commands/exec.ts:2571-2580`, `cli/src/lib/installations/shims.ts:55-76`).

## 2. Target data model

### Proposed records

```ts
HarnessInstallation {
  harness: AgentId;
  releaseVersion: string;
  installationRoot: string;  // one binary/package per harness
}

Account {
  id: string;                // stable fleet identity
  harness: AgentId;
  name: string;
  identityKey: string;
  identityLabel?: string;
  workerCredentialRef?: string; // bundle reference, never secret value
  provisioning: 'portable' | 'per-device';
}

DeviceAccountSlot {
  accountId: string;
  configRoot: string;        // credential/config slot, not an installation
  authMode: 'native-oauth' | 'durable-worker' | 'per-device';
  health: 'ready' | 'missing' | 'expired' | 'revoked' | 'unknown';
  checkedAt?: string;
}
```

There is exactly one active `HarnessInstallation` per harness. Updating it changes only its `releaseVersion`. An account slot contains no binary and cannot be addressed by `agents update`, `use`, or `view --versions`.

Central `Account` rows remain fleet-shared. `DeviceAccountSlot` remains device-scoped because headed OAuth is local and token-less harnesses require distinct per-box login.

### Runtime selection

`agents run claude#work` selects an account. `agents run claude` uses the project/harness binding and then the harness default. `--account` remains a compatibility selector, but help should teach `#label`.

The executable always comes from the single harness installation. The selected account supplies only the account config root or worker environment. This removes the current binary/config cross-product represented by `version` plus `configVersion` (`cli/src/lib/exec.ts:545-594`).

### Coexistence mechanisms

Use a registry-driven `accountSlot` capability rather than per-command harness branches:

| Harness | Proposed account isolation | Existing mechanism |
|---|---|---|
| Claude | Set `CLAUDE_CONFIG_DIR` to the selected account slot | `cli/src/lib/harness/adapters/claude.ts:96-105` |
| Codex | Set `CODEX_HOME` to the selected account slot | `cli/src/lib/harness/adapters/codex.ts:13-20` |
| Cursor | Swap `HOME`; force file credential store | `cli/src/lib/harness/adapters/cursor.ts:6-20` |
| Grok | Set `GROK_HOME` | `cli/src/lib/harness/adapters/grok.ts:8-18` |
| Kimi | Set `KIMI_CODE_HOME`; authentication remains per-box | `cli/src/lib/harness/adapters/kimi.ts:6-19` |
| OpenCode | Set `OPENCODE_CONFIG_DIR` | `cli/src/lib/installations/shims.ts:89-96` |
| Muse | Set XDG config/data roots | `cli/src/lib/harness/adapters/muse.ts:6-27` |
| Copilot | Set `COPILOT_HOME` | `cli/src/lib/harness/adapters/copilot.ts:6-22` |

Account-independent settings and installed resources should live under the harness installation and be projected into each slot using the existing settings/resource manifests. Credential-bearing files must remain slot-local.

Only Claude and Codex currently have a complete native connection flow (`cli/src/lib/account-capabilities.ts:22-51`, `cli/src/lib/accounts/connect.ts:185-199`). Other harnesses stay explicitly unsupported by `accounts add` until they have all four capabilities: native login, identity inspection, account-slot redirection, and a role-correct worker credential path.

Kimi and Antigravity use local per-device slots only. Their credentials must never become portable merely because account-slot redirection exists.

## 3. Command surface after the change

### Accounts commands

| Current command | Decision |
|---|---|
| `accounts list` (`cli/src/commands/accounts.ts:570-574`) | **Keep.** Show account, harness, default, local/fleet health, and worker readiness. |
| `accounts add <name> --provider...` (`:602-650`) | **Replace** with `accounts add <harness> [name]`. Fold provider credential capture into onboarding. |
| `accounts connect <harness> [name]` (`:578-600`) | **Hide** as a compatibility alias to `add`, with a deprecation warning. Remove after migration support ends. |
| `accounts mint claude` (`:576`, registration in `cli/src/lib/auth-mint.ts:480-506`) | **Fold** into Claude onboarding and `accounts rotate`. |
| `accounts name` / `label` (`cli/src/commands/accounts.ts:669-710`) | **Hide.** Naming occurs during add; rename remains available. |
| `accounts view` / `inspect` (`:653-667`) | **Keep.** Add slot and fleet credential health. |
| `accounts attach` / `detach` (`:712-787`) | **Remove from public help.** Migrate harness/profile bindings to account defaults or profile configuration. |
| `accounts logout` (`:789-815`) | **Keep.** It clears only this device’s slot and does not delete the fleet account. |
| `accounts rename` (`:817-845`) | **Keep.** |
| `accounts remove` (`:847-868`) | **Keep.** Require an explicit second step before deleting durable worker bundles. |
| `accounts default` (`:870-897`) | **Keep.** |
| `accounts profiles` (`:899-945`) | **Keep.** Profiles remain provider-routing configuration. |
| `accounts verify` (`:947-981`) | **Keep and strengthen.** Validate authentication, not only secret presence. |
| `accounts sync` (`:983-1020`) | **Keep as manual repair.** Normal provisioning becomes automatic. |
| New `accounts rotate <account>` | Rotate/re-enter the durable worker credential without changing the headed OAuth account. |

### Installation commands

- Keep `agents add claude@latest`, but allow only one managed installation per harness. Current registration and account-first reuse logic are in `cli/src/commands/versions.ts:445-539`.
- Hide `--isolated`, explicit duplicate labels, and help suggesting that versions are account identities (`cli/src/commands/versions.ts:447-470`, `:774-797`).
- Remove `agents view <harness> --versions` from public help and replace its account connection hint with `agents accounts add <harness>` (`cli/src/commands/view.ts:87-99`, `:894-901`).
- Make `agents update <harness>` update the single installation. Hide `<harness>@<label>` selection (`cli/src/commands/update.ts:32-51`, `:180-202`).
- Retain exact releases internally for session restoration and rollback, but do not present cached releases as account-bearing installations.

### `agents accounts add <harness>` on a headed device

1. Require `personal` or `desktop`; headed role detection already treats both roles identically (`cli/src/lib/device-config.ts:849-875`).
2. Ensure the one harness installation exists, installing it once if absent.
3. Allocate a device-local account slot, not an installation.
4. Launch the harness’s native interactive login inside that slot:
   - Claude: `claude /login`.
   - Codex: `codex login`.
   These are the current connection commands (`cli/src/lib/accounts/connect.ts:185-199`).
5. Inspect the resulting identity and reject duplicate or conflicting identities before registration. Current connection already performs post-login identity validation (`cli/src/lib/accounts/connect.ts:292-372`).
6. Register one fleet account row and one local slot mapping.
7. Acquire the worker credential separately:
   - Claude: run `claude setup-token`, store it in an account-named secret bundle, and never use it on the headed device. Current minting already runs setup-token, stores named/reserved bundles, and can push them (`cli/src/lib/auth-mint.ts:289-385`, `:406-466`).
   - Codex/Grok/OpenCode/Gemini-style providers: prompt for or import the provider API key. Do not attempt to derive an API key from native OAuth.
   - Kimi/Antigravity: mark `per-device`; do not request a portable token.
8. Trigger account metadata sync and daemon worker-bundle reconciliation.
9. Print the run selector and fleet provisioning result.

### On a worker

`accounts add` must not create a new fleet identity or open native OAuth. It should fail with: “Add this account on a personal/desktop device.” Existing fleet accounts should appear automatically through metadata sync, and the daemon should materialize their worker slots from durable bundles.

## 4. Sync design

### Metadata

Continue syncing account IDs, names, harnesses, identities, defaults, and credential references through central `agents.yaml`. `accounts` is classified as central state, while `deviceAccounts` is device state (`cli/src/lib/state.ts:1055-1077`, `:1140-1152`). The shared-repo publisher already stages central `agents.yaml` so account labels are not lost (`cli/src/lib/fleet-shared-repo-sync.ts:314-340`).

Do not sync local slot paths or pending onboarding state. Their current equivalents are deliberately device-scoped (`cli/src/lib/types.ts:919-956`).

### Secret transport

Generalize reserved-auth synchronization into account-bundle reconciliation:

```text
headed custodian
  ├── pushes central account metadata through shared-repo sync
  └── daemon evaluates worker readiness
          └── hardened SSH bundle transfer
                    └── worker secret store
                          └── selected account injected at spawn
```

The daemon currently publishes readiness, syncs fleet-shared state, and provisions the reserved bundle (`cli/src/lib/daemon/auth-sync-service.ts:24-43`). Reserved synchronization transfers secrets over SSH only to eligible missing peers; values never enter Git (`cli/src/lib/secrets/reserved-sync.ts:1-9`, `:280-319`).

Extend that protocol from one reserved `auth` bundle to every account’s `workerCredentialRef`. Preserve the existing `auth` bundle temporarily as the default-Claude compatibility alias, then migrate to named account bundles.

Per harness, workers receive:

- Claude: account-specific setup token, injected as `CLAUDE_CODE_OAUTH_TOKEN`.
- Codex: account-specific API key, injected as `OPENAI_API_KEY`.
- Grok: account-specific API key, injected as `XAI_API_KEY`.
- Gemini: account-specific API key, injected as `GEMINI_API_KEY`.
- Other providers: only registry-declared durable environment values.
- Kimi/Antigravity: metadata only; authentication happens on each worker.

The current provider registry maps Anthropic, OpenAI, Google, and xAI credentials to environment variables (`cli/src/lib/account-provider-registry.ts:44-83`). Current provider bundles use secret propagation policy `never` and therefore require explicit sync (`cli/src/commands/accounts.ts:631-649`, `:983-1020`); account-owned worker bundles need a distinct daemon-managed policy.

Never transfer files enumerated as native OAuth/session credentials. The existing fleet-auth gate returns false for every native credential because they rotate, can be keychain-bound, or can invalidate other holders (`cli/src/lib/fleet/auth-sync.ts:1-9`, `:26-66`).

### Role enforcement

At spawn:

- Headed device: select the account slot and use only its native login. Ignore any synced worker bundle.
- Worker: inject only the selected durable credential.
- Unmarked devices remain worker-equivalent under the current role predicate (`cli/src/lib/device-config.ts:849-875`).
- Claude already implements the key distinction: headed devices defer to native OAuth while workers read the setup token (`cli/src/lib/harness/adapters/claude.ts:65-93`).

### Expiry and revocation

Add daemon-owned health checks and persist only verdicts:

- `missing`: bundle absent or local native credential absent.
- `expired` / `revoked`: provider explicitly rejects authentication.
- `ready`: a provider-authenticated probe succeeds.
- `unknown`: no safe validation endpoint exists.
- Include `checkedAt`, source device, and non-sensitive error category.

`accounts list`, `accounts view`, `accounts verify`, `agents view`, and `agents doctor` should expose these verdicts. Do not infer “ready” from file existence alone; current credential inspection distinguishes file presence but does not prove validity (`cli/src/lib/agent-spec/agents.ts:2656-2704`).

The daemon must remain the only periodic validator and provisioner. CLI commands may request an immediate reconciliation but must not add another scheduler.

## 5. Migration

1. **Inventory without mutation.** Enumerate installation records, account rows, local home mappings, defaults, bindings, sessions, signed-in identities, and empty homes. Emit a dry-run report.
2. **Choose one installation per harness.** Prefer the current global default if healthy; otherwise the newest healthy managed release. Do not choose a logged-out account home merely because it is default.
3. **Create account slots.** Reuse each stable account ID. Initially point the slot at the existing account config root so migration does not copy or rewrite OAuth.
4. **Separate executable selection.** Run every slot through the chosen harness binary. Preserve the old release internally for session compatibility until validation completes.
5. **Migrate settings/resources.** Move only manifest-classified shared files into the harness installation. Leave credentials and account-specific sessions in account slots.
6. **Migrate central state.** Convert exact installation bindings to harness/profile account bindings. Preserve account defaults independently from the installation release.
7. **Rebuild workers.** Never import worker OAuth files. Recreate worker slots from central account metadata plus durable bundles.
8. **Resolve identity joins.** Join Claude setup-token homes to central accounts by unambiguous registered identity; fail closed on duplicate or malformed identity. The supplied worker audit found email-only homes cannot currently produce the UUID-based key used by registry folding (`~/.agents/artifacts/2026-09-06/fleet-worker-account-identity/plan.md:62-93`).
9. **Quarantine duplicates and empty homes.** Do not delete immediately. Mark them legacy, stop selecting them, and retain rollback/session references through one release window. The account UX audit records duplicate/logged-out homes and default drift as observed fleet symptoms (`.agents/worktrees/accounts-ux-audit/.agents/artifacts/2026-09-06/accounts-ux-audit.md:30-46`, `:83-86`).
10. **Validate before retirement.** For each account, launch a harmless authenticated probe on its headed slot and at least one worker. Only then retire obsolete installation records and binaries.
11. **Rollback.** Keep the migration manifest mapping old installation labels to new account slots. A failed validation restores selectors and defaults without copying credentials.

Risky steps are identity matching, choosing the canonical installation, relocating harness-owned config/session files, translating defaults and bindings, and deleting old homes. Each must be atomic or reversible.

## 6. Gaps and unresolved questions

- Only Claude has automated durable-token minting. Source does not provide a way to mint OpenAI, Google, xAI, OpenCode, or Droid API keys from native OAuth (`cli/src/lib/auth-mint.ts:289-385`).
- Only Claude and Codex currently have implemented native onboarding commands (`cli/src/lib/accounts/connect.ts:185-199`).
- The portable provider registry currently covers only Anthropic, OpenAI, Google, and xAI (`cli/src/lib/account-provider-registry.ts:44-83`). Droid/OpenCode-specific worker credential contracts need verification.
- Cursor, Muse, and Copilot can redirect config roots, but code does not establish a portable worker credential or reliable identity probe for each.
- Claude setup-token authentication cannot be assumed to expose the same profile/usage identity as native OAuth; the supplied worker audit records that mismatch (`~/.agents/artifacts/2026-09-06/fleet-worker-account-identity/plan.md:62-93`).
- The safe relocation rules for harness-native session databases and absolute paths are not defined by the current installation manifests.
- The compatibility duration for `@version`, `connect`, and old installation labels is a product decision. Internal session restore may still require exact release lookup.
- Provider-specific low-cost validation endpoints and rate limits need confirmation before implementing active health probes.
- The correct custodian election when several headed devices possess the same account’s durable bundle is not defined by current reserved-bundle synchronization.

## 7. Ordered implementation tasks

1. **Add schema and migration versioning.** Edit `cli/src/lib/types.ts`, `state.ts`, `account-registry.ts`; add `cli/src/lib/accounts/migrate.ts` and tests.
2. **Enforce one managed installation per harness.** Edit `cli/src/lib/installations/store.ts`, `versions.ts`, `update.ts`, `shims.ts`, and `cli/src/commands/versions.ts`; update adjacent installation tests.
3. **Introduce account slots.** Add `cli/src/lib/accounts/slots.ts`; refactor `cli/src/lib/exec.ts`, `cli/src/commands/exec.ts`, and harness adapters so executable root and account config root are independent.
4. **Build a truthful capability registry.** Edit `cli/src/lib/account-capabilities.ts` and `account-provider-registry.ts` with native-login, identity-probe, slot, worker-auth, and validation capabilities. Add completeness tests.
5. **Replace onboarding.** Refactor `cli/src/commands/accounts.ts`, `cli/src/lib/accounts/connect.ts`, and `cli/src/lib/auth-mint.ts` so `accounts add <harness>` owns login, identity registration, durable credential capture, and sync.
6. **Add role-safe rotation.** Implement `accounts rotate` in `cli/src/commands/accounts.ts`; ensure headed OAuth and worker credential rotation remain separate.
7. **Generalize automatic bundle provisioning.** Refactor `cli/src/lib/secrets/reserved-sync.ts`, `cli/src/lib/daemon/auth-sync-service.ts`, and secret transport helpers from one reserved bundle to account-declared worker bundles.
8. **Preserve the native OAuth prohibition.** Extend tests around `cli/src/lib/fleet/auth-sync.ts` and each harness adapter. Assert that no native credential is ever serialized or injected on another device.
9. **Add health verdicts.** Edit `cli/src/lib/agent-spec/agents.ts`, accounting/usage readers, `cli/src/commands/accounts.ts`, `view.ts`, and doctor checks. Add provider-specific probes only where verified.
10. **Migrate command presentation.** Edit `cli/src/commands/view.ts`, `update.ts`, `versions.ts`, help examples, JSON schemas, and shell completions. Hide `connect`, `--versions`, duplicate installs, and installation-scoped account bindings.
11. **Add fleet migration tests.** Replace per-account-install assumptions in `cli/src/lib/accounts/connect.test.ts`, `account-registry.test.ts`, `cli/src/commands/view.account.test.ts`, `accounts.native-home.test.ts`, and installation suites.
12. **Update documentation.** Edit `cli/AGENTS.md`, `cli/README.md`, `cli/docs/credential-management.md`, `cli/docs/version-management.md`, and `cli/CHANGELOG.md`. Audit the companion fleet guidance for old commands.
13. **Stage rollout.** Ship schema readers first, then dual-read migration, then the new command surface, then automatic worker provisioning, and only finally retire legacy records and aliases.

Return file:line quotes for every claim.
