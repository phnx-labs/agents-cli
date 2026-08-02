/**
 * `agents setup secrets` — guided defaults for `agents secrets` onboarding.
 *
 * The wizard writes setup preferences and delegates imports to the existing
 * `agents secrets import` command, keeping bundle storage as the source of truth.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import { getCliLaunch } from '../lib/cli-entry.js';
import { getHistoryDir, updateMeta } from '../lib/state.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';

type SetupSecretsBackend = 'keychain' | 'file' | 'vault';
type SetupSecretsPolicy = 'daily' | 'always' | 'never';
type SetupSecretsImportSource = 'none' | 'env' | '1password' | 'icloud';

interface SetupSecretsOptions {
  backend?: string;
  policy?: string;
  importFrom?: string;
  bundle?: string;
  vault?: string;
  iUnderstand?: boolean;
  force?: boolean;
}

interface SetupSecretsPrefs {
  defaultBackend: SetupSecretsBackend;
  defaultPolicy: SetupSecretsPolicy;
  updatedAt: string;
}

function defaultBackendForPlatform(platform: NodeJS.Platform = process.platform): SetupSecretsBackend {
  return platform === 'darwin' ? 'keychain' : 'file';
}

function setupSecretsPrefsPath(): string {
  return path.join(getHistoryDir(), 'setup', 'secrets.json');
}

function parseBackend(raw: string | undefined): SetupSecretsBackend {
  const value = (raw ?? defaultBackendForPlatform()).toLowerCase();
  if (value === 'keychain' || value === 'file' || value === 'vault') return value;
  throw new Error(`Invalid --backend '${raw}'. Use keychain, file, or vault.`);
}

function parsePolicy(raw: string | undefined): SetupSecretsPolicy {
  const value = (raw ?? 'daily').toLowerCase();
  if (value === 'daily' || value === 'always' || value === 'never') return value;
  throw new Error(`Invalid --policy '${raw}'. Use daily, always, or never.`);
}

function parseImportSource(raw: string | undefined): SetupSecretsImportSource {
  const value = (raw ?? 'none').toLowerCase();
  if (value === 'none' || value === 'env' || value === '1password' || value === 'icloud') return value;
  throw new Error(`Invalid --import-from '${raw}'. Use none, env, 1password, or icloud.`);
}

function hasCommand(command: string): boolean {
  const res = spawnSync(command, ['--version'], { stdio: 'ignore', windowsHide: true });
  return !res.error;
}

function saveSetupSecretsPrefs(prefs: SetupSecretsPrefs): string {
  const file = setupSecretsPrefsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 });
  return file;
}

function applySecretsDefaults(backend: SetupSecretsBackend, policy: SetupSecretsPolicy): void {
  updateMeta((meta) => ({
    ...meta,
    secrets: {
      ...meta.secrets,
      backend,
      ...(policy === 'never' ? {} : { policy }),
    },
  }));
}

function backendArgs(backend: SetupSecretsBackend): string[] {
  return backend === 'vault' ? ['--synced'] : ['--backend', backend];
}

function printBackendNotes(backend: SetupSecretsBackend): void {
  if (backend === 'keychain') {
    console.log(chalk.gray('backend: keychain — macOS reads may ask for Touch ID or the device password.'));
  } else if (backend === 'file') {
    console.log(chalk.gray('backend: file — set AGENTS_SECRETS_PASSPHRASE for headless encrypted-file reads.'));
  } else {
    console.log(chalk.gray('backend: vault — synced ~/.agents/vault.age storage; unlock it with agents login.'));
  }
}

function runAgentsSubcommand(args: string[]): void {
  const launch = getCliLaunch(args);
  const res = spawnSync(launch.command, launch.args, { stdio: 'inherit', env: process.env });
  if ((res.status ?? 1) !== 0) {
    throw new Error(`agents ${args.join(' ')} failed with exit ${res.status ?? 1}.`);
  }
}

async function maybeImportSecrets(
  source: SetupSecretsImportSource,
  opts: { bundle?: string; vault?: string; backend: SetupSecretsBackend; force?: boolean },
): Promise<void> {
  if (source === 'none') return;

  let bundle = opts.bundle;
  if (!bundle) {
    if (!isInteractiveTerminal()) {
      throw new Error(`--bundle is required with --import-from ${source} in a non-interactive shell.`);
    }
    const { input } = await import('@inquirer/prompts');
    bundle = await input({
      message: 'Import into which bundle?',
      default: 'default',
      validate: (v) => (v.trim().length > 0 ? true : 'Enter a bundle name.'),
    });
  }

  const args = ['secrets', 'import', bundle, ...backendArgs(opts.backend)];
  if (opts.force) args.push('--force');
  if (source === 'env') {
    let envPath = opts.vault;
    if (!envPath) {
      if (!isInteractiveTerminal()) {
        throw new Error('--vault must name the .env path when --import-from env is used non-interactively.');
      }
      const { input } = await import('@inquirer/prompts');
      envPath = await input({
        message: '.env file path',
        default: '.env',
        validate: (v) => (v.trim().length > 0 ? true : 'Enter a .env path.'),
      });
    }
    args.push('--from', envPath);
  } else if (source === '1password') {
    const vault = opts.vault;
    if (!vault) throw new Error('--vault <name> is required with --import-from 1password.');
    args.push('--from', `1password:${vault}`);
  } else {
    args.push('--from', 'icloud');
  }
  runAgentsSubcommand(args);
}

async function resolveInteractiveChoices(opts: SetupSecretsOptions): Promise<{
  backend: SetupSecretsBackend;
  policy: SetupSecretsPolicy;
  importSource: SetupSecretsImportSource;
}> {
  if (!isInteractiveTerminal()) {
    return {
      backend: parseBackend(opts.backend),
      policy: parsePolicy(opts.policy),
      importSource: parseImportSource(opts.importFrom),
    };
  }

  const { select } = await import('@inquirer/prompts');
  const backend = opts.backend ? parseBackend(opts.backend) : await select<SetupSecretsBackend>({
    message: 'Default secrets backend',
    default: defaultBackendForPlatform(),
    choices: [
      { name: 'keychain — local OS keychain; reads may ask for Touch ID/device password', value: 'keychain' },
      { name: 'file — passphrase-encrypted file store for headless machines', value: 'file' },
      { name: 'vault — synced ~/.agents/vault.age file; requires agents login', value: 'vault' },
    ],
  });
  const policy = opts.policy ? parsePolicy(opts.policy) : await select<SetupSecretsPolicy>({
    message: 'Default prompt policy',
    default: 'daily',
    choices: [
      { name: 'daily — ask once, then hold for the configured window', value: 'daily' },
      { name: 'always — ask on every read', value: 'always' },
      { name: 'never — no biometry ACL; use only for automation-only bundles', value: 'never' },
    ],
  });
  const importChoices = [
    { name: 'skip import', value: 'none' as const },
    { name: 'import from .env file', value: 'env' as const },
    ...(hasCommand('op') ? [{ name: 'import from 1Password vault', value: '1password' as const }] : []),
    { name: 'import legacy iCloud Keychain bundles', value: 'icloud' as const },
  ];
  const importSource = opts.importFrom ? parseImportSource(opts.importFrom) : await select<SetupSecretsImportSource>({
    message: 'Import existing secrets now?',
    default: 'none',
    choices: importChoices,
  });
  return { backend, policy, importSource };
}

function printOnboardingSummary(backend: SetupSecretsBackend, policy: SetupSecretsPolicy, prefsFile: string): void {
  console.log(chalk.bold('\nSecrets setup saved.'));
  console.log(chalk.gray(`preferences: ${prefsFile}`));
  printBackendNotes(backend);
  if (policy === 'never') {
    console.log(chalk.yellow('policy: never is saved as a setup preference; create automation-only bundles with --policy never --i-understand.'));
  } else {
    console.log(chalk.gray(`policy: ${policy} — used by bundles that do not set their own policy.`));
  }
  console.log(chalk.bold('\nTry:'));
  console.log(chalk.cyan(`  agents secrets create prod ${backendArgs(backend).join(' ')} --policy ${policy === 'never' ? 'daily' : policy}`));
  console.log(chalk.cyan('  agents secrets add prod API_KEY'));
  console.log(chalk.cyan('  agents run claude "deploy" --secrets prod'));
}

export async function runSecretsSetupWizard(opts: SetupSecretsOptions = {}): Promise<boolean> {
  const { backend, policy, importSource } = await resolveInteractiveChoices(opts);
  if (policy === 'never' && !opts.iUnderstand && !isInteractiveTerminal()) {
    throw new Error("Refusing to save policy 'never' non-interactively without --i-understand.");
  }

  applySecretsDefaults(backend, policy);
  const prefsFile = saveSetupSecretsPrefs({
    defaultBackend: backend,
    defaultPolicy: policy,
    updatedAt: new Date().toISOString(),
  });

  await maybeImportSecrets(importSource, {
    bundle: opts.bundle,
    vault: opts.vault,
    backend,
    force: opts.force,
  });

  printOnboardingSummary(backend, policy, prefsFile);
  return true;
}

/** Register `agents setup secrets` under the parent `setup` command. */
export function registerSetupSecretsCommand(setupCmd: Command): void {
  setupCmd
    .command('secrets')
    .description('Configure `agents secrets` defaults and optionally import existing secrets.')
    .option('--backend <backend>', 'default backend: keychain, file, or vault')
    .option('--policy <policy>', 'default prompt policy: daily, always, or never')
    .option('--import-from <source>', 'optional import source: none, env, 1password, or icloud')
    .option('--bundle <name>', 'bundle name for optional imports')
    .option('--vault <name-or-path>', '1Password vault name, or .env path with --import-from env')
    .option('--i-understand', 'allow saving the "never" policy preference without an interactive prompt')
    .option('--force', 'pass --force through to optional imports')
    .action(async (options: SetupSecretsOptions) => {
      try {
        await runSecretsSetupWizard(options);
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
