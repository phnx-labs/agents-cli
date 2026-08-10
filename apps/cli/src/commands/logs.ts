/**
 * `agents logs` — thin alias of `agents events`, plus a content redirect.
 *
 * Timeline / ops / audit / stats / rotate all live on the events engine:
 *   agents logs              ≡ agents events
 *   agents logs audit        ≡ agents events --include ops
 *   agents logs stats        ≡ agents events stats
 *   agents logs rotate       ≡ agents events rotate
 *
 * Per-run content (session transcript / host-task stdout) is NOT this product:
 *   agents sessions <id>
 *   agents hosts logs <id>
 *
 * A bare `agents logs <id>` prints a redirect to those commands.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  addEventsReadOptions,
  runEventsCommand,
  runEventsStats,
  runEventsRotate,
  type EventsOptions,
} from './events.js';

/** Register the top-level `agents logs` command as an events alias. */
export function registerLogsCommand(program: Command): void {
  const logsCmd = addEventsReadOptions(
    program
      .command('logs [id]')
      .description('Alias of `agents events`. Pass an id to see the content redirect.'),
    true,
  )
    .addHelpText('after', `
Examples:
  agents logs                            Same as: agents events
  agents logs --exclude commands
  agents logs audit                      Same as: agents events --include ops
  agents logs stats
  agents logs rotate

  # Session / host-task content is not this command:
  agents sessions <id>
  agents hosts logs <task-id>
`)
    .action(async (id: string | undefined, opts: EventsOptions & { session?: string }, command: Command) => {
      const merged = { ...command.optsWithGlobals(), ...opts } as EventsOptions & { session?: string };
      const directId = id ?? merged.session;
      if (directId) {
        console.error(chalk.yellow(
          `agents logs no longer shows run content for "${directId}".\n` +
          `  Session transcript:  agents sessions ${directId}\n` +
          `  Host-task stdout:    agents hosts logs ${directId}\n` +
          `  Event timeline:      agents events --session ${directId}`,
        ));
        process.exitCode = 2;
        return;
      }
      return runEventsCommand(merged);
    });

  addEventsReadOptions(
    logsCmd
      .command('audit')
      .description('Alias of `agents events --include ops`'),
    false,
  )
    .action((_options: EventsOptions, command: Command) => {
      const opts = command.optsWithGlobals() as EventsOptions;
      // Default ops-only via family; do not forceAudit — families own includeActivity.
      if (!opts.include && !opts.exclude && !opts.audit) opts.include = 'ops';
      return runEventsCommand(opts);
    });

  logsCmd
    .command('stats')
    .description('Alias of `agents events stats`')
    .option('--since <time>', 'Window size (e.g. 7d, 30d; default 7d)')
    .option('--json', 'Output stats as JSON')
    .action(async (opts: { since?: string; json?: boolean }) => runEventsStats(opts));

  logsCmd
    .command('rotate')
    .description('Alias of `agents events rotate`')
    .option('--days <n>', 'Retention period in days (default 7)', '7')
    .option('--max-mb <n>', 'Total event storage ceiling in MiB (default 50)', '50')
    .action((opts: { days?: string; maxMb?: string }) => runEventsRotate(opts));
}
