/**
 * `agents secrets vault` — unlock/lock the age-encrypted synced-secrets file
 * at ~/.agents/vault.age (distinct from `agents secrets unlock|lock`, which
 * holds keychain bundles in the secrets-agent).
 *
 * Formerly top-level `agents login` / `agents logout`.
 */

import chalk from 'chalk';
import type { Command } from 'commander';
import * as fs from 'fs';
import { readStdinSync } from '../lib/format.js';
import {
  clearVaultKey,
  createVault,
  getVaultSession,
  joinVault,
  unlock,
  vaultExists,
  vaultPath,
} from '../lib/secrets/vault.js';
import { setHelpSections } from '../lib/help.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

async function promptPassword(message: string): Promise<string> {
  if (!isInteractiveTerminal()) {
    throw new Error('A password is required. Run from a TTY or pass --password-stdin.');
  }
  const { password } = await import('@inquirer/prompts');
  return password({ message, mask: true });
}

async function readPassword(opts: { passwordStdin?: boolean }, message: string): Promise<string> {
  if (opts.passwordStdin) {
    const value = readStdinSync();
    if (!value) throw new Error('No password received on stdin.');
    return value.replace(/\r?\n$/, '');
  }
  return promptPassword(message);
}

async function chooseFreshMode(opts: { create?: boolean; join?: string }): Promise<'create' | 'join'> {
  if (opts.create && opts.join) throw new Error('--create and --join are mutually exclusive.');
  if (opts.create) return 'create';
  if (opts.join) return 'join';
  if (!isInteractiveTerminal()) {
    throw new Error('No synced secrets file exists. Pass --create or --join <vault.age> in a non-interactive shell.');
  }
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'No synced secrets vault found. What do you want to do?',
    choices: [
      { name: 'Create a new vault', value: 'create' as const },
      { name: 'Join with an existing vault.age file', value: 'join' as const },
    ],
  });
}

function formatRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Register `agents secrets vault unlock|lock` under the secrets parent. */
export function registerSecretsVaultCommands(secretsCmd: Command): void {
  const vault = secretsCmd
    .command('vault')
    .description('Unlock or lock the age-encrypted synced-secrets file (~/.agents/vault.age)');

  setHelpSections(vault, {
    examples: `agents secrets vault unlock
agents secrets vault unlock --create
agents secrets vault unlock --join ~/Downloads/vault.age
agents secrets vault lock`,
    notes: `This is the synced vault passphrase cache — not \`agents secrets unlock\`, which holds keychain bundles in the secrets-agent after Touch ID.
Harness OAuth sign-out is \`agents accounts logout\` (OAuth native logins only).`,
  });

  vault
    .command('unlock')
    .description('Unlock synced secrets for this shell session')
    .option('--create', 'Create a new encrypted synced-secrets file at ~/.agents/vault.age')
    .option('--join <path>', 'Copy and unlock an existing vault.age file')
    .option('--force', 'Replace an existing synced-secrets file when used with --create or --join')
    .option('--password-stdin', 'Read the master password from stdin')
    .action(async (opts: { create?: boolean; join?: string; force?: boolean; passwordStdin?: boolean }) => {
      try {
        if (opts.force && !opts.create && !opts.join) {
          throw new Error('--force can only be used with --create or --join.');
        }
        if (vaultExists() && !opts.create && !opts.join) {
          const password = await readPassword(opts, 'Master password');
          unlock(password);
          const session = getVaultSession();
          const ttl = session.loggedIn ? formatRemaining(session.expiresAt) : '8 hours';
          console.log(chalk.green(`Unlocked. Synced secrets available for ${ttl}.`));
          return;
        }

        const mode = await chooseFreshMode(opts);
        if (mode === 'join') {
          let source = opts.join;
          if (!source) {
            if (!isInteractiveTerminal()) throw new Error('--join needs a vault.age path.');
            const { input } = await import('@inquirer/prompts');
            source = await input({
              message: 'Path to existing vault.age',
              validate: (value: string) => fs.existsSync(value) || 'File not found.',
            });
          }
          const password = await readPassword(opts, 'Master password');
          joinVault(password, source, { overwrite: opts.force });
          console.log(chalk.green(`Unlocked. Copied synced secrets file to ${vaultPath()}.`));
          return;
        }

        const password = await readPassword(opts, 'Choose a master password');
        createVault(password, { overwrite: opts.force });
        console.log(chalk.green(`Unlocked. Created synced secrets file at ${vaultPath()}.`));
      } catch (err) {
        if (isPromptCancelled(err)) return;
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  vault
    .command('lock')
    .description('Forget the cached synced-secrets key')
    .action(() => {
      clearVaultKey();
      console.log(chalk.green('Locked. Synced secrets require unlock again.'));
    });
}
