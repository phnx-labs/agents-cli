import type { Command } from 'commander';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import { setHelpSections } from '../lib/help.js';
import { getKeychainToken, secretsKeychainItem } from '../lib/secrets/index.js';
import { getAccountProvider, listAccountProviders, type AccountAuthKind } from '../lib/account-provider-registry.js';
import { addAccount, findAccount, inspectAccount, readAccountRegistry, removeAccount, renameAccount, setAccountSecret } from '../lib/account-registry.js';

export function parseBundleKey(raw: string): { bundle: string; key: string } {
  const colon = raw.indexOf(':');
  if (colon < 1 || colon === raw.length - 1) throw new Error(`Expected bundle:key, got '${raw}'.`);
  return { bundle: raw.slice(0, colon), key: raw.slice(colon + 1) };
}

function secretFromBundle(raw: string): string {
  const { bundle, key } = parseBundleKey(raw);
  return getKeychainToken(secretsKeychainItem(bundle, key));
}

function publicAccount(account: ReturnType<typeof inspectAccount>) {
  return { id: account.id, name: account.name, provider: account.provider, auth: account.auth, secretPresent: account.secretPresent };
}

function printAccounts(json: boolean): void {
  const records = Object.values(readAccountRegistry().accounts).sort((a, b) => a.name.localeCompare(b.name));
  if (json) {
    console.log(JSON.stringify(records.map(account => publicAccount(inspectAccount(account.name))), null, 2));
    return;
  }
  if (!records.length) {
    console.log(chalk.gray("No credential accounts. Add one with 'agents accounts add <name> --provider <provider> --auth <type>'."));
    return;
  }
  console.log(chalk.bold('Credential accounts\n'));
  for (const account of records) {
    const present = inspectAccount(account.name).secretPresent ? chalk.green('ready') : chalk.red('missing on this device');
    console.log(`  ${chalk.cyan(account.name)}  ${account.provider}  ${account.auth}  ${present}`);
  }
}

function parseAuth(raw: string): AccountAuthKind {
  if (raw === 'api-key' || raw === 'setup-token' || raw === 'bearer-token') return raw;
  throw new Error(`Unsupported auth type '${raw}'. Use api-key, setup-token, or bearer-token.`);
}

export function registerAccountsCommand(program: Command): void {
  const accounts = program.command('accounts').description('Manage durable provider credentials').option('--json', 'Machine-readable account metadata').action((o: { json?: boolean }) => printAccounts(!!o.json));
  accounts.command('list').description('List credential accounts').option('--json', 'Machine-readable account metadata').action((o: { json?: boolean }, command: Command) => printAccounts(!!(o.json || command.optsWithGlobals().json)));

  accounts.command('add <name>')
    .description('Add a durable API key, setup token, or bearer token')
    .requiredOption('--provider <provider>', `Credential provider (${listAccountProviders().join(', ')})`)
    .requiredOption('--auth <type>', 'Credential type: api-key | setup-token | bearer-token')
    .option('--from-secrets <bundle:key>', 'Import from an existing agents secrets entry')
    .action(async (name: string, o: { provider: string; auth: string; fromSecrets?: string }) => {
      const auth = parseAuth(o.auth);
      const provider = getAccountProvider(o.provider);
      if (!provider.authKinds.includes(auth)) throw new Error(`Provider '${provider.provider}' does not support ${auth}. Supported: ${provider.authKinds.join(', ')}.`);
      const secret = o.fromSecrets ? secretFromBundle(o.fromSecrets) : await password({ message: `Enter ${provider.provider} ${auth} for '${name}':` });
      const account = addAccount(name, provider.provider, auth, secret);
      console.log(chalk.green(`Added ${account.provider} ${account.auth} account '${account.name}'.`));
      console.log(chalk.gray('The credential is stored in the device keychain; accounts.yaml contains metadata only.'));
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
    console.log(`  credential: ${account.secretPresent ? 'present on this device' : 'missing on this device'}`);
  });

  accounts.command('rename <old> <new>').description('Rename an account without changing its stable id').action((oldName: string, newName: string) => renameAccount(oldName, newName));
  accounts.command('remove <name>').description('Remove an account and its device-local credential').action((name: string) => removeAccount(name));

  setHelpSections(accounts, {
    examples: `agents accounts add work --provider anthropic --auth setup-token
agents accounts add openrouter-work --provider openrouter --auth api-key --from-secrets openrouter.ai:OPENROUTER_API_KEY
agents accounts set-key work
agents accounts inspect work --json
agents run claude --account work`,
    notes: 'Accounts are durable credentials, independent of agent versions. Native OAuth login remains managed by the harness and is not copied or renamed by agents-cli.',
  });
}
