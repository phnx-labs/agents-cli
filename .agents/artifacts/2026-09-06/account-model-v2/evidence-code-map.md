# Evidence: installations vs accounts, current model (file:line map)

Collected 2026-09-06 by an Explore subagent from `cli/` at origin/main (1bc8ae2d2). Paths relative to `cli/`.

## 1. `agents add`
- `add` registered in `src/commands/versions.ts:409`. Bare-add reuse rule `planAccountFirstInstall` `versions.ts:94-106`: no `@`, supported harness, not isolated → reuse existing label (`:515-517`, "already installed. Your account home is unchanged" `:546-551`), first-ever bare install gets label `main` (`:519-520`).
- `claude@latest` contains `@` → legacy path → `installVersion(agent,'latest')` `versions.ts:559`; `installVersion` `src/lib/installations/versions.ts:1162-1328`; label = resolved release for `latest` (`:1268`); `createInstallation` `:1319` (identity frozen, release recorded separately `:1316-1318`).
- Record `installation.json` written by `src/lib/installations/store.ts:167-192`; schema `types.ts:12,26-53`; idempotent `store.ts:163-177`.
- Fresh home gap-filled from default's settings, credentials excluded `versions.ts:588-593`, `settings-manifest.ts:44-54`.
- Help text asserting the model `versions.ts:434-440` ("Connect another account with 'agents accounts connect <agent> [name]'").

## 2. accounts add / connect / mint / name / label
| Surface | Registered | Creates home? | Binding |
|---|---|---|---|
| `accounts add <name> --provider --auth` | `commands/accounts.ts:578-600` | no | secrets bundle `account-registry.ts:540`, bundle is the account `:1-18` |
| `accounts connect <harness> [name]` | `accounts.ts:548-568` | YES, one isolated home per new account | `deviceAccounts.homes[accountId]` via `setNativeAccountHome` |
| `accounts mint <harness>` | `auth-mint.ts:47-58`, wired `accounts.ts:546` | no, reuses installation | provider bundle + reserved `auth` bundle |
| `accounts name <agent@version> <name>` | `accounts.ts:646-655` | no | central `accounts.native` (or device doc when scope device) |
| `accounts label <agent@version> [label]` | `accounts.ts:657-669` | no | central `accounts.native` keyed (agent, identityKey) |

- connect docblock `src/lib/accounts/connect.ts:8-25`: mints fresh opaque label, installs current release into that label's isolated home even if already installed elsewhere.
- `mintConnectLabel` `acct-<hex>` `connect.ts:109-111` (random, PHNX-3940 fix `:100-108`); `allocateConnectSlot` `:190-208`; occupied set `:348-351`; pending slot retry `:358-363,426` + registry `account-registry.ts:388-410`; `planConnect` `:157-176`; install `:389-396`; `addNativeAccount(...,'version')` then `setNativeAccountHome` `:424-425`; reconnect re-record `:436`; `setDefaultAccountIfAbsent` `:429` / registry `:423-436`.
- `connectSupported` needs `cap.scope==='version'` + wired login `connect.ts:65-68`; `LOGIN_INVOCATIONS` = claude + codex only `:59-62`.
- `deviceAccounts.homes` write/read `account-registry.ts:358-371`, `ownedConnectHomeLabels` `:379-381`; rationale `types.ts:933-943` (device-scoped on purpose), `pendingConnects` `:944-956`.
- mint resolves an existing home `auth-mint.ts:389-400`, `seedReservedAuthToken` `:227`, `seedNamedAccount` `:267`.

## 3. Identity capture
- `nativeIdentityKey` `account-capabilities.ts:118-125` (accountKey, else lowercased email; null when signed out).
- Capability table `account-capabilities.ts:34-67`: claude/codex/grok/cursor strong+version; kimi opaque+version; muse email+version conditional; antigravity/droid/opencode device+unsupported.
- `getAccountInfo` `agent-spec/agents.ts:2128+`; claude `readClaudeHomeConfig` `:2087-2126`; `buildIdentityKey` `:2618-2627`; blank credential ⇒ signed out `:2165-2170`.
- `nativeIdentityFromSource` `commands/accounts.ts:56-65`.
- `signin-badge.ts`: `formatSignInBadge` `:88-95`, `loginHint` `:16-38`, `ambientClaudeToken` `:69-74`.
- `readClaudeIdentity` `claude-statusline.ts:124`, used `:220`.
- `ACCOUNT_INSPECTION_AGENT_IDS` `agent-spec/agents.ts:1480-1491` (claude codex gemini cursor grok antigravity kimi droid opencode muse); `supportsAccountInspection` `:1496-1498`; `CREDENTIAL_FILE_SEGMENTS` `:1565-1580`; `resolveAccountCredentialPath` `:1537-1546` (per-version home first, then real HOME); `credentialPresence` `:1635`.

## 4. Run-time selection
- Spec parse `parseAgentVersionSpec` `agent-spec/agents.ts:3341-3364`; `agents run` copy `commands/exec.ts:2168-2188` (`#label` → `options.account`; conflict with `--account` hard error `:2184-2187`). `#label` = account-first; `@label` = installation label.
- `resolveSpawnAccount` `account-registry.ts:710-757`: explicit `--account` → exact `agent@version` binding → device binding → per-harness default (`resolveAccountSelection` `:497-536`, bindings merged `:507`). Native carries no env `:701-704,752`; provider injects env `:756`. Stale default warns → balanced; stale binding/explicit fails loud `:729-741`.
- Native account ⇒ version home `commands/exec.ts:2580-2596` via `resolveAccountVersion` `accounting/rotate.ts:1037-1044` + `matchAccountVersion` `:1013-1030`; gated by `CONFIG_ENV_ISOLATED_AGENTS` `exec.ts:2574-2578`; refused for remote `--device` `exec.ts:2568-2573`.
- Balanced/available candidates are installed version homes: `collectRunCandidates` `rotate.ts:904-946`, `pickBalancedCandidate` `:509`, `pickAvailableCandidate` `:648`, `resolveRunVersion` `:1257`, consumed `exec.ts:2826`; picker `run-account-picker.ts:96-147`.
- `accounts.defaults` written `account-registry.ts:423-436`, `commands/accounts.ts:763-778`.

## 5. Version-variant surfaces still exposed
- `view --versions` `commands/view.ts:2157-2158,2227`; badges `:708,720,722`; "Connect: … · Details: --versions" `:726-727`; no-account hint → `accounts connect` `:714`; help examples `:2186,2194-2195`.
- `add <harness>@<version>` examples/notes `commands/versions.ts:420-440`; `--isolated` `:413,439`; prune examples `:382-393`.
- `update <agent>@<label>` `commands/update.ts:39,190,265,280,332`; `prune cleanup` `commands/prune.ts:346-362`; `trash restore` `commands/trash.ts:164`.
- `accounts logout <harness>@<label>` `accounts.ts:793-795` (parser `:455-472`); `accounts label codex@0.146.0` example `:658,667`; `attach <account> <agent@version>` `:671,697`.
- docs/version-management.md `:20,36,52-54,63-108,121-136,265,301,414,421`; README `:580,1159-1160,1164`; cli/AGENTS.md `:725,769,779,914,926`; docs/command-index.md `:26,882-885`.

## 6. Cross-device sync
- `CENTRAL_META_KEYS` includes `accounts` `state.ts:1055-1077`; `BESPOKE_DEVICE_KEYS` includes `deviceAccounts` `:1140-1152`; default-to-device rationale `:1108-1124`; device-doc write `:1418-1436`, read-back `:1557-1571`.
- Syncs: `accounts.native` (scope version), `accounts.defaults`, `accounts.bindings`. Never syncs: `deviceAccounts.homes`, `pendingConnects`, device-scoped natives (`types.ts:933-956`, `account-registry.ts:293-315,352-357`).
- Transport `fleet-shared-repo-sync.ts:1-10` (publishes `devices/<device>/daemon-state.json`), stages central `agents.yaml` too `:314-340` (PHNX-3887 label loss).
- `daemon/auth-sync-service.ts:1-8,31-42`: readiness verdict + `syncReservedAuthBundle`. `secrets/reserved-sync.ts:1-9,36-60`: only a `missing` peer gets an SSH push.
- `fleet/auth-sync.ts`: `FLEET_AUTH_FILES` `:26-36`; `KEYCHAIN_BOUND_ON_MAC={claude,antigravity}` `:39`; `SINGLE_USE_ROTATING_REFRESH_AGENTS={droid}` `:41-51` (RUSH-1958 collapsed 10 boxes to 1); `isCredentialSafeToPropagate` returns false unconditionally `:53-66` (SING-1b).
- Usage rides identity: `accounting/usage.ts:1648`, `ingestPeerClaudeUsageRows`.

## 7. Tests pinning one-home-per-account
- `accounts/connect.test.ts` `:30,36,50,60,66,72,82,89,96,101,106,127,135,141,224,238,262,275,306,349`.
- `account-registry.test.ts` `:251,264,570,582,598,614`.
- `commands/view.account.test.ts` `:31,249-275,285-310,315-386,424-440` (prune duplicate homes).
- `commands/accounts.native-home.test.ts` `:36,43,49,57`; `commands/versions.test.ts` `:7,11,16,20`; `installations/store.test.ts` `:43,56,66,89,105,129`; adjacent `installations/{versions,resolve,update,update-runtime,shims.auth-carry,versions.heal-dangling}.test.ts`.
