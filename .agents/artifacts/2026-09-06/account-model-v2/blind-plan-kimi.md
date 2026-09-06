kimi version 0.41.0
• UserPromptSubmit hook

  Reminder (worktree law): every write goes through a linked worktree under <repo>/.agents/worktrees/<slug>/ + a PR. The user's primary checkouts are untouchable — never edit, commit, or switch branches there, on any branch.

• This is a read-only planning task. I need to read a lot of files and produce an independent change proposal. Let me start by reading the required files. This is a big task — I could delegate exploration to subagents, but the output must be mine with file:line evidence. Given the volume, I'll read the key files myself but could fan out explore agents. Actually, the task is substantial — reading ~20 files plus two audits. Delegating to explore agents risks losing the file:line precision. Let me read the files directly, in parallel batches.

  Let me start with CLAUDE.md files and the core evidence files. Note AGENTS.md content is already provided above (root). cli/CLAUDE.md is a symlink to cli/AGENTS.md — I should read it.

  Let me batch reads.

• I'll start by reading the component guidance and the core evidence files in parallel batches.

• The cli/AGENTS.md output was saved to a file. I need to read relevant sections of it. Let me continue reading the other evidence files. There's a lot to read. Given the volume, I should consider delegating some reading to explore subagents. But the output needs file:line evidence — subagents can return that. However, the task says "Your output is your final message" — I need to synthesize. Given the sheer volume (auth-mint.ts, installations/*, commands/*, agents.ts, exec.ts, fleet/auth-sync.ts, secrets/reserved-sync.ts, daemon/auth-sync-service.ts, state.ts, two docs, two audits), delegating parallel exploration to explore agents is wise to save context. But precision of file:line matters — explore agents can quote them.

  Actually, let me be strategic: I'll read the most load-bearing files myself (auth-mint.ts, exec.ts relevant parts, agents.ts relevant parts, installations store/versions, accounts command, add/view commands) and delegate the rest (fleet/auth-sync, reserved-sync, daemon auth-sync-service, state.ts, docs, audits) to explore agents that return dense file:line summaries.

  Let me first grep for key symbols to page through large files efficiently. Let me check file sizes.     588 cli/src/lib/auth-mint.ts
     714 cli/src/lib/installations/store.ts
    3566 cli/src/lib/installations/versions.ts
     364 cli/src/lib/installations/update.ts
    3128 cli/src/lib/installations/shims.ts
     896 cli/src/commands/accounts.ts
    2249 cli/src/commands/view.ts
     338 cli/src/commands/update.ts
       2 cli/src/lib/agents.ts
    2886 cli/src/lib/exec.ts
     257 cli/src/lib/fleet/auth-sync.ts
     202 cli/src/lib/secrets/reserved-sync.ts
      50 cli/src/lib/daemon/auth-sync-service.ts
    1922 cli/src/lib/state.ts
     420 cli/docs/credential-management.md
     508 cli/docs/version-management.md
     125 cli/src/lib/account-capabilities.ts
     282 cli/src/lib/account-catalog.ts
   18497 total
agents.ts is only 2 lines? Probably re-exports. cli/src/commands/add.ts missing? wc failed exit 1 because one file missing — likely cli/src/commands/add.ts doesn't exist. Let me check. Also agents.ts is 2 lines — re-export.

  Given volume (~18k lines), I'll delegate parallel exploration to explore agents with precise instructions, while I read the most critical small files myself: auth-mint.ts (588), accounts.ts command (896), account-capabilities.ts (125), account-catalog.ts (282), fleet/auth-sync.ts (257), reserved-sync.ts (202), auth-sync-service.ts (50), docs (420+508), update.ts (338), installations/update.ts (364).

  The big ones to delegate: installations/versions.ts (3566), shims.ts (3128), store.ts (714), exec.ts (2886), state.ts (1922), view.ts (2249), agents.ts real location, add command location, plus the two audits.

  Let me find where add command and agents lib really live.__tests__
accounts-render.test.ts
accounts.native-home.test.ts
accounts.test.ts
accounts.ts
alias.test.ts
alias.ts
apply.test.ts
apply.ts
artifacts-setup.ts
artifacts.test.ts
artifacts.ts
attach.test.ts
attach.ts
audit.ts
auth-mint.ts
auth.test.ts
auth.ts
beta.ts
browser-picker.ts
browser-sessions-picker.test.ts
browser-sessions-picker.ts
browser.claim.test.ts
browser.default-device.test.ts
browser.edit.test.ts
browser.pdf-har.test.ts
browser.profiles-surface.test.ts
browser.task.test.ts
browser.ts
browser.use.test.ts
budget.test.ts
budget.ts
cli.ts
cloud.test.ts
cloud.ts
commands.ts
computer-actions.test.ts
computer-actions.ts
computer-sessions-picker.test.ts
computer-sessions-picker.ts
computer.test.ts
computer.ts
config.test.ts
config.ts
cost.test.ts
cost.ts
daemon-test-harness.ts
daemon.health.test.ts
daemon.services.test.ts
daemon.test.ts
daemon.ts
daemon.uptime.test.ts
detach-core.ts
detach.test.ts
detach.ts
device-config-test-harness.ts
doctor.check.test.ts
doctor.test.ts
doctor.ts
events.ts
---
/** Hub facade. The AGENTS table lives in agent-spec/agents.ts. */
export * from './agent-spec/agents.js';
---
I've read part of cli/AGENTS.md (saved to file). I should read the relevant sections — it's 2069 lines. Let me grep it for accounts-related sections later if needed. For now, let me proceed with the plan: delegate big files to explore agents, read key files myself.

  Let me find where getAccountInfo, credentialPresence, ACCOUNT_INSPECTION_AGENT_IDS live (agent-spec/agents.ts), where add command lives (maybe commands/install.ts or add is part of something).agents.test.ts
agents.ts
index.ts
materialize.test.ts
materialize.ts
package-resolve.test.ts
package-resolve.ts
package-schema.test.ts
package-schema.ts
package-types.ts
---
cli/src/lib/agent-spec/agents.test.ts:10:  ACCOUNT_INSPECTION_AGENT_IDS,
cli/src/lib/agent-spec/agents.test.ts:16:  credentialPresence,
cli/src/lib/agent-spec/agents.test.ts:19:  getAccountInfo,
cli/src/lib/agent-spec/agents.test.ts:36:  it('matches the credential formats getAccountInfo can inspect safely', () => {
cli/src/lib/agent-spec/agents.test.ts:37:    expect(ACCOUNT_INSPECTION_AGENT_IDS).toEqual([
cli/src/lib/agent-spec/agents.test.ts:49:    for (const agent of ACCOUNT_INSPECTION_AGENT_IDS) {
cli/src/lib/agent-spec/agents.test.ts:62:describe('credentialPresence (RUSH-2069 provable-logout signal)', () => {
cli/src/lib/agent-spec/agents.test.ts:63:  // credentialPresence splits a credential file's existence into the per-version
cli/src/lib/agent-spec/agents.test.ts:88:    const p = credentialPresence('codex', versionHome);
cli/src/lib/agent-spec/agents.test.ts:96:    const p = credentialPresence('codex', makeTempDir());
cli/src/lib/agent-spec/agents.test.ts:105:    const p = credentialPresence('codex', makeTempDir());
cli/src/lib/agent-spec/agents.test.ts:121:    expect(credentialPresence('claude', versionHome).perVersion).toBe(true);
cli/src/lib/agent-spec/agents.test.ts:131:    const p = credentialPresence('claude', versionHome);
cli/src/lib/agent-spec/agents.test.ts:145:    const p = credentialPresence('amp' as any, makeTempDir());
cli/src/lib/agent-spec/agents.test.ts:151:    // ACCOUNT_INSPECTION_AGENT_IDS with no credential path, which without the
cli/src/lib/agent-spec/agents.test.ts:155:      const p = credentialPresence(agent, dir);
cli/src/lib/agent-spec/agents.test.ts:611:describe('getAccountInfo — token-only agents (no local email)', () => {
cli/src/lib/agent-spec/agents.test.ts:612:  // Sign-in is account-global: getAccountInfo falls back from the passed
cli/src/lib/agent-spec/agents.test.ts:646:    const info = await getAccountInfo('antigravity', home);
cli/src/lib/agent-spec/agents.test.ts:660:    const info = await getAccountInfo('antigravity', makeTempDir());
---
fork.preview-contract.test.ts
resource-view.test.ts
resource-view.ts
routines.add.test.ts
sessions.overview.test.ts
sessions.remote-preview-attribution.test.ts
teams.add-cleanup.integration.test.ts
uninstall.ts
view.account.test.ts
view.harness.test.ts
view.isolated.integration.test.ts
view.merged.test.ts
view.resources.test.ts
view.ts
No `add.ts` command file. Where is `agents add` defined? Probably in cli.ts or commands.ts wiring. Let me grep for "add" command registration. Also `agents accounts` is commands/accounts.ts (896 lines).

  Given the scale, I'll fan out explore subagents in parallel:

  Agent 1: installations/* (store.ts, versions.ts, update.ts, shims.ts) + commands related to add/install — how version homes are created, what a "version home" is, install labels, shims, `agents add` surface, defaults.
  Agent 2: exec.ts + agent-spec/agents.ts — resolveSpawnAccount (already read in account-registry... actually resolveSpawnAccount is in account-registry.ts which I read; exec.ts has its own? The prompt said exec.ts (resolveSpawnAccount, applyExecConfigEnv, isHeadedDeviceRole). Maybe exec.ts re-exports or has related functions), getAccountInfo, credentialPresence, ACCOUNT_INSPECTION_AGENT_IDS, buildExecEnv.
  Agent 3: sync layer — fleet/auth-sync.ts, secrets/reserved-sync.ts, daemon/auth-sync-service.ts, state.ts (central agents.yaml vs device doc), auth-mint.ts.
  Agent 4: commands surface — commands/accounts.ts, view.ts, update.ts, plus where `agents add` and `--versions` are defined (cli.ts/commands.ts), account-capabilities.ts, account-catalog.ts.
  Agent 5: the two docs + two audits.

  Actually, I'll read auth-mint.ts, account-capabilities.ts, account-catalog.ts, and the sync files myself since they're small, and delegate the big ones. Hmm — balance. Total ~18k lines is too much for my context alongside everything else. Delegate 4 explore agents in parallel with precise asks for file:line quotes. Meanwhile I read the docs and audits myself (they're the product-intent evidence), plus small files.

  Let me launch the swarm. Use AgentSwarm with 4 items? Items are differently-shaped tasks... "For a few differently-shaped tasks, make separate Agent calls in one message instead." I'll make 4 Agent calls in one message plus read docs myself afterward.

  Prompts must be self-contained: read-only planning in agents-cli repo at the worktree path. Ask for dense file:line evidence.Excellent — four thorough reports. Now I need to read the docs (credential-management.md, version-management.md) and the two audits myself. Let me read them in parallel.

• All four exploration reports are in. Now reading the two docs and the two audit artifacts myself.

• Now the two audits.I have comprehensive evidence now. I don't need to make changes in those directories (read-only task). Let me also quickly verify a couple of load-bearing details I want to cite precisely in my proposal:

  1. `planAccountFirstInstall` in versions.ts cmd — agent-0 covered it (cmd:95-106, label 'main').
  2. The `agents add` command file is cli/src/commands/versions.ts:407-760 — good.
  3. `connectSupported` / LOGIN_INVOCATIONS — read directly.
  4. `isHeadedDeviceRole` in device-config.ts:874-876 — cited.
  5. Cursor adapter HOME swap — cited.

  I should verify a few key lines myself for accuracy since the final proposal must have file:line quotes for every claim. The subagent reports are detailed with quotes; I'll trust them but spot-check the most load-bearing ones. Actually, given the volume, spot-check a handful:

  - cli/src/commands/versions.ts add command + planAccountFirstInstall
  - cli/src/lib/device-config.ts:874-876
  - view.ts:704 "not connected here"
  - shims.ts:1167 CONFIG_ENV_ISOLATED_AGENTS

  Let me spot check those quickly.

• I have all the evidence. Let me spot-check a few load-bearing citations before writing the proposal. * Mac mini) qualify; a `worker` and an unmarked box do NOT. This is the single
 * predicate the auth-bucket sites read, so `personal` and `desktop` never drift
 * apart (claude adapter, routine spawn env, `agents view` usage login).
 */
export function isHeadedDeviceRole(role: ConfiguredDeviceRole | undefined): boolean {
  return role === 'personal' || role === 'desktop';
}

/** Mark a device's role fleet-wide; `undefined` clears the mark. */
export function setConfiguredDeviceRole(name: string, role: ConfiguredDeviceRole | undefined): void {
  assertValidDeviceName(name);
===
        const model = source ? resolveConfiguredModel(agentId, source.label)?.model : null;
        const pinned = row.installations.some((home) => readInstallation(agentId, home.label)?.updatePolicy === 'pinned');
        const parts = [
          `    ${row.isDefault ? chalk.green('*') : ' '} ${chalk.cyan(padToWidth(nativeAccountViewLabel(row), width))}`,
          connected ? chalk.green('connected') : chalk.yellow('not connected here'),
          model ? chalk.yellow(model) : '',
          usage,
          formatUsageStatusBadge(info?.usageStatus),
          pinned ? chalk.gray('release pinned · --versions') : '',
===
 *
 * KEEP IN SYNC with the `managedEnv` switch in `generateVersionedAliasScript`.
 * The colocated test `shims.isolation-capability.test.ts` enforces this.
 */
export const CONFIG_ENV_ISOLATED_AGENTS: readonly AgentId[] = ['claude', 'codex', 'copilot', 'cursor', 'grok', 'kimi', 'opencode', 'muse'];

/**
 * Whether an agent supports a clean `--isolated` install — i.e. its config
 * location can be redirected by an env var so the isolated copy stays fully
 * separate from the user's real `~/.<agent>`. See {@link CONFIG_ENV_ISOLATED_AGENTS}.
 */
export function supportsIsolatedInstall(agent: AgentId): boolean {
  return CONFIG_ENV_ISOLATED_AGENTS.includes(agent);
}

/**
===
import { setHelpSections } from '../lib/help.js';
import { updateSessionFilePaths } from '../lib/session/db.js';
import { connectSupported } from '../lib/accounts/connect.js';

/** Bare installs reuse an account home; explicit labels keep their expert semantics. */
export function planAccountFirstInstall(input: {
  spec: string;
  supported: boolean;
  isolated: boolean;
  labels: string[];
  defaultLabel: string | null;
}): { existingLabel?: string; installationLabel?: string } {
  if (!input.supported || input.isolated || input.spec.includes('@')) return {};
  const existingLabel = input.defaultLabel && input.labels.includes(input.defaultLabel)
    ? input.defaultLabel : input.labels[0];
  return existingLabel ? { existingLabel } : { installationLabel: 'main' };
}

/**
 * After removeVersion soft-deletes a version dir to trash, rewrite session
 * file_path entries in the DB so reads still work from the new trash location.
===
cli/src/commands/accounts.ts:197:        const state = acct.state === 'reconnect-needed' ? 'not connected here' : 'connected';
cli/src/commands/view.ts:704:          connected ? chalk.green('connected') : chalk.yellow('not connected here'),


• All spot-checks pass. Now I write the final proposal. Requirements: max ~300 lines, sections 1-7 in order, file:line evidence for every claim about current behavior, end with "Return file:line quotes for every claim" — that phrase is the instruction that my output must carry file:line quotes; I'll interpret the final line literally: end the message with that confirmation. Actually "End with: Return file:line quotes for every claim." means my output should end by ensuring every claim has file:line quotes. I'll structure carefully and keep within ~300 lines.

  Let me draft the proposal now. Key content:

  **1. Current architecture paragraph + diagram.**

  Today: install = installation record at `~/.agents/.history/versions/<agent>/<label>/` with `installation.json` (id, label, releaseVersion, history, updatePolicy) — types.ts:41-70, store.ts:36-38. Home = `<dir>/home` (store.ts:439-441). Account = two kinds: provider (secrets bundle, account-registry.ts:1-17) and native (metadata row in meta.accounts.native central or deviceAccounts.native device doc, account-registry.ts:174-177, 280-315). Connect mints `acct-<hex>` label and installs current release into it (connect.ts:109-111, 391-396, 469-471). Default = pins (meta.agents, versions.ts:1004-1019) + accounts.defaults (account-registry.ts:423-435). Selection at run: resolveSpawnAccount explicit → binding agent@version → device binding → default (account-registry.ts:710-756). Sync: central agents.yaml via repo push/pull; deviceAccounts never unioned; reserved `auth` bundle via daemon 15-min tick (auth-sync-service.ts:12); provider bundles via manual `accounts sync` (accounts.ts:836-866).

  **2. Target data model.**

  One install per harness: the `main` label (already the planAccountFirstInstall convention, versions.ts cmd:95-106). Account = a named credential + identity, decoupled from installation. N accounts coexist in one install by config-dir swap at spawn: buildExecEnv already separates `version` (binary) from `configVersion` (home overlay) (exec.ts:282-284). Target: account homes become *config-only* homes (no node_modules, no installation.json) — e.g. `~/.agents/.history/accounts/<agent>/<account-id>/` carrying just the harness config dir; exec points CLAUDE_CONFIG_DIR/CODEX_HOME/etc. there while the binary comes from the single install. Per-harness mechanism: claude CLAUDE_CONFIG_DIR (adapters/claude.ts:21), codex CODEX_HOME (adapters/codex.ts:23-31), copilot COPILOT_HOME, kimi KIMI_CODE_HOME, grok GROK_HOME, cursor HOME swap, muse XDG. Cannot: gemini, antigravity, droid, openclaw, amp, goose, hermes, warp — symlink-adopt `~/.<config>` only (shims.ts:1153-1166); plus opencode has shim pin but no exec pin (gap). For those: keep at most one live native login per box (device-scoped account), select by swapping the adopted symlink at switch time (serialized by auth-op lock), or steer to provider API-key accounts.

  Credential location: headed device → native OAuth in the account's config home on that device, minted by interactive login; worker → durable credential: claude setup-token in reserved `auth` bundle, injected as CLAUDE_CODE_OAUTH_TOKEN (adapters/claude.ts:87-91) and/or `.oauth_token` file; codex/grok/opencode/gemini → provider API-key bundles resolved at spawn (account-registry.ts:653-688).

  Selection: `<harness>#<label>` or --account → explicit; binding; default (resolveAccountSelection order preserved, account-registry.ts:497-514).

  **3. Command surface.**

  Keep/fold/hide/remove with file:line:
  - `agents add <harness>@latest` stays the install verb (commands/versions.ts:407-413) but bare add becomes purely "install the harness once"; remove account-first planning? Actually keep planAccountFirstInstall simplified: always label `main`.
  - `agents accounts connect` → folded into `agents accounts add <harness>`: headed → install-free native login into a new account config home under the one install; worker → provision from durable store (per PHNX-3940 plan).
  - `--versions` hidden (view.ts:2158).
  - `accounts name` folded into `label` (accounts.ts:646-655 vs 657-669) — audit recommends.
  - `switch` → alias of set-default (accounts.ts:772-777).
  - `agents update` unchanged but now trivially one installation per harness.
  - Step-by-step `agents accounts add claude` on headed: check install exists (else `agents add claude@latest` first or auto), allocate account home, drive `claude auth login` (LOGIN_INVOCATIONS connect.ts:59-62) with config-dir env pinned to account home, strip provider env (connect.ts:33-39), verify identity (connect.ts:222-237), register native row, then offer/auto-mint the worker durable token: for claude, drive `claude setup-token` (auth-mint MINT_FLOWS auth-mint.ts:71-81) seeding named bundle + reserved auth bundle (auth-mint.ts:267-278, 227-260) and fan out via daemon auth-sync. For codex: native login on headed; for workers there's no durable per-account OAuth — provider API key (`accounts add --provider openai`) is the worker path.
  - On a worker: `accounts add` never opens browser; provisions from bundle (the PHNX-3940 plan's worker branch), fails for unknown names.

  **4. Sync design.**

  Per harness what travels: claude — setup-token via reserved `auth` bundle (daemon, reserved-sync.ts:175-180, 15-min tick auth-sync-service.ts:12) + registry metadata via agents.yaml repo sync; codex/grok/opencode/gemini/droid — provider API-key bundles; today manual `accounts sync` (accounts.ts:836-866); proposal: extend daemon auth-sync verdict mechanism to per-account bundles targeted at role=worker devices. Never travels: native OAuth (fleet/auth-sync.ts:64-66 isCredentialSafeToPropagate false), device-scoped rows' credentials. Expiry detection: auth-health probes (auth-health.ts:38-53) + credentialPresence; surface in view/accounts list (currently not rendered — audit finding 1) and notify on transitions (audit finding 2).

  **5. Migration.**

  - Collapse per-account version homes: for each harness, pick canonical install (`main` or current default), move each account home's config dir to the new account-home location, re-point deviceAccounts.homes, trash the duplicate node_modules trees. Risky: launch leases/sessions keyed on version home paths; session DB file_path rewrite (precedent versions.ts cmd updateSessionFilePaths); empty logged-out codex homes — detect via credentialPresence (agents.ts:1635-1641) and prune; default on worker pointing at logged-out home — re-resolve default to provisioned account.
  - Risky steps named: symlink switching of ~/.claude (shims.ts switchConfigSymlink), concurrent runs mid-migration (auth-op lock), workers pulling half-migrated registry.

  **6. Gaps.**

  - opencode exec-path pin missing; grok only with configVersion; CONFIG_DIR_ENV_KEYS strip list lacks GROK_HOME/OPENCODE_CONFIG_DIR/XDG (adapter.ts:176-181).
  - Cursor keychain machine-global; antigravity single keyring credential (agents.ts:2358-2361).
  - Whether codex supports multiple auth.json profiles in one CODEX_HOME — unknown; current model is one auth.json per home.
  - Whether a single install's resource-synced settings conflict with per-account homes (statusline etc.).
  - copilot/openclaw/hermes/goose/warp credential locations unknown (outside ACCOUNT_INSPECTION_AGENT_IDS, agents.ts:1480-1491).
  - The two-token-store contradiction (doc says no reserved bundle; code has AUTH_BUNDLE_NAME, bundles.ts:214).

  **7. Ordered task list with files.**

  Keep to ~300 lines. Write tightly. I'll write the final message now. Line budget: aim ~280 lines.

• All evidence gathered and spot-checked. Here is the independent change proposal.

  ---

  # One install per harness, N accounts — change proposal

  Read-only analysis of `cli/` at worktree `plan-kimi`. Every behavioral claim carries file:line evidence; the two 2026-09-06 audits are cited as `[ux-audit]` (`.agents/worktrees/accounts-ux-audit/.agents/artifacts/2026-09-06/accounts-ux-audit.md`) and `[worker-plan]` (`~/.agents/artifacts/2026-09-06/fleet-worker-account-identity/plan.md`).

  ## 1. Current architecture

  An **installation** is a directory `~/.agents/.history/versions/<agent>/<label>/` containing `node_modules/`, an `installation.json` record (`id`, `label` frozen at creation, `releaseVersion` that moves on update, `history`, `updatePolicy` — `cli/src/lib/types.ts:41-70`), and a `home/` that is the config+credential root (`getVersionHomePath`, `cli/src/lib/installations/store.ts:439-441`). Identity and release are deliberately split so two labels can carry one release (`types.ts:25-39`; `resolve.ts:87-95` throws `InstallationAmbiguousError` precisely because a release is not an identifier). An **account** is two unrelated things: a *provider* account = a policy-`never` secrets bundle (`cli/src/lib/account-registry.ts:1-17`), and a *native* account = a metadata row `{id,name,agent,identityKey,identityLabel,scope}` in central `meta.accounts.native` or this box's `deviceAccounts.native` (`account-registry.ts:280-315`; scope split at `:294-310`). Today an account **is** a version home: `agents accounts connect` mints an opaque `acct-<hex>` label (`cli/src/lib/accounts/connect.ts:109-111`) and installs the current release into it (`connect.ts:391-396`, runner `:469-471`) — ten accounts means ten full npm installs of the same release. The **default** is two mechanisms: installation pins `meta.agents[agent]` in machine-local `pins-<host>.json` (`cli/src/lib/installations/versions.ts:1004-1019`; `cli/src/lib/state.ts:674`) and per-harness account defaults `meta.accounts.defaults` (central, synced; `account-registry.ts:423-435`). **Selection** at spawn: explicit → binding on `agent@version` → device-scoped binding → default (`resolveSpawnAccount`, `account-registry.ts:710-756`; order at `:697-701`). **Sync**: central `agents.yaml` (labels/defaults/bindings, no secrets) travels via `agents repo push/pull` (`state.ts:1056`, `types.ts:896-913`); `deviceAccounts` never union across boxes ([ux-audit] §5.1, `device-docs.ts:156-159`); claude setup-tokens travel in the reserved file-backed `auth` bundle pushed by the daemon's 15-min `auth-sync` service (`cli/src/lib/daemon/auth-sync-service.ts:12`; `cli/src/lib/secrets/reserved-sync.ts:175-180`); other provider bundles move only by manual `agents accounts sync <name> <device>` (`cli/src/commands/accounts.ts:836-866`).

  ```
   agents add claude@X ──installVersion()──▶ versions/claude/<label>/{node_modules, home/, installation.json}
                                                  ▲                     │
   accounts connect claude work ──acct-<hex>──────┘   home/.claude = native OAuth login (headed only)
   accounts add --provider openai ──▶ secrets bundle (policy never) ──accounts sync──▶ worker (manual)
   accounts mint claude ──▶ named bundle + reserved `auth` bundle ──daemon 15-min──▶ workers (auto, claude only)
   agents.yaml (central) ──repo push/pull──▶ fleet: native rows, defaults, bindings   [no secrets]
   devices/<host>/agents.yaml (device doc): homes, pendingConnects, device-scoped rows [never unioned]
   run: resolveSpawnAccount → native: configVersion = account's version home → CLAUDE_CONFIG_DIR/CODEX_HOME pin
                            → provider: env from bundle (OPENAI_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)
  ```

  ## 2. Target data model

  **Install once:** one managed installation per harness per box — label `main`, the convention `planAccountFirstInstall` already uses for fresh bare installs (`cli/src/commands/versions.ts:95-106`). `releaseVersion` keeps moving on update; nothing account-related keys on it.

  **Account = named credential + identity, decoupled from installation.** An account gets a *config-only* home — e.g. `~/.agents/.history/accounts/<agent>/<accountId>/` — holding only the harness config dir (`.claude/`, `.codex/`, …), no `node_modules`, no `installation.json`. The run path already has exactly the seam this needs: `buildExecEnv` takes `version` (binary) separate from `configVersion` ("Version home whose native auth/config is overlaid onto this run's binary", `cli/src/lib/exec.ts:282-284`), and the per-harness pins already exist — claude `CLAUDE_CONFIG_DIR` (`cli/src/lib/harness/adapters/claude.ts:21`), codex `CODEX_HOME` (`adapters/codex.ts:23-31`), copilot `COPILOT_HOME` (`adapters/copilot.ts:11-15`), kimi `KIMI_CODE_HOME` (`adapters/kimi.ts:10-14`), cursor HOME-swap (`adapters/cursor.ts:12-18`), muse XDG (`adapters/muse.ts:14-19`), grok `GROK_HOME` (`exec.ts:557-561`). So N accounts in ONE install = one binary + per-spawn config-dir env pointing at the account's config-only home. Selection is unchanged in shape: `<harness>#<label>` / `--account` explicit → binding → per-harness default (`account-registry.ts:497-514`), but the binding target key becomes the account id, never `agent@version`.

  **Credential custody per device role (invariant 7 preserved):**
  - *Headed* (`personal`/`desktop`; `isHeadedDeviceRole`, `cli/src/lib/device-config.ts:874-876`): the account's native OAuth login lives in its config-only home on that box, minted there by the harness's own interactive flow; never copied (invariant 2; enforced false at `cli/src/lib/fleet/auth-sync.ts:64-66`).
  - *Worker*: no native login. Claude → the account's setup-token from the reserved `auth` bundle, injected as `CLAUDE_CODE_OAUTH_TOKEN` (`adapters/claude.ts:87-91`, Linux shim `.oauth_token` fallback `adapters/claude.ts:108-111`). Codex/grok/gemini/opencode/droid → provider API-key account bundles resolved to env at spawn (`resolveCredentialAccount`, `account-registry.ts:653-688`).

  **Harnesses that cannot do per-spawn config swap:** gemini, antigravity, droid, openclaw, amp, goose, hermes, warp have no config-dir env — they isolate only by adopting `~/.<config>` via symlink (`cli/src/lib/installations/shims.ts:1153-1166`; `CONFIG_ENV_ISOLATED_AGENTS` at `shims.ts:1167`). Two of these are token-less by design (kimi, antigravity → per-box login, `cli/docs/credential-management.md:164-170`). Plan for the no-env group: at most one live native login per box (a device-scoped account row), with `accounts switch` repointing the adopted `~/.<config>` symlink under the existing auth-operation mutex (`connect.ts:304-314`), and provider API-key accounts as the multi-account answer where the vendor offers a key. opencode needs its missing exec-path pin added (it has a shim pin `adapters/opencode.ts:14` but no `applyExecConfigEnv`).

  ## 3. Command surface after the change

  Kept / folded / hidden / removed (current definitions cited):

  | Surface | Today | After |
  |---|---|---|
  | `agents add <harness>@latest` | `versions.ts:407-413`; account-first planning at `:507-511` | **Kept**, simplified: always installs/updates the single `main` install; `@<release>` pins still allowed but create no homes |
  | `agents accounts connect <h> [name]` | `accounts.ts:548-576`; engine `connect.ts` | **Folded into `accounts add <harness>`** (new native-account form); `connect` kept one release as a hidden alias |
  | `agents accounts add <name> --provider …` | `accounts.ts:578-600` | **Kept**; gains the native form `accounts add <harness> [name]` (no `--provider` ⇒ native) |
  | `agents view <h> --versions` | `view.ts:2158`; arrows at `view.ts:657,812` | **Hidden** (`hidden: true`), output reframed as install diagnostics; account rows leave it |
  | `agents accounts name` | `accounts.ts:646-655` (subset of `label`, [ux-audit] §2.2.1) | **Folded into `label`** (`accounts.ts:657-669`) |
  | `agents accounts switch` | `accounts.ts:772-777` (same write as set-default, `:419,450`) | **Alias** of `set-default` |
  | `agents update`, `agents use`, `agents remove` | `update.ts:188-298`, `versions.ts:771-775`, `versions.ts:767` | Kept; update now touches one installation per harness |
  | `agents accounts mint` | `auth-mint.ts:48`, claude-only `MINT_FLOWS` (`cli/src/lib/auth-mint.ts:71-81`) | Kept, but invoked automatically as the worker-token step of `accounts add claude` |

  **`agents accounts add claude [name]` on a headed device, step by step:** (1) ensure the `main` install exists, else run the `add` install path first; (2) allocate a fresh account config-home (reuse `mintConnectLabel`/`allocateConnectSlot` collision safety, `connect.ts:109-111,190-208`) under the auth-op lock; (3) drive the native login — claude `['auth','login']` with `--email`, codex `['login']` (`connect.ts:59-62`) — with the harness config-dir env pinned to the account home and ambient provider keys stripped (`connect.ts:33-39,480`); (4) fail-closed identity verify (`verifyConnectedIdentity`, `connect.ts:222-237`); (5) register the native row + record the account home in the device doc (`account-registry.ts:280-315,358-366`); set default only if none (`:423-435`); (6) **mint the worker credential in the same flow**: claude → drive `claude setup-token` (setup-token OAuth, not an API key; `auth-mint.ts:71-81`) and seed the named provider bundle + reserved `auth` bundle (`auth-mint.ts:227-278`), which the daemon already fans out. Codex on headed is the same native `codex login`; its *worker* credential is an `OPENAI_API_KEY` provider account (`credential-management.md:153-162`), which `accounts add` offers to create next.

  **On a worker:** `accounts add` never opens a browser — workers "NEVER run an interactive login flow" (`credential-management.md:141-147`). Claude: provision the account's config-only home from the `auth` bundle (the [worker-plan] worker branch: resolve token by registered email, write `.oauth_token` 0600, seed identity; refuse unregistered names and missing tokens). Other harnesses: require/sync the provider bundle, then succeed; unknown names fail loud.

  ## 4. Sync design

  - **Registry metadata** (native rows, defaults, bindings, and the new account→config-home map) — central `agents.yaml` via `agents repo push/pull` (`state.ts:1056`; auto-commit at `state.ts:1768-1772`). Account homes are recorded per box in the device doc (today: `deviceAccounts.homes`, `account-registry.ts:358-371`) and additionally converged by the provisioning path, so a worker never needs the headed box's device doc.
  - **Claude setup-tokens** — the reserved file-backed `auth` bundle, daemon `auth-sync` 15-min tick, verdict-gated SSH push (`reserved-sync.ts:37-60,175-180`; `auth-sync-service.ts:12`). Gap to close: the verdict is bundle-coarse (`ready|missing|invalid`); a `ready` peer missing one account's key gets no push — extend the verdict to per-key presence so a newly added account propagates within one tick (this is the "everything is taken care of" half of PHNX-3728).
  - **Provider API-key bundles** (codex/grok/gemini/opencode/droid) — today manual only (`accounts sync`, `accounts.ts:836-866`). Extend the same daemon service to push named account bundles to `role=worker` devices, reusing `pushBundleToHost` (stdin, host-pin verified, no multiplexing — `cli/src/lib/secrets/push.ts:64,163-168`). Role targeting is new: today neither `accounts sync` nor mint `--fleet` filters by role (`auth-mint.ts:499-518` targets all non-self devices).
  - **Must never travel:** native OAuth/session files (already forbidden, `fleet/auth-sync.ts:64-66`; SING-1b refusals in `hosts/credentials.ts` per `credential-management.md:36-47`); anything headed→headed; a setup-token into a headed device's runtime env (adapter already defers, `adapters/claude.ts:59-92`).
  - **Expiry/revocation:** detection exists — live probes for claude/kimi/droid (`cli/src/lib/auth-health.ts:73`), verdicts `live|revoked|expired|rate_limited|unverified` (`auth-health.ts:38-53`), provable-logout via `credentialPresence` (`cli/src/lib/agent-spec/agents.ts:1635-1641`) — but is rendered nowhere for humans and never notifies on transition ([ux-audit] findings 1-2: `accounts.ts:197` maps file presence to `connected`; no notify call in the daemon services). The change surfaces the verdict in `accounts list`/`view` and adds a daemon notify on `live→revoked|expired` transitions; sync consumes the same verdict so a revoked account stops being provisioned.

  ## 5. Migration

  1. **Per-account version homes → config-only account homes.** For each harness, elect the canonical install (the current global default, else `main`), then for each `acct-*`/duplicate home: move its `home/.<config>` into the new account-home location, re-point `deviceAccounts.homes[accountId]`, and soft-delete the version dir to trash (existing `removeVersion` semantics). **Risky:** sessions and the session DB key on version-home paths — the `updateSessionFilePaths` rewrite precedent exists (`versions.ts:108-110` region); launch leases block mid-flight swaps (`update.ts:161-175`); homes with live sessions must be deferred, not moved.
  2. **Empty logged-out homes (the three codex ones):** detect with `credentialPresence` (both locations absent + `knownLocation`, `agents.ts:1628-1633`) and prune without creating account rows.
  3. **Logged-out default on the worker:** re-resolve the default to a provisioned account; the stale-default fallback path already exists (`account-registry.ts:731-735`).
  4. **Registry convergence:** native rows already sync byte-identical (E3, [worker-plan]); the email-only worker homes get completed identity at read time per [worker-plan] (registry-join in the reader), so no per-home disk migration is needed for identity.
  5. **Order:** read-side identity completion and worker provisioning ship first (they fix "not connected here" with zero data movement), the install-collapse migration ships behind `agents doctor --fix`/a one-time migrator, and `--versions`/`connect` hiding ships last.

  ## 6. Gaps and unknowns

  - **opencode/grok exec pins:** opencode has no `applyExecConfigEnv`; grok only gets `GROK_HOME` when `configVersion` is set; the strip list `CONFIG_DIR_ENV_KEYS` (`cli/src/lib/harness/adapter.ts:176-181`) omits `GROK_HOME`/`OPENCODE_CONFIG_DIR`/XDG — cross-account leak behavior for these harnesses is unverified.
  - **Cursor:** macOS keychain login is machine-global (worked around with `AGENT_CLI_CREDENTIAL_STORE=file`, `adapters/cursor.ts:7-16`); antigravity's keyring holds exactly one credential (`agents.ts:2358-2361`) — true N-account coexistence on one box is not possible for either; plan assumes one-live-login + provider keys.
  - **codex multi-account in one CODEX_HOME:** whether codex supports profile switching inside one home is unknown; the proposal keeps one config-only home per account, which the current `CODEX_HOME` pin supports.
  - **Resource sync:** version homes get resources synced into them (`syncResourcesToVersion`, `versions.ts`); whether account config-only homes need the same treatment (statusline command merge, `credential-management.md:80-87`) is unresolved.
  - **Two token stores:** the doc says "no reserved bundle name" (`credential-management.md:60`) but code defines `AUTH_BUNDLE_NAME='auth'` (`cli/src/lib/secrets/bundles.ts:214`) and every worker read uses it ([worker-plan] Focus 3) — the proposal standardizes on `auth` for claude + named bundles for API keys, but the doc/code contradiction needs one decision.
  - **copilot/openclaw/hermes/goose/warp:** no credential location known (absent from `ACCOUNT_INSPECTION_AGENT_IDS`, `agents.ts:1480-1491`); their account story is UNVERIFIED ([ux-audit] §4).
  - Whether the daemon may push account bundles to workers without violating "the daemon holds no token" (invariant 1, `credential-management.md:31-34`) — the `auth`-bundle precedent says transport-without-retention is acceptable, but this should be stated explicitly.

  ## 7. Ordered task list

  1. `cli/src/lib/native-accounts.ts` (new leaf) + `cli/src/lib/agent-spec/agents.ts` — registry-join identity completion for email-only homes; `cli/src/lib/account-registry.ts` re-exports ([worker-plan] tasks 1-2).
  2. `cli/src/lib/claude-account-token.ts` + `cli/src/lib/accounts/connect.ts` + `cli/src/commands/accounts.ts` — worker provisioning branch keyed on `isHeadedDeviceRole`; `provisionClaudeWorkerHome`; signed-out identity-home reuse.
  3. `cli/src/lib/accounts/add.ts` (new) + `cli/src/commands/accounts.ts` — `accounts add <harness> [name]` native flow (steps in §3), auto-mint for claude via `cli/src/lib/auth-mint.ts`; fold `connect`/`name` to aliases.
  4. `cli/src/lib/exec.ts` + `cli/src/lib/harness/adapters/{opencode,grok}.ts` + `cli/src/lib/harness/adapter.ts` — account config-home as first-class `configVersion`; close the opencode/grok/strip-list gaps.
  5. `cli/src/lib/daemon/auth-sync-service.ts` + `cli/src/lib/secrets/reserved-sync.ts` — per-key verdicts; extend push to named provider bundles, worker-role targeting (`cli/src/lib/device-config.ts`).
  6. `cli/src/lib/installations/{migrate}.ts` (new) + `cli/src/commands/doctor.ts` — collapse per-account version homes to config-only account homes; empty-home prune; default re-resolution; session-path rewrite via `updateSessionFilePaths`.
  7. `cli/src/commands/view.ts` + `cli/src/commands/accounts.ts` — hide `--versions`; render `authVerdict` + FIX hints (Design A, [ux-audit] §1.4); `connect` hint becomes `accounts add`.
  8. `cli/src/lib/auth-health.ts` + `cli/src/lib/daemon/account-state-daemon-service.ts` — notify on `live→revoked|expired`.
  9. Docs: `cli/docs/credential-management.md` (account model, resolve reserved-bundle contradiction), `cli/docs/version-management.md` (one-install model), `cli/AGENTS.md`, `cli/CHANGELOG.md`.

  Every claim about current behavior above carries a file:line quote from the code or a cited audit artifact.

To resume this session: kimi -r session_c6bccfa1-bee0-471d-a81c-b89e6b9eae3b
