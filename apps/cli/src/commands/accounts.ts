import type { Command } from 'commander';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { setHelpSections } from '../lib/help.js';
import { readMeta, updateMeta } from '../lib/state.js';
import type { AgentId } from '../lib/types.js';
import { ALL_AGENT_IDS, getAccountInfo, resolveAgentName } from '../lib/agents.js';
import { getVersionHomePath, listInstalledVersions } from '../lib/versions.js';
import { nativeAccountCapability, nativeAccountNameable, nativeIdentityKey } from '../lib/account-capabilities.js';
import { profileExists, readProfile, type Profile } from '../lib/profiles.js';
import { pushBundleToHost } from '../lib/secrets/push.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import { runDevicesAccounts } from './ssh.js';
import { discoverNativeAccounts } from '../lib/account-catalog.js';
import { readAndResolveBundleEnv } from '../lib/secrets/bundles.js';
import { getAccountProvider, listAccountProviders, type AccountAuthKind } from '../lib/account-provider-registry.js';
import { accountBindings, addAccount, addNativeAccount, bindAccount, findAccount, findUnifiedAccount, inspectAccount, listNativeAccounts, readAccountRegistry, removeAccount, renameAccount, setAccountSecret, unbindAccount } from '../lib/account-registry.js';

function parseInstallation(raw: string): { agent: AgentId; version: string } {
  const at = raw.lastIndexOf('@');
  if (at < 1 || at === raw.length - 1) throw new Error(`Expected <agent>@<version>, got '${raw}'.`);
  const agent = resolveAgentName(raw.slice(0, at));
  if (!agent) throw new Error(`Unknown agent '${raw.slice(0, at)}'.`);
  return { agent, version: raw.slice(at + 1) };
}

async function nativeIdentityFromSource(raw: string): Promise<{ agent: AgentId; version: string; identityKey: string; identityLabel?: string; scope: 'version' | 'device' }> {
  const parsed = parseInstallation(raw);
  const capability = nativeAccountCapability(parsed.agent);
  if (!nativeAccountNameable(parsed.agent)) {
    throw new Error(`${parsed.agent} native accounts are ${capability.status}; agents-cli cannot safely name or attach this login.`);
  }
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
  const native = discovered.map(row => {
    const saved = savedNative.find(account => account.agent === row.agent && account.identityKey === row.id);
    return { ...row, name: saved?.name, id: saved?.id ?? row.id };
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
  for (const account of native) console.log(`  ${account.name ? `${chalk.cyan(account.name)} · ` : ''}${account.display}  ${account.agent}  ${account.versions.join(', ')}`);
}

function parseAuth(raw: string): AccountAuthKind {
  if (raw === 'api-key' || raw === 'setup-token' || raw === 'bearer-token') return raw;
  throw new Error(`Unsupported auth type '${raw}'. Use api-key, setup-token, or bearer-token.`);
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
      const secret = o.fromSecrets ? secretFromBundle(o.fromSecrets) : await password({ message: `Enter ${provider.provider} ${auth} for '${name}':` });
      const account = addAccount(name, provider.provider, auth, secret, undefined, { baseUrl: o.baseUrl });
      console.log(chalk.green(`Added ${account.provider} ${account.auth} account '${account.name}'.`));
      console.log(chalk.gray(`Secret bundle '${account.name}' is the account and uses policy never, so agent launches never request Touch ID.`));
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
      const account = addNativeAccount(name, identity.agent, identity.identityKey, identity.identityLabel, identity.scope);
      console.log(chalk.green(`Named ${source} as ${account.name}.`));
      if (account.scope === 'device') console.log(chalk.gray(`${identity.agent} authentication is device-scoped; attach '${account.name}' to '${identity.agent}', not an individual version.`));
    });

  accounts.command('attach <account> <target>')
    .description('Attach a named account to a native installation or custom harness')
    .action(async (name: string, target: string) => {
      const meta = readMeta();
      const account = findUnifiedAccount(name, meta);
      if (!account) throw new Error(`Unknown account '${name}'.`);
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
    .description('Use a provider account for a harness when --account is omitted')
    .action((agentRaw: string, name: string) => {
      if (!ALL_AGENT_IDS.includes(agentRaw as AgentId)) throw new Error(`Unknown agent '${agentRaw}'.`);
      const agent = agentRaw as AgentId;
      const account = findAccount(name);
      if (!account) throw new Error(`Unknown provider account '${name}'.`);
      getAccountProvider(account.provider).envFor(agent, account.auth);
      // Defaults follow the stable account id, so renaming the bundle cannot
      // strand bare runs on a deleted label. findAccount accepts ids and names.
      updateMeta(meta => ({ ...meta, accounts: { ...meta.accounts, defaults: { ...meta.accounts?.defaults, [agent]: account.id } } }));
      console.log(chalk.green(`${agent} now uses account '${account.name}' unless --account overrides it.`));
    });

  accounts.command('clear-default <agent>')
    .description('Return a harness to native login or balanced account selection')
    .action((agentRaw: string) => {
      if (!ALL_AGENT_IDS.includes(agentRaw as AgentId)) throw new Error(`Unknown agent '${agentRaw}'.`);
      updateMeta(meta => {
        const defaults = { ...meta.accounts?.defaults };
        delete defaults[agentRaw as AgentId];
        return { ...meta, accounts: { ...meta.accounts, defaults } };
      });
      console.log(chalk.green(`Cleared the default account for ${agentRaw}.`));
    });

  accounts.command('sync <name> [device]')
    .description('Copy one provider account bundle to a worker device')
    .option('--device <device>', 'Deprecated destination form; use the positional device')
    .option('--force', 'Replace matching keys on the destination')
    .action((name: string, deviceArg: string | undefined, o: { device?: string; force?: boolean }) => {
      const device = deviceArg ?? o.device;
      if (!device) throw new Error('Missing destination device. Usage: agents accounts sync <account> <device>.');
      const account = findAccount(name);
      if (!account) throw new Error(`Unknown provider account '${name}'.`);
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

  setHelpSections(accounts, {
    examples: `agents accounts add work --provider anthropic --auth setup-token
agents accounts add openrouter-work --provider openrouter --auth api-key --from-secrets openrouter.ai:OPENROUTER_API_KEY
agents accounts set-key work
agents accounts name claude@2.1.220 work
agents accounts attach work claude@2.1.225
agents accounts view work --json
agents accounts set-default claude work
agents accounts sync openrouter-work yosemite-s0
agents run claude --account work`,
    notes: 'Native account records contain metadata only; harness-owned OAuth credentials are never copied. Provider accounts are explicit portable bundles with policy never.',
  });
}
