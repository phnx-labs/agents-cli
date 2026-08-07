import type { Command } from 'commander';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';
import { resolveAgentName, formatAgentError } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { listInstalledVersions } from '../lib/versions.js';
import { discoverAccounts, identityFingerprint, nameAccount, readAccountLabels, removeAccountLabel, renameAccountLabel } from '../lib/account-labels.js';
import { setHelpSections } from '../lib/help.js';

function parseSource(raw: string): { agent: AgentId; version: string } { const at = raw.lastIndexOf('@'); if (at < 1 || at === raw.length - 1) throw new Error(`Expected <agent>@<version>, got '${raw}'.`); const name = raw.slice(0, at); const agent = resolveAgentName(name); if (!agent) throw new Error(formatAgentError(name)); return { agent, version: raw.slice(at + 1) }; }
export async function fingerprintFromSource(
  raw: string,
  deps: { installedVersions?: typeof listInstalledVersions; discover?: typeof discoverAccounts } = {},
): Promise<{ agent: AgentId; fingerprint: string; versions: string[] }> {
  const { agent, version } = parseSource(raw);
  if (!(deps.installedVersions ?? listInstalledVersions)(agent).includes(version)) throw new Error(`${raw} is not installed.`);
  const account = (await (deps.discover ?? discoverAccounts)([agent])).find(candidate => candidate.versions.includes(version));
  if (!account) throw new Error(`${raw} has no stable signed-in account. Run it and complete its normal login first.`);
  return { agent, fingerprint: account.fingerprint, versions: account.versions };
}
async function printAccounts(json: boolean): Promise<void> { const accounts = await discoverAccounts(); if (json) return console.log(JSON.stringify(accounts, null, 2)); if (!accounts.length) return console.log(chalk.gray('No signed-in accounts found. Run an installed agent and complete its normal login first.')); console.log(chalk.bold('Signed-in accounts\n')); for (const account of accounts) console.log(`  ${account.label ? chalk.cyan(account.label) : chalk.gray('(unnamed)')}  ${account.agent}  ${account.display}\n    ${account.versions.length} installed version${account.versions.length === 1 ? '' : 's'}: ${account.versions.join(', ')}`); }
async function chooseAccount() { const accounts = await discoverAccounts(); if (!accounts.length) throw new Error('No signed-in accounts found. Run an installed agent and complete its normal login first.'); return select({ message: 'Which signed-in account do you want to name?', choices: accounts.map(account => ({ name: `${account.agent}  ${account.display}  (${account.versions.length} version${account.versions.length === 1 ? '' : 's'})${account.label ? `  currently “${account.label}”` : ''}`, value: account })) }); }

export function registerAccountsCommand(program: Command): void {
  const accounts = program.command('accounts').description('Browse and name signed-in harness accounts').option('--json', 'Machine-readable discovered accounts').action(async (o: {json?: boolean}) => printAccounts(!!o.json));
  accounts.command('list').description('Alias for accounts').option('--json').action((o: {json?: boolean}) => printAccounts(!!o.json));
  accounts.command('name <label>').description('Name one signed-in account; matching installed versions are found automatically').option('--from <agent@version>', 'Non-interactive identity source').action(async (label: string, o: {from?: string}) => { const picked = o.from ? await fingerprintFromSource(o.from) : await chooseAccount(); nameAccount(label, picked.agent, picked.fingerprint); console.log(chalk.green(`Named the ${picked.agent} account '${label}'.`)); console.log(chalk.gray(`Found it in ${picked.versions.length} installed version${picked.versions.length === 1 ? '' : 's'}: ${picked.versions.join(', ')}`)); });
  accounts.command('rename <old> <new>').action((oldLabel: string, newLabel: string) => renameAccountLabel(oldLabel, newLabel));
  accounts.command('remove <label>').action((label: string) => removeAccountLabel(label));
  setHelpSections(accounts, { examples: `agents accounts\nagents accounts name work\nagents accounts name work --from claude@2.1.220\nagents run claude --account work`, notes: 'First run the harness and complete its normal login. A label names one provider account; every matching installed version is discovered automatically. OAuth credentials are never copied or shared.' });
}
