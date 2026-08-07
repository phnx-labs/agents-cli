import type { Command } from 'commander';
import chalk from 'chalk';
import { machineId } from '../lib/machine-id.js';
import { resolveAgentName, formatAgentError, getAccountInfo } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { getVersionHomePath, listInstalledVersions } from '../lib/versions.js';
import { bindAccount, identityFingerprint, readAccountBindings, readAccountLabels, removeAccountLabel, renameAccountLabel, setAccountLabel, unbindAccount } from '../lib/account-labels.js';
import { setHelpSections } from '../lib/help.js';

function parseTarget(raw: string): { agent: AgentId; version: string } {
  const at = raw.lastIndexOf('@'); if (at < 1 || at === raw.length - 1) throw new Error(`Expected <agent>@<version>, got '${raw}'.`);
  const name = raw.slice(0, at); const agent = resolveAgentName(name); if (!agent) throw new Error(formatAgentError(name));
  return { agent, version: raw.slice(at + 1) };
}
async function liveFingerprint(raw: string): Promise<{ agent: AgentId; fingerprint: string }> {
  const { agent, version } = parseTarget(raw); if (!listInstalledVersions(agent).includes(version)) throw new Error(`${raw} is not installed.`);
  const info = await getAccountInfo(agent, getVersionHomePath(agent, version));
  if (!info.signedIn || !info.accountKey) throw new Error(`${raw} has no stable signed-in identity. Sign in normally, then retry.`);
  return { agent, fingerprint: identityFingerprint(agent, info.accountKey) };
}
export function registerAccountsCommand(program: Command): void {
  const accounts = program.command('accounts').description('Name signed-in identities and bind them to installed harness versions');
  accounts.command('list').option('--json').option('--device <name>', 'Device bindings to show', machineId()).action((o: {json?: boolean; device: string}) => {
    const value = { ...readAccountLabels(), device: o.device, ...readAccountBindings(o.device) };
    if (o.json) return console.log(JSON.stringify(value, null, 2));
    const rows = Object.entries(value.labels); if (!rows.length) return console.log(chalk.gray('No account labels configured.'));
    for (const [name, label] of rows) console.log(`${chalk.cyan(name)}  ${Object.keys(label.identities).join(', ')}  ${Object.entries(value.bindings).filter(([, b]) => b.label === name).map(([t]) => t).join(', ')}`);
  });
  accounts.command('label <label> <target>').option('--device <name>', 'Device to bind', machineId()).action(async (label: string, target: string, o: {device: string}) => {
    const { agent } = parseTarget(target); const { fingerprint } = await liveFingerprint(target); const { version } = parseTarget(target);
    const info = await getAccountInfo(agent, getVersionHomePath(agent, version)); const stored = setAccountLabel(label, agent, info.accountKey!); bindAccount(o.device, target, label, stored);
    console.log(chalk.green(`Labeled and attached ${target} as '${label}' on ${o.device}.`));
  });
  accounts.command('attach <label> <targets...>').option('--device <name>', 'Device to bind', machineId()).action(async (label: string, targets: string[], o: {device: string}) => {
    const identities = readAccountLabels().labels[label]?.identities; if (!identities) throw new Error(`Unknown account label '${label}'.`);
    const verified = [] as Array<{ target: string; fingerprint: string }>;
    for (const target of targets) { const { agent, fingerprint } = await liveFingerprint(target); if (identities[agent]?.fingerprint !== fingerprint) throw new Error(`${target} is signed into a different identity than '${label}'. No binding was changed.`); verified.push({ target, fingerprint }); }
    for (const item of verified) { bindAccount(o.device, item.target, label, item.fingerprint); console.log(chalk.green(`Attached ${item.target} to '${label}' on ${o.device}.`)); }
  });
  accounts.command('detach <targets...>').option('--device <name>', 'Device to change', machineId()).action((targets: string[], o: {device: string}) => { for (const target of targets) unbindAccount(o.device, target); });
  accounts.command('rename <old> <new>').action((oldLabel: string, newLabel: string) => renameAccountLabel(oldLabel, newLabel));
  accounts.command('remove <label>').action((label: string) => removeAccountLabel(label));
  setHelpSections(accounts, { examples: `agents accounts label work claude@2.1.220\nagents accounts attach work claude@2.1.219 codex@0.146.0\nagents accounts list --json\nagents run claude --account work`, notes: 'Only identity fingerprints and intended bindings are stored. Credentials remain in each version home. Attach verifies the live identity before writing.' });
}
