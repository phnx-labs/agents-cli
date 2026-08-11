/**
 * `agents artifacts setup` — configure the artifact share endpoint (Cloudflare
 * R2 + Worker) that backs `agents artifacts share`.
 *
 * One door, two modes, because it replaces two commands that used to be
 * separate (RUSH-2580): the interactive wizard formerly at `agents setup share`
 * and the flag-driven provisioner formerly at `agents share setup`. On a TTY
 * with no provisioning flags it runs the wizard (provision or join, and offers
 * a Worker update when an endpoint already exists); with any provisioning flag,
 * or on a non-TTY, it provisions directly. Both modes call the same
 * `runShareProvision` / `runShareJoin` in commands/share.ts, so there is a
 * single source of truth for provisioning.
 *
 * Idempotent: re-running shows the current endpoint and offers to reconfigure.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  DEFAULT_BUCKET_NAME,
  DEFAULT_CF_BUNDLE,
  DEFAULT_SHARE_DOMAIN,
  DEFAULT_WORKER_NAME,
  readShareConfig,
} from '../lib/share/config.js';
import { runShareProvision, runShareJoin, runShareUpdate, shareTemplateStatus } from './share.js';
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
        'The artifact share wizard needs an interactive terminal. ' +
          'Non-interactively, use `agents artifacts setup --account <id> --token <t>` (provision) ' +
          'or `agents artifacts share join <baseUrl> --token <t>`.',
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
    const templateStatus = shareTemplateStatus(existing);
    console.log(chalk.dim(`  template ${templateStatus}`));

    const { select } = await import('@inquirer/prompts');
    const action = await select({
      message: 'Share is already configured. What do you want to do?',
      choices: [
        { name: 'Keep as is', value: 'keep' as const },
        {
          name: 'Update the deployed Worker to the latest template',
          value: 'update' as const,
          description:
            templateStatus === 'current'
              ? 'Already current — this re-deploys anyway and refreshes the token in place.'
              : 'Re-deploys the Worker script on your existing endpoint (same account/worker/bucket, same write token).',
        },
        {
          name: 'Reconfigure from scratch (provision or join again)',
          value: 'reconfigure' as const,
        },
      ],
      default: templateStatus === 'outdated' || templateStatus === 'unknown' ? ('update' as const) : ('keep' as const),
    });

    if (action === 'keep') {
      console.log(chalk.dim('Keeping the current endpoint.'));
      return true;
    }
    if (action === 'update') {
      // When the template is already current, the description below promises a
      // re-deploy anyway — force it, or runShareUpdate's own no-op would silently
      // contradict what was just said.
      const result = await runShareUpdate({ force: templateStatus === 'current' });
      console.log(
        result.updated
          ? chalk.green(`Worker '${result.workerName}' updated → template ${result.templateHash.slice(0, 12)}…`)
          : chalk.dim(`Worker '${result.workerName}' already matches the current template — no-op.`),
      );
      return true;
    }
    // action === 'reconfigure' — fall through to the provision/join flow below.
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
        description: 'Use synced config when present, or paste the base URL + write token from the endpoint owner.',
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

/** Provisioning flags — the ones that make `artifacts setup` skip the wizard. */
interface ArtifactsSetupOpts {
  bundle: string;
  worker: string;
  bucket: string;
  account?: string;
  token?: string;
  domain?: string;
  analyticsToken?: string;
}

/**
 * True when the invocation named a Cloudflare endpoint detail, i.e. the caller
 * is driving the old `agents share setup` provisioning path rather than asking
 * for the wizard. `--bundle`/`--worker`/`--bucket` carry commander defaults and
 * are therefore always present, so they cannot be part of this signal — only
 * the flags with no default can.
 */
export function isDirectProvisionRequest(opts: ArtifactsSetupOpts): boolean {
  return Boolean(opts.account || opts.token || opts.domain || opts.analyticsToken);
}

/** Register `agents artifacts setup` under the parent `artifacts` command. */
export function registerArtifactsSetupCommand(artifactsCmd: Command): void {
  artifactsCmd
    .command('setup')
    .description('Provision (or join) the Cloudflare R2 + Worker endpoint that backs `agents artifacts share`.')
    .option('--bundle <name>', 'secrets bundle holding the Cloudflare API token', DEFAULT_CF_BUNDLE)
    .option('--worker <name>', 'Worker name', DEFAULT_WORKER_NAME)
    .option('--bucket <name>', 'R2 bucket name', DEFAULT_BUCKET_NAME)
    .option('--account <id>', 'Cloudflare account id (else read from the bundle / prompt)')
    .option('--token <t>', 'Cloudflare API token (else read from the --bundle)')
    .option('--domain <host>', `custom domain to map (default: ${DEFAULT_SHARE_DOMAIN}; workers.dev if zone is not visible)`)
    .option('--analytics-token <token>', 'Cloudflare Web Analytics token to inject into published HTML pages')
    .action(async (opts: ArtifactsSetupOpts) => {
      try {
        // Named endpoint details, or no terminal to prompt on, means provision
        // directly — the wizard has nothing to ask that was not already given.
        if (isDirectProvisionRequest(opts) || !isInteractiveTerminal()) {
          await runShareProvision(opts);
          return;
        }
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
