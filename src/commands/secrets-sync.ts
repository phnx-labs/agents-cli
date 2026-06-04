/**
 * `agents secrets push|pull` subcommands.
 *
 * Replaces iCloud Keychain as the cross-device sync mechanism with explicit
 * encrypted-at-rest sync against api.prix.dev. Plaintext never leaves the
 * machine — bundle contents are sealed with AES-256-GCM under a user-supplied
 * passphrase before upload.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  listRemoteBundles,
  MIN_PASSPHRASE_LEN,
  pullBundle,
  pushBundle,
} from '../lib/secrets/sync.js';
import { bundleExists, listBundles } from '../lib/secrets/bundles.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

async function promptPassphrase(message: string, confirm = false): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A sync passphrase is required. Run from a TTY, or set AGENTS_SECRETS_PASSPHRASE.');
  }
  const { password } = await import('@inquirer/prompts');
  const first = await password({ message, mask: true });
  if (first.length < MIN_PASSPHRASE_LEN) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters.`);
  if (!confirm) return first;
  const second = await password({ message: 'Confirm passphrase', mask: true });
  if (first !== second) throw new Error('Passphrases do not match.');
  return first;
}

function passphraseFromEnvOrPrompt(confirm: boolean): Promise<string> {
  const fromEnv = process.env.AGENTS_SECRETS_PASSPHRASE;
  if (fromEnv) {
    if (fromEnv.length < MIN_PASSPHRASE_LEN) {
      return Promise.reject(new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters.`));
    }
    return Promise.resolve(fromEnv);
  }
  return promptPassphrase('Sync passphrase', confirm);
}

/** Register `agents secrets push|pull|remote-list` on the parent secrets Command. */
export function registerSecretsSyncCommands(secrets: Command): void {
  secrets
    .command('push [name]')
    .description('Encrypt a local bundle and upload it to api.prix.dev (replaces iCloud Keychain sync).')
    .option('--all', 'Push every local bundle (each prompts independently if no passphrase env var is set)')
    .action(async (name: string | undefined, opts: { all?: boolean }) => {
      try {
        if (opts.all) {
          const bundles = listBundles();
          if (bundles.length === 0) {
            console.log(chalk.gray('No local bundles to push.'));
            return;
          }
          const passphrase = await passphraseFromEnvOrPrompt(true);
          for (const b of bundles) {
            try {
              const { updated_at } = await pushBundle(b.name, { passphrase });
              console.log(chalk.green(`Pushed '${b.name}' (updated_at=${updated_at}).`));
            } catch (err) {
              console.error(chalk.red(`Failed to push '${b.name}': ${(err as Error).message}`));
            }
          }
          return;
        }
        if (!name) {
          throw new Error('Bundle name required. Try: agents secrets push <name> | agents secrets push --all');
        }
        if (!bundleExists(name)) {
          throw new Error(`Bundle '${name}' not found locally.`);
        }
        const passphrase = await passphraseFromEnvOrPrompt(true);
        const { updated_at } = await pushBundle(name, { passphrase });
        console.log(chalk.green(`Pushed '${name}' to api.prix.dev (updated_at=${updated_at}).`));
        console.log(chalk.gray('Remember the passphrase — it is required to pull this bundle on another machine.'));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  secrets
    .command('pull [name]')
    .description('Decrypt a remote bundle from api.prix.dev and restore it into the local keychain.')
    .option('--all', 'Pull every bundle visible on the remote')
    .option('--force', 'Overwrite a local bundle with the same name')
    .action(async (name: string | undefined, opts: { all?: boolean; force?: boolean }) => {
      try {
        if (opts.all) {
          const remote = await listRemoteBundles();
          if (remote.length === 0) {
            console.log(chalk.gray('No remote bundles found.'));
            return;
          }
          const passphrase = await passphraseFromEnvOrPrompt(false);
          for (const r of remote) {
            try {
              await pullBundle(r.name, { passphrase, force: opts.force });
              console.log(chalk.green(`Pulled '${r.name}'.`));
            } catch (err) {
              console.error(chalk.red(`Failed to pull '${r.name}': ${(err as Error).message}`));
            }
          }
          return;
        }
        if (!name) {
          throw new Error('Bundle name required. Try: agents secrets pull <name> | agents secrets pull --all');
        }
        const passphrase = await passphraseFromEnvOrPrompt(false);
        const bundle = await pullBundle(name, { passphrase, force: opts.force });
        const keyCount = Object.keys(bundle.vars).length;
        console.log(chalk.green(`Pulled '${name}' (${keyCount} key${keyCount === 1 ? '' : 's'}) into local keychain.`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  secrets
    .command('remote-list')
    .alias('remote-ls')
    .description('List bundles currently stored on api.prix.dev for this account.')
    .action(async () => {
      try {
        const remote = await listRemoteBundles();
        if (remote.length === 0) {
          console.log(chalk.gray('No remote bundles found.'));
          return;
        }
        console.log(chalk.bold(`${'NAME'.padEnd(24)} UPDATED_AT`));
        for (const r of remote) {
          console.log(`${chalk.cyan(r.name.padEnd(24))} ${chalk.gray(r.updated_at)}`);
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
