/**
 * Removed `agents activity` command.
 *
 * The standalone milestone timeline is gone. Its stream is consumed through
 * `agents feed --filter updates` (progress posts only) or
 * `agents feed --filter all` (open blocks + updates). Project scoping is
 * `agents feed --project <name>`.
 *
 * The underlying activity log (`lib/activity.ts`) remains — feed posts and the
 * feed activity lane still write/read it.
 *
 * Kept registered so muscle-memory invocations get a clear redirect instead of
 * an "unknown command" error.
 */

import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';

const REDIRECT =
  'agents-cli: "agents activity" was removed.\n' +
  '            Progress posts:    agents feed --filter updates\n' +
  '            Blocks + updates:  agents feed --filter all\n' +
  '            One project:       agents feed --project <name>\n' +
  '            (optional --json / --local / --host as on feed)\n\n';

/** Register the removed `agents activity` command as a hard-error redirect. */
export function registerActivityCommand(program: Command): void {
  const activityCmd = program
    .command('activity')
    .description('Removed. Use `agents feed --filter updates` or `--filter all`.')
    .option('--json', '(no-op)')
    .option('--all', '(no-op)')
    .option('--milestones', '(no-op)')
    .option('-n, --limit <n>', '(no-op)')
    .option('--since <minutes>', '(no-op)')
    .option('--local', '(no-op)')
    .option('-H, --host <target...>', '(no-op)')
    .option('--device <target...>', '(no-op)')
    .option('--devices-all', '(no-op)')
    .option('--hosts-all', '(no-op)')
    .option('--group-by <field>', '(no-op)')
    .option('--flat', '(no-op)')
    .option('--project <name>', '(no-op)')
    .option('--filter <text>', '(no-op)');

  setHelpSections(activityCmd, {
    notes: `
      Removed. Equivalents:
        agents feed --filter updates     progress posts (milestone stream)
        agents feed --filter all         open blocks + updates
        agents feed --project <name>     scope to one project
    `,
  });

  activityCmd.action(() => {
    process.stderr.write(REDIRECT);
    process.exit(2);
  });
}
