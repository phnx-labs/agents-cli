/**
 * Deprecated daemon commands.
 *
 * Registers the hidden `agents daemon` command tree as backward-compatible
 * aliases for `agents routines` scheduler lifecycle commands. Scheduled
 * for removal in v2.0.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';

import {
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  readDaemonPid,
  readDaemonLog,
  runDaemon,
} from '../lib/daemon.js';
import { listJobs as listAllJobs } from '../lib/routines.js';
import { JobScheduler } from '../lib/scheduler.js';

/** Print a deprecation warning pointing to the replacement command. */
function warnDeprecated(subcommand: string, replacement: string): void {
  console.log(chalk.yellow(`\u26a0  'agents daemon ${subcommand}' is deprecated and will be removed in v2.0. Use '${replacement}' instead.\n`));
}

/** Register the deprecated `agents daemon` command tree. */
export function registerDaemonCommands(program: Command): void {
  const daemonCmd = program
    .command('daemon', { hidden: true })
    .description('[DEPRECATED] Use `agents routines start|stop|status|scheduler-logs` instead. Kept for backward compatibility; will be removed in v2.0.')
    .addHelpText(
      'after',
      `
DEPRECATED: The 'agents daemon' commands are scheduled for removal in v2.0.

Migration:
  agents daemon start    ->  agents routines start
  agents daemon stop     ->  agents routines stop
  agents daemon status   ->  agents routines status
  agents daemon logs     ->  agents routines scheduler-logs

The scheduler now auto-starts when you run 'agents routines add', so in most cases
you never need to start it manually.
`
    );

  daemonCmd
    .command('start')
    .description('[DEPRECATED] Use `agents routines start`.')
    .action(() => {
      warnDeprecated('start', 'agents routines start');
      const result = startDaemon();
      if (result.method === 'already-running') {
        console.log(chalk.yellow(`Daemon already running (PID: ${result.pid})`));
      } else if (result.pid) {
        console.log(chalk.green(`Daemon started (PID: ${result.pid}, method: ${result.method})`));
      } else {
        console.log(chalk.yellow('Daemon start dispatched but no PID surfaced. Check `agents routines status`.'));
      }
    });

  daemonCmd
    .command('stop')
    .description('[DEPRECATED] Use `agents routines stop`.')
    .action(() => {
      warnDeprecated('stop', 'agents routines stop');
      if (!isDaemonRunning()) {
        console.log(chalk.yellow('Daemon is not running'));
        return;
      }
      stopDaemon();
      console.log(chalk.green('Daemon stopped'));
    });

  daemonCmd
    .command('status')
    .description('[DEPRECATED] Use `agents routines status`.')
    .action(() => {
      warnDeprecated('status', 'agents routines status');
      const running = isDaemonRunning();
      const pid = readDaemonPid();

      console.log(chalk.bold('Daemon Status\n'));
      console.log(`  Status:  ${running ? chalk.green('running') : chalk.gray('stopped')}`);
      if (pid) console.log(`  PID:     ${pid}`);

      const jobs = listAllJobs();
      const enabled = jobs.filter((j) => j.enabled);
      console.log(`  Jobs:    ${enabled.length} enabled / ${jobs.length} total`);

      if (running && enabled.length > 0) {
        const scheduler = new JobScheduler(async () => {});
        scheduler.loadAll();
        const scheduled = scheduler.listScheduled();
        console.log(chalk.bold('\n  Scheduled Jobs\n'));
        for (const job of scheduled) {
          const next = job.nextRun ? job.nextRun.toLocaleString() : 'unknown';
          console.log(`    ${chalk.cyan(job.name.padEnd(24))} next: ${chalk.gray(next)}`);
        }
        scheduler.stopAll();
      }
    });

  daemonCmd
    .command('logs')
    .description('[DEPRECATED] Use `agents routines scheduler-logs`.')
    .option('-n, --lines <number>', 'Show this many recent lines (default: 50)', '50')
    .option('-f, --follow', 'Stream log output in real time (like tail -f)')
    .action(async (options) => {
      warnDeprecated('logs', 'agents routines scheduler-logs');
      if (options.follow) {
        const { getDaemonDir } = await import('../lib/state.js');
        const { followFile } = await import('../lib/log-follow.js');
        const logPath = path.join(getDaemonDir(), 'logs.jsonl');
        const recent = readDaemonLog(parseInt(options.lines, 10));
        if (recent) console.log(recent);
        const stop = followFile(logPath, (text) => process.stdout.write(text), { fromEnd: true });
        process.on('SIGINT', () => { stop(); process.exit(0); });
        return;
      }

      const lines = parseInt(options.lines, 10);
      const output = readDaemonLog(lines);
      if (output) {
        console.log(output);
      } else {
        console.log(chalk.gray('No daemon logs'));
      }
    });

  daemonCmd
    .command('_run', { hidden: true })
    .description('Run daemon in foreground (internal)')
    .action(async () => {
      await runDaemon();
    });
}
