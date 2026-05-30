/**
 * `agents helper` -- install, inspect, and reinstall the signed macOS
 * Keychain helper at the stable user path.
 *
 * The signed `Agents CLI.app` ships inside the npm package, but its keychain
 * ACLs need a stable signature-pinned location to survive `npm i -g` and
 * version bumps. This command copies it to
 * `~/Library/Application Support/agents-cli/` once and lets users force a
 * reinstall when the trusted-app ACL needs to be re-established.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  ensureKeychainHelperInstalled,
  getKeychainHelperPath,
  getKeychainHelperStatus,
} from '../lib/secrets/install-helper.js';

function requireDarwin(): void {
  if (process.platform !== 'darwin') {
    console.error(chalk.red('agents helper: macOS only.'));
    process.exit(1);
  }
}

export function registerHelperCommand(program: Command): void {
  const cmd = program
    .command('helper')
    .description('Manage the signed macOS Keychain helper (.app) install');

  cmd
    .command('install')
    .description('Copy the bundled .app to ~/Library/Application Support/agents-cli/')
    .action(() => {
      requireDarwin();
      try {
        ensureKeychainHelperInstalled({ forceReinstall: true });
      } catch (err: any) {
        console.error(chalk.red(err.message || String(err)));
        process.exit(1);
      }
      const s = getKeychainHelperStatus();
      console.log(chalk.green('Installed:'), s.destination);
      console.log(chalk.dim('codesign:'), s.codesignOk ? chalk.green('ok') : chalk.red(s.codesignOutput));
      console.log(chalk.dim('spctl:   '), s.spctlOk ? chalk.green('ok') : chalk.yellow(s.spctlOutput));
    });

  cmd
    .command('update')
    .description('Reinstall the .app, overwriting any existing copy (alias of install)')
    .action(() => {
      requireDarwin();
      try {
        ensureKeychainHelperInstalled({ forceReinstall: true });
      } catch (err: any) {
        console.error(chalk.red(err.message || String(err)));
        process.exit(1);
      }
      const s = getKeychainHelperStatus();
      console.log(chalk.green('Updated: '), s.destination);
      console.log(chalk.dim('codesign:'), s.codesignOk ? chalk.green('ok') : chalk.red(s.codesignOutput));
      console.log(chalk.dim('spctl:   '), s.spctlOk ? chalk.green('ok') : chalk.yellow(s.spctlOutput));
    });

  cmd
    .command('status')
    .description('Show source, destination, codesign and notarization status')
    .action(() => {
      requireDarwin();
      const s = getKeychainHelperStatus();
      console.log(chalk.bold('Source:     '), s.source ?? chalk.red('(not found)'));
      console.log(chalk.bold('Destination:'), s.destination);
      console.log(chalk.bold('Installed:  '), s.installed ? chalk.green('yes') : chalk.yellow('no'));
      if (s.installed) {
        console.log(chalk.bold('codesign:   '), s.codesignOk ? chalk.green('ok') : chalk.red(s.codesignOutput));
        console.log(chalk.bold('spctl:      '), s.spctlOk ? chalk.green('ok') : chalk.yellow(s.spctlOutput));
      } else {
        console.log(chalk.dim('Run `agents helper install` to copy the bundled .app to the destination.'));
      }
    });

  cmd
    .command('where')
    .description('Print the absolute path to the installed helper executable')
    .action(() => {
      requireDarwin();
      try {
        console.log(getKeychainHelperPath());
      } catch (err: any) {
        console.error(chalk.red(err.message || String(err)));
        process.exit(1);
      }
    });
}
