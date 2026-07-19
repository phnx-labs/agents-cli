/**
 * `agents setup share` — interactive wizard to configure the `agents share`
 * endpoint (Cloudflare R2 + Worker). A friendly front door over the existing
 * `agents share setup` (provision) and `agents share join` flows, reusing their
 * exact logic so there is a single source of truth for provisioning.
 *
 * Idempotent: re-running shows the current endpoint and offers to reconfigure.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  DEFAULT_BUCKET_NAME,
  DEFAULT_CF_BUNDLE,
  DEFAULT_WORKER_NAME,
  readShareConfig,
} from '../lib/share/config.js';
import { runShareProvision, runShareJoin } from './share.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

/**
 * Interactive share setup. Returns true if the user configured (or already had)
 * an endpoint, false if they skipped. Never throws on user cancel — callers
 * (the `agents setup` hub) rely on that to keep the fresh-machine flow going.
 */
export async function runShareWizard(): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    console.error(
      chalk.red(
        'agents setup share needs an interactive terminal. ' +
          'Non-interactively, use `agents share setup` (provision) or `agents share join <url>`.',
      ),
    );
    return false;
  }

  const existing = readShareConfig();
  if (existing) {
    console.log(chalk.dim(`Share is already configured → ${chalk.green(existing.baseUrl)}`));
    console.log(
      chalk.dim(`  worker ${existing.workerName} · bucket ${existing.bucketName} · account ${existing.accountId}`),
    );
    const { confirm } = await import('@inquirer/prompts');
    const reconfigure = await confirm({ message: 'Reconfigure the share endpoint?', default: false });
    if (!reconfigure) {
      console.log(chalk.dim('Keeping the current endpoint.'));
      return true;
    }
  }

  const { select } = await import('@inquirer/prompts');
  const mode = await select({
    message: 'How do you want to publish shared links?',
    choices: [
      {
        name: 'Provision my own (Cloudflare R2 + Worker)',
        value: 'provision' as const,
        description: 'One-time: creates a bucket + Worker on your Cloudflare account (~$0). Needs a Cloudflare API token.',
      },
      {
        name: 'Join an existing endpoint (a teammate already provisioned one)',
        value: 'join' as const,
        description: 'Paste the base URL + write token from whoever owns the endpoint.',
      },
    ],
  });

  if (mode === 'provision') {
    await runShareProvision({
      bundle: DEFAULT_CF_BUNDLE,
      worker: DEFAULT_WORKER_NAME,
      bucket: DEFAULT_BUCKET_NAME,
    });
    return true;
  }

  const { input } = await import('@inquirer/prompts');
  const baseUrl = await input({
    message: 'Endpoint base URL (e.g. https://share.agents-cli.sh)',
    validate: (v) => (v.trim().startsWith('http') ? true : 'Enter the full https:// URL of the endpoint.'),
  });
  await runShareJoin(baseUrl.trim());
  return true;
}

/** Register `agents setup share` under the parent `setup` command. */
export function registerSetupShareCommand(setupCmd: Command): void {
  setupCmd
    .command('share')
    .description('Configure the `agents share` endpoint (Cloudflare R2 + Worker) — provision your own or join one.')
    .action(async () => {
      try {
        await runShareWizard();
      } catch (err) {
        if (isPromptCancelled(err)) {
          console.log(chalk.yellow('\nCancelled'));
          return;
        }
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });
}
