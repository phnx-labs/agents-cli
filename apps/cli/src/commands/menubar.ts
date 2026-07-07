/**
 * `agents menubar` — manage the macOS menu-bar helper.
 *
 * The helper is a no-Dock status-bar app that surfaces running sessions, agents
 * needing input, and routines, and launches new sessions. It auto-installs on
 * upgrade (runMigration -> installMenubarLaunchAgentOnUpgrade) for every macOS
 * user; these commands are the manual override.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  enableMenubarService,
  disableMenubarService,
  getMenubarStatus,
} from '../lib/menubar/install-menubar.js';

function notMac(): boolean {
  if (process.platform !== 'darwin') {
    console.log(chalk.yellow('The menu bar helper is macOS only.'));
    return true;
  }
  return false;
}

export function registerMenubarCommands(program: Command): void {
  const menubar = program
    .command('menubar')
    .description('Manage the macOS menu-bar helper (running sessions, agents awaiting input, routines)');

  menubar
    .command('enable')
    .description('Install and start the menu-bar helper (launches at login)')
    .action(() => {
      if (notMac()) return;
      const ok = enableMenubarService({ clearOptOut: true });
      if (!ok) {
        console.log(chalk.red('Could not enable: no menu-bar helper bundle ships with this install.'));
        console.log(chalk.gray('  This build may predate the helper, or be a non-macOS package.'));
        return;
      }
      console.log(chalk.green('Menu bar helper enabled.') + chalk.gray('  Look for the agents mark in your menu bar.'));
    });

  menubar
    .command('disable')
    .description('Stop and remove the menu-bar helper (stays off across upgrades)')
    .action(() => {
      if (notMac()) return;
      disableMenubarService();
      console.log(chalk.green('Menu bar helper disabled.') + chalk.gray('  Re-enable any time with `agents menubar enable`.'));
    });

  menubar
    .command('status')
    .description('Show whether the menu-bar helper is installed and running')
    .option('--json', 'Emit machine-readable JSON')
    .action((options: { json?: boolean }) => {
      const s = getMenubarStatus();
      if (options.json) {
        process.stdout.write(JSON.stringify(s) + '\n');
        return;
      }
      if (s.platform !== 'darwin') {
        console.log(chalk.yellow('The menu bar helper is macOS only.'));
        return;
      }
      const yn = (b: boolean) => (b ? chalk.green('yes') : chalk.gray('no'));
      console.log(chalk.bold('Menu bar helper\n'));
      console.log(`  running            ${yn(s.running)}`);
      console.log(`  service installed  ${yn(s.serviceInstalled)}`);
      console.log(`  app installed      ${s.installedApp ? chalk.gray(s.installedApp) : chalk.gray('no')}`);
      console.log(`  installed version  ${s.installedVersion ? chalk.gray(s.installedVersion) : chalk.gray('unknown')}`);
      console.log(`  current version    ${chalk.gray(s.currentVersion)}`);
      console.log(`  bundle source      ${s.source ? chalk.gray(s.source) : chalk.red('missing (cannot enable)')}`);
      console.log(`  disabled by user   ${yn(s.disabledByUser)}`);
      if (s.stale) {
        console.log(chalk.yellow('\n  Installed helper is stale — runs on next `agents` startup, or `agents menubar enable` now.'));
      } else if (!s.serviceInstalled && !s.disabledByUser) {
        console.log(chalk.gray('\n  Enable it with `agents menubar enable`.'));
      }
    });

  // Bare `agents menubar` -> status.
  menubar.action(() => {
    const s = getMenubarStatus();
    if (s.platform !== 'darwin') {
      console.log(chalk.yellow('The menu bar helper is macOS only.'));
      return;
    }
    const yn = (b: boolean) => (b ? chalk.green('yes') : chalk.gray('no'));
    console.log(chalk.bold('Menu bar helper\n'));
    console.log(`  running            ${yn(s.running)}`);
    console.log(`  service installed  ${yn(s.serviceInstalled)}`);
    console.log(chalk.gray('\n  enable | disable | status'));
  });
}
