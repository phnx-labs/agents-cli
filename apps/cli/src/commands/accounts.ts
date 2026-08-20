import type { Command } from 'commander';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { setHelpSections } from '../lib/help.js';
import { readMeta, updateMeta } from '../lib/state.js';
import type { AgentId } from '../lib/types.js';
import { ALL_AGENT_IDS, getAccountInfo, resolveAgentName } from '../lib/agents.js';
import { getVersionHomePath, listInstalledVersions } from '../lib/installations/versions.js';
import { assertNativeAccountNameable, nativeAccountCapability, nativeIdentityKey } from '../lib/account-capabilities.js';
import { collectRunCandidates } from '../lib/accounting/rotate.js';
import { isInteractiveTerminal } from './utils.js';
import { buildSwitchAccountChoices, formatAccountLimits, pickSwitchAccount, type SwitchAccountRow } from './run-account-picker.js';
import { profileExists, readProfile, type Profile } from '../lib/profiles.js';
import { pushBundleToHost } from '../lib/secrets/push.js';
import { assertCredentialTransportHostPinned, resolveHostSshTarget } from '../lib/secrets/remote.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import { runDevicesAccounts } from './ssh.js';
import { discoverNativeAccounts } from '../lib/account-catalog.js';
import { readAndResolveBundleEnv } from '../lib/secrets/bundles.js';
import { getAccountProvider, listAccountProviders, type AccountAuthKind } from '../lib/account-provider-registry.js';
import { accountBindings, addAccount, addNativeAccount, bindAccount, findAccount, findUnifiedAccount, inspectAccount, listNativeAccounts, readAccountRegistry, removeAccount, renameAccount, setAccountSecret, unbindAccount, type UnifiedAccount } from '../lib/account-registry.js';
import { accountCapForTier, getTier, type EntitlementTier } from '../lib/entitlement.js';

function parseInstallation(raw: string): { agent: AgentId; version: string } {
  const at = raw.lastIndexOf('@');
  if (at < 1 || at === raw.length - 1) throw new Error(`Expected <agent>@<version>, got '${raw}'.`);
  const agent = resolveAgentName(raw.slice(0, at));
  if (!agent) throw new Error(`Unknown agent '${raw.slice(0, at)}'.`);
  return { agent, version: raw.slice(at + 1) };
}

export async function nativeIdentityFromSource(raw: string): Promise<{ agent: AgentId; version: string; identityKey: string; identityLabel?: string; scope: 'version' | 'device' }> {
  const parsed = parseInstallation(raw);
  const capability = nativeAccountCapability(parsed.agent);
  assertNativeAccountNameable(parsed.agent);
  if (!listInstalledVersions(parsed.agent).includes(parsed.version)) throw new Error(`${raw} is not installed.`);
  const info = await getAccountInfo(parsed.agent, getVersionHomePath(parsed.agent, parsed.version));
  const identityKey = nativeIdentityKey(info, capability);
  if (!identityKey) throw new Error(`${raw} has no stable signed-in identity. Run it and complete its normal login first.`);
  return { agent: parsed.agent, version: parsed.version, identityKey, identityLabel: info.email ?? undefined, scope: capability.scope as 'version' | 'device' };
}

type AttachTarget =
  | { kind: 'installation'; agent: AgentId; version: string }
  | { kind: 'device-agent'; agent: AgentId }
  | { kind: 'profile'; profile: Profile };

/**
 * Classify + validate an attach target, rejecting a typo BEFORE any binding is
 * written: it must be an existing custom-harness profile, an installed
 * `agent@version`, or a known harness id.
 */
export function classifyAttachTarget(target: string): AttachTarget {
  if (profileExists(target)) return { kind: 'profile', profile: readProfile(target) };
  if (target.includes('@')) {
    const at = target.lastIndexOf('@');
    const agent = resolveAgentName(target.slice(0, at));
    const version = target.slice(at + 1);
    if (!agent) throw new Error(`Unknown harness '${target.slice(0, at)}' in target '${target}'.`);
    if (!version) throw new Error(`Target '${target}' is missing a version.`);
    if (!listInstalledVersions(agent).includes(version)) throw new Error(`${agent}@${version} is not installed.`);
    return { kind: 'installation', agent, version };
  }
  const agent = resolveAgentName(target);
  if (agent) return { kind: 'device-agent', agent };
  throw new Error(`Unknown attach target '${target}'. Expected an installed <agent>@<version>, a harness id, or an existing custom harness profile.`);
}

export function parseBundleKey(raw: string): { bundle: string; key: string } {
  const colon = raw.indexOf(':');
  if (colon < 1 || colon === raw.length - 1) throw new Error(`Expected bundle:key, got '${raw}'.`);
  return { bundle: raw.slice(0, colon), key: raw.slice(colon + 1) };
}

function secretFromBundle(raw: string): string {
  const { bundle, key } = parseBundleKey(raw);
  return readAndResolveBundleEnv(bundle, { keys: [key], keyMode: 'storage', agentOnly: true, caller: 'accounts import' }).env[key];
}

function publicAccount(account: ReturnType<typeof inspectAccount>) {
  return { kind: 'provider' as const, id: account.id, name: account.name, provider: account.provider, auth: account.auth, baseUrl: account.baseUrl, policy: account.policy, secretPresent: account.secretPresent };
}

async function printAccounts(json: boolean, fleet = false): Promise<void> {
  if (fleet) return runDevicesAccounts({ json });
  const records = Object.values(readAccountRegistry().accounts).sort((a, b) => a.name.localeCompare(b.name));
  const discovered = await discoverNativeAccounts();
  const savedNative = listNativeAccounts(readMeta());
  const dormantIds = new Set<string>();
  for (const agent of ALL_AGENT_IDS) for (const account of await dormantAccountsForHarness(agent)) dormantIds.add(account.id);
  const native = discovered.map(row => {
    const saved = savedNative.find(account => account.agent === row.agent && account.identityKey === row.id);
    return { ...row, name: saved?.name, id: saved?.id ?? row.id, dormant: !!saved && dormantIds.has(saved.id) };
  });
  if (json) {
    console.log(JSON.stringify([...records.map(account => publicAccount(inspectAccount(account.name))), ...native], null, 2));
    return;
  }
  console.log(chalk.bold('Provider account bundles\n'));
  if (!records.length) console.log(chalk.gray("  None. Add one with 'agents accounts add <name> --provider <provider> --auth <type>'."));
  for (const account of records) {
    const present = inspectAccount(account.name).secretPresent ? chalk.green('ready') : chalk.red('missing on this device');
    console.log(`  ${chalk.cyan(account.name)}  ${account.provider}  ${account.auth}  ${present}`);
  }
  console.log(chalk.bold('\nNative harness logins\n'));
  if (!native.length) console.log(chalk.gray('  No signed-in native accounts found.'));
  for (const account of native) console.log(`  ${account.name ? `${chalk.cyan(account.name)} · ` : ''}${account.display}  ${account.agent}  ${account.versions.join(', ')}${account.dormant ? chalk.gray('  — dormant (upgrade to reactivate)') : ''}`);
}

function parseAuth(raw: string): AccountAuthKind {
  if (raw === 'api-key' || raw === 'setup-token' || raw === 'bearer-token') return raw;
  throw new Error(`Unsupported auth type '${raw}'. Use api-key, setup-token, or bearer-token.`);
}

function parseHarness(agentRaw: string): AgentId {
  if (!ALL_AGENT_IDS.includes(agentRaw as AgentId)) throw new Error(`Unknown agent '${agentRaw}'.`);
  return agentRaw as AgentId;
}

function providerAuthenticatesHarness(provider: string, auth: AccountAuthKind, agent: AgentId): boolean {
  try {
    getAccountProvider(provider).envFor(agent, auth);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('cannot authenticate')) return false;
    throw err;
  }
}

/** Every account (native + provider) registered/usable for this harness, oldest-first by name — the full set a plan-tier cap slices into active vs dormant. */
function accountsForHarness(agent: AgentId): UnifiedAccount[] {
  const meta = readMeta();
  const native = listNativeAccounts(meta).filter(account => account.agent === agent);
  const providers: UnifiedAccount[] = Object.values(readAccountRegistry().accounts)
    .filter(account => providerAuthenticatesHarness(account.provider, account.auth, agent))
    .map(account => ({ ...account, kind: 'provider' as const }));
  return [...native, ...providers].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Named accounts that `set-default` / `switch` can pin for this harness —
 * capped to the caller's plan tier (RUSH-2424). Downgrading never deletes a
 * credential: an over-cap account simply falls out of this list (see
 * {@link dormantAccountsForHarness}) and stops being a switch/rotation target
 * until the plan is upgraded.
 */
export async function listSwitchableAccounts(agent: AgentId): Promise<UnifiedAccount[]> {
  const cap = accountCapForTier(await getTier());
  return accountsForHarness(agent).slice(0, cap);
}

/** Accounts registered for this harness beyond the plan's cap — kept, never deleted, excluded from switch/rotation, reactivated by an upgrade. */
export async function dormantAccountsForHarness(agent: AgentId): Promise<UnifiedAccount[]> {
  const cap = accountCapForTier(await getTier());
  return accountsForHarness(agent).slice(cap);
}

function accountCapRefusalMessage(agent: AgentId, tier: EntitlementTier, cap: number): string {
  if (!tier.isPaid) return `free plan is capped at 3 ${agent} accounts (3/3). agents upgrade — up to 10 per harness.`;
  return `${tier.tierName} plan is capped at ${cap} ${agent} accounts (${cap}/${cap}).`;
}

/**
 * Refuse BEFORE any write when adding a new account would push one of
 * `harnesses` over the caller's plan cap. Returns the tier/cap/pre-add counts
 * so the caller can print the exactly-at-cap notice after a successful write.
 */
async function assertAccountCapacityFor(harnesses: AgentId[]): Promise<{ tier: EntitlementTier; cap: number; existing: Map<AgentId, number> }> {
  const tier = await getTier();
  const cap = accountCapForTier(tier);
  const existing = new Map<AgentId, number>();
  for (const harness of harnesses) existing.set(harness, accountsForHarness(harness).length);
  const capped = harnesses.find(harness => (existing.get(harness) ?? 0) >= cap);
  if (capped) throw new Error(accountCapRefusalMessage(capped, tier, cap));
  return { tier, cap, existing };
}

/** One-line, non-blocking notice for every harness a free-tier add just brought to exactly its cap. */
function printCapNoticesFor(harnesses: AgentId[], tier: EntitlementTier, cap: number, existing: Map<AgentId, number>): void {
  if (tier.isPaid) return;
  for (const harness of harnesses) {
    if ((existing.get(harness) ?? 0) + 1 === cap) {
      console.log(chalk.yellow(`${cap}/${cap} ${harness} accounts on the free plan. agents upgrade — up to 10 per harness.`));
    }
  }
}

/**
 * Pin the per-harness default. Shared by `accounts set-default` and `accounts switch`.
 * Provider accounts must authenticate the harness; native accounts must belong to it.
 */
export function setDefaultAccount(agentRaw: string, name: string): { agent: AgentId; account: UnifiedAccount } {
  const agent = parseHarness(agentRaw);
  const account = findUnifiedAccount(name, readMeta());
  if (!account) throw new Error(`Unknown account '${name}'.`);
  if (account.kind === 'provider') {
    getAccountProvider(account.provider).envFor(agent, account.auth);
  } else {
    if (account.agent !== agent) {
      throw new Error(`Account '${account.name}' is a ${account.agent} login and cannot be the default for ${agent}.`);
    }
    assertNativeAccountNameable(account.agent);
  }
  updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: { ...meta.accounts?.defaults, [agent]: account.id } } }));
  return { agent, account };
}

async function switchAccountRows(agent: AgentId): Promise<SwitchAccountRow[]> {
  const accounts = await listSwitchableAccounts(agent);
  const candidates = await collectRunCandidates(agent);
  const defaultId = readMeta().accounts?.defaults?.[agent];
  return accounts.map(account => {
    const candidate = account.kind === 'native'
      ? candidates.find(row => row.accountKey === account.identityKey) ?? null
      : null;
    return {
      accountName: account.name,
      kind: account.kind,
      detail: account.kind === 'provider' ? account.provider : (account.identityLabel ?? account.identityKey),
      current: account.id === defaultId,
      candidate,
    };
  });
}

export async function runAccountsSwitch(
  harness: string,
  accountName: string | undefined,
  opts: { json: boolean },
): Promise<void> {
  const agent = parseHarness(harness);
  const rows = await switchAccountRows(agent);
  if (accountName) {
    const { account } = setDefaultAccount(agent, accountName);
    if (opts.json) {
      console.log(JSON.stringify({ harness: agent, account: account.name, id: account.id }, null, 2));
      return;
    }
    console.log(chalk.green(`${agent} now uses account '${account.name}' unless --account overrides it.`));
    return;
  }
  if (opts.json) {
    const choices = buildSwitchAccountChoices(rows);
    console.log(JSON.stringify({
      harness: agent,
      default: rows.find(row => row.current)?.accountName ?? null,
      accounts: rows.map((row, i) => ({
        name: row.accountName,
        kind: row.kind,
        detail: row.detail,
        current: row.current,
        ready: choices[i].ready,
        limits: row.candidate ? formatAccountLimits(row.candidate) : 'limits unavailable',
      })),
    }, null, 2));
    return;
  }
  if (!isInteractiveTerminal()) {
    throw new Error(
      `Selecting a ${agent} account requires an interactive terminal.\nUse: agents accounts switch ${agent} <account>\nOr:  agents accounts set-default ${agent} <account>`,
    );
  }
  const selected = await pickSwitchAccount(agent, rows);
  if (!selected) return;
  const { account } = setDefaultAccount(agent, selected);
  console.log(chalk.green(`${agent} now uses account '${account.name}' unless --account overrides it.`));
}

export function registerAccountsCommand(program: Command): void {
  const accounts = program.command('accounts').description('Browse native logins and manage provider account bundles')
    .option('--json', 'Machine-readable account metadata')
    .option('--fleet', 'Show harness-native signed-in identities across reachable devices')
    .action((o: { json?: boolean; fleet?: boolean }) => printAccounts(!!o.json, !!o.fleet));
  accounts.command('list').description('List credential accounts').option('--json', 'Machine-readable account metadata').action((o: { json?: boolean }, command: Command) => printAccounts(!!(o.json || command.optsWithGlobals().json)));

  accounts.command('add <name>')
    .description('Add a durable API key, setup token, or bearer token')
    .requiredOption('--provider <provider>', `Credential provider (${listAccountProviders().join(', ')})`)
    .requiredOption('--auth <type>', 'Credential type: api-key | setup-token | bearer-token')
    .option('--base-url <url>', 'Optional endpoint override stored with the account')
    .option('--from-secrets <bundle:key>', 'Import from an existing agents secrets entry')
    .action(async (name: string, o: { provider: string; auth: string; baseUrl?: string; fromSecrets?: string }) => {
      const auth = parseAuth(o.auth);
      const provider = getAccountProvider(o.provider);
      if (!provider.authKinds.includes(auth)) throw new Error(`Provider '${provider.provider}' does not support ${auth}. Supported: ${provider.authKinds.join(', ')}.`);
      // A provider account may authenticate more than one harness (e.g. openrouter);
      // it counts toward every harness it can authenticate, so refuse before any
      // write if adding it would push ANY of those harnesses over the plan cap.
      const harnesses = ALL_AGENT_IDS.filter(h => providerAuthenticatesHarness(provider.provider, auth, h));
      const { tier, cap, existing } = await assertAccountCapacityFor(harnesses);
      const secret = o.fromSecrets ? secretFromBundle(o.fromSecrets) : await password({ message: `Enter ${provider.provider} ${auth} for '${name}':` });
      const account = addAccount(name, provider.provider, auth, secret, undefined, { baseUrl: o.baseUrl });
      console.log(chalk.green(`Added ${account.provider} ${account.auth} account '${account.name}'.`));
      console.log(chalk.gray(`Secret bundle '${account.name}' is the account and uses policy never, so agent launches never request Touch ID.`));
      printCapNoticesFor(harnesses, tier, cap, existing);
    });

  accounts.command('set-key <name>')
    .description('Rotate an account credential without changing its identity')
    .option('--from-secrets <bundle:key>', 'Import from an existing agents secrets entry')
    .action(async (name: string, o: { fromSecrets?: string }) => {
      const account = findAccount(name);
      if (!account) throw new Error(`Unknown provider account '${name}'.`);
      const secret = o.fromSecrets ? secretFromBundle(o.fromSecrets) : await password({ message: `Enter new ${account.provider} ${account.auth} for '${name}':` });
      setAccountSecret(name, secret);
      console.log(chalk.green(`Updated credential for account '${name}'.`));
    });

  accounts.command('view <name>').alias('inspect').description('Show safe account metadata, custody, and attachments').option('--json', 'Machine-readable output').action((name: string, o: { json?: boolean }, command: Command) => {
    const meta = readMeta();
    const unified = findUnifiedAccount(name, meta);
    if (!unified) throw new Error(`Unknown account '${name}'.`);
    const account = unified.kind === 'provider'
      ? { ...publicAccount(inspectAccount(unified.name)), custody: 'agents secrets (policy never)', attached: accountBindings(unified.id, meta) }
      : { ...unified, custody: `${unified.agent} (not stored by agents-cli)`, attached: accountBindings(unified.id, meta) };
    if (o.json || command.optsWithGlobals().json) return console.log(JSON.stringify(account, null, 2));
    console.log(chalk.bold(account.name));
    console.log(`  kind: ${account.kind}`);
    console.log(`  id: ${account.id}`);
    console.log(`  custody: ${account.custody}`);
    if (account.kind === 'provider') {
      console.log(`  provider: ${account.provider}`);
      console.log(`  auth: ${account.auth}`);
      console.log(`  credential: ${account.secretPresent ? 'present on this device' : 'missing on this device'}`);
    } else {
      console.log(`  identity: ${account.identityLabel ?? account.identityKey}`);
      console.log(`  scope: ${account.scope}`);
    }
    console.log(`  attached: ${account.attached.length ? account.attached.join(', ') : 'none'}`);
  });

  accounts.command('name <source> <name>')
    .description('Name a signed-in native installation without copying its OAuth credentials')
    .action(async (source: string, name: string) => {
      const identity = await nativeIdentityFromSource(source);
      const { tier, cap, existing } = await assertAccountCapacityFor([identity.agent]);
      const account = addNativeAccount(name, identity.agent, identity.identityKey, identity.identityLabel, identity.scope);
      console.log(chalk.green(`Named ${source} as ${account.name}.`));
      if (account.scope === 'device') console.log(chalk.gray(`${identity.agent} authentication is device-scoped; attach '${account.name}' to '${identity.agent}', not an individual version.`));
      printCapNoticesFor([identity.agent], tier, cap, existing);
    });

  accounts.command('attach <account> <target>')
    .description('Attach a named account to a native installation or custom harness')
    .action(async (name: string, target: string) => {
      const meta = readMeta();
      const account = findUnifiedAccount(name, meta);
      if (!account) throw new Error(`Unknown account '${name}'.`);
      if (account.kind === 'native') assertNativeAccountNameable(account.agent);
      // Validate the target exists before mutating any binding.
      const t = classifyAttachTarget(target);
      const targetAgent = t.kind === 'profile' ? t.profile.host.agent : t.agent;
      if (account.kind === 'native') {
        // A provider-backed profile injects provider env at spawn, which would run
        // under a different credential than the native identity claims — refuse it.
        if (t.kind === 'profile' && t.profile.provider) {
          throw new Error(`Custom harness '${target}' is provider-backed (${t.profile.provider}); it cannot host the native login account '${account.name}'. Attach a matching provider account instead.`);
        }
        if (targetAgent !== account.agent) throw new Error(`Account '${account.name}' is a ${account.agent} login; '${target}' runs ${targetAgent}.`);
        if (account.scope === 'device') {
          if (t.kind !== 'device-agent') throw new Error(`${account.agent} authentication is device-scoped. Attach it with 'agents accounts attach ${account.name} ${account.agent}'.`);
        } else {
          if (t.kind !== 'installation') throw new Error(`${account.agent} authentication is per-version. Attach '${account.name}' to a specific ${account.agent}@<version>.`);
          const identity = await nativeIdentityFromSource(target);
          if (identity.identityKey !== account.identityKey) throw new Error(`'${target}' is signed in to a different identity than account '${account.name}'.`);
        }
      } else {
        // Provider account: it must be able to authenticate the target's harness.
        getAccountProvider(account.provider).envFor(targetAgent, account.auth);
      }
      // Defense-in-depth cap check: by the point we get here `account` already
      // authenticates/belongs to `targetAgent` (validated above), so it is
      // already counted in accountsForHarness(targetAgent) from its `add`/`name`
      // time — this can only refuse if that invariant is ever violated, never a
      // normal re-attach of an account the harness is already at cap with.
      const tier = await getTier();
      const cap = accountCapForTier(tier);
      const alreadyCounted = accountsForHarness(targetAgent).some(existing => existing.id === account.id);
      const otherCount = accountsForHarness(targetAgent).length - (alreadyCounted ? 1 : 0);
      if (otherCount >= cap) throw new Error(accountCapRefusalMessage(targetAgent, tier, cap));
      bindAccount(name, target);
      console.log(chalk.green(`Attached ${account.name} to ${target}.`));
    });

  accounts.command('detach <account> <target>')
    .description('Remove one account attachment')
    .action((name: string, target: string) => {
      unbindAccount(name, target);
      console.log(chalk.green(`Detached ${name} from ${target}.`));
    });

  accounts.command('rename <old> <new>').description('Rename an account without changing its stable id').action((oldName: string, newName: string) => renameAccount(oldName, newName));
  accounts.command('remove <name>').description('Remove an account and its device-local credential').action((name: string) => removeAccount(name));

  accounts.command('set-default <agent> <name>')
    .description('Use this account for a harness when --account is omitted')
    .action((agentRaw: string, name: string) => {
      const { agent, account } = setDefaultAccount(agentRaw, name);
      console.log(chalk.green(`${agent} now uses account '${account.name}' unless --account overrides it.`));
    });

  const switchCmd = accounts.command('switch <harness> [account]')
    .description('Pick the default account for a harness')
    .option('--json', 'Machine-readable account list or the resulting default')
    .action(async (harness: string, account: string | undefined, o: { json?: boolean }, command: Command) => {
      await runAccountsSwitch(harness, account, { json: !!(o.json || command.optsWithGlobals().json) });
    });

  accounts.command('clear-default <agent>')
    .description('Return a harness to native login or balanced account selection')
    .action((agentRaw: string) => {
      parseHarness(agentRaw);
      updateMeta(meta => {
        const defaults = { ...meta.accounts?.defaults };
        delete defaults[agentRaw as AgentId];
        return { ...meta, accounts: { ...meta.accounts, defaults } };
      });
      console.log(chalk.green(`Cleared the default account for ${agentRaw}.`));
    });

  accounts.command('logout <target>')
    .description('Sign out a harness-native OAuth login. API-key / setup-token / bearer accounts use `accounts remove` instead.')
    .action(async (target: string) => {
      const provider = findAccount(target);
      if (provider) {
        throw new Error(
          `Account '${provider.name}' uses ${provider.auth}, not OAuth. Remove it with: agents accounts remove ${provider.name}`,
        );
      }
      const agentRaw = target.split('@')[0];
      if (!ALL_AGENT_IDS.includes(agentRaw as AgentId)) {
        throw new Error(
          `Unknown target '${target}'. Pass a native harness (claude, codex, …) or a provider account name. Provider API-key accounts use \`agents accounts remove\`.`,
        );
      }
      const agent = agentRaw as AgentId;
      const { spawnSync } = await import('child_process');
      const { getBinaryPath, getGlobalDefault, getVersionHomePath, listInstalledVersions } = await import('../lib/installations/versions.js');
      const installed = listInstalledVersions(agent);
      const version = getGlobalDefault(agent) ?? installed[installed.length - 1];
      if (!version) throw new Error(`No installed version of ${agent}. Install one with: agents add ${agent}`);
      const bin = getBinaryPath(agent, version);
      const home = getVersionHomePath(agent, version);
      const result = spawnSync(bin, ['logout'], {
        env: { ...process.env, HOME: home },
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if ((result.status ?? 1) !== 0) {
        throw new Error(
          `${agent} logout exited ${result.status ?? 'null'}. If this harness has no logout verb, sign out from its own UI.`,
        );
      }
      console.log(chalk.green(`Signed out native ${agent} login (${version}).`));
    });

  accounts.command('sync <name> [device]')
    .description('Copy one provider account bundle to a worker device')
    .option('--device <device>', 'Deprecated destination form; use the positional device')
    .option('--force', 'Replace matching keys on the destination')
    .action(async (name: string, deviceArg: string | undefined, o: { device?: string; force?: boolean }) => {
      const device = deviceArg ?? o.device;
      if (!device) throw new Error('Missing destination device. Usage: agents accounts sync <account> <device>.');
      const account = findAccount(name);
      if (!account) throw new Error(`Unknown provider account '${name}'.`);
      const sshTarget = await resolveHostSshTarget(device);
      assertCredentialTransportHostPinned(sshTarget);
      const remoteBackend = resolveRemoteOsSync(device) === 'win32' ? 'keychain' : 'file';
      const literalValues = {
        ACCOUNT_ID: account.id,
        PROVIDER: account.provider,
        AUTH_TYPE: account.auth,
        ...(account.baseUrl ? { BASE_URL: account.baseUrl } : {}),
      };
      const result = pushBundleToHost(account.name, device, {
        remoteBackend,
        force: o.force,
        operation: 'accounts sync',
        policyNever: true,
        agentOnly: false,
        literalValues,
      });
      if (!result.ok) throw new Error(`${result.message}\nRetry: agents accounts sync ${account.name} ${device}${o.force ? ' --force' : ''}`);
      console.log(chalk.green(`${account.name} synced to ${device} (${result.keyCount} keys, ${remoteBackend} backend, policy never).`));
    });

  setHelpSections(switchCmd, {
    examples: `agents accounts switch claude
agents accounts switch claude work
agents accounts switch claude --json
agents run claude`,
    notes: 'Switch writes the existing per-harness default (same binding as set-default). Rotation already honors it. Pass an account name to skip the picker. Native name/attach is only for harnesses agents-cli can isolate (claude, codex, grok); provider add is unrestricted.',
  });

  setHelpSections(accounts, {
    examples: `agents accounts add work --provider anthropic --auth setup-token
agents accounts add openrouter-work --provider openrouter --auth api-key --from-secrets openrouter.ai:OPENROUTER_API_KEY
agents accounts set-key work
agents accounts name claude@2.1.220 work
agents accounts attach work claude@2.1.225
agents accounts view work --json
agents accounts switch claude
agents accounts switch claude work
agents accounts set-default claude work
agents accounts sync openrouter-work yosemite-s0
agents run claude --account work
agents accounts logout claude`,
    notes: 'Native account records contain metadata only; harness-owned OAuth credentials are never copied. Provider accounts are explicit portable bundles with policy never. `accounts switch` is the fast picker over the same default `set-default` writes. Harness-native OAuth sign-out is `agents accounts logout <harness>` (API-key accounts use `accounts remove`). Synced vault unlock is `agents secrets vault unlock`.',
  });
}
