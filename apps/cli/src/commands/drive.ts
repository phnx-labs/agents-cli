/**
 * Drive sync commands.
 *
 * Registers the `agents drive` command tree for syncing agent session
 * history across machines via rsync. Supports pull, push, attach
 * (redirect agent homes to drive), and detach operations.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { betaEnableHint, isBetaEnabled } from '../lib/beta.js';
import {
  setRemote,
  pull,
  push,
  attach,
  detach,
  getDriveStatus,
} from '../lib/drive-sync.js';

/** Register the `agents drive` command tree. */
export function registerDriveCommands(program: Command): void {
  const enabled = isBetaEnabled('drive');
  const driveCmd = program
    .command('drive', { hidden: !enabled })
    .description('Sync agent session history across machines via rsync. Set up once, then pull/push to keep sessions in sync.')
    .addHelpText('after', `
Typical workflow:
  # One-time setup: point to your remote machine
  agents drive remote user@hostname

  # Pull sessions from remote to local
  agents drive pull

  # Work locally with your agents...

  # Push your new sessions back to remote
  agents drive push

  # Check sync state
  agents drive status

Use case: Keep session history consistent across your laptop and desktop,
or back up sessions to a server you control.
`);

  driveCmd.hook('preAction', () => {
    if (enabled) return;
    console.error(chalk.red('agents drive is in beta.'));
    console.error(chalk.gray(betaEnableHint('drive')));
    process.exit(1);
  });

  driveCmd
    .command('remote <target>')
    .description('Set the rsync remote target (e.g., user@hostname). Sessions sync to <target>:~/.agents/drive/')
    .addHelpText('after', `
Examples:
  # Set remote to a server
  agents drive remote user@server

  # Set remote to a local machine on your network
  agents drive remote macbook.local
`)
    .action((target: string) => {
      try {
        setRemote(target);
        console.log(chalk.green(`Remote set to ${target}`));
        console.log(chalk.gray(`Syncs to ${target}:~/.agents/drive/`));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  driveCmd
    .command('pull')
    .description('Fetch sessions from the remote and merge them into your local ~/.agents/drive/.')
    .addHelpText('after', `
Example:
  agents drive pull

Run this when you switch machines to get the latest session history.
`)
    .action(async () => {
      const spinner = ora('Pulling from remote...').start();
      try {
        await pull();
        spinner.succeed('Pull complete');
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  driveCmd
    .command('push')
    .description('Upload your local sessions to the remote so other machines can pull them.')
    .addHelpText('after', `
Example:
  agents drive push

Run this after working locally to share your new sessions with other machines.
`)
    .action(async () => {
      const spinner = ora('Pushing to remote...').start();
      try {
        await push();
        spinner.succeed('Push complete');
      } catch (err: any) {
        spinner.fail(err.message);
        process.exit(1);
      }
    });

  driveCmd
    .command('attach')
    .description('Point your agent homes (~/.claude, etc.) at drive so sessions write directly to the synced location.')
    .addHelpText('after', `
Example:
  agents drive attach

After attach, agent sessions are saved to ~/.agents/drive/ instead of version homes.
Use 'detach' to switch back to version-specific homes.
`)
    .action(() => {
      try {
        attach();
        console.log(chalk.green('Drive attached'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  driveCmd
    .command('detach')
    .description('Restore agent homes back to their version-specific directories (undo attach).')
    .addHelpText('after', `
Example:
  agents drive detach
`)
    .action(() => {
      try {
        detach();
        console.log(chalk.green('Drive detached'));
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  driveCmd
    .command('status')
    .description('Show current drive configuration, attach state, and last sync times.')
    .addHelpText('after', `
Example:
  agents drive status
`)
    .action(() => {
      const status = getDriveStatus();

      console.log(chalk.bold('Drive'));
      console.log(`  Remote:     ${status.remote || chalk.gray('not set')}`);
      console.log(`  Attached:   ${status.attached ? chalk.green('yes') : chalk.gray('no')}`);
      console.log(`  Last pull:  ${status.lastPull ? formatTime(status.lastPull) : chalk.gray('never')}`);
      console.log(`  Last push:  ${status.lastPush ? formatTime(status.lastPush) : chalk.gray('never')}`);
      console.log(`  Path:       ${chalk.gray(status.driveDir)}`);
      console.log('');
      console.log(chalk.bold('Symlinks'));
      console.log(`  ~/.claude       -> ${status.configDirTarget || chalk.gray('not a symlink')}`);
      for (const [hf, target] of Object.entries(status.homeFileTargets)) {
        console.log(`  ~/${hf}  -> ${target || chalk.gray('not a symlink')}`);
      }
    });
}

/** Format an ISO timestamp as a human-readable relative time (e.g. "5 min ago"). */
function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs === 1 ? '' : 's'} ago`;

  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}
