import type { Command } from 'commander';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { setHelpSections } from '../lib/help.js';
import { readMeta, updateMeta } from '../lib/state.js';
import type { AgentId } from '../lib/types.js';
import { ALL_AGENT_IDS } from '../lib/agents.js';
import { pushBundleToHost } from '../lib/secrets/push.js';
import { resolveRemoteOsSync } from '../lib/hosts/remote-os.js';
import { runDevicesAccounts } from './ssh.js';
import { discoverNativeAccounts } from '../lib/account-catalog.js';
import { readAndResolveBundleEnv } from '../lib/secrets/bundles.js';
import { getAccountProvider, listAccountProviders, type AccountAuthKind } from '../lib/account-provider-registry.js';
import { addAccount, findAccount, inspectAccount, readAccountRegistry, removeAccount, renameAccount, setAccountSecret } from '../lib/account-registry.js';

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
  const native = await discoverNativeAccounts();
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
  for (const account of native) console.log(`  ${chalk.cyan(account.display)}  ${account.agent}  ${account.versions.join(', ')}`);
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
      if (!account) throw new Error(`Unknown account '${name}'.`);
      const secret = o.fromSecrets ? secretFromBundle(o.fromSecrets) : await password({ message: `Enter new ${account.provider} ${account.auth} for '${name}':` });
      setAccountSecret(name, secret);
      console.log(chalk.green(`Updated credential for account '${name}'.`));
    });

  accounts.command('inspect <name>').description('Show safe account metadata').option('--json', 'Machine-readable output').action((name: string, o: { json?: boolean }, command: Command) => {
    const account = publicAccount(inspectAccount(name));
    if (o.json || command.optsWithGlobals().json) return console.log(JSON.stringify(account, null, 2));
    console.log(`${chalk.bold(account.name)}  ${account.provider}`);
    console.log(`  auth: ${account.auth}`);
    console.log(`  id: ${account.id}`);
    console.log(`  policy: ${account.policy}`);
    if (account.baseUrl) console.log(`  base url: ${account.baseUrl}`);
    console.log(`  credential: ${account.secretPresent ? 'present on this device' : 'missing on this device'}`);
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

  accounts.command('sync <name>')
    .description('Copy one provider account bundle to a worker device')
    .requiredOption('--device <device>', 'Destination device or SSH host')
    .option('--force', 'Replace matching keys on the destination')
    .action((name: string, o: { device: string; force?: boolean }) => {
      const account = findAccount(name);
      if (!account) throw new Error(`Unknown provider account '${name}'.`);
      const remoteBackend = resolveRemoteOsSync(o.device) === 'win32' ? 'keychain' : 'file';
      const literalValues = {
        ACCOUNT_ID: account.id,
        PROVIDER: account.provider,
        AUTH_TYPE: account.auth,
        ...(account.baseUrl ? { BASE_URL: account.baseUrl } : {}),
      };
      const result = pushBundleToHost(account.name, o.device, {
        remoteBackend,
        force: o.force,
        operation: 'accounts sync',
        policyNever: true,
        agentOnly: false,
        literalValues,
      });
      if (!result.ok) throw new Error(`${result.message}\nRetry: agents accounts sync ${account.name} --device ${o.device}${o.force ? ' --force' : ''}`);
      console.log(chalk.green(`${account.name} synced to ${o.device} (${result.keyCount} keys, ${remoteBackend} backend, policy never).`));
    });

  setHelpSections(accounts, {
    examples: `agents accounts add work --provider anthropic --auth setup-token
agents accounts add openrouter-work --provider openrouter --auth api-key --from-secrets openrouter.ai:OPENROUTER_API_KEY
agents accounts set-key work
agents accounts inspect work --json
agents accounts set-default claude work
agents accounts sync work --device yosemite-s0
agents run claude --account work`,
    notes: 'Provider accounts are durable credentials independent of agent versions. Harness-native auth remains managed by each harness and is not copied or renamed by agents-cli.',
  });
}
