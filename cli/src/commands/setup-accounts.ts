/**
 * `agents setup accounts` — mint a Claude setup-token so unattended usage/probe
 * is not stuck on "usage pending". Delegates to the same mint engine as
 * `agents accounts mint` / `agents auth mint`.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { hasMintedSetupToken, mintAndSeed } from '../lib/auth-mint.js';

export async function runAccountsSetupWizard(): Promise<void> {
  const status = hasMintedSetupToken();
  if (status.ready) {
    console.log(chalk.green(`Setup-token already minted (${status.detail}).`));
    console.log(chalk.gray('Re-mint with: agents accounts mint claude'));
    return;
  }
  if (!isInteractiveTerminal()) {
    console.log(chalk.yellow('No Claude setup-token on this machine.'));
    console.log(chalk.gray('Mint one with: agents accounts mint claude'));
    console.log(chalk.gray('Already have a token: agents accounts mint claude --token-stdin'));
    process.exitCode = 1;
    return;
  }
  const proceed = await confirm({
    message: 'Mint a Claude setup-token now? (opens a browser; seeds a named account + the reserved auth bundle)',
    default: true,
  });
  if (!proceed) {
    console.log(chalk.gray('Skipped. Run `agents accounts mint claude` when ready.'));
    return;
  }
  const result = await mintAndSeed({ harness: 'claude' });
  console.log(chalk.green(`Minted account '${result.account}' for ${result.email}.`));
}

export function registerSetupAccountsCommand(setupCmd: Command): void {
  setupCmd
    .command('accounts')
    .description('Mint a Claude setup-token into a named account (unattended usage/probe).')
    .action(async () => {
      try {
        await runAccountsSetupWizard();
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });
}
